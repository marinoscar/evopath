// =============================================================================
// Real-Postgres test: every JobTerminalService write is claim-token-guarded
// (issue #477)
// =============================================================================
//
// `ea97db4` made `safeTerminalUpdate` write through `updateManyAndReturn` with
// `heldClaimWhere(job)` — this id, still `running`, same `claim_token`, same
// `claimed_by_node_id`, DELIBERATELY NO LEASE CLAUSE — instead of `{ id }`
// alone. `job-lease.service.spec.ts` and `job-terminal.service.spec.ts` cover
// the predicate's SHAPE and the state machine's BRANCHES against a mocked
// Prisma client, which answers whatever a test told it to no matter what
// `where` it was actually handed. What neither mocked suite can show is the
// only question that matters operationally:
//
//     does a real re-claim's write ACTUALLY change what a stale executor's
//     terminal write matches, against a real row, under a real second claim?
//
// This file drives the real `JobClaimService`, `JobStuckService` and
// `JobTerminalService` — the same three services `job-lease-renewal.db.spec.ts`
// and `queue-fleet-concurrency.db.spec.ts` already exercise together — through
// the claim → expire → reap → re-claim → stale-settle sequence #477 exists to
// make harmless, and reads the row back to prove it.
//
// THIS IS A `*.db.spec.ts` FILE — see `db-test-support.ts`.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, Prisma, PrismaClient } from '@prisma/client';

import { ClaimOptions, JobClaimService } from '../../src/jobs/job-claim.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobStuckService } from '../../src/jobs/job-stuck.service';
import { JobTerminalService } from '../../src/jobs/job-terminal.service';
import { JOB_SETTLED_EVENT } from '../../src/jobs/events/job-settled.event';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import { RateLimitError } from '../../src/jobs/rate-limit.error';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { createDbClient, resolveDbSuite } from './db-test-support';

const { describeWithDb } = resolveDbSuite('job-terminal-claim-guard.db.spec');

/** The stuck threshold every test in this suite runs with. */
const THRESHOLD_MINUTES = 30;

/** The deployment-wide attempt budget most tests in this suite run with. */
const MAX_ATTEMPTS = 3;

const LEASE_MS = 60_000;

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

function stubConfig(maxAttempts: number = MAX_ATTEMPTS): ConfigService {
  return {
    get: (key: string) => (key === 'jobs.maxAttempts' ? maxAttempts : undefined),
  } as unknown as ConfigService;
}

function stubSystemSettings(): SystemSettingsService {
  return {
    getJobsPolicy: async () => ({
      history: { retentionDays: 30, purgeEnabled: true },
      stuckThresholdMinutes: THRESHOLD_MINUTES,
    }),
  } as unknown as SystemSettingsService;
}

