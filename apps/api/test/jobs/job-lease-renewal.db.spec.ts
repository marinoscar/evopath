// =============================================================================
// Real-Postgres test: renewal and the reaper, against each other (issue #347,
// epic #345)
// =============================================================================
//
// THE TWO HALVES OF #347 ARE ONLY CORRECT TOGETHER, and that is precisely why
// this suite exists as a real-database one. `JobLeaseService` pushes
// `lease_expires_at` out while work is in flight; `stuckRunningWhere` decides
// which rows are abandoned. Each is testable in isolation with a mock — the
// service's predicate shape in `src/jobs/job-lease.service.spec.ts`, the
// reaper's clause list in `src/jobs/job-stuck.service.spec.ts` — and NEITHER
// mocked test can answer the only question that matters here:
//
//     does a row that was just renewed actually fall outside the `where` the
//     reaper is about to run?
//
// A mocked `updateMany` returns whatever the test told it to no matter what
// `where` it was handed, so a predicate that quietly matched nothing (or
// everything) would keep both unit suites green. Issue #346 shipped a claim
// bug that every mocked test in this repository passed; the lesson taken from
// it is this file.
//
// ⚠ THE SUITE DRIVES THE REAL SERVICES OVER REAL ROWS, never a hand-written
// `where`. Every case renews through `JobLeaseService` and sweeps through
// `JobStuckService.resetStuck`, so it is the shipped code path being asked,
// not a transcription of it.
//
// THIS IS A `*.db.spec.ts` FILE — see `db-test-support.ts` and
// `job-claim.db.spec.ts`'s header for the run/skip mechanics.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, PrismaClient } from '@prisma/client';

import { JobClaimService, ClaimOptions } from '../../src/jobs/job-claim.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobLeaseService } from '../../src/jobs/job-lease.service';
import { JobStuckService } from '../../src/jobs/job-stuck.service';
import { JobTerminalService } from '../../src/jobs/job-terminal.service';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { createDbClient, resolveDbSuite } from './db-test-support';

const { describeWithDb } = resolveDbSuite('job-lease-renewal.db.spec');

/** The stuck threshold every test in this suite runs with. */
const THRESHOLD_MINUTES = 30;

/** The attempt budget every test in this suite runs with. */
const MAX_ATTEMPTS = 3;

/**
 * The deployment-wide runtime ceiling this suite's config stub reports.
 *
 * IT DETERMINES THE LEASE HORIZON, so it is stated rather than defaulted. No
 * handler is registered, so the longest lease anything could ask for is
 * `JOB_TIMEOUT_MS + 60s grace`, and the horizon is that plus another 60s
 * grace — ten minutes and change. Every fixture below is written against that
 * number: a "live" lease sits well inside it, and the clause-4 fixture sits
 * far outside it.
 */
const JOB_TIMEOUT_MS = 600_000;

/** `resolveJobLeaseMs` with no profile: the ceiling plus one grace. */
const LEASE_MS = JOB_TIMEOUT_MS + 60_000;

/** `resolveLeaseHorizonMs`: the longest lease, plus one more grace. */
const HORIZON_MS = LEASE_MS + 60_000;

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

