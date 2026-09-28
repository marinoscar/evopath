// =============================================================================
// Real-Postgres test: the admin broadcast fan-out (issue #326, epic #319)
// =============================================================================
//
// `broadcast-start.handler.spec.ts` and `broadcast-chunk.handler.spec.ts`
// prove the SHAPE of every query the two handlers issue, against hand-built
// mocks. What they cannot prove — the same gap `job-claim.db.spec.ts` exists
// to close for the queue's claim — is that the compare-and-swap in
// `BroadcastStartHandler.process` really does resolve two concurrent
// executions to exactly one winner, that Postgres really does keyset-page the
// audience the way `audienceWhere` assumes, and that the terminal "mark sent"
// CAS in `BroadcastChunkHandler.finish` really cannot overwrite a concurrent
// cancel. A mocked `updateMany` returns whatever the test told it to; only a
// real server executing a real UPDATE under real row locks answers those
// questions, per `docs/specs/notification-broadcasts.md` §5.
//
// THE HANDLERS ARE CONSTRUCTED FOR REAL, over a real `PrismaClient` from
// `createDbClient()`. `JobsService` is ALSO the real class — its `enqueue` is
// nothing but `prisma.job.create` plus the dedup re-read
// (`jobs.service.ts`), so faking it would mean re-implementing the exact
// dedup-key logic this suite needs to prove `skipDedup: true` actually works
// against the real partial unique index, for no benefit. The two collaborators
// mocked are the outward edges the file header of both handlers names as
// deliberately swallowing everything beneath them: `NotificationsService`
// (`notifyNow` would otherwise try to send real email/browser notifications)
// and `JobHandlerRegistry` (`onModuleInit` is never called here — this suite
// drives `process()` directly, exactly like `job-claim.db.spec.ts` drives
// `JobClaimService.claim` directly, so nothing self-registers into a running
// application). `ConfigService` is a bare stub because neither handler under
// test needs `appUrl` for these assertions (no `link`/`ctaLabel` is set on
// any fixture broadcast).
//
// SUCCESSOR CHUNKS ARE DRIVEN BY RE-READING THE REAL `jobs` TABLE, not by
// capturing `JobsService.enqueue`'s return value: after each `process()` call
// this suite looks up the next `pending` `admin.broadcast.chunk` row for the
// broadcast (`nextPendingChunk`) and flips it to `succeeded` once handled
// (`markProcessed`) — a deliberately small stand-in for what the real worker
// does after a handler returns, sufficient to make "keep driving chunks until
// none are pending" a well-defined loop without pulling in the whole queue
// worker.
//
// THIS IS A `*.db.spec.ts` FILE, excluded from `npm test`/`test:unit`/
// `test:cov`/`test:ci` (see `apps/api/package.json`'s
// `testPathIgnorePatterns`) and run only by `npm run test:db` --runInBand,
// which is also what keeps this file from racing any sibling `*.db.spec.ts`
// suite for "all active users" — see the audience-computation note below.
// See `db-test-support.ts` for the reachability probe and for why
// `DATABASE_URL` is stripped before connecting.
// =============================================================================

import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, PrismaClient } from '@prisma/client';

import { RateLimitError } from '../../src/jobs/rate-limit.error';
import { JobTerminalService } from '../../src/jobs/job-terminal.service';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JOB_SETTLED_EVENT, JobSettledEvent } from '../../src/jobs/events/job-settled.event';
import { JobStuckService } from '../../src/jobs/job-stuck.service';
import { BroadcastFailureListener } from '../../src/notifications/broadcasts/broadcast-failure.listener';
import { BroadcastsService } from '../../src/notifications/broadcasts/broadcasts.service';
import { BroadcastChunkHandler, BROADCAST_CHUNK_TYPE } from '../../src/notifications/broadcasts/handlers/broadcast-chunk.handler';
import { BroadcastStartHandler, BROADCAST_START_TYPE } from '../../src/notifications/broadcasts/handlers/broadcast-start.handler';
import {
  BROADCAST_CHUNK_SIZE,
  BROADCAST_SEND_CONCURRENCY,
  BROADCAST_SUBJECT_TYPE,
} from '../../src/notifications/broadcasts/broadcast-audience';
import { JobsService } from '../../src/jobs/jobs.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { NotifyOptions } from '../../src/notifications/notification.types';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('broadcast-fanout.db.spec');

/**
 * Every user email and every broadcast `eventKey` this suite creates carries
 * this prefix, so cleanup (`afterEach`) can delete exactly what this suite
 * made — the database is shared with every other `*.db.spec.ts` suite and,
 * locally, may be a developer's seeded dev database. `broadcast-model.db.spec.ts`
 * uses the same `eventKey`-prefix convention.
 */
const PREFIX = `test.broadcast-fanout.${process.pid}.`;
let userCounter = 0;
let eventKeyCounter = 0;

/** A fresh, unique user email under this suite's prefix. */
const nextEmail = (label: string): string => `${PREFIX}${label}-${(userCounter += 1)}@example.test`;

/** A fresh, unique `eventKey`, so `notification_broadcasts` rows are identifiable and cleanable. */
const nextEventKey = (): string => `${PREFIX}${(eventKeyCounter += 1)}`;

/** A no-op `JobHandlerRegistry` stub — this suite calls `process()` directly and never `onModuleInit()`. */
function registryStub(): JobHandlerRegistry {
  return { register: jest.fn() } as unknown as JobHandlerRegistry;
}

