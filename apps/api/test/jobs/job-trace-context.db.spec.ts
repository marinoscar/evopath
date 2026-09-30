// =============================================================================
// Real-Postgres test: jobs.trace_context (issue #132)
// =============================================================================
//
// Proves the parts a mocked Prisma cannot: the column exists as nullable TEXT
// after `migrate deploy`, the real `JobsService` writes the active span's
// traceparent into it, and the real claim statement's `RETURNING` (derived
// from `JOB_CLAIM_COLUMNS`) hands it back to the claimer.
//
// THIS IS A `*.db.spec.ts` FILE — see `db-test-support.ts` and
// `job-claim.db.spec.ts`'s header for the run/skip mechanics.
// =============================================================================

import { PrismaClient } from '@prisma/client';

import { JobClaimService } from '../../src/jobs/job-claim.service';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { installTestTracing, TestTracing } from '../helpers/otel-tracing.helper';
import { createDbClient, resolveDbSuite } from './db-test-support';

const { describeWithDb } = resolveDbSuite('job-trace-context.db.spec');

describeWithDb('jobs.trace_context (real Postgres)', () => {
  let client: PrismaClient;
  let jobs: JobsService;
  let claims: JobClaimService;
  let tracing: TestTracing;

  const TYPE_PREFIX = `test.trace.${process.pid}.`;
  let typeCounter = 0;
  const nextType = (): string => `${TYPE_PREFIX}${(typeCounter += 1)}`;

  beforeAll(async () => {
    client = createDbClient();
    await client.$connect();
    jobs = new JobsService(client as unknown as PrismaService);
    claims = new JobClaimService(client as unknown as PrismaService);
  });

  beforeEach(() => {
    tracing = installTestTracing();
  });

  afterEach(async () => {
    tracing.uninstall();
    await client.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
  });

  afterAll(async () => {
    await client?.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
    await client?.$disconnect();
  });

  it('exists as a nullable TEXT column', async () => {
    const rows = await client.$queryRaw<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'jobs' AND column_name = 'trace_context'`;

    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
  });

  it('leaves the active-dedup partial unique index in place', async () => {
    const rows = await client.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'jobs' AND indexname = 'jobs_active_dedup_uniq_idx'`;

    expect(rows).toHaveLength(1);
  });

  it('stores the active span at enqueue and returns it from the claim', async () => {
    const type = nextType();

    const expected = await tracing.tracer.startActiveSpan('POST /api/things', async (span) => {
      await jobs.enqueue({ type, reason: 'upload', skipDedup: true });
      span.end();
      const { traceId, spanId } = span.spanContext();
      return `00-${traceId}-${spanId}-01`;
    });

    const stored = await client.job.findFirstOrThrow({ where: { type } });
    expect(stored.traceContext).toBe(expected);

    const [claimed] = await claims.claim({
      nodeId: null,
      executor: 'server',
      eligibleTypes: [type],
      limit: 1,
      leases: [{ type, leaseMs: 60_000 }],
    });
    expect(claimed.traceContext).toBe(expected);
  });

  it('stores NULL when nothing is traced', async () => {
    const type = nextType();

    await jobs.enqueue({ type, reason: 'upload', skipDedup: true });

    const stored = await client.job.findFirstOrThrow({ where: { type } });
    expect(stored.traceContext).toBeNull();
  });
});