describeWithDb('JobTerminalService writes are guarded by the claim, not just the id (real Postgres)', () => {
  let client: PrismaClient;
  let claims: JobClaimService;
  let terminal: JobTerminalService;
  let stuck: JobStuckService;
  let events: EventEmitter2;
  let settledIds: string[];

  const TYPE_PREFIX = `test.terminal-claim-guard.${process.pid}.`;
  let typeCounter = 0;
  const nextType = (): string => `${TYPE_PREFIX}${(typeCounter += 1)}`;

  beforeAll(async () => {
    client = createDbClient();
    await client.$connect();
  });

  beforeEach(() => {
    events = new EventEmitter2();
    settledIds = [];
    events.on(JOB_SETTLED_EVENT, (event: { job: Job }) => settledIds.push(event.job.id));

    const registry = new JobHandlerRegistry();
    const config = stubConfig();

    claims = new JobClaimService(client as unknown as PrismaService);
    terminal = new JobTerminalService(
      client as unknown as PrismaService,
      config,
      new ProviderThrottleService(config),
      events,
      registry
    );
    stuck = new JobStuckService(
      client as unknown as PrismaService,
      config,
      stubSystemSettings(),
      registry,
      events
    );
  });

  afterEach(async () => {
    await client.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
  });

  afterAll(async () => {
    await client?.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
    await client?.$disconnect();
  });

  const read = (id: string): Promise<Job> => client.job.findUniqueOrThrow({ where: { id } });

  async function seed(data: Omit<Prisma.JobUncheckedCreateInput, 'reason'>): Promise<Job> {
    return client.job.create({
      data: { reason: 'backfill', ...data } as Prisma.JobUncheckedCreateInput,
    });
  }

  const claimOptions = (type: string, overrides: Partial<ClaimOptions> = {}): ClaimOptions => ({
    nodeId: null,
    executor: 'server',
    eligibleTypes: [type],
    limit: 1,
    leases: [{ type, leaseMs: LEASE_MS }],
    ...overrides,
  });

  async function claimOne(type: string): Promise<Job> {
    const [claimed] = await claims.claim(claimOptions(type));
    expect(claimed).toBeDefined();
    return claimed;
  }

  // ===========================================================================
  // 1. A settle under a matching claim lands and emits once — including with
  //    an expired-but-unreaped lease. This is the case that PINS "no lease
  //    clause": identity, not liveness, is what `heldClaimWhere` checks.
  // ===========================================================================

  it('settles a freshly claimed job and emits job.settled exactly once', async () => {
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimed = await claimOne(type);

    await expect(terminal.completeSucceeded(claimed)).resolves.toBe('succeeded');

    const row = await read(claimed.id);
    expect(row.status).toBe('succeeded');
    expect(row.claimToken).toBeNull();
    expect(row.claimedByNodeId).toBeNull();
    expect(settledIds).toEqual([claimed.id]);
  });

  it('settles a claim whose lease has already expired but was never reaped — no lease clause in the guard', async () => {
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimed = await claimOne(type);

    // The executor is about to report back, but its lease already lapsed a
    // moment ago and nothing has reaped the row yet. `heldClaimWhere` asks an
    // IDENTITY question only, so this settle must still land.
    await client.job.update({
      where: { id: claimed.id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });

    await expect(terminal.completeSucceeded(claimed)).resolves.toBe('succeeded');

    const row = await read(claimed.id);
    expect(row.status).toBe('succeeded');
    expect(settledIds).toEqual([claimed.id]);
  });

  // ===========================================================================
  // 2. Claim (A) -> expire -> reaper requeues -> claim (B) -> A's stale
  //    completeSucceeded/completeFailed are claim-lost; B's row is untouched;
  //    B's own settle lands and emits exactly once.
  // ===========================================================================

  it('discards a stale completeSucceeded from a reaped-and-reclaimed executor without touching the new claim', async () => {
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimedByA = await claimOne(type);
    expect(claimedByA.attempts).toBe(1);

    await client.job.update({
      where: { id: claimedByA.id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });
    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });

    const claimedByB = await claimOne(type);
    expect(claimedByB.id).toBe(claimedByA.id);
    expect(claimedByB.claimToken).not.toBe(claimedByA.claimToken);
    expect(claimedByB.attempts).toBe(2);

    const beforeStale = await read(claimedByB.id);

    // A's stale conclusion, carrying A's now-superseded claim token.
    await expect(terminal.completeSucceeded(claimedByA)).resolves.toBe('claim-lost');

    const afterStaleSuccess = await read(claimedByB.id);
    expect(afterStaleSuccess).toEqual(beforeStale);
    expect(settledIds).toEqual([]);

    // A's stale FAILURE is refused identically — the guard does not care which
    // branch of `completeFailed` produced the write.
    await expect(terminal.completeFailed(claimedByA, new Error('stale failure'))).resolves.toBe(
      'claim-lost'
    );

    const afterStaleFailure = await read(claimedByB.id);
    expect(afterStaleFailure).toEqual(beforeStale);
    expect(settledIds).toEqual([]);

    // B's OWN settle, over the very same row, still lands and emits once.
    await expect(terminal.completeSucceeded(claimedByB)).resolves.toBe('succeeded');

    const final = await read(claimedByB.id);
    expect(final.status).toBe('succeeded');
    expect(settledIds).toEqual([claimedByB.id]);
  });

  // ===========================================================================
  // 3. Claim -> expire -> reaper phase 1 gives up (budget spent) -> stale
  //    success ⇒ row stays `failed` with the reaper's own lastError; exactly
  //    ONE job.settled in total (the #468 duplicate stays gone).
  // ===========================================================================

  it('leaves a reaper give-up alone when the abandoned executor reports back late, and never double-emits', async () => {
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimed = await claimOne(type);

    // Fixture setup only: put this row AT its attempt budget so the reaper's
    // give-up phase (not its requeue phase) is the one that fires, without
    // spending three real claim/abandon cycles to get there.
    await client.job.update({
      where: { id: claimed.id },
      data: { attempts: MAX_ATTEMPTS, leaseExpiresAt: minutesAgo(1) },
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 0, failed: 1 });

    const reaped = await read(claimed.id);
    expect(reaped.status).toBe('failed');
    expect(reaped.lastError).toContain('Abandoned by its executor');
    expect(settledIds).toEqual([claimed.id]);

    // The executor's `process()` finally returns, long after the reaper gave
    // up on it, and reports success on a row that is no longer running.
    await expect(terminal.completeSucceeded(claimed)).resolves.toBe('claim-lost');

    const final = await read(claimed.id);
    expect(final).toEqual(reaped);

    // Exactly one settlement across BOTH the reaper's give-up and the stale
    // executor's own conclusion — the #468 duplicate this guard also closes.
    expect(settledIds).toEqual([claimed.id]);
  });

  // ===========================================================================
  // 4. A stale retry and a stale rate-limit deferral against a live re-claim
  //    must not push the row back to pending or un-charge its attempts.
  // ===========================================================================

  it('refuses a stale retry-scheduling write from an executor whose claim was reaped and reclaimed', async () => {
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimedByA = await claimOne(type);

    await client.job.update({
      where: { id: claimedByA.id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });
    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });

    const claimedByB = await claimOne(type);
    expect(claimedByB.claimToken).not.toBe(claimedByA.claimToken);

    const beforeStale = await read(claimedByB.id);

    // A's stale ORDINARY failure would, on a live claim, schedule a retry
    // (attempts=2 < budget=3). Against B's live claim it must match nothing.
    await expect(terminal.completeFailed(claimedByA, new Error('boom'))).resolves.toBe(
      'claim-lost'
    );

    const after = await read(claimedByB.id);
    expect(after).toEqual(beforeStale);
    expect(after.status).toBe('running');
    expect(after.attempts).toBe(beforeStale.attempts);
    expect(settledIds).toEqual([]);
  });

  it('refuses a stale rate-limit deferral from an executor whose claim was reaped and reclaimed', async () => {
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimedByA = await claimOne(type);

    await client.job.update({
      where: { id: claimedByA.id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });
    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });

    const claimedByB = await claimOne(type);
    expect(claimedByB.claimToken).not.toBe(claimedByA.claimToken);
    const beforeStale = await read(claimedByB.id);

    // A's stale rate-limit deferral would, on a live claim, push the row back
    // to `pending` and UN-CHARGE the claim-time attempt (the single most
    // important line in `deferForRateLimit`). Against B's live claim it must
    // not touch `status` or `attempts` at all.
    await expect(
      terminal.completeFailed(claimedByA, new RateLimitError('slow down'))
    ).resolves.toBe('claim-lost');

    const after = await read(claimedByB.id);
    expect(after).toEqual(beforeStale);
    expect(after.status).toBe('running');
    expect(after.attempts).toBe(beforeStale.attempts);
    expect(settledIds).toEqual([]);
  });

  // ===========================================================================
  // 5. A null claim token (a pre-#361 claim) settles fine on its own row, and
  //    is refused once a real re-claim has minted a real token over it.
  // ===========================================================================

  it('settles a null-claim-token row (a pre-#361 claim shape) normally', async () => {
    const type = nextType();
    const preLegacyClaim = await seed({
      type,
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      claimedByNodeId: null,
      claimToken: null,
      executor: 'server',
    });

    await expect(terminal.completeSucceeded(preLegacyClaim)).resolves.toBe('succeeded');

    const row = await read(preLegacyClaim.id);
    expect(row.status).toBe('succeeded');
    expect(settledIds).toEqual([preLegacyClaim.id]);
  });

  it('refuses a stale null-token settle once a real re-claim has minted a real token over the same row', async () => {
    const type = nextType();
    const preLegacyClaim = await seed({
      type,
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(5),
      // Never leased at all — the pre-#361/pre-lease-renewal shape — so the
      // reaper's clause 1 (aged, unleased) is what recovers it.
      leaseExpiresAt: null,
      claimedByNodeId: null,
      claimToken: null,
      executor: 'server',
    });

    await client.job.update({
      where: { id: preLegacyClaim.id },
      data: { startedAt: minutesAgo(THRESHOLD_MINUTES + 5) },
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(preLegacyClaim.id)).resolves.toMatchObject({
      status: 'pending',
      claimToken: null,
    });

    // A real re-claim mints a REAL, non-null token over the same row.
    const reclaimed = await claimOne(type);
    expect(reclaimed.id).toBe(preLegacyClaim.id);
    expect(reclaimed.claimToken).toEqual(expect.any(String));

    const beforeStale = await read(reclaimed.id);

    // The stale settle still carries the OLD, null-token identity — it must
    // not match the row the real claim now owns.
    await expect(terminal.completeSucceeded(preLegacyClaim)).resolves.toBe('claim-lost');

    const after = await read(reclaimed.id);
    expect(after).toEqual(beforeStale);
    expect(settledIds).toEqual([]);
  });

  // ===========================================================================
  // 6. The row is deleted out from under a settle: claim-lost, never a throw.
  // ===========================================================================

  it('answers claim-lost, without throwing, when the row is deleted before the settle lands', async () => {
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimed = await claimOne(type);

    await client.job.delete({ where: { id: claimed.id } });

    await expect(terminal.completeSucceeded(claimed)).resolves.toBe('claim-lost');
    expect(settledIds).toEqual([]);

    await expect(client.job.findUnique({ where: { id: claimed.id } })).resolves.toBeNull();
  });

  // ===========================================================================
  // 7. The ambiguous-commit path: the first write actually lands, then the
  //    connection reports failure on the way back. The retry must recognise
  //    its OWN write and answer `written`, not `claim-lost` — and must not
  //    double-emit.
  // ===========================================================================

  it('recognises its own committed-but-thrown first write on retry, and emits exactly once', async () => {
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimed = await claimOne(type);

    // A `PrismaService`-shaped stand-in whose `job.updateManyAndReturn`
    // performs the REAL write against the REAL database and only then
    // throws on its first call — the "connection dropped on the way back
    // after the commit" scenario `safeTerminalUpdate`'s ambiguous-commit
    // branch exists for. `JobTerminalService` touches nothing on `prisma`
    // besides `job.updateManyAndReturn` and `job.findUnique`, so this stand-in
    // needs no more than those two.
    let updateCalls = 0;
    const realJobDelegate = client.job;
    const flakyPrisma = {
      job: {
        updateManyAndReturn: async (
          args: Parameters<typeof realJobDelegate.updateManyAndReturn>[0]
        ) => {
          updateCalls += 1;
          const result = await realJobDelegate.updateManyAndReturn(args);

          if (updateCalls === 1) {
            throw new Error('simulated connection drop after commit');
          }

          return result;
        },
        findUnique: (args: Parameters<typeof realJobDelegate.findUnique>[0]) =>
          realJobDelegate.findUnique(args),
      },
    } as unknown as PrismaService;

    const config = stubConfig();
    const flakyTerminal = new JobTerminalService(
      flakyPrisma,
      config,
      new ProviderThrottleService(config),
      events,
      new JobHandlerRegistry()
    );

    await expect(flakyTerminal.completeSucceeded(claimed)).resolves.toBe('succeeded');

    // Two calls were made: the first committed-then-threw, the second
    // (guarded by the same `heldClaimWhere`) matched nothing because the
    // first already moved the row — and the ambiguous-commit re-read is what
    // turned that into `written` rather than a false `claim-lost`.
    expect(updateCalls).toBe(2);

    const row = await read(claimed.id);
    expect(row.status).toBe('succeeded');

    // Exactly one settlement, not two, despite two attempted writes.
    expect(settledIds).toEqual([claimed.id]);
  });
});
