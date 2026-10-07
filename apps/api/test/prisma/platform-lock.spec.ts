import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { checkLock, readLock, readManifest, sha256Hex } from '@marinoscar/platform-db';

// =============================================================================
// EvoPath's platform.lock (marinoscar/EnterpriseAppBase#747, PP-10.6)
// =============================================================================
//
// `platform-db-conformance.spec.ts` runs the package's own check (`checkLock`).
// This spec pins the EvoPath-specific facts that check cannot know, and proves
// that the check fails when a locked migration is touched (the negative run the
// story asks for, as a test rather than a one-off).
//
// The mapping exists because EvoPath's database already ran the platform
// history under local names. Nothing here may rename, edit or delete one of
// those directories: Prisma identifies an applied migration by directory name
// and stores its checksum, and would re-run a renamed one.
// =============================================================================

const apiRoot = join(__dirname, '..', '..');
const migrationsDir = join(apiRoot, 'prisma', 'migrations');
const packageDir = join(apiRoot, '..', '..', 'node_modules', '@marinoscar', 'platform-db');

const lock = readLock(join(apiRoot, 'prisma', 'platform.lock'));
const manifest = readManifest(join(packageDir, 'migrations', 'manifest.json'));

const readLocal = (dir: string): Uint8Array | undefined => {
  const file = join(migrationsDir, dir, 'migration.sql');
  return existsSync(file) ? readFileSync(file) : undefined;
};
const entry = (originId: string) => {
  const found = lock.migrations.find((m) => m.originId === originId);
  if (!found) throw new Error(`platform.lock has no ${originId}`);
  return found;
};

describe('platform.lock (EvoPath)', () => {
  it('maps every migration of the platform history, in package order', () => {
    expect(lock.migrations.map((m) => m.originId)).toEqual(manifest.map((m) => `platform:${m.id}`));
    expect(lock.migrations).toHaveLength(22);
  });

  it('maps the 19 byte-identical migrations to the directories EvoPath already had', () => {
    const identical = lock.migrations.filter(
      (m) =>
        m.localSha256 === undefined &&
        m.originId !== 'platform:0020_add_worker_node_vitals' &&
        m.originId !== 'platform:0022_add_retention_created_at_indexes'
    );
    expect(identical).toHaveLength(19);
    for (const m of identical) {
      expect(sha256Hex(readLocal(m.localDir)!)).toBe(m.sha256);
      // Same name as the platform's own migration, minus the sequence number.
      expect(m.localDir.replace(/^\d{14}_/, '')).toBe(m.originId.replace(/^platform:\d{4}_/, ''));
    }
  });

  it('maps the renamed add_worker_node_vitals to the EvoPath directory, with the platform checksum', () => {
    const m = entry('platform:0020_add_worker_node_vitals');
    expect(m.localDir).toBe('20260930100000_add_worker_node_vitals');
    expect(m.localSha256).toBeUndefined();
    expect(sha256Hex(readLocal(m.localDir)!)).toBe(m.sha256);
    // The platform's own id for it is a different directory: renaming EvoPath's
    // would make Prisma treat it as a new migration and re-run the ALTER TABLE.
    expect(manifest.find((x) => x.id === '0020_add_worker_node_vitals')).toBeDefined();
    expect(m.localDir).not.toBe('20260928100000_add_worker_node_vitals');
  });

  it('records the comment-only add_job_trace_context divergence instead of editing the file', () => {
    const m = entry('platform:0021_add_job_trace_context');
    expect(m.localDir).toBe('20260930120000_add_job_trace_context');
    expect(m.localSha256).toBeDefined();
    expect(m.note).toBeTruthy();
    expect(m.localSha256).not.toBe(m.sha256);
    const local = readFileSync(join(migrationsDir, m.localDir, 'migration.sql'), 'utf8');
    const platform = readFileSync(
      join(packageDir, 'migrations', '0021_add_job_trace_context', 'migration.sql'),
      'utf8'
    );
    expect(sha256Hex(local)).toBe(m.localSha256);
    expect(sha256Hex(platform)).toBe(m.sha256);
    // Only the first line (an issue reference in a comment) differs.
    const [localHead, ...localTail] = local.split('\n');
    const [platformHead, ...platformTail] = platform.split('\n');
    expect(localHead.startsWith('--')).toBe(true);
    expect(platformHead.startsWith('--')).toBe(true);
    expect(localTail).toEqual(platformTail);
  });

  it('installs 0022 as an unmodified copy after every existing EvoPath migration', () => {
    const m = entry('platform:0022_add_retention_created_at_indexes');
    expect(sha256Hex(readLocal(m.localDir)!)).toBe(m.sha256);
    const others = readdirSync(migrationsDir).filter((d) => /^\d{14}_/.test(d) && d !== m.localDir);
    expect(others.every((d) => d < m.localDir)).toBe(true);
  });

  it('declares push_subscriptions.platform, which the platform history lacks, and never drops it', () => {
    const deviation = lock.deviations?.find((d) => d.id === 'evopath:push-subscriptions-platform');
    expect(deviation).toBeDefined();
    expect(deviation!.expectDiff).toEqual([
      `ALTER TABLE "push_subscriptions" ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'browser';`,
    ]);
    const sql = readFileSync(
      join(migrationsDir, '20261004100000_add_push_subscription_platform', 'migration.sql'),
      'utf8'
    );
    expect(sql).toContain('push_subscriptions_platform_check');
    // The platform's own history has no such column.
    for (const m of manifest) {
      const text = readFileSync(join(packageDir, 'migrations', m.dir, 'migration.sql'), 'utf8');
      expect(text).not.toMatch(/push_subscriptions[^;]*"platform"/);
    }
  });

  it("lists EvoPath's ten domain raw-SQL partial indexes, so the drift test asserts them", () => {
    expect((lock.rawSqlIndexes ?? []).map((i) => i.name).sort()).toEqual(
      [
        'activity_entries_provider_external_uniq_idx',
        'activity_entries_workout_kind_uniq_idx',
        'android_app_releases_one_current_uniq_idx',
        'gyms_user_default_uniq_idx',
        'measurements_provider_external_uniq_idx',
        'programs_one_active_per_user_uniq_idx',
        'sleep_sessions_provider_external_uniq_idx',
        'training_plan_runs_active_per_user_uniq_idx',
        'workout_adaptations_active_per_user_uniq_idx',
        'workouts_user_in_progress_uniq_idx',
      ].sort()
    );
  });

  it('passes the package check against the real migration files', () => {
    expect(checkLock(manifest, lock, readLocal)).toEqual({ ok: true, problems: [] });
  });
});

