// =============================================================================
// Real-Postgres test: the lease reaper's four recovery signals (issue #263,
// epic #254; re-cut by #347)
// =============================================================================
//
// `stuckRunningWhere` is a claim about WHICH ROWS POSTGRES MATCHES, and a mock
// cannot make that claim: a mocked `updateMany` returns whatever the test told
// it to no matter what `where` it was handed, so a unit test can only assert
// the shape of an object. That is worth doing (and
// `src/jobs/job-stuck.service.spec.ts` does it), but it would keep passing if
// a signal quietly matched nothing — which is exactly how the zombie clause
// would break, since `NULL < threshold` is NULL rather than false and no
// TypeScript type notices.
//
// So this suite builds each stuck shape as a real row and asks the real
// service, one signal at a time, with the others deliberately unable to fire.
//
// ⚠ SINCE #347 THE AGE SIGNALS ONLY LOOK AT UNLEASED ROWS, and several
// fixtures below changed to say so. A `running` row carrying a LIVE lease is
// a job whose executor is renewing on schedule, and reaping it was the defect
// that issue fixed — so the cases that used to stage "aged, but leased" now
// either drop the lease (they are about age) or assert the row is left alone
// (they are about renewal). The lease horizon that clause 4 judges against is
// derived from this suite's own config stub: no profile and no
// `jobs.jobTimeoutMs` means the 600s default, a 660s lease, and a horizon of
// 720s — so a fixture wanting a plausible live lease must stay well inside
// twelve minutes, and one wanting to trip clause 4 must be far outside it.
//
// THIS IS A `*.db.spec.ts` FILE — see `db-test-support.ts` and
// `job-claim.db.spec.ts`'s header for the run/skip mechanics.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, PrismaClient } from '@prisma/client';

import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../src/jobs/events/job-settled.event';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobStuckService } from '../../src/jobs/job-stuck.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { createDbClient, resolveDbSuite } from './db-test-support';

const { describeWithDb } = resolveDbSuite('job-stuck-reset.db.spec');

/** The stuck threshold every test in this suite runs with. */
const THRESHOLD_MINUTES = 30;

/** The attempt budget every test in this suite runs with. */
const MAX_ATTEMPTS = 3;

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

/**
 * The real service over a bare client, with the two collaborators it does not
 * exercise here stubbed: the settings row belongs to the application rather
 * than to this suite, so the threshold is stated explicitly instead of being
 * read out of (and possibly written into) a shared database.
 */
function stuckServiceFor(client: PrismaClient, events: EventEmitter2 = new EventEmitter2()): JobStuckService {
  const config = {
    get: (key: string) => (key === 'jobs.maxAttempts' ? MAX_ATTEMPTS : undefined),
  } as unknown as ConfigService;

  const systemSettings = {
    getJobsPolicy: async () => ({
      history: { retentionDays: 30, purgeEnabled: true },
      stuckThresholdMinutes: THRESHOLD_MINUTES,
    }),
  } as unknown as SystemSettingsService;

  return new JobStuckService(
    client as unknown as PrismaService,
    config,
    systemSettings,
    // No handler registered means no execution profile anywhere, which is the
    // single-budget shape the reaper has always had (#346).
    new JobHandlerRegistry(),
    events
  );
}

/** An `EventEmitter2` plus every `JobSettledEvent` it has dispatched, in order (#468). */
function collectingEmitter(): { emitter: EventEmitter2; events: JobSettledEvent[] } {
  const emitter = new EventEmitter2();
  const events: JobSettledEvent[] = [];
  emitter.on(JOB_SETTLED_EVENT, (event: JobSettledEvent) => events.push(event));
  return { emitter, events };
}