function stubConfig(): ConfigService {
  return {
    get: (key: string) =>
      key === 'jobs.maxAttempts'
        ? MAX_ATTEMPTS
        : key === 'jobs.jobTimeoutMs'
          ? JOB_TIMEOUT_MS
          : undefined,
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

describeWithDb('Lease renewal vs. the lease reaper (real Postgres)', () => {
  let client: PrismaClient;
  let leases: JobLeaseService;
  let stuck: JobStuckService;
  let claims: JobClaimService;
  let terminal: JobTerminalService;

  // The same per-process scoping discipline as the other queue suites: every
  // row this file creates carries a type prefixed with this, so cleanup
  // removes exactly this suite's rows from a database it shares with the
  // other `*.db.spec.ts` files (and, locally, with a developer's dev data).
  const TYPE_PREFIX = `test.lease.${process.pid}.`;
  let typeCounter = 0;
  const nextType = (): string => `${TYPE_PREFIX}${(typeCounter += 1)}`;

  // A real `WorkerNode` row, for the same reason `job-stuck-reset.db.spec.ts`
  // creates one: `jobs.claimed_by_node_id` is a real foreign key since #267,
  // and a nullable FK still enforces referential integrity for every non-NULL
  // value. A hand-invented UUID violates the constraint; a real-but-silent
  // node row is the correct fixture for "a node holds this job".
  const OWNER_EMAIL = `${TYPE_PREFIX}owner@example.test`;
  let ownerId: string;
  let nodeId: string;

  beforeAll(async () => {
    client = createDbClient();
    await client.$connect();

    leases = new JobLeaseService(client as unknown as PrismaService);
    stuck = new JobStuckService(
      client as unknown as PrismaService,
      stubConfig(),
      stubSystemSettings(),
      // Nothing registered: the single-budget, single-lease shape a
      // deployment with no execution profiles has. See `JOB_TIMEOUT_MS`.
      new JobHandlerRegistry(),
      new EventEmitter2()
    );
    // The REAL claim, so the token this suite renews against is one
    // `gen_random_uuid()` actually minted — not a hand-set column value that
    // would prove nothing about the statement in `job-claim.service.ts`.
    claims = new JobClaimService(client as unknown as PrismaService);
    // The REAL terminal service, so "a settled row carries no claim token"
    // is driven through the shipped settle path rather than a raw UPDATE.
    terminal = new JobTerminalService(
      client as unknown as PrismaService,
      stubConfig(),
      new ProviderThrottleService(stubConfig()),
      new EventEmitter2(),
      new JobHandlerRegistry()
    );

    const owner = await client.user.create({
      data: { email: OWNER_EMAIL, displayName: 'job-lease-renewal suite' },
    });
    ownerId = owner.id;

    const node = await client.workerNode.create({
      data: {
        name: `${TYPE_PREFIX}node`,
        hostname: 'job-lease-renewal-suite-box',
        platform: 'linux-x64',
        cliVersion: '0.0.0-test',
        eligibleTypes: [],
        concurrency: 1,
        createdById: ownerId,
      },
    });
    nodeId = node.id;
  });

  afterEach(async () => {
    await client.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
  });

  afterAll(async () => {
    // Jobs before the node before the owner: `jobs.claimed_by_node_id` FKs to
    // `worker_nodes`, which FKs to `users`.
    await client?.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
    await client?.workerNode.deleteMany({ where: { name: { startsWith: TYPE_PREFIX } } });
    await client?.user.deleteMany({ where: { email: OWNER_EMAIL } });
    await client?.$disconnect();
  });

  async function seed(data: Omit<Prisma.JobUncheckedCreateInput, 'reason'>): Promise<string> {
    const row = await client.job.create({
      data: { reason: 'backfill', ...data } as Prisma.JobUncheckedCreateInput,
    });

    return row.id;
  }

  const read = (id: string) => client.job.findUniqueOrThrow({ where: { id } });

  // ===========================================================================
  // The headline claim: renewal keeps a job safe at ANY age
  // ===========================================================================

  it('never requeues a continuously renewed job, however long it has run', async () => {
    // THE WHOLE POINT OF #347. This row started TWO DAYS ago — sixty-odd
    // times the 30-minute stuck threshold — and the only thing keeping it
    // safe is that its executor keeps renewing. Before this issue the age
    // clause matched it outright and a second executor was handed the same
    // work; the database-backup case that motivated the issue is precisely
    // this row.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(48 * 60),
      createdAt: minutesAgo(48 * 60),
      // A live lease, which is the ONLY thing standing between this row and
      // the reaper. That the same shape WITHOUT one is reaped on age is the
      // "still reaps an aged row whose lease was NEVER written" case below —
      // together the two say age still counts, but only where there is no
      // lease to count instead.
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      claimedByNodeId: null,
      executor: 'server',
    });

    // Ten sweeps, each after another renewal — a long job is not one sweep's
    // worth of luck.
    for (let round = 0; round < 10; round += 1) {
      await expect(leases.renew(id, LEASE_MS, { nodeId: null })).resolves.toBe(true);
      await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
    }

    await expect(read(id)).resolves.toMatchObject({ status: 'running', attempts: 1 });
  });

  it('reaps that same job the moment renewal stops', async () => {
    // The other side of the claim above: the row is not immune, it is
    // PROTECTED BY EVIDENCE it keeps producing. Stop producing it and the
    // dead-owner clause takes the row immediately, without waiting out the
    // threshold.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(48 * 60),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });

    // The executor died here: the lease is allowed to lapse.
    await client.job.update({
      where: { id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  // ===========================================================================
  // The signals the narrowing had to preserve
  // ===========================================================================

  it('still reaps an aged row whose lease was NEVER written', async () => {
    // The load-bearing half of the old signal 1: a fork's own claim path, a
    // row hand-inserted by an operator, a migration that pre-dates leases.
    // Nothing renews such a row because nothing leased it, so age is the only
    // evidence available and it must still count.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 5),
      leaseExpiresAt: null,
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('still reaps a zombie: running, never stamped, never leased', async () => {
    // `NULL < threshold` is NULL rather than false, so this row is invisible
    // to every other clause. Without the `createdAt` arm it sits `running`
    // forever and holds its dedup key with it — and no TypeScript type
    // notices, which is why this assertion lives against a real server.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: null,
      leaseExpiresAt: null,
      createdAt: minutesAgo(THRESHOLD_MINUTES + 5),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('reaps an expired lease immediately, without waiting out the threshold', async () => {
    // Seconds old, so no age clause can reach it. The only thing wrong with
    // this row is that whoever claimed it promised to renew and did not —
    // the lid-closing laptop.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() - 1_000),
      claimedByNodeId: nodeId,
      executor: 'node',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('reaps a thirty-day lease by the implausible-lease clause', async () => {
    // Clause 4, and the reason narrowing clauses 1 and 2 did not open a gap.
    // No handler in this process could ask for a lease past `HORIZON_MS`, so
    // a lease a month out is not a live executor's promise however recently
    // the row started. Nothing else can match: the lease is neither absent
    // nor expired, and `startedAt` is now.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('leaves a lease just inside the horizon alone', async () => {
    // The boundary from the safe side, so clause 4 cannot be tightened into
    // reaping ordinary rows without this failing. A lease of exactly
    // `LEASE_MS` is what every claim in this deployment writes.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'running' });
  });

  // ===========================================================================
  // What renewal itself will and will not do
  // ===========================================================================

  it('refuses to renew a lease that has already expired', async () => {
    // THE GUARD THE WHOLE SERVICE EXISTS FOR. Past the expiry the reaper is
    // entitled to requeue the row and another executor to claim it, so a late
    // renewal is a claim about ownership that may already be false.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(5),
      leaseExpiresAt: new Date(Date.now() - 1_000),
      executor: 'server',
    });

    await expect(leases.renew(id, LEASE_MS, { nodeId: null })).resolves.toBe(false);

    const row = await read(id);
    expect(row.leaseExpiresAt?.getTime()).toBeLessThan(Date.now());
  });

  it('refuses to renew a row the reaper has already requeued', async () => {
    // The sequence a slow worker really lives through: it was running, the
    // sweep took the row, and its next tick arrives afterwards. `false` is
    // the answer, and the row must be left exactly as the reaper left it —
    // a renewal landing here would put a `pending` row back under a lease
    // nobody holds.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 5),
      leaseExpiresAt: minutesAgo(1),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1 });
    await expect(leases.renew(id, LEASE_MS, { nodeId: null })).resolves.toBe(false);

    await expect(read(id)).resolves.toMatchObject({
      status: 'pending',
      leaseExpiresAt: null,
    });
  });

  it('refuses a server renewal on a row a NODE now holds', async () => {
    // The in-process worker renews with `nodeId: null`, which is not "no
    // constraint" — it is "this row must be held by no node". If the reaper
    // requeued the row and a node claimed it, the old worker's renewals stop
    // landing, which is exactly right.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      claimedByNodeId: nodeId,
      executor: 'node',
    });

    await expect(leases.renew(id, LEASE_MS, { nodeId: null })).resolves.toBe(false);
    // ...while the node that actually holds it renews fine.
    await expect(leases.renew(id, LEASE_MS, { nodeId })).resolves.toBe(true);
  });

  it('refuses to renew a settled row', async () => {
    const id = await seed({
      type: nextType(),
      status: 'succeeded',
      attempts: 1,
      startedAt: minutesAgo(5),
      finishedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      executor: 'server',
    });

    await expect(leases.renew(id, LEASE_MS, { nodeId: null })).resolves.toBe(false);
    await expect(read(id)).resolves.toMatchObject({ status: 'succeeded' });
  });

  // ===========================================================================
  // The per-claim token (issue #361)
  // ===========================================================================
  //
  // Every case above renews with `{ nodeId: null }` alone, which is exactly
  // what let #361 happen: every API replica claims with `claimedByNodeId:
  // null`, so `heldLeaseWhere` could not tell replica A's claim of a row from
  // replica B's later claim of the SAME row. These cases drive a real claim,
  // a real reap, and a real re-claim through the actual services, and check
  // that `jobs.claim_token` is what finally tells the two apart.

  it('refuses a server renewal on a row ANOTHER SERVER REPLICA has since claimed', async () => {
    // THE #361 REGRESSION ITSELF. Replica A claims the row; A stalls past its
    // lease; the reaper requeues it; replica B claims it; A's renewal ticker
    // fires anyway, carrying A's OLD claim's identity. Before this issue that
    // renewal would land on B's claim and A would never learn it had lost the
    // row — which is precisely the "extends the wrong replica's lease" defect
    // #361 closes.
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimOptions: ClaimOptions = {
      nodeId: null,
      executor: 'server',
      eligibleTypes: [type],
      limit: 1,
      leases: [{ type, leaseMs: LEASE_MS }],
    };

    // Replica A's claim.
    const [claimedByA] = await claims.claim(claimOptions);
    expect(claimedByA).toBeDefined();
    expect(claimedByA.claimToken).toEqual(expect.any(String));

    // A stalls: its lease lapses, and the REAL reaper — not a hand-written
    // UPDATE — puts the row back to `pending`. This is also what pins that
    // the reaper clears `claim_token` on the way (see the dedicated case
    // below): if it didn't, B's claim overwriting a stale token would still
    // happen to prove the same thing for the wrong reason.
    await client.job.update({
      where: { id: claimedByA.id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });
    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });

    // Replica B's claim of the SAME row.
    const [claimedByB] = await claims.claim(claimOptions);
    expect(claimedByB.id).toBe(claimedByA.id);
    expect(claimedByB.claimToken).toEqual(expect.any(String));

    // THE PROPERTY THE WHOLE FIX RESTS ON: two claims of one row, two
    // different tokens.
    expect(claimedByB.claimToken).not.toBe(claimedByA.claimToken);

    // ⚠ WITHOUT THE TOKEN, EVERY ONE OF THE STEPS BELOW IS IDENTICAL FOR A AND
    // B: same job id, same `status: 'running'`, same `claimedByNodeId: null`
    // (both replicas are the server, neither is a node). The pre-#361 `where`
    // — `{ id, status: 'running', leaseExpiresAt: { gt: now }, claimedByNodeId:
    // null }` — could not distinguish A's stale renewal from a legitimate one
    // and would have returned `true` here, extending B's lease under A's dead
    // ticker. That is the bug this test exists to keep dead.
    const beforeStaleRenewal = await read(claimedByA.id);

    await expect(
      leases.renew(claimedByA.id, LEASE_MS, {
        nodeId: null,
        claimToken: claimedByA.claimToken,
      })
    ).resolves.toBe(false);

    // THE LEASE MUST BE EXACTLY UNCHANGED — a `false` with the lease moved
    // anyway would be the bug wearing a passing test.
    const afterStaleRenewal = await read(claimedByA.id);
    expect(afterStaleRenewal.leaseExpiresAt?.getTime()).toBe(
      beforeStaleRenewal.leaseExpiresAt?.getTime()
    );

    // ...while B's OWN renewal, carrying B's own token, still lands. The guard
    // must refuse the stale claimant without refusing the legitimate one.
    await expect(
      leases.renew(claimedByB.id, LEASE_MS, {
        nodeId: null,
        claimToken: claimedByB.claimToken,
      })
    ).resolves.toBe(true);

    const afterLiveRenewal = await read(claimedByB.id);
    expect(afterLiveRenewal.leaseExpiresAt?.getTime()).toBeGreaterThan(
      afterStaleRenewal.leaseExpiresAt?.getTime() as number
    );
  });

  it('drops replica A’s stale settle too, once replica B holds the claim (#477)', async () => {
    // THE SAME #361 SEQUENCE AS THE TEST ABOVE, but instead of asking whether
    // A can still RENEW, this asks whether A can still SETTLE — the question
    // #477 answers. `JobTerminalService.completeSucceeded` writes through
    // `heldClaimWhere(job)`, which carries no lease clause at all (unlike
    // `heldLeaseWhere` above), so this is a genuinely different guard being
    // exercised against the same real claim/reap/reclaim sequence.
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimOptions: ClaimOptions = {
      nodeId: null,
      executor: 'server',
      eligibleTypes: [type],
      limit: 1,
      leases: [{ type, leaseMs: LEASE_MS }],
    };

    const [claimedByA] = await claims.claim(claimOptions);

    await client.job.update({
      where: { id: claimedByA.id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });
    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });

    const [claimedByB] = await claims.claim(claimOptions);
    expect(claimedByB.claimToken).not.toBe(claimedByA.claimToken);

    const beforeStaleSettle = await read(claimedByB.id);

    // Replica A finally reports back — long after it lost the row — with the
    // stale claim it was originally handed.
    await expect(terminal.completeSucceeded(claimedByA)).resolves.toBe('claim-lost');

    // B's row must be byte-for-byte unchanged: A's stale conclusion must not
    // mark B's still-running job `succeeded` out from under it.
    const afterStaleSettle = await read(claimedByB.id);
    expect(afterStaleSettle).toEqual(beforeStaleSettle);
    expect(afterStaleSettle.status).toBe('running');

    // ...while B's own, current claim still settles normally.
    await expect(terminal.completeSucceeded(claimedByB)).resolves.toBe('succeeded');
    await expect(read(claimedByB.id)).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('a worker that reclaims the same row cannot renew with its previous claim’s token', async () => {
    // THE CASE THAT JUSTIFIES MINTING PER ROW RATHER THAN PER PROCESS. If the
    // token identified the CLAIMING PROCESS instead of the claim, one worker
    // reclaiming its own abandoned row after being reaped would carry the SAME
    // token across both runs and be unable to tell its current claim from its
    // previous, already-superseded one — reproducing #361 one process short of
    // it, with a single claimer and nobody else involved.
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimOptions: ClaimOptions = {
      nodeId: null,
      executor: 'server',
      eligibleTypes: [type],
      limit: 1,
      leases: [{ type, leaseMs: LEASE_MS }],
    };

    const [firstClaim] = await claims.claim(claimOptions);
    const firstToken = firstClaim.claimToken;

    await client.job.update({
      where: { id: firstClaim.id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });
    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });

    const [secondClaim] = await claims.claim(claimOptions);
    const secondToken = secondClaim.claimToken;

    expect(secondToken).not.toBe(firstToken);

    // The FIRST claim's token no longer renews anything...
    await expect(
      leases.renew(firstClaim.id, LEASE_MS, { nodeId: null, claimToken: firstToken })
    ).resolves.toBe(false);

    // ...while the SECOND claim's does, over the very same row.
    await expect(
      leases.renew(secondClaim.id, LEASE_MS, { nodeId: null, claimToken: secondToken })
    ).resolves.toBe(true);
  });

  it('a NODE that reclaims the same row cannot renew with its previous claim’s token (#364)', async () => {
    // THE HEADLINE CASE #364 CLOSES, in the same shape as the case just
    // above — but this is the one issue #364 is actually about. The case
    // above proves the token per se; this one proves it for `claimedByNodeId`
    // specifically, which is the identifier that CANNOT tell a node's two
    // slots apart on its own (unlike the server's `nodeId: null`, which #361
    // already covers). A worker node claims job J into slot 1, slot 1 stalls
    // past its lease, the REAL reaper requeues J, the SAME node re-claims J
    // into slot 2 — and slot 1's renewal ticker is still alive, still
    // quoting slot 1's OLD token. Before #364, `heldLeaseWhere`'s
    // `claimedByNodeId` condition alone could not distinguish slot 1's stale
    // renewal from slot 2's legitimate one, because both name the SAME node.
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const claimOptions: ClaimOptions = {
      nodeId,
      executor: 'node',
      eligibleTypes: [type],
      limit: 1,
      leases: [{ type, leaseMs: LEASE_MS }],
    };

    // Slot 1: the node's first, real claim.
    const [firstClaim] = await claims.claim(claimOptions);
    const firstToken = firstClaim.claimToken;
    expect(firstClaim.claimedByNodeId).toBe(nodeId);

    // Slot 1 stalls: its lease lapses, and the REAL reaper — not a
    // hand-written `UPDATE` — puts the row back to `pending`.
    await client.job.update({
      where: { id: firstClaim.id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });
    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });

    // Slot 2: the SAME node re-claims the SAME row.
    const [secondClaim] = await claims.claim(claimOptions);
    expect(secondClaim.id).toBe(firstClaim.id);
    expect(secondClaim.claimedByNodeId).toBe(nodeId);
    const secondToken = secondClaim.claimToken;

    // THE PROPERTY THE WHOLE FIX RESTS ON: two claims of one row, by the
    // SAME node, carry two DIFFERENT tokens.
    expect(secondToken).not.toBe(firstToken);

    // ⚠ WITHOUT THE TOKEN, THESE TWO RENEWALS ARE INDISTINGUISHABLE: same job
    // id, same `claimedByNodeId: nodeId`, same `status: 'running'`. The
    // pre-#364 `where` would have extended slot 1's dead ticker as happily as
    // slot 2's live one.
    const beforeStaleRenewal = await read(firstClaim.id);

    // Slot 1's stale token no longer renews anything...
    await expect(
      leases.renew(firstClaim.id, LEASE_MS, { nodeId, claimToken: firstToken })
    ).resolves.toBe(false);

    // THE LEASE MUST BE EXACTLY UNCHANGED — a `false` with the lease moved
    // anyway would be the bug wearing a passing test.
    const afterStaleRenewal = await read(firstClaim.id);
    expect(afterStaleRenewal.leaseExpiresAt?.getTime()).toBe(
      beforeStaleRenewal.leaseExpiresAt?.getTime()
    );

    // ...while slot 2's own, CURRENT token still lands, over the very same
    // row. The guard must refuse the stale slot without refusing the
    // legitimate one.
    await expect(
      leases.renew(secondClaim.id, LEASE_MS, { nodeId, claimToken: secondToken })
    ).resolves.toBe(true);

    const afterLiveRenewal = await read(secondClaim.id);
    expect(afterLiveRenewal.leaseExpiresAt?.getTime()).toBeGreaterThan(
      afterStaleRenewal.leaseExpiresAt?.getTime() as number
    );
  });

  it('the reaper leaves no claim token on a row it requeues', async () => {
    // `claim_token IS NOT NULL` iff the row is currently claimed. A row the
    // reaper hands back to `pending` is claimed by nobody, and a stray token
    // left behind would be exactly the kind of stale identity that let #361
    // happen in the first place — a value that still LOOKS like an active
    // claim after the claim it named is over.
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const [claimed] = await claims.claim({
      nodeId: null,
      executor: 'server',
      eligibleTypes: [type],
      limit: 1,
      leases: [{ type, leaseMs: LEASE_MS }],
    });
    expect(claimed.claimToken).toEqual(expect.any(String));

    await client.job.update({
      where: { id: claimed.id },
      data: { leaseExpiresAt: minutesAgo(1) },
    });
    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });

    await expect(read(claimed.id)).resolves.toMatchObject({
      status: 'pending',
      claimToken: null,
    });
  });

  it('a settled row carries no claim token', async () => {
    // The other half of the same invariant, driven through the REAL settle
    // chokepoint (`JobTerminalService`) rather than a raw UPDATE: a
    // `succeeded` row is exactly as un-claimed as a `pending` one, even though
    // — unlike the reap above — `executor` survives on this path.
    const type = nextType();
    await client.job.create({ data: { type, reason: 'backfill' } });

    const [claimed] = await claims.claim({
      nodeId: null,
      executor: 'server',
      eligibleTypes: [type],
      limit: 1,
      leases: [{ type, leaseMs: LEASE_MS }],
    });
    expect(claimed.claimToken).toEqual(expect.any(String));

    await expect(terminal.completeSucceeded(claimed)).resolves.toBe('succeeded');

    await expect(read(claimed.id)).resolves.toMatchObject({
      status: 'succeeded',
      claimToken: null,
    });
  });

  it('writes a lease the reaper then reads as live', async () => {
    // The round trip stated as one assertion: the instant `renew` persists is
    // the instant `stuckRunningWhere` compares against. Two `Date`s that
    // agree in TypeScript and disagree after a timezone-naive column write
    // would fail here and nowhere else.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 5),
      // Live, but only just: a renewal must land BEFORE the expiry (see
      // `heldLeaseWhere`), so a row on the brink is the honest fixture for
      // "the ticker got there in time".
      leaseExpiresAt: new Date(Date.now() + 2_000),
      executor: 'server',
    });

    const before = Date.now();
    await expect(leases.renew(id, LEASE_MS, { nodeId: null })).resolves.toBe(true);

    const row = await read(id);
    expect(row.leaseExpiresAt?.getTime()).toBeGreaterThanOrEqual(before + LEASE_MS - 1);
    // ...and strictly inside the horizon, or clause 4 would take it back.
    expect(row.leaseExpiresAt?.getTime()).toBeLessThan(Date.now() + HORIZON_MS);

    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
  });
});