/** A `ConfigService` stub. Neither handler needs `appUrl` for any fixture in this suite (no `link` is set). */
function configStub(): ConfigService {
  return { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
}

interface RecordedDispatch {
  eventKey: string;
  userId: string;
  data: unknown;
  options?: NotifyOptions;
}

/** A resolved/rejected pair a test can await, then settle from outside. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A `NotificationsService` stand-in that records every `notifyNow` dispatch
 * and can pause the call at a chosen 0-based index until the test releases
 * it — the mechanism `it('a chunk still in flight...')` below uses to hold a
 * dispatch open while a concurrent cancel lands in the database.
 */
function makeNotificationsStub() {
  const calls: RecordedDispatch[] = [];
  let callIndex = 0;
  let trap: { at: number; reached: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> } | null = null;
  /**
   * User ids that should report a provider throttle on their NEXT dispatch
   * only (issue #456's resume test below) — consumed on read, so a resumed
   * chunk's re-dispatch of the same recipient succeeds normally, exactly as
   * the real email provider's throttle window would have lifted by then.
   */
  const rateLimitOnce = new Map<string, number | null>();

  const notifyNow = jest.fn(
    async (eventKey: string, userId: string, data: unknown, options?: NotifyOptions) => {
      const current = callIndex;
      callIndex += 1;

      if (trap && trap.at === current) {
        trap.reached.resolve();
        await trap.gate.promise;
      }

      calls.push({ eventKey, userId, data, options });

      if (rateLimitOnce.has(userId)) {
        const retryAfterMs = rateLimitOnce.get(userId) ?? null;
        rateLimitOnce.delete(userId);
        return { rateLimited: true, retryAfterMs };
      }

      return { rateLimited: false, retryAfterMs: null };
    }
  );
  const notify = jest.fn();

  return {
    notifications: { notifyNow, notify } as unknown as NotificationsService,
    calls,
    notifyNow,
    notify,
    /**
     * Arranges for the dispatch at `at` to block until `release()` is
     * called, and returns a promise that resolves once that dispatch has
     * actually been reached (so the test does not race the handler to
     * install a trap after the call already passed).
     */
    trapAt(at: number): Promise<void> {
      trap = { at, reached: deferred(), gate: deferred() };
      return trap.reached.promise;
    },
    release(): void {
      trap?.gate.resolve();
    },
    /** See `rateLimitOnce` above. */
    rateLimitOnce(userId: string, retryAfterMs: number | null = null): void {
      rateLimitOnce.set(userId, retryAfterMs);
    },
    /**
     * Resets BOTH the recorded-dispatch array and the underlying jest mock's
     * own call log. `notifyNow.mockClear()` alone would leave `calls` (the
     * array assertions actually read `userId`s off of) holding every earlier
     * phase's entries — the two must be cleared together or a later phase's
     * assertions silently include recipients from an earlier one.
     */
    clear(): void {
      calls.length = 0;
      notifyNow.mockClear();
    },
  };
}

/** The user ids `notifyNow` was actually called for, in call order. */
const dispatchedIds = (calls: RecordedDispatch[]): string[] => calls.map((call) => call.userId);

describeWithDb('Admin broadcast fan-out (real Postgres)', () => {
  let clientA: PrismaClient;
  let clientB: PrismaClient;
  let jobsA: JobsService;
  let jobsB: JobsService;

  /** Every broadcast id this suite creates, so `afterEach` cleans up exactly these rows and their jobs. */
  let createdBroadcastIds: string[];

  beforeAll(async () => {
    clientA = createDbClient();
    clientB = createDbClient();
    await Promise.all([clientA.$connect(), clientB.$connect()]);
    jobsA = new JobsService(clientA as unknown as PrismaService);
    jobsB = new JobsService(clientB as unknown as PrismaService);
  });

  beforeEach(() => {
    createdBroadcastIds = [];
  });

  afterEach(async () => {
    // Jobs before broadcasts: `Job.subjectId` is a plain, un-FK'd text column
    // (see the `jobs` table comment in CLAUDE.md), so there is no ordering
    // constraint, but jobs are the "trace" of a broadcast and are deleted
    // first purely to mirror that dependency conceptually.
    if (createdBroadcastIds.length > 0) {
      await clientA.job.deleteMany({ where: { subjectId: { in: createdBroadcastIds } } });
      // Audit rows the resume tests write via the real `BroadcastsService`
      // (issue #459) — cleaned by target id, same as jobs above.
      await clientA.auditEvent.deleteMany({ where: { targetId: { in: createdBroadcastIds } } });
      await clientA.notificationBroadcast.deleteMany({ where: { id: { in: createdBroadcastIds } } });
    }
    // Users are cleaned every test, not just at the end of the suite: the
    // audience predicate is "every active user in the database", so a user
    // left behind by one test would silently join the next test's audience.
    await clientA.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await clientA?.job.deleteMany({ where: { subjectType: BROADCAST_SUBJECT_TYPE } }).catch(() => undefined);
    await clientA?.notificationBroadcast
      .deleteMany({ where: { eventKey: { startsWith: PREFIX } } })
      .catch(() => undefined);
    await clientA?.user.deleteMany({ where: { email: { startsWith: PREFIX } } }).catch(() => undefined);
    await Promise.all([clientA?.$disconnect(), clientB?.$disconnect()]);
  });

  /** Creates `count` users under this suite's prefix, all active unless `isActive: false`. */
  async function createUsers(count: number, label: string, isActive = true): Promise<string[]> {
    if (count === 0) {
      return [];
    }
    await clientA.user.createMany({
      data: Array.from({ length: count }, () => ({ email: nextEmail(label), isActive })),
    });
    const rows = await clientA.user.findMany({
      where: { email: { startsWith: `${PREFIX}${label}-` } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** Creates a `scheduled` broadcast and tracks its id for cleanup. */
  async function createBroadcast(overrides: Partial<{ status: string }> = {}) {
    const broadcast = await clientA.notificationBroadcast.create({
      data: {
        title: 'Scheduled maintenance',
        body: 'The application will be briefly unavailable.',
        eventKey: nextEventKey(),
        channels: ['browser'],
        status: (overrides.status ?? 'scheduled') as never,
      },
    });
    createdBroadcastIds.push(broadcast.id);
    return broadcast;
  }

  function startJobFor(broadcastId: string, id = 'start-job'): Job {
    return {
      id,
      type: BROADCAST_START_TYPE,
      subjectType: BROADCAST_SUBJECT_TYPE,
      subjectId: broadcastId,
    } as Job;
  }

  /** The earliest still-`pending` chunk job for `broadcastId`, or `null` once none remain. */
  async function nextPendingChunk(broadcastId: string) {
    return clientA.job.findFirst({
      where: { type: BROADCAST_CHUNK_TYPE, subjectId: broadcastId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Marks a job row `succeeded`, standing in for what the real worker does
   * once a handler's `process()` returns — see the file header for why this
   * suite does not pull in the whole claim/worker machinery to get that one
   * status flip.
   */
  async function markProcessed(jobId: string): Promise<void> {
    await clientA.job.update({ where: { id: jobId }, data: { status: 'succeeded' } });
  }

  /**
   * Drives `chunkHandler` against every pending chunk job for `broadcastId`
   * until none remain, up to a generous safety cap so a regression that
   * makes the chain never terminate fails the test instead of hanging CI.
   */
  async function runChunksToCompletion(
    chunkHandler: BroadcastChunkHandler,
    broadcastId: string,
    maxChunks = 20
  ): Promise<number> {
    let processed = 0;
    for (; processed < maxChunks; processed += 1) {
      const job = await nextPendingChunk(broadcastId);
      if (!job) {
        break;
      }
      await chunkHandler.process(job);
      await markProcessed(job.id);
    }
    return processed;
  }

  function handlersFor(client: PrismaClient, jobs: JobsService, stub = makeNotificationsStub()) {
    const prisma = client as unknown as PrismaService;
    return {
      startHandler: new BroadcastStartHandler(prisma, jobs, registryStub()),
      chunkHandler: new BroadcastChunkHandler(
        prisma,
        stub.notifications,
        jobs,
        configStub(),
        registryStub(),
        { registerProviderKey: jest.fn() } as unknown as ProviderThrottleService
      ),
      stub,
    };
  }

  // ===========================================================================
  // 1. The full fan-out: exactly the active audience, none of the inactive
  // ===========================================================================

  it('dispatches to exactly the active audience as of the cutoff, and none of the inactive users', async () => {
    const activeIds = await createUsers(250, 'active');
    const inactiveIds = await createUsers(10, 'inactive', false);
    const broadcast = await createBroadcast();

    const { startHandler, chunkHandler, stub } = handlersFor(clientA, jobsA);

    await startHandler.process(startJobFor(broadcast.id));

    const afterStart = await clientA.notificationBroadcast.findUniqueOrThrow({
      where: { id: broadcast.id },
    });
    expect(afterStart.status).toBe('sending');
    expect(afterStart.audienceCutoff).toBeInstanceOf(Date);

    // The AUDIENCE THIS SUITE OWNS is exactly `activeIds` + `inactiveIds`, but
    // the predicate under test ("all active users as of the cutoff") also
    // matches whatever active users pre-exist in a shared database (a seeded
    // admin, rows left by another suite). Rather than assume isolation this
    // suite does not have, the expected set is COMPUTED with the same
    // predicate the handlers use, right after the cutoff is fixed — see the
    // task's "robust option" and `audienceWhere`'s own contract.
    const expectedRecipients = await clientA.user.findMany({
      where: { isActive: true, createdAt: { lte: afterStart.audienceCutoff! } },
      select: { id: true },
    });
    const expectedIds = expectedRecipients.map((row) => row.id).sort();

    expect(expectedIds).toEqual(expect.arrayContaining(activeIds));
    for (const inactiveId of inactiveIds) {
      expect(expectedIds).not.toContain(inactiveId);
    }

    const chunksRun = await runChunksToCompletion(chunkHandler, broadcast.id);
    expect(chunksRun).toBeGreaterThan(0);
    // 250 active users guarantees at least two 200-recipient pages.
    expect(chunksRun).toBeGreaterThanOrEqual(2);

    expect(dispatchedIds(stub.calls).sort()).toEqual(expectedIds);
    expect(dispatchedIds(stub.calls).sort()).toEqual(expect.arrayContaining(activeIds.sort()));
    for (const inactiveId of inactiveIds) {
      expect(dispatchedIds(stub.calls)).not.toContain(inactiveId);
    }

    const finished = await clientA.notificationBroadcast.findUniqueOrThrow({
      where: { id: broadcast.id },
    });
    expect(finished.status).toBe('sent');
    expect(finished.recipientsDispatched).toBe(expectedIds.length);
    expect(finished.recipientsTargeted).toBe(expectedIds.length);
    expect(finished.finishedAt).toBeInstanceOf(Date);

    // No successor left dangling once the audience is exhausted.
    expect(await nextPendingChunk(broadcast.id)).toBeNull();
  });

  // ===========================================================================
  // 2. The frozen cutoff excludes a user created mid-fan-out
  // ===========================================================================

  it('excludes a user created after the audience cutoff, even though they are active', async () => {
    await createUsers(5, 'before-cutoff');
    const broadcast = await createBroadcast();
    const { startHandler, chunkHandler, stub } = handlersFor(clientA, jobsA);

    await startHandler.process(startJobFor(broadcast.id));

    // Created strictly after `audienceCutoff` was stamped — the handler's own
    // `createdAt: { lte: cutoff }` clause is the thing under test here, not
    // an artificially back-dated row.
    const [lateUserId] = await createUsers(1, 'after-cutoff');

    await runChunksToCompletion(chunkHandler, broadcast.id);

    expect(dispatchedIds(stub.calls)).not.toContain(lateUserId);

    const finished = await clientA.notificationBroadcast.findUniqueOrThrow({
      where: { id: broadcast.id },
    });
    expect(finished.status).toBe('sent');
    // The late user does not inflate the target snapshot either — it was
    // counted before the user existed.
    expect(finished.recipientsTargeted).toBe(stub.calls.length);
  });

  // ===========================================================================
  // 3. Two concurrent starts: exactly one claim, one stamp, one first chunk
  // ===========================================================================

  it('lets exactly one of two concurrent start executions claim the broadcast', async () => {
    await createUsers(3, 'concurrent-audience');
    const broadcast = await createBroadcast();

    // Two INDEPENDENT connections, like `job-claim.db.spec.ts`'s two
    // claimers — the point is to let Postgres's own row locking resolve the
    // race, not an in-process mutex neither replica of a real deployment
    // would share.
    const { startHandler: startA } = handlersFor(clientA, jobsA);
    const { startHandler: startB } = handlersFor(clientB, jobsB);

    // `Promise.all` genuinely overlaps the two `process()` calls; if either
    // rejected, `Promise.all` would reject and fail this test — which is
    // exactly how "the loser is a clean no-op" is checked, alongside the
    // explicit assertions below.
    await expect(
      Promise.all([
        startA.process(startJobFor(broadcast.id, 'start-a')),
        startB.process(startJobFor(broadcast.id, 'start-b')),
      ])
    ).resolves.toBeDefined();

    const claimed = await clientA.notificationBroadcast.findUniqueOrThrow({
      where: { id: broadcast.id },
    });
    expect(claimed.status).toBe('sending');
    expect(claimed.audienceCutoff).toBeInstanceOf(Date);
    expect(claimed.startedAt).toBeInstanceOf(Date);

    // Exactly one first chunk — a second `updateMany` that matched nothing
    // never reaches the enqueue call at all, so a second chunk here would
    // mean the compare-and-swap let both executions past it.
    const chunkJobs = await clientA.job.findMany({
      where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
    });
    expect(chunkJobs).toHaveLength(1);
  });

  // ===========================================================================
  // 4. A replayed chunk re-pages from the persisted cursor, never earlier
  // ===========================================================================

  it('replaying a chunk after the cursor advanced re-sends only the window after it', async () => {
    const PAGE_ONE_SIZE = BROADCAST_CHUNK_SIZE;
    const PAGE_TWO_SIZE = 20;
    await createUsers(PAGE_ONE_SIZE + PAGE_TWO_SIZE, 'replay-audience');
    const broadcast = await createBroadcast();
    const { startHandler, chunkHandler, stub } = handlersFor(clientA, jobsA);

    await startHandler.process(startJobFor(broadcast.id));

    const firstChunkJob = await nextPendingChunk(broadcast.id);
    expect(firstChunkJob).not.toBeNull();

    // Run the first chunk once — a full 200-recipient page, cursor
    // committed, successor enqueued but not yet run.
    await chunkHandler.process(firstChunkJob!);
    // NOT marked `succeeded` here — the whole point of this test is to hand
    // this exact row to `process()` a second time, standing in for a retry
    // or a lease reclaimed after the executing process died.
    expect(stub.calls).toHaveLength(PAGE_ONE_SIZE);
    const pageOneIds = new Set(dispatchedIds(stub.calls));

    const afterPageOne = await clientA.notificationBroadcast.findUniqueOrThrow({
      where: { id: broadcast.id },
    });
    expect(afterPageOne.status).toBe('sending');
    const cursorAfterPageOne = afterPageOne.cursorUserId;

    // ⚠ THE REPLAY: the SAME job row is handed to `process()` again — the
    // at-least-once scenario the file header of `broadcast-chunk.handler.ts`
    // names explicitly (a retry, or a lease reclaimed after the executing
    // process died). The cursor lives on the BROADCAST, not on the job, so
    // this replay reads the cursor page one just committed and pages from
    // there — page two — rather than resending page one.
    stub.clear();
    await chunkHandler.process(firstChunkJob!);
    // Now settle the row this suite is done replaying, so the lookup below
    // finds the REAL successor rather than this still-`pending` one again.
    await markProcessed(firstChunkJob!.id);

    const replayIds = dispatchedIds(stub.calls);
    expect(replayIds).toHaveLength(PAGE_TWO_SIZE);
    // Nobody from page one is touched again by the replay.
    expect(replayIds.some((id) => pageOneIds.has(id))).toBe(false);

    const afterReplay = await clientA.notificationBroadcast.findUniqueOrThrow({
      where: { id: broadcast.id },
    });
    // The audience is exhausted (page two was short), so the replay itself
    // finished the broadcast without needing the separately-enqueued
    // successor job to run at all.
    expect(afterReplay.status).toBe('sent');
    expect(afterReplay.cursorUserId).not.toBe(cursorAfterPageOne);
    expect(afterReplay.recipientsDispatched).toBe(PAGE_ONE_SIZE + PAGE_TWO_SIZE);

    // The successor job the FIRST run of the chunk enqueued is still sitting
    // there, unrun. Running it too must be a harmless no-op: the audience
    // is exhausted and the broadcast is already `sent`.
    const successor = await nextPendingChunk(broadcast.id);
    expect(successor).not.toBeNull();
    stub.notifyNow.mockClear();
    await chunkHandler.process(successor!);
    await markProcessed(successor!.id);
    expect(stub.notifyNow).not.toHaveBeenCalled();

    const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
      where: { id: broadcast.id },
    });
    expect(finalState.status).toBe('sent');
    expect(finalState.recipientsDispatched).toBe(PAGE_ONE_SIZE + PAGE_TWO_SIZE);
  });

  // ===========================================================================
  // 5. Cancel between two chunks, and cancel racing an in-flight finish
  // ===========================================================================

  describe('cancellation', () => {
    it('stops the fan-out when a cancel lands between two chunk jobs', async () => {
      const PAGE_ONE_SIZE = BROADCAST_CHUNK_SIZE;
      await createUsers(PAGE_ONE_SIZE + 30, 'cancel-between-audience');
      const broadcast = await createBroadcast();
      const { startHandler, chunkHandler, stub } = handlersFor(clientA, jobsA);

      await startHandler.process(startJobFor(broadcast.id));

      const firstChunkJob = await nextPendingChunk(broadcast.id);
      await chunkHandler.process(firstChunkJob!);
      await markProcessed(firstChunkJob!.id);
      expect(stub.calls).toHaveLength(PAGE_ONE_SIZE);

      // The cancel: the same conditional write `NotificationBroadcastsService
      // .cancel` performs (`CANCELABLE_STATUSES` is `['scheduled', 'sending']`
      // and is not exported, so this restates the shape rather than importing
      // a private constant — see `broadcasts.service.ts`).
      const canceled = await clientA.notificationBroadcast.updateMany({
        where: { id: broadcast.id, status: { in: ['scheduled', 'sending'] } },
        data: { status: 'canceled', canceledAt: new Date() },
      });
      expect(canceled.count).toBe(1);

      const successor = await nextPendingChunk(broadcast.id);
      expect(successor).not.toBeNull();

      stub.notifyNow.mockClear();
      await chunkHandler.process(successor!);
      await markProcessed(successor!.id);

      // The status guard at the top of `process()` — `canceled` is not
      // `sending`, so the chunk sends nothing at all, not even a partial
      // page.
      expect(stub.notifyNow).not.toHaveBeenCalled();

      const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
        where: { id: broadcast.id },
      });
      expect(finalState.status).toBe('canceled');
      expect(finalState.recipientsDispatched).toBe(PAGE_ONE_SIZE);
      expect(await nextPendingChunk(broadcast.id)).toBeNull();
    });

    it('cannot let a chunk still dispatching flip a concurrently-cancelled broadcast to sent', async () => {
      // A SHORT PAGE (well under `BROADCAST_CHUNK_SIZE`) so the whole audience
      // fits in the dispatch loop's first (and only) sub-group — no mid-page
      // status re-check fires, and the run proceeds straight to `finish()`
      // once every recipient has been dispatched. That is the precise window
      // this test forces a cancel into: the chunk has ALREADY committed to
      // finishing when the row underneath it becomes `canceled`.
      const activeIds = await createUsers(5, 'inflight-audience');
      const broadcast = await createBroadcast();
      const { startHandler, chunkHandler, stub } = handlersFor(clientA, jobsA);

      await startHandler.process(startJobFor(broadcast.id));
      const chunkJob = await nextPendingChunk(broadcast.id);
      expect(chunkJob).not.toBeNull();

      // Block the LAST recipient's dispatch mid-flight — everyone before it
      // has already been "sent" by the time the cancel below is issued.
      const reachedLastDispatch = stub.trapAt(activeIds.length - 1);

      const processPromise = chunkHandler.process(chunkJob!);

      await reachedLastDispatch;

      // The cancel is issued WHILE the chunk is paused inside its last
      // `notifyNow` call — i.e. genuinely concurrently with the chunk's own
      // in-flight work, not sequenced before or after it.
      const canceled = await clientA.notificationBroadcast.updateMany({
        where: { id: broadcast.id, status: { in: ['scheduled', 'sending'] } },
        data: { status: 'canceled', canceledAt: new Date() },
      });
      expect(canceled.count).toBe(1);

      stub.release();
      await processPromise;
      await markProcessed(chunkJob!.id);

      // The dispatch itself still completed for every recipient — cancelling
      // does not un-send a notification already in flight, which is exactly
      // what the handlers' own comments say ("worst case one in-flight
      // sub-group still goes out after the click"). What must NOT have
      // happened is `finish()` overwriting `canceled` with `sent`.
      expect(dispatchedIds(stub.calls).sort()).toEqual([...activeIds].sort());

      const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
        where: { id: broadcast.id },
      });
      expect(finalState.status).toBe('canceled');
      expect(finalState.finishedAt).toBeNull();
      // The progress counter is still written — it records what was actually
      // sent regardless of how the broadcast ended.
      expect(finalState.recipientsDispatched).toBe(activeIds.length);
      // And no successor was queued once the (short) page was dispatched —
      // `finish()` never enqueues, whichever way its own CAS resolves.
      expect(await nextPendingChunk(broadcast.id)).toBeNull();
    });
  });

  // ===========================================================================
  // 6. A provider throttle mid-page: partial commit, then a full resume
  // ===========================================================================

  describe('provider throttle (issue #456)', () => {
    it(
      'commits only the prefix before a throttled recipient, queues no successor, then ' +
        'resumes to completion on retry with nobody skipped and duplicates bounded by concurrency',
      async () => {
        const PAGE_ONE_SIZE = BROADCAST_CHUNK_SIZE;
        await createUsers(PAGE_ONE_SIZE + 40, 'throttle-audience');
        const broadcast = await createBroadcast();
        const { startHandler, chunkHandler, stub } = handlersFor(clientA, jobsA);

        await startHandler.process(startJobFor(broadcast.id));

        const afterStart = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        const expectedRecipients = await clientA.user.findMany({
          where: { isActive: true, createdAt: { lte: afterStart.audienceCutoff! } },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        const expectedIds = expectedRecipients.map((row) => row.id);
        expect(expectedIds.length).toBeGreaterThanOrEqual(PAGE_ONE_SIZE + 40);

        // A recipient safely inside the FIRST page (well past the start, so
        // the committed prefix is provably non-trivial; well before the end,
        // so there is provably more work left after it).
        const throttledId = expectedIds[100];
        stub.rateLimitOnce(throttledId, 30_000);

        const firstChunkJob = await nextPendingChunk(broadcast.id);
        expect(firstChunkJob).not.toBeNull();

        // --- attempt 1: the provider throttles on `throttledId` ---
        let thrown: unknown;
        try {
          await chunkHandler.process(firstChunkJob!);
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(RateLimitError);
        expect((thrown as RateLimitError).retryAfterMs).toBe(30_000);

        const afterThrottle = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        // Still `sending` — a throttle defers the CHUNK JOB, not the broadcast.
        expect(afterThrottle.status).toBe('sending');
        // Cursor and counter both describe the longest contiguous prefix
        // that completed before the throttled recipient — index 100 in id
        // order, so exactly 100 recipients are committed.
        expect(afterThrottle.recipientsDispatched).toBe(100);
        expect(afterThrottle.cursorUserId).toBe(expectedIds[99]);

        // NO SUCCESSOR was queued — the page is not done, so nothing chains
        // off it. The only chunk row for this broadcast is still the one
        // that just threw, and it is still `pending` (this suite drives
        // `process()` directly rather than through `JobTerminalService`, so
        // the row's own status/backoff bookkeeping is out of scope here —
        // see the file header; what matters is that nothing ELSE was
        // created).
        const chunkRows = await clientA.job.findMany({
          where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
        });
        expect(chunkRows).toHaveLength(1);
        expect(chunkRows[0].id).toBe(firstChunkJob!.id);

        // --- resume: the queue's retry of the SAME job, from the persisted cursor ---
        // NOT cleared — the final assertions below need the FULL dispatch
        // history, including attempt 1's 100 committed recipients (plus the
        // throttled one, which attempt 1 also recorded before failing).
        const beforeResume = stub.calls.length;
        await chunkHandler.process(firstChunkJob!);
        await markProcessed(firstChunkJob!.id);

        // Every recipient from the throttled one onward is reached again on
        // this resumed run — nobody after the committed prefix was skipped.
        // Only 140 recipients remain past the committed prefix of 100 (out
        // of the 240-strong audience), well under one page, so this single
        // resumed `process()` call reaches all of them at once and finishes
        // the broadcast directly, with no successor chunk required.
        const resumedPage = dispatchedIds(stub.calls.slice(beforeResume));
        expect(resumedPage[0]).toBe(throttledId);
        expect(resumedPage).toEqual(expectedIds.slice(100));

        // Drive whatever successor chunks the resumed run enqueued (the
        // remaining recipients past the first 200-recipient page) to
        // completion.
        await runChunksToCompletion(chunkHandler, broadcast.id);

        const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        expect(finalState.status).toBe('sent');
        // Every audience member was dispatched to at least once.
        const allDispatchedIds = dispatchedIds(stub.calls);
        const uniqueDispatched = new Set(allDispatchedIds);
        for (const id of expectedIds) {
          expect(uniqueDispatched.has(id)).toBe(true);
        }
        // `recipientsDispatched` counts each committed recipient exactly
        // once — the throttled recipient's FIRST (failed) attempt was never
        // counted, only its successful resend was — so the total across both
        // commits (100 then 140) equals the full audience, not more.
        expect(finalState.recipientsDispatched).toBe(expectedIds.length);

        // Duplicates are bounded by the concurrency pool: only recipients
        // already in flight when the throttle was discovered could have
        // both "succeeded" and been re-sent on resume.
        const counts = new Map<string, number>();
        for (const id of allDispatchedIds) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        for (const [, count] of counts) {
          expect(count).toBeLessThanOrEqual(BROADCAST_SEND_CONCURRENCY);
        }
      }
    );
  });

  // ===========================================================================
  // 7. Permanent failure and resume (issue #459, epic #319)
  // ===========================================================================
  //
  // The listener and the service's own decisions are proven against mocks in
  // `broadcast-failure.listener.spec.ts` and `broadcasts.service.spec.ts`.
  // What only a real database can answer is the same class of question
  // `job-lease-renewal.db.spec.ts`'s header states for its own suite: does the
  // REAL `JobTerminalService`, dispatching through a REAL `EventEmitter2`, to
  // a REAL `BroadcastFailureListener`, actually flip a `sending` broadcast to
  // `failed` under real row locks — and does `BroadcastsService.resume`,
  // driven by the REAL `JobsService` against the REAL `jobs` table, actually
  // walk the rest of a real audience to completion afterwards, with the
  // concurrency guarantees the chunk handler's own header claims (two
  // executions racing the same cursor collapse to one).
  //
  // `BroadcastFailureListener.markFailed` runs DETACHED off the terminal
  // write (see its own file header, section 2) — `EventEmitter2.emit` is
  // synchronous, but the listener's own database write is not, so a test
  // cannot assume the broadcast row has already flipped the instant
  // `completeFailed` resolves. `waitUntilBroadcastStatus` polls briefly rather
  // than asserting immediately, which is the same shape `job-claim.db.spec.ts`
  // uses for asynchronous side effects it does not control the timing of.
  describe('permanent failure and resume (#459)', () => {
    /** `jobs.maxAttempts` this suite's terminal service runs with — 1, so a single `completeFailed` call is already the give-up. */
    const MAX_ATTEMPTS = 1;

    function configStubWithMaxAttempts(): ConfigService {
      return {
        get: (key: string) => (key === 'jobs.maxAttempts' ? MAX_ATTEMPTS : undefined),
      } as unknown as ConfigService;
    }

    /**
     * A real `JobTerminalService` wired, by a plain `emitter.on`, to a real
     * `BroadcastFailureListener` over `client`. Not `EventEmitterModule` +
     * Nest's `@OnEvent` discovery (as `job-failure-notifier.spec.ts` uses) —
     * that machinery is what proves the DECORATOR is wired, which is not in
     * question here (it is proven once, there); this suite only needs the two
     * real objects the decorator would otherwise connect to actually agree
     * over a real broadcast row.
     */
    function terminalWithRealListener(client: PrismaClient) {
      const emitter = new EventEmitter2();
      const listener = new BroadcastFailureListener(client as unknown as PrismaService);
      emitter.on(JOB_SETTLED_EVENT, (event: JobSettledEvent) => listener.handleJobSettled(event));

      const terminal = new JobTerminalService(
        client as unknown as PrismaService,
        configStubWithMaxAttempts(),
        new ProviderThrottleService(configStubWithMaxAttempts()),
        emitter,
        new JobHandlerRegistry()
      );

      return { terminal, listener };
    }

    function broadcastsServiceFor(client: PrismaClient, jobs: JobsService): BroadcastsService {
      const notifications = {
        notifyNow: jest.fn().mockResolvedValue(undefined),
        notify: jest.fn(),
      } as unknown as NotificationsService;
      const systemSettings = {
        getNotificationsPolicy: jest.fn().mockResolvedValue({ browserEnabled: true, disabledEvents: [] }),
      } as unknown as SystemSettingsService;
      const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;

      return new BroadcastsService(client as unknown as PrismaService, jobs, notifications, systemSettings, config);
    }

    /** Creates a `running` chunk job row already charged for its one attempt — the claim-time charge `completeFailed` assumes happened. */
    async function claimedChunkJob(broadcastId: string): Promise<Job> {
      return clientA.job.create({
        data: {
          type: BROADCAST_CHUNK_TYPE,
          subjectType: BROADCAST_SUBJECT_TYPE,
          subjectId: broadcastId,
          status: 'running',
          reason: 'backfill',
          attempts: MAX_ATTEMPTS,
        },
      });
    }

    /** Polls until the broadcast reaches `status`, or fails the test — see the describe-block header for why polling is necessary here. */
    async function waitUntilBroadcastStatus(
      broadcastId: string,
      status: string,
      timeoutMs = 2000
    ) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const row = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcastId },
        });
        if (row.status === status) return row;
        if (Date.now() > deadline) {
          throw new Error(
            `broadcast ${broadcastId} did not reach '${status}' within ${timeoutMs}ms ` +
              `(currently '${row.status}')`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    /** A user to attribute a real `BroadcastsService.resume` audit write to. */
    async function createActor(): Promise<string> {
      const [id] = await createUsers(1, 'resume-actor');
      return id;
    }

    // -------------------------------------------------------------------------
    // 7a. The real listener flips sending -> failed
    // -------------------------------------------------------------------------

    it('flips a sending broadcast to failed when its chunk job settles permanently failed', async () => {
      const [cursorUserId] = await createUsers(1, 'permfail-cursor');
      const broadcast = await createBroadcast({ status: 'sending' });
      await clientA.notificationBroadcast.update({
        where: { id: broadcast.id },
        data: { audienceCutoff: new Date(), cursorUserId, recipientsDispatched: 100 },
      });
      const job = await claimedChunkJob(broadcast.id);
      const { terminal } = terminalWithRealListener(clientA);

      await terminal.completeFailed(job, new Error('the email provider refused the batch'));

      const finalState = await waitUntilBroadcastStatus(broadcast.id, 'failed');

      expect(finalState.lastError).toContain(job.id);
      expect(finalState.lastError).toContain('the email provider refused the batch');
      // The cursor and the counter are left exactly where the last committed
      // page put them — nobody past the cursor is marked as sent.
      expect(finalState.cursorUserId).toBe(cursorUserId);
      expect(finalState.recipientsDispatched).toBe(100);
      expect(finalState.finishedAt).toBeInstanceOf(Date);
    });

    it('flips a sending admin.broadcast.start job the same way', async () => {
      const broadcast = await createBroadcast({ status: 'sending' });
      const job = await clientA.job.create({
        data: {
          type: BROADCAST_START_TYPE,
          subjectType: BROADCAST_SUBJECT_TYPE,
          subjectId: broadcast.id,
          status: 'running',
          reason: 'backfill',
          attempts: MAX_ATTEMPTS,
        },
      });
      const { terminal } = terminalWithRealListener(clientA);

      await terminal.completeFailed(job, new Error('could not enqueue the first chunk'));

      const finalState = await waitUntilBroadcastStatus(broadcast.id, 'failed');
      expect(finalState.lastError).toContain(job.id);
    });

    // -------------------------------------------------------------------------
    // 7b. Cancel and the failure flip race each other; cancel always wins if
    // it lands first, and a `failed` row is still cancelable afterwards.
    // -------------------------------------------------------------------------

    it('a cancel that lands before the give-up leaves the broadcast canceled, not failed', async () => {
      const broadcast = await createBroadcast({ status: 'sending' });
      await clientA.notificationBroadcast.update({
        where: { id: broadcast.id },
        data: { audienceCutoff: new Date() },
      });
      const job = await claimedChunkJob(broadcast.id);

      // The cancel: the same conditional write `BroadcastsService.cancel` performs.
      const canceled = await clientA.notificationBroadcast.updateMany({
        where: { id: broadcast.id, status: { in: ['scheduled', 'sending', 'failed'] } },
        data: { status: 'canceled', canceledAt: new Date() },
      });
      expect(canceled.count).toBe(1);

      const { terminal } = terminalWithRealListener(clientA);
      await terminal.completeFailed(job, new Error('too late, already canceled'));

      // Give the detached listener write a moment to run (or not run) before
      // asserting the negative — there is no "reached failed" state to poll
      // for here, so a short, fixed wait is used instead of
      // `waitUntilBroadcastStatus`.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
        where: { id: broadcast.id },
      });
      expect(finalState.status).toBe('canceled');
      expect(finalState.lastError).toBeNull();
    });

    it('a broadcast already failed can still be cancelled through BroadcastsService.cancel', async () => {
      const broadcast = await createBroadcast({ status: 'sending' });
      await clientA.notificationBroadcast.update({
        where: { id: broadcast.id },
        data: { audienceCutoff: new Date() },
      });
      const job = await claimedChunkJob(broadcast.id);
      const { terminal } = terminalWithRealListener(clientA);

      await terminal.completeFailed(job, new Error('smtp outage'));
      await waitUntilBroadcastStatus(broadcast.id, 'failed');

      const actorId = await createActor();
      const service = broadcastsServiceFor(clientA, jobsA);
      const result = await service.cancel(broadcast.id, actorId);

      expect(result.status).toBe('canceled');

      const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
        where: { id: broadcast.id },
      });
      expect(finalState.status).toBe('canceled');
    });

    // -------------------------------------------------------------------------
    // 7c. Resume drives the rest of a real audience to completion
    // -------------------------------------------------------------------------

    it(
      'resumes a broadcast whose second chunk failed permanently, reaching every remaining ' +
        'recipient exactly once and finishing the audience',
      async () => {
        const PAGE_ONE_SIZE = BROADCAST_CHUNK_SIZE;
        const PAGE_TWO_SIZE = 30;
        await createUsers(PAGE_ONE_SIZE + PAGE_TWO_SIZE, 'resume-audience');
        const broadcast = await createBroadcast();
        const { startHandler, chunkHandler, stub } = handlersFor(clientA, jobsA);

        await startHandler.process(startJobFor(broadcast.id));

        // Page one: a full, successfully committed page. Its successor
        // (page two) is enqueued but never run — it is about to be made to
        // fail permanently instead, standing in for a chunk that could not
        // reach the provider at all (its own dispatch never got a chance to
        // run, unlike the throttle suite above).
        const firstChunkJob = await nextPendingChunk(broadcast.id);
        await chunkHandler.process(firstChunkJob!);
        await markProcessed(firstChunkJob!.id);
        expect(stub.calls).toHaveLength(PAGE_ONE_SIZE);

        const afterPageOne = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        const cursorAfterPageOne = afterPageOne.cursorUserId;

        const secondChunkJob = await nextPendingChunk(broadcast.id);
        expect(secondChunkJob).not.toBeNull();
        // Simulate the claim charge and drive it straight to permanent
        // failure, exactly as 7a does.
        const claimedSecondChunk = await clientA.job.update({
          where: { id: secondChunkJob!.id },
          data: { attempts: MAX_ATTEMPTS, status: 'running' },
        });
        const { terminal } = terminalWithRealListener(clientA);
        await terminal.completeFailed(claimedSecondChunk, new Error('connection reset'));

        const failedState = await waitUntilBroadcastStatus(broadcast.id, 'failed');
        expect(failedState.cursorUserId).toBe(cursorAfterPageOne);
        expect(failedState.recipientsDispatched).toBe(PAGE_ONE_SIZE);

        // --- resume, through the real service ---
        const actorId = await createActor();
        const service = broadcastsServiceFor(clientA, jobsA);
        const resumed = await service.resume(broadcast.id, actorId);
        expect(resumed.status).toBe('sending');

        await runChunksToCompletion(chunkHandler, broadcast.id);

        const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        expect(finalState.status).toBe('sent');
        // The failed chunk never actually dispatched anything (it failed
        // before doing any work), so the resumed run reaches EXACTLY the
        // remainder, with no overlap at all.
        const dispatchedAfterFirstPage = dispatchedIds(stub.calls).slice(PAGE_ONE_SIZE);
        expect(dispatchedAfterFirstPage).toHaveLength(PAGE_TWO_SIZE);
        expect(new Set(dispatchedAfterFirstPage).size).toBe(PAGE_TWO_SIZE);
        expect(finalState.recipientsDispatched).toBe(PAGE_ONE_SIZE + PAGE_TWO_SIZE);

        // Every audience member was reached exactly once.
        const counts = new Map<string, number>();
        for (const id of dispatchedIds(stub.calls)) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        expect(counts.size).toBe(PAGE_ONE_SIZE + PAGE_TWO_SIZE);
        for (const [, count] of counts) {
          expect(count).toBe(1);
        }

        // The audit trail records the resume, never the composed content.
        const auditRows = await clientA.auditEvent.findMany({
          where: { targetId: broadcast.id, action: 'notification_broadcast.resumed' },
        });
        expect(auditRows).toHaveLength(1);
        expect(JSON.stringify(auditRows[0].meta)).not.toContain(broadcast.title);
      }
    );

    // -------------------------------------------------------------------------
    // 7d. Two concurrent chunk executions from the same cursor collapse to one
    // -------------------------------------------------------------------------

    it(
      'two concurrent chunk executions racing the same cursor commit exactly once, ' +
        'enqueue exactly one successor, and still finish the whole audience',
      async () => {
        const PAGE_ONE_SIZE = BROADCAST_CHUNK_SIZE;
        const PAGE_TWO_SIZE = BROADCAST_CHUNK_SIZE;
        const PAGE_THREE_SIZE = 10;
        await createUsers(PAGE_ONE_SIZE + PAGE_TWO_SIZE + PAGE_THREE_SIZE, 'race-audience');
        const broadcast = await createBroadcast();
        const stub = makeNotificationsStub();
        const { startHandler } = handlersFor(clientA, jobsA, stub);
        const { chunkHandler: chunkA } = handlersFor(clientA, jobsA, stub);
        const { chunkHandler: chunkB } = handlersFor(clientB, jobsB, stub);

        await startHandler.process(startJobFor(broadcast.id));

        const firstChunkJob = await nextPendingChunk(broadcast.id);
        await chunkA.process(firstChunkJob!);
        await markProcessed(firstChunkJob!.id);
        expect(stub.calls).toHaveLength(PAGE_ONE_SIZE);

        // The second chunk — a full page again — is handed to TWO independent
        // executions concurrently, standing in for a resumed chain racing a
        // re-queued copy of the same failed chunk (issue #459's own scenario)
        // or a lease-expired duplicate. Both read the same cursor.
        const secondChunkJob = await nextPendingChunk(broadcast.id);
        expect(secondChunkJob).not.toBeNull();

        await expect(
          Promise.all([chunkA.process(secondChunkJob!), chunkB.process({ ...secondChunkJob! })])
        ).resolves.toBeDefined();
        await markProcessed(secondChunkJob!.id);

        const afterRace = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        // Exactly one execution's commit won: the counter reflects ONE page's
        // worth of progress on top of page one, never two.
        expect(afterRace.recipientsDispatched).toBe(PAGE_ONE_SIZE + PAGE_TWO_SIZE);

        // Exactly one successor was enqueued for the (full) second page — the
        // loser's CAS matched zero rows and returned before reaching enqueue.
        const chunkRows = await clientA.job.findMany({
          where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
        });
        // firstChunkJob + secondChunkJob (now succeeded) + exactly one successor.
        expect(chunkRows).toHaveLength(3);

        // Drive the successor (the short, final page) to completion.
        const { chunkHandler: chunkFinisher } = handlersFor(clientA, jobsA, stub);
        await runChunksToCompletion(chunkFinisher, broadcast.id);

        const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        expect(finalState.status).toBe('sent');
        expect(finalState.recipientsDispatched).toBe(PAGE_ONE_SIZE + PAGE_TWO_SIZE + PAGE_THREE_SIZE);

        // Every audience member was dispatched to at least once, and at most
        // twice — the second page's recipients are the only ones that could
        // have been sent by both racing executions before one lost the CAS.
        const counts = new Map<string, number>();
        for (const id of dispatchedIds(stub.calls)) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        expect(counts.size).toBe(PAGE_ONE_SIZE + PAGE_TWO_SIZE + PAGE_THREE_SIZE);
        for (const [, count] of counts) {
          expect(count).toBeGreaterThanOrEqual(1);
          expect(count).toBeLessThanOrEqual(2);
        }
      }
    );

    // -------------------------------------------------------------------------
    // 7e. Resume refuses anything that is not failed
    // -------------------------------------------------------------------------

    it('refuses to resume a broadcast that is not failed, and creates no chunk job', async () => {
      const broadcast = await createBroadcast({ status: 'scheduled' });
      const actorId = await createActor();
      const service = broadcastsServiceFor(clientA, jobsA);

      const before = await clientA.job.count({
        where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
      });

      await expect(service.resume(broadcast.id, actorId)).rejects.toBeInstanceOf(
        ConflictException
      );

      const after = await clientA.job.count({
        where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
      });
      expect(after).toBe(before);

      const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
        where: { id: broadcast.id },
      });
      expect(finalState.status).toBe('scheduled');
    });
  });

  // ===========================================================================
  // 8. Lease reaper give-up (#468)
  // ===========================================================================
  //
  // Section 7 above proves the TERMINAL path (`JobTerminalService.completeFailed`)
  // flips a `sending` broadcast to `failed` through a real `BroadcastFailureListener`.
  // This section proves the OTHER path that can fail a chunk job permanently:
  // the lease reaper's phase-1 give-up (`JobStuckService.resetStuck`), which
  // until #468 settled the row silently and never told the listener anything —
  // exactly the gap `broadcast-failure.listener.ts`'s own header used to
  // document. Wired end to end here with a REAL `JobStuckService`, a REAL
  // `EventEmitter2`, and a REAL `BroadcastFailureListener`, over real Postgres.
  describe('lease reaper give-up (#468)', () => {
    /** `jobs.maxAttempts` this scenario runs with — 1, so the seeded job is already at its cap. */
    const MAX_ATTEMPTS = 1;
    const STUCK_THRESHOLD_MINUTES = 30;

    /**
     * A real `JobStuckService` whose real `EventEmitter2` is wired to a real
     * `BroadcastFailureListener` over `client` — the same
     * "construct the two real objects a `@OnEvent` decorator would otherwise
     * connect" shape `terminalWithRealListener` uses above for
     * `JobTerminalService`, applied to the reaper instead.
     */
    function reaperWithRealListener(client: PrismaClient) {
      const config = {
        get: (key: string) => (key === 'jobs.maxAttempts' ? MAX_ATTEMPTS : undefined),
      } as unknown as ConfigService;
      const settings = {
        getJobsPolicy: async () => ({
          history: { retentionDays: 30, purgeEnabled: true },
          stuckThresholdMinutes: STUCK_THRESHOLD_MINUTES,
        }),
      } as unknown as SystemSettingsService;

      const emitter = new EventEmitter2();
      const listener = new BroadcastFailureListener(client as unknown as PrismaService);
      const events: JobSettledEvent[] = [];
      emitter.on(JOB_SETTLED_EVENT, (event: JobSettledEvent) => {
        events.push(event);
        listener.handleJobSettled(event);
      });

      const reaper = new JobStuckService(
        client as unknown as PrismaService,
        config,
        settings,
        new JobHandlerRegistry(),
        emitter
      );

      return { reaper, events };
    }

    /** Polls until the broadcast reaches `status`, or fails the test. */
    async function waitUntilBroadcastStatus(broadcastId: string, status: string, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const row = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcastId },
        });
        if (row.status === status) return row;
        if (Date.now() > deadline) {
          throw new Error(
            `broadcast ${broadcastId} did not reach '${status}' within ${timeoutMs}ms ` +
              `(currently '${row.status}')`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    it(
      'fails a chunk job the reaper gives up on, flips its broadcast to failed, and leaves ' +
        'the cursor and dispatch count where the last committed page put them',
      async () => {
        const [cursorUserId] = await createUsers(1, 'reaper-cursor');
        const broadcast = await createBroadcast({ status: 'sending' });
        await clientA.notificationBroadcast.update({
          where: { id: broadcast.id },
          data: { audienceCutoff: new Date(), cursorUserId, recipientsDispatched: 42 },
        });

        // A `running` chunk job, already at its (1-attempt) cap, with an
        // EXPIRED lease — signal 3 ("dead owner") alone is enough to make the
        // reaper reclaim it, regardless of how recently it started.
        const job = await clientA.job.create({
          data: {
            type: BROADCAST_CHUNK_TYPE,
            subjectType: BROADCAST_SUBJECT_TYPE,
            subjectId: broadcast.id,
            status: 'running',
            reason: 'backfill',
            attempts: MAX_ATTEMPTS,
            startedAt: new Date(),
            leaseExpiresAt: new Date(Date.now() - 60_000),
          },
        });

        const { reaper, events } = reaperWithRealListener(clientA);

        const result = await reaper.resetStuck();

        expect(result.failed).toBeGreaterThanOrEqual(1);

        // Exactly one settled event for THIS job — the sweep is global (see
        // the file header above and this suite's own db-test-support notes),
        // so other rows left `running` by a concurrently-running suite could
        // in principle also be reaped in the same pass; what must hold for
        // this test is that this job's own give-up was announced exactly once.
        const eventsForThisJob = events.filter((event) => event.jobId === job.id);
        expect(eventsForThisJob).toHaveLength(1);

        const finalState = await waitUntilBroadcastStatus(broadcast.id, 'failed');

        expect(finalState.lastError).toContain(job.id);
        expect(finalState.lastError).toContain('lease reaper');
        // Nobody past the last committed page is marked as sent.
        expect(finalState.cursorUserId).toBe(cursorUserId);
        expect(finalState.recipientsDispatched).toBe(42);
      }
    );
  });

  // ===========================================================================
  // 9. Hand-off after a post-claim failure (issue #469)
  // ===========================================================================
  //
  // `broadcast-start.handler.spec.ts` proves the SHAPE of the resume path
  // against mocks. What only a real database can answer is whether a start
  // job that genuinely fails AFTER the claim CAS (a thrown error from the
  // enqueue call, standing in for a connection drop, a worker crash, or a
  // process OOM) really does leave the broadcast recoverably `sending`, and
  // whether a subsequent execution (whether the queue's own retry or a
  // second execution racing it) really does finish the hand-off exactly
  // once against the STORED cutoff rather than starting a second fan-out.
  describe('hand-off after a post-claim failure (#469)', () => {
    /**
     * Wraps a real `JobsService` so its very first `enqueue` call rejects
     * (standing in for the crash/connection-drop this suite needs to land
     * strictly AFTER the claim CAS has already committed) and every
     * subsequent call delegates to the real service.
     */
    function jobsFailingFirstEnqueue(real: JobsService): JobsService {
      let failed = false;
      return {
        enqueue: async (params: Parameters<JobsService['enqueue']>[0]) => {
          if (!failed) {
            failed = true;
            throw new Error('simulated post-claim failure (#469)');
          }
          return real.enqueue(params);
        },
      } as unknown as JobsService;
    }

    it(
      'a retry after the first attempt fails past its claim finishes the hand-off against the ' +
        'stored cutoff, excluding a user created after that cutoff, and reaches sent',
      async () => {
        const audienceIds = await createUsers(5, 'posthandoff-audience');
        const broadcast = await createBroadcast();

        const failingJobs = jobsFailingFirstEnqueue(jobsA);
        const failingStartHandler = new BroadcastStartHandler(
          clientA as unknown as PrismaService,
          failingJobs,
          registryStub()
        );

        // --- attempt 1: claims, then fails inside handOff's enqueue ---
        await expect(
          failingStartHandler.process(startJobFor(broadcast.id, 'start-attempt-1'))
        ).rejects.toThrow('simulated post-claim failure (#469)');

        const afterAttempt1 = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        expect(afterAttempt1.status).toBe('sending');
        expect(afterAttempt1.audienceCutoff).toBeInstanceOf(Date);
        expect(afterAttempt1.startedAt).toBeInstanceOf(Date);
        // The claim committed, and handOff's count + conditional write run
        // BEFORE the enqueue call — so recipientsTargeted IS already written
        // by the time the simulated failure throws. What genuinely never
        // happened is the chunk enqueue itself.
        expect(afterAttempt1.recipientsTargeted).toBe(audienceIds.length);
        const chunksAfterAttempt1 = await clientA.job.findMany({
          where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
        });
        expect(chunksAfterAttempt1).toHaveLength(0);

        // A user created AFTER the first (failed) attempt — the cutoff was
        // already frozen by the claim, so this user must be excluded from
        // both recipientsTargeted and dispatch on the resumed hand-off.
        const [lateUserId] = await createUsers(1, 'posthandoff-late');

        // --- attempt 2: the retry, now via the real (non-failing) jobs service ---
        const retryStartHandler = new BroadcastStartHandler(
          clientA as unknown as PrismaService,
          jobsA,
          registryStub()
        );

        await expect(
          retryStartHandler.process(startJobFor(broadcast.id, 'start-attempt-2'))
        ).resolves.toBeUndefined();

        const afterAttempt2 = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        expect(afterAttempt2.status).toBe('sending');
        // The cutoff and startedAt are UNCHANGED — the resume path reuses
        // the stamp the (only) claim made, it never re-stamps.
        expect(afterAttempt2.audienceCutoff!.getTime()).toBe(afterAttempt1.audienceCutoff!.getTime());
        expect(afterAttempt2.startedAt!.getTime()).toBe(afterAttempt1.startedAt!.getTime());
        // recipientsTargeted reflects the audience AT THE STORED CUTOFF —
        // the late user is excluded.
        expect(afterAttempt2.recipientsTargeted).toBe(audienceIds.length);

        const chunksAfterAttempt2 = await clientA.job.findMany({
          where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
        });
        expect(chunksAfterAttempt2).toHaveLength(1);

        // --- drive to completion ---
        const { chunkHandler, stub } = handlersFor(clientA, jobsA);
        await runChunksToCompletion(chunkHandler, broadcast.id);

        const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        expect(finalState.status).toBe('sent');
        expect(finalState.recipientsTargeted).toBe(audienceIds.length);
        expect(finalState.recipientsDispatched).toBe(audienceIds.length);

        const dispatched = dispatchedIds(stub.calls);
        expect(dispatched.sort()).toEqual([...audienceIds].sort());
        expect(dispatched).not.toContain(lateUserId);
      }
    );

    it('a second retry after a chunk already exists is a clean no-op (still exactly one chunk)', async () => {
      await createUsers(3, 'already-chunked-audience');
      const broadcast = await createBroadcast();
      const { startHandler } = handlersFor(clientA, jobsA);

      // A normal, successful start — claims, hands off, enqueues one chunk.
      await startHandler.process(startJobFor(broadcast.id, 'start-normal'));

      const afterFirst = await clientA.notificationBroadcast.findUniqueOrThrow({
        where: { id: broadcast.id },
      });
      expect(afterFirst.status).toBe('sending');
      expect(afterFirst.cursorUserId).toBeNull();
      expect(afterFirst.recipientsDispatched).toBe(0);

      const chunksAfterFirst = await clientA.job.findMany({
        where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
      });
      expect(chunksAfterFirst).toHaveLength(1);

      // An operator (or a duplicated worker) reruns the start job. Cutoff
      // is set, cursor/dispatched are still zero (no chunk has RUN yet), but
      // a chunk job now exists — the resume guard's third check must catch
      // this and no-op.
      await startHandler.process(startJobFor(broadcast.id, 'start-rerun'));

      const chunksAfterRerun = await clientA.job.findMany({
        where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
      });
      expect(chunksAfterRerun).toHaveLength(1);
      expect(chunksAfterRerun[0].id).toBe(chunksAfterFirst[0].id);
    });

    it('a sending broadcast with real fan-out progress creates no chunk on retry', async () => {
      const [cursorUserId] = await createUsers(1, 'progress-cursor');
      const broadcast = await createBroadcast({ status: 'sending' });
      await clientA.notificationBroadcast.update({
        where: { id: broadcast.id },
        data: { audienceCutoff: new Date(), cursorUserId, recipientsDispatched: 1 },
      });
      // Deliberately NO chunk job row — standing in for one purged by job
      // history retention, which is exactly why the cursor/dispatched checks
      // must not depend on a chunk row existing.
      const { startHandler } = handlersFor(clientA, jobsA);

      await startHandler.process(startJobFor(broadcast.id, 'start-progress-retry'));

      const chunkCount = await clientA.job.count({
        where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
      });
      expect(chunkCount).toBe(0);

      const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
        where: { id: broadcast.id },
      });
      // Untouched — the resume guard's no-op leaves the row exactly as found.
      expect(finalState.status).toBe('sending');
      expect(finalState.cursorUserId).toBe(cursorUserId);
      expect(finalState.recipientsDispatched).toBe(1);
    });

    it('a broadcast canceled before the resume creates no chunk', async () => {
      await createUsers(2, 'canceled-before-resume-audience');
      const broadcast = await createBroadcast({ status: 'canceled' });
      await clientA.notificationBroadcast.update({
        where: { id: broadcast.id },
        data: { audienceCutoff: new Date(), canceledAt: new Date() },
      });
      const { startHandler } = handlersFor(clientA, jobsA);

      await expect(
        startHandler.process(startJobFor(broadcast.id, 'start-after-cancel'))
      ).resolves.toBeUndefined();

      const chunkCount = await clientA.job.count({
        where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
      });
      expect(chunkCount).toBe(0);

      const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
        where: { id: broadcast.id },
      });
      expect(finalState.status).toBe('canceled');
    });

    it(
      'two concurrent resume executions after a post-claim failure produce at most two chunks, ' +
        'and the #459 cursor CAS still collapses the fan-out to exactly one delivery per recipient',
      async () => {
        // At least two full BROADCAST_CHUNK_SIZE pages, so a genuine
        // duplicate-first-chunk race (both resume executions passing the
        // "no chunk exists" check before either enqueues) has real paging
        // behaviour to collapse, not just a single short page.
        const audienceIds = await createUsers(2 * BROADCAST_CHUNK_SIZE + 15, 'double-resume-audience');
        const broadcast = await createBroadcast();

        const failingJobs = jobsFailingFirstEnqueue(jobsA);
        const failingStartHandler = new BroadcastStartHandler(
          clientA as unknown as PrismaService,
          failingJobs,
          registryStub()
        );

        // The claim, deliberately failing past it — broadcast is `sending`,
        // cutoff stamped, NO chunk row.
        await expect(
          failingStartHandler.process(startJobFor(broadcast.id, 'start-claim'))
        ).rejects.toThrow('simulated post-claim failure (#469)');

        const chunksBeforeResume = await clientA.job.count({
          where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
        });
        expect(chunksBeforeResume).toBe(0);

        // Two SEPARATE PrismaClients, exactly like the "exactly one of two
        // concurrent start executions" test above, so the race is resolved
        // by real Postgres row locking rather than an in-process mutex.
        const resumeA = new BroadcastStartHandler(clientA as unknown as PrismaService, jobsA, registryStub());
        const resumeB = new BroadcastStartHandler(clientB as unknown as PrismaService, jobsB, registryStub());

        await expect(
          Promise.all([
            resumeA.process(startJobFor(broadcast.id, 'start-resume-a')),
            resumeB.process(startJobFor(broadcast.id, 'start-resume-b')),
          ])
        ).resolves.toBeDefined();

        const chunkRows = await clientA.job.findMany({
          where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id },
          orderBy: { createdAt: 'asc' },
        });
        // Both resume executions may pass the "no chunk exists" read before
        // either commits its recipientsTargeted write, so up to two FIRST
        // chunks may be enqueued (unlike the single-claim CAS test above,
        // this resume guard's existence check is not itself atomic with the
        // enqueue — the #459 cursor CAS inside the chunk handler is what
        // bounds the resulting duplication, not this check).
        expect(chunkRows.length).toBeGreaterThanOrEqual(1);
        expect(chunkRows.length).toBeLessThanOrEqual(2);

        const { chunkHandler, stub } = handlersFor(clientA, jobsA);
        // Drive every chunk row (both first-chunk duplicates, if two were
        // created, plus every successor either enqueues) to completion.
        let guard = 0;
        for (;;) {
          guard += 1;
          if (guard > 50) {
            throw new Error('runaway chunk chain in double-resume test');
          }
          const job = await clientA.job.findFirst({
            where: { type: BROADCAST_CHUNK_TYPE, subjectType: BROADCAST_SUBJECT_TYPE, subjectId: broadcast.id, status: 'pending' },
            orderBy: { createdAt: 'asc' },
          });
          if (!job) break;
          await chunkHandler.process(job);
          await clientA.job.update({ where: { id: job.id }, data: { status: 'succeeded' } });
        }

        const finalState = await clientA.notificationBroadcast.findUniqueOrThrow({
          where: { id: broadcast.id },
        });
        expect(finalState.status).toBe('sent');
        // The #459 cursor CAS allows at most one increment per page, so the
        // final dispatched count equals the audience size exactly, never
        // more, however many duplicate first chunks were created above.
        expect(finalState.recipientsDispatched).toBe(audienceIds.length);

        const dispatched = dispatchedIds(stub.calls);
        const uniqueDispatched = new Set(dispatched);
        for (const id of audienceIds) {
          expect(uniqueDispatched.has(id)).toBe(true);
        }
        expect(uniqueDispatched.size).toBe(audienceIds.length);

        // Duplicate dispatches (from the same recipient being paged by two
        // racing first chunks before the cursor CAS resolved) are bounded by
        // one full chunk size — the whole first page could, in the worst
        // case, be sent by both racing executions before one loses its CAS.
        const counts = new Map<string, number>();
        for (const id of dispatched) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        let duplicateCount = 0;
        for (const [, count] of counts) {
          expect(count).toBeGreaterThanOrEqual(1);
          duplicateCount += count - 1;
        }
        expect(duplicateCount).toBeLessThanOrEqual(BROADCAST_CHUNK_SIZE);
      }
    );
  });
});
