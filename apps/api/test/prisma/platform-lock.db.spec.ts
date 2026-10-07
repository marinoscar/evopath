// =============================================================================
// platform.lock against a migrated Postgres (marinoscar/EnterpriseAppBase#747)
// =============================================================================
//
// The offline half (platform-lock.spec.ts) proves the lock and the files agree.
// This half proves the DATABASE agrees with both: every locked directory is a
// finished row of `_prisma_migrations` with the checksum Prisma stored for it
// (`platform db check --database`, as a test), and platform migration 0022's
// indexes are really there. Runs after `prisma:migrate`, via `npm run test:db`.
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkLedger, readLock } from '@marinoscar/platform-db';

import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('platform-lock.db.spec');

const apiRoot = join(__dirname, '..', '..');
const migrationsDir = join(apiRoot, 'prisma', 'migrations');
const lock = readLock(join(apiRoot, 'prisma', 'platform.lock'));

describeWithDb('platform.lock vs the database (real Postgres)', () => {
  let prisma: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('records every locked directory as finished, with the checksum of the file on disk', async () => {
    const rows = await prisma.$queryRaw<
      {
        migration_name: string;
        checksum: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }[]
    >`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations`;
    const readLocal = (dir: string) => {
      const file = join(migrationsDir, dir, 'migration.sql');
      return existsSync(file) ? readFileSync(file) : undefined;
    };
    const result = checkLedger(
      lock.migrations.map((m) => m.localDir),
      readLocal,
      rows.map((r) => ({
        migrationName: r.migration_name,
        checksum: r.checksum,
        finishedAt: r.finished_at,
        rolledBackAt: r.rolled_back_at,
      }))
    );
    expect(result.problems).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  it('has the retention created_at indexes of platform migration 0022', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('notification_deliveries_created_at_idx', 'notifications_created_at_idx', 'ai_runs_created_at_idx')`;
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'ai_runs_created_at_idx',
      'notification_deliveries_created_at_idx',
      'notifications_created_at_idx',
    ]);
  });
});