describe('platform.lock drift check (negative runs)', () => {
  it('fails when a locked migration.sql is modified', () => {
    const target = entry('platform:0008_add_jobs').localDir;
    const result = checkLock(manifest, lock, (dir) =>
      dir === target
        ? Buffer.concat([
            readFileSync(join(migrationsDir, dir, 'migration.sql')),
            Buffer.from('\n-- edited\n'),
          ])
        : readLocal(dir)
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ code: 'LOCAL_MODIFIED', originId: 'platform:0008_add_jobs' }),
    ]);
  });

  it('fails when the comment-only entry is edited any further', () => {
    const target = entry('platform:0021_add_job_trace_context').localDir;
    const result = checkLock(manifest, lock, (dir) =>
      dir === target
        ? Buffer.from(
            `${readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8')}\nSELECT 1;\n`
          )
        : readLocal(dir)
    );
    expect(result.problems.map((p) => p.code)).toContain('LOCAL_MODIFIED');
  });

  it('fails when a locked directory is renamed or deleted', () => {
    const target = entry('platform:0020_add_worker_node_vitals').localDir;
    const result = checkLock(manifest, lock, (dir) =>
      dir === target ? undefined : readLocal(dir)
    );
    expect(result.problems).toEqual([
      expect.objectContaining({
        code: 'LOCAL_DIR_MISSING',
        originId: 'platform:0020_add_worker_node_vitals',
      }),
    ]);
  });

  it('fails when a platform migration is missing from the lock', () => {
    const shorter = { ...lock, migrations: lock.migrations.slice(0, -1) };
    const result = checkLock(manifest, shorter, readLocal);
    expect(result.problems).toEqual([
      expect.objectContaining({
        code: 'NOT_INSTALLED',
        originId: 'platform:0022_add_retention_created_at_indexes',
      }),
    ]);
  });
});