describeWithDb('JobStuckService.resetStuck (real Postgres)', () => {
  let client: PrismaClient;
  let stuck: JobStuckService;

  // The same per-process scoping discipline as the other queue suites: every
  // row this file creates carries a type prefixed with this, so cleanup
  // removes exactly this suite's rows from a database it shares with the
  // other `*.db.spec.ts` files (and, locally, with a developer's dev data).
  const TYPE_PREFIX = `test.stuck.${process.pid}.`;
  let typeCounter = 0;
  const nextType = (): string => `${TYPE_PREFIX}${(typeCounter += 1)}`;

  // Two real `WorkerNode` rows (not one) — see the `seed()` comment below for
  // why a real row is required at all. Two distinct ids because the "DEAD
  // OWNER" test and the "requeues ... with its claim ... released" test each
  // stage a job claimed by its OWN dead node; sharing one row would still
  // pass, but it would blur the fact that these are two independent node
  // failures, not the same node twice.
  const OWNER_EMAIL = `${TYPE_PREFIX}owner@example.test`;
  let ownerId: string;
  let deadOwnerNodeId: string;
  let requeuedNodeId: string;

  beforeAll(async () => {
    client = createDbClient();
    await client.$connect();
    stuck = stuckServiceFor(client);

    const owner = await client.user.create({
      data: { email: OWNER_EMAIL, displayName: 'job-stuck-reset suite' },
    });
    ownerId = owner.id;

    const [deadOwnerNode, requeuedNode] = await Promise.all([
      client.workerNode.create({
        data: {
          name: `${TYPE_PREFIX}dead-owner-node`,
          hostname: 'job-stuck-reset-suite-box',
          platform: 'linux-x64',
          cliVersion: '0.0.0-test',
          eligibleTypes: [],
          concurrency: 1,
          createdById: ownerId,
        },
      }),
      client.workerNode.create({
        data: {
          name: `${TYPE_PREFIX}requeued-node`,
          hostname: 'job-stuck-reset-suite-box',
          platform: 'linux-x64',
          cliVersion: '0.0.0-test',
          eligibleTypes: [],
          concurrency: 1,
          createdById: ownerId,
        },
      }),
    ]);
    deadOwnerNodeId = deadOwnerNode.id;
    requeuedNodeId = requeuedNode.id;
  });

  afterEach(async () => {
    await client.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
  });

  afterAll(async () => {
    // Jobs before the nodes before the owner: `jobs.claimed_by_node_id` FKs
    // to `worker_nodes`, which FKs to `users` — the reverse order would trip
    // the very constraint these fixtures exist to satisfy.
    await client?.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
    await client?.workerNode.deleteMany({ where: { name: { startsWith: TYPE_PREFIX } } });
    await client?.user.deleteMany({ where: { email: OWNER_EMAIL } });
    await client?.$disconnect();
  });

  /**
   * Inserts one row and returns its id.
   *
   * WHY THE *Unchecked* CREATE INPUT. Several cases below seed
   * `claimedByNodeId` directly — a raw foreign-key scalar — to stage a job
   * that a node was holding when it died. Since #267 wired
   * `Job.claimedByNode` as a real relation, Prisma's *Checked*
   * `JobCreateInput` no longer exposes that scalar at all; it exposes only
   * `claimedByNode: { connect: ... }`, so `Unchecked` — Prisma's own name for
   * "I am writing the foreign key myself" — is still the right input type for
   * these fixtures to use.
   *
   * WHAT IS **NOT** TRUE, though this file used to say it: "the FK is
   * nullable so a NULL stays legal" does NOT license writing a non-null,
   * made-up UUID here. A nullable foreign key still enforces referential
   * integrity for every non-NULL value — Postgres does not special-case
   * "the column merely happens to be nullable" — so a hand-invented id such
   * as `'11111111-1111-4111-8111-111111111111'` violates
   * `jobs_claimed_by_node_id_fkey` exactly as any other dangling reference
   * would. That mistaken reasoning is precisely what left this suite RED on
   * `main` from #267 until this fix: every case below that sets
   * `claimedByNodeId` now points at `deadOwnerNodeId` or `requeuedNodeId`, a
   * real `WorkerNode` row created in `beforeAll` — never a literal string.
   * The row deliberately never heartbeats, which is exactly right: the point
   * of these cases is a job whose owning node is dead or has let its lease
   * expire, not one that is healthy, so a real-but-silent node row is the
   * correct fixture, not a contradiction of it. Do not go back to a literal
   * UUID here; if a new case needs a node id, create (or reuse) a real
   * `WorkerNode` row instead.
   */
  async function seed(data: Omit<Prisma.JobUncheckedCreateInput, 'reason'>): Promise<string> {
    const row = await client.job.create({
      data: { reason: 'backfill', ...data } as Prisma.JobUncheckedCreateInput,
    });

    return row.id;
  }

  const read = (id: string) => client.job.findUniqueOrThrow({ where: { id } });

  // ===========================================================================
  // Each of the three signals, independently
  // ===========================================================================

  it('reclaims an AGED, UNLEASED claim: startedAt old, lease never written', async () => {
    // Signal 1 alone, and #347 narrowed it to exactly this row: `startedAt`
    // is set and old, and there is NO lease at all — a fork's own claim path,
    // a row hand-inserted by an operator, a migration that pre-dates leases.
    // Nothing about such a row says when its owner promised to be back, so
    // age is the only evidence there is. (Signal 2 cannot match, `startedAt`
    // is present; signals 3 and 4 cannot, there is no lease to compare.)
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 5),
      leaseExpiresAt: null,
      claimedByNodeId: null,
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('NEVER reclaims an aged claim whose lease is live — the #347 defect', async () => {
    // THE REGRESSION THIS WHOLE ISSUE IS ABOUT, staged as a row rather than
    // as a predicate. Before #347 this job — running for well over the
    // threshold, with a lease its executor is plainly still extending — was
    // requeued, a second executor claimed it, and the same work ran twice
    // concurrently. For a database backup that is two `pg_dump`s streaming
    // into one storage key, both exiting 0, and an unrestorable archive with
    // no error anywhere.
    //
    // The age is deliberately absurd: no threshold, however small, may
    // outrank a live lease.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(24 * 60),
      // Inside the horizon (720s) — this is what a renewal has just written.
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      claimedByNodeId: null,
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
    // ...and not even when an operator asks for an aggressive threshold.
    await expect(stuck.resetStuck(1)).resolves.toEqual({ reset: 0, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'running' });
  });

  it('reclaims an IMPLAUSIBLE lease: further out than any handler could ask for', async () => {
    // Signal 4 alone, and the clause that replaces the protection #347
    // dropped. A thirty-day lease is not expired (signal 3 misses it) and is
    // not absent (signals 1 and 2 miss it), so before clause 4 this row —
    // written by a clock jump, a fork's claim path multiplying instead of
    // adding, or a hostile write — would sit `running` forever and hold its
    // dedup key with it. `startedAt` is recent, so nothing else can be what
    // matched.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      claimedByNodeId: null,
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('reclaims a ZOMBIE: running with no startedAt, aged by createdAt', async () => {
    // Signal 2 alone, and the one a mock cannot catch. `startedAt` is NULL,
    // so signal 1's comparison is NULL (never true); `leaseExpiresAt` is NULL
    // too, so signal 3 cannot fire either. If this row comes back, the
    // `createdAt` arm is the only thing that could have matched it — and
    // without that arm the row would sit `running` forever, holding its dedup
    // key with it.
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

  it('reclaims a DEAD OWNER: an expired lease, however recently the job started', async () => {
    // Signal 3 alone: the job started seconds ago, so it is nowhere near the
    // stuck threshold — the only thing wrong with it is that whoever claimed
    // it promised to renew the lease and did not. This is the node-fleet
    // case: a laptop that closed its lid mid-job.
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
      leaseExpiresAt: minutesAgo(1),
      claimedByNodeId: deadOwnerNodeId,
      executor: 'node',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  it('leaves a healthy running job alone: young, stamped, and holding a live lease', async () => {
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(1),
      // Well inside the 720s horizon: a lease a live executor could actually
      // have been granted, which is the whole of what clause 4 asks.
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'running' });
  });

  it('never touches a pending, succeeded or failed row, however old', async () => {
    const ancient = minutesAgo(60 * 24 * 30);
    const ids = await Promise.all(
      (['pending', 'succeeded', 'failed'] as const).map((status) =>
        seed({
          type: nextType(),
          status,
          attempts: 9,
          createdAt: ancient,
          startedAt: status === 'pending' ? null : ancient,
          finishedAt: status === 'pending' ? null : ancient,
        })
      )
    );

    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });

    const rows = await client.job.findMany({ where: { id: { in: ids } } });
    expect(rows.map((row) => row.status).sort()).toEqual(['failed', 'pending', 'succeeded']);
  });

  // ===========================================================================
  // The two phases
  // ===========================================================================

  it('requeues a row under the cap with its claim, lease and executor released', async () => {
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: MAX_ATTEMPTS - 1,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 1),
      leaseExpiresAt: minutesAgo(1),
      claimedByNodeId: requeuedNodeId,
      executor: 'node',
      finishedAt: null,
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });

    const row = await read(id);

    expect(row.status).toBe('pending');
    expect(row.claimedByNodeId).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.executor).toBeNull();
    expect(row.scheduledFor).toBeNull();
    // Eligible again, and its already-charged attempt is left exactly as it
    // was: the attempt genuinely happened.
    expect(row.attempts).toBe(MAX_ATTEMPTS - 1);
    expect(row.lastError).toContain('lease reaper');
  });

  it('fails a row at the cap, with its own attempt count in the message', async () => {
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: MAX_ATTEMPTS,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 1),
      executor: 'server',
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ reset: 0, failed: 1 });

    const row = await read(id);

    expect(row.status).toBe('failed');
    expect(row.finishedAt).not.toBeNull();
    expect(row.claimedByNodeId).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    // Kept on a terminal row, exactly as `JobTerminalService` keeps it: which
    // side the job died on is worth knowing later.
    expect(row.executor).toBe('server');
    expect(row.lastError).toContain(`after ${MAX_ATTEMPTS} attempt(s)`);
  });

  it('fails a row OVER the cap too, so a raised budget cannot strand old rows', async () => {
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: MAX_ATTEMPTS + 4,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 1),
    });

    await expect(stuck.resetStuck()).resolves.toMatchObject({ failed: 1 });
    await expect(read(id)).resolves.toMatchObject({ status: 'failed' });
  });

  it('splits a mixed sweep between the two phases in one pass', async () => {
    const type = nextType();
    const doomed = await seed({
      type,
      status: 'running',
      attempts: MAX_ATTEMPTS,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 1),
    });
    const retryable = await seed({
      type,
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 1),
    });

    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 1, failed: 1 });
    await expect(read(doomed)).resolves.toMatchObject({ status: 'failed' });
    await expect(read(retryable)).resolves.toMatchObject({ status: 'pending' });
  });

  it('is idempotent: a second sweep finds nothing left to do, and emits nothing (#468)', async () => {
    // The reaper runs every ten minutes forever, and two replicas may sweep
    // at once. A second pass over rows it has already reclaimed must be a
    // no-op rather than, say, re-failing a job it just requeued — and must
    // not re-announce a settlement that never happened on this row (it was
    // only ever requeued, never failed).
    const { emitter, events } = collectingEmitter();
    const instrumented = stuckServiceFor(client, emitter);

    await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(THRESHOLD_MINUTES + 1),
    });

    await expect(instrumented.resetStuck()).resolves.toEqual({ reset: 1, failed: 0 });
    await expect(instrumented.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
    expect(events).toHaveLength(0);
  });

  it('honours an explicit threshold, so an operator can reclaim more aggressively', async () => {
    const id = await seed({
      type: nextType(),
      status: 'running',
      attempts: 1,
      startedAt: minutesAgo(5),
      // UNLEASED, since #347: the threshold is what governs an aged claim, and
      // an aged claim is by definition one with no lease to judge it by. A
      // fixture carrying a live lease here would be testing nothing — no
      // threshold reaches a leased row any more.
      leaseExpiresAt: null,
    });

    // Five minutes old: untouched at the configured 30-minute threshold...
    await expect(stuck.resetStuck()).resolves.toEqual({ reset: 0, failed: 0 });
    // ...and reclaimed when the caller says two.
    await expect(stuck.resetStuck(2)).resolves.toMatchObject({ reset: 1 });
    await expect(read(id)).resolves.toMatchObject({ status: 'pending' });
  });

  // ===========================================================================
  // The give-up is a settlement, so it is announced (#468)
  // ===========================================================================
  //
  // `job-stuck.service.spec.ts` proves the SHAPE of the emit (once per row
  // `updateManyAndReturn` actually changed, the exact row object, contained
  // against a throwing listener) against mocks. What only a real database can
  // prove is the CLAIM the file header above makes about exactly-once-across-
  // replicas: that two concurrent reapers racing the same exhausted row
  // really do serialize on Postgres's own row lock, and that only the one
  // whose `UPDATE ... RETURNING` actually changed the row ever calls
  // `events.emit`.
  describe('JOB_SETTLED_EVENT on the reaper give-up (#468)', () => {
    it('emits exactly one event, carrying the post-update row, for a reaped permanent failure', async () => {
      const { emitter, events } = collectingEmitter();
      const instrumented = stuckServiceFor(client, emitter);

      const id = await seed({
        type: nextType(),
        status: 'running',
        attempts: MAX_ATTEMPTS,
        startedAt: minutesAgo(THRESHOLD_MINUTES + 1),
        executor: 'server',
      });

      await expect(instrumented.resetStuck()).resolves.toMatchObject({ reset: 0, failed: 1 });

      expect(events).toHaveLength(1);

      const settled = events[0].job;
      expect(settled.id).toBe(id);
      expect(settled.status).toBe('failed');
      expect(settled.finishedAt).not.toBeNull();
      expect(settled.claimToken).toBeNull();
      // Kept on a terminal row, exactly as the plain DB assertion above checks.
      expect(settled.executor).toBe('server');
      expect(settled.lastError).toContain('lease reaper');
      expect(settled.lastError).toContain(`after ${MAX_ATTEMPTS} attempt(s)`);

      // The event's row IS the row now in the database — not a stale snapshot.
      const row = await read(id);
      expect(row).toMatchObject({
        status: 'failed',
        executor: 'server',
        claimToken: null,
      });
    });

    it('emits nothing when phase 2 requeues a row still under budget', async () => {
      const { emitter, events } = collectingEmitter();
      const instrumented = stuckServiceFor(client, emitter);

      await seed({
        type: nextType(),
        status: 'running',
        attempts: MAX_ATTEMPTS - 1,
        startedAt: minutesAgo(THRESHOLD_MINUTES + 1),
      });

      await expect(instrumented.resetStuck()).resolves.toMatchObject({ reset: 1, failed: 0 });
      expect(events).toHaveLength(0);
    });

    it(
      'two concurrent sweeps over one exhausted, lease-expired row settle it exactly once, ' +
        'with exactly one event across both emitters',
      async () => {
        const id = await seed({
          type: nextType(),
          status: 'running',
          attempts: MAX_ATTEMPTS,
          startedAt: minutesAgo(THRESHOLD_MINUTES + 1),
          leaseExpiresAt: minutesAgo(1),
          executor: 'server',
        });

        // A SECOND, independent connection running its own reaper — the real
        // seam this test closes: two REPLICAS, not two calls on one client.
        const clientB = createDbClient();
        // A THIRD, independent connection used only to hold a real row lock,
        // so both sweeps below are genuinely forced to block on Postgres's
        // own lock rather than merely racing in JS event-loop order.
        const lockClient = createDbClient();
        await Promise.all([clientB.$connect(), lockClient.$connect()]);

        try {
          const { emitter: emitterA, events: eventsA } = collectingEmitter();
          const { emitter: emitterB, events: eventsB } = collectingEmitter();
          const reaperA = stuckServiceFor(client, emitterA);
          const reaperB = stuckServiceFor(clientB, emitterB);

          let signalLockAcquired!: () => void;
          const lockAcquired = new Promise<void>((resolve) => {
            signalLockAcquired = resolve;
          });
          let releaseLock!: () => void;
          const heldUntilReleased = new Promise<void>((resolve) => {
            releaseLock = resolve;
          });

          // Hold `SELECT ... FOR UPDATE` on the row from the third connection,
          // inside an interactive transaction, so the row lock is real and
          // held by a party neither reaper is.
          const lockTx = lockClient.$transaction(
            async (tx) => {
              await tx.$queryRawUnsafe('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', id);
              signalLockAcquired();
              await heldUntilReleased;
            },
            { timeout: 10_000 }
          );

          await lockAcquired;

          // Both sweeps start while the lock is held: each reader's own
          // `findMany` sees the row fine (plain reads are not blocked by
          // `FOR UPDATE`), but each one's give-up `UPDATE ... RETURNING`
          // blocks on the held row lock.
          const sweeps = Promise.all([reaperA.resetStuck(), reaperB.resetStuck()]);

          // Hold the lock for ~1s while both sweeps are genuinely blocked on
          // it, then release — the window the task's approach calls for.
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          releaseLock();

          const [[resultA, resultB]] = await Promise.all([sweeps, lockTx]);

          // Exactly one of the two reapers actually changed the row — the
          // other's re-asserted `WHERE` no longer matched once the first's
          // write committed, so `UPDATE ... RETURNING` gave it `[]`.
          expect(resultA.failed + resultB.failed).toBe(1);
          expect(resultA.reset + resultB.reset).toBe(0);

          // And exactly one event was emitted, across BOTH emitters.
          expect(eventsA.length + eventsB.length).toBe(1);

          const row = await read(id);
          expect(row.status).toBe('failed');
        } finally {
          await Promise.all([clientB.$disconnect(), lockClient.$disconnect()]);
        }
      }
    );
  });
});
