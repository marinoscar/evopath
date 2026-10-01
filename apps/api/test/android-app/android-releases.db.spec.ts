// =============================================================================
// Real-Postgres test: Android APK releases (#285, epic #276)
// =============================================================================
//
// What only a real server can prove: the raw-SQL partial unique index
// `android_app_releases_one_current_uniq_idx` (at most one current release
// deployment-wide, any number of non-current ones), the unique version per
// package, the uploader's ON DELETE SET NULL, that `makeCurrent` swaps the
// current release atomically (concurrent swaps leave exactly one current and
// the loser gets RELEASE_CURRENT_CONFLICT), and that the service recognises
// the index by name in a real driver error.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { ONE_CURRENT_RELEASE_INDEX } from '../../src/android-app/releases/android-release.constants';
import { AndroidReleaseService, isUniqueViolationOn } from '../../src/android-app/releases/android-release.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('android-releases.db.spec');

const SHA = Array.from({ length: 32 }, () => 'AB').join(':');

describeWithDb('android_app_releases (real Postgres)', () => {
  let client: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const pkg = `com.test.rel${tag}`;
  let userId: string;

  const release = (versionCode: number, over: Record<string, unknown> = {}) => ({
    packageName: pkg,
    versionName: `0.${versionCode}.0`,
    versionCode,
    signingSha256: SHA,
    fileSha256: 'a'.repeat(64),
    sizeBytes: 1024,
    storageKey: `android-releases/${randomUUID()}.apk`,
    uploadedById: userId,
    ...over,
  });

  const service = () =>
    new AndroidReleaseService(
      client as never,
      {} as never,
      {} as never,
      { ensureTrusted: jest.fn().mockResolvedValue(false) } as never,
    );

  beforeAll(async () => {
    client = createDbClient();
    // The index is deployment-wide: no other suite creates releases, but a
    // crashed earlier run of this one may have left a current row behind.
    await client.androidAppRelease.deleteMany({ where: { packageName: { startsWith: 'com.test.rel' } } });
    userId = (await client.user.create({ data: { email: `android-rel-${tag}@example.com` } })).id;
  });

  afterEach(async () => {
    await client.androidAppRelease.deleteMany({ where: { packageName: pkg } });
  });

  afterAll(async () => {
    await client.androidAppRelease.deleteMany({ where: { packageName: pkg } });
    await client.auditEvent.deleteMany({ where: { actorUserId: userId } }).catch(() => undefined);
    await client.user.delete({ where: { id: userId } }).catch(() => undefined);
    await client.$disconnect();
  });

  it('allows any number of non-current releases but only one current, recognised by index name', async () => {
    await client.androidAppRelease.create({ data: release(1) });
    await client.androidAppRelease.create({ data: release(2) });
    await client.androidAppRelease.create({ data: release(3, { isCurrent: true }) });

    const error = await client.androidAppRelease
      .create({ data: release(4, { isCurrent: true, packageName: `${pkg}.other` }) })
      .catch((caught: unknown) => caught);

    expect(isUniqueViolationOn(error, ONE_CURRENT_RELEASE_INDEX)).toBe(true);
    await client.androidAppRelease.deleteMany({ where: { packageName: `${pkg}.other` } });
  });

  it('allows one release per (packageName, versionCode), not recognised as the current index', async () => {
    await client.androidAppRelease.create({ data: release(1) });
    const error = await client.androidAppRelease.create({ data: release(1) }).catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('P2002');
    expect(isUniqueViolationOn(error, ONE_CURRENT_RELEASE_INDEX)).toBe(false);
    await client.androidAppRelease.create({ data: release(1, { packageName: `${pkg}.debug` }) });
    await client.androidAppRelease.deleteMany({ where: { packageName: `${pkg}.debug` } });
  });

  it('make-current swaps the current release in one step, rollback included', async () => {
    const one = await client.androidAppRelease.create({ data: release(1) });
    const two = await client.androidAppRelease.create({ data: release(2, { isCurrent: true }) });

    const view = await service().makeCurrent(one.id, userId);

    expect(view).toMatchObject({ id: one.id, isCurrent: true });
    const current = await client.androidAppRelease.findMany({ where: { packageName: pkg, isCurrent: true } });
    expect(current.map((row) => row.id)).toEqual([one.id]);
    expect((await client.androidAppRelease.findUnique({ where: { id: two.id } }))?.isCurrent).toBe(false);
  });

  it('concurrent make-currents leave exactly one current release; a loser gets RELEASE_CURRENT_CONFLICT', async () => {
    const rows = await Promise.all([1, 2, 3, 4].map((code) => client.androidAppRelease.create({ data: release(code) })));

    const results = await Promise.allSettled(rows.map((row) => service().makeCurrent(row.id, userId)));

    const current = await client.androidAppRelease.findMany({ where: { packageName: pkg, isCurrent: true } });
    expect(current).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(ConflictException);
        expect((result.reason as ConflictException).getResponse()).toMatchObject({
          details: { reason: 'RELEASE_CURRENT_CONFLICT' },
        });
      }
    }
  });

  it('keeps a release when its uploader is deleted (uploadedById SET NULL)', async () => {
    const uploader = await client.user.create({ data: { email: `android-rel-up-${tag}@example.com` } });
    const row = await client.androidAppRelease.create({ data: release(1, { uploadedById: uploader.id }) });

    await client.user.delete({ where: { id: uploader.id } });

    expect((await client.androidAppRelease.findUnique({ where: { id: row.id } }))?.uploadedById).toBeNull();
  });

  it('stores health_sync_devices.app_version_code', async () => {
    const device = await client.healthSyncDevice.create({
      data: { userId, installationId: randomUUID(), name: 'Pixel', appVersionCode: 42 },
    });
    expect((await client.healthSyncDevice.findUnique({ where: { id: device.id } }))?.appVersionCode).toBe(42);
    await client.healthSyncDevice.delete({ where: { id: device.id } });
  });
});
