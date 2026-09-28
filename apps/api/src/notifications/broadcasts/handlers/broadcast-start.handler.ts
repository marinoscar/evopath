// =============================================================================
// Broadcast start: claim, freeze, count, hand off (issue #323, epic #319)
// =============================================================================
//
// The first of the two job types that make up a broadcast fan-out. It sends
// NOTHING. Its entire job is to turn a `scheduled` broadcast into a `sending`
// one exactly once, decide who is in the audience, and enqueue the first
// chunk; `broadcast-chunk.handler.ts` does the delivering.
//
// That split is what makes scheduling free. The start job is enqueued with
// `scheduledFor: broadcast.scheduledFor ?? undefined` (#324 owns the enqueue),
// so "send this on Friday at 09:00" is a `jobs` row the claim query ignores
// until Friday — durable across every restart and every redeploy between now
// and then, invisible to every replica's claim until it is due, and using the
// `[status, scheduledFor, priority, createdAt]` index that was built for
// exactly this. A `@Cron` sweeper polling for due broadcasts was rejected: it
// is a second scheduler doing worse what `Job.scheduledFor` already does
// durably, and a second place where "is it time yet?" gets decided.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, by carrying NEITHER `nodeResultSchema` NOR `persistNodeResult`
// -----------------------------------------------------------------------------
//
// The default per `handlers/README.md`, and here it is the only correct
// answer. A worker node has no database access and no mail credentials; this
// handler IS a sequence of database statements against `notification_broadcasts`
// and `users`, so there is nothing for a remote machine to compute and nothing
// it could post back that the server would not have had to compute itself.
// `JobHandlerRegistry.serverOnlyTypes()` derives that from the absence of the
// pair, so a `JOBS_WORKER_MODE=system` API server keeps running broadcasts
// while the fleet takes node-eligible work. Both broadcast handlers are
// server-only for the same reason.
//
// -----------------------------------------------------------------------------
// DEDUP IS LEFT ON HERE — AND OFF ON THE CHUNK HANDLER
// -----------------------------------------------------------------------------
//
// This job takes the queue's default (`skipDedup` unset), so while a start job
// for a broadcast is `pending` or `running`, a second `enqueue` for the same
// subject returns the row already in flight instead of creating another. A
// double-clicked "Send now" therefore cannot produce two fan-outs at the job
// layer at all. The chunk handler needs the opposite and says so at length in
// its own header — the two settings are deliberate opposites, not an
// inconsistency.
//
// Note that dedup is a CONVENIENCE here, not the correctness argument. It is
// scoped to jobs that are still active, so it says nothing about a start job
// that already succeeded and is rerun by an operator from the admin dashboard.
// The compare-and-swap below is what makes that harmless for a broadcast that
// is already under way, and the resume guard (next section) is what makes it
// harmless for one whose hand-off never finished.
//
// -----------------------------------------------------------------------------
// IDEMPOTENT PAST ITS CLAIM (issue #469)
// -----------------------------------------------------------------------------
//
// The claim and the hand-off are separate statements: the CAS flips
// `scheduled` -> `sending` and stamps `startedAt`/`audienceCutoff`, and only
// then is the audience counted, `recipientsTargeted` written and the first
// chunk enqueued. If anything after the claim throws, the retry finds the
// broadcast already `sending` — so a CAS-only handler would match nothing,
// report `succeeded`, and strand the broadcast in `sending` with no chunk
// chain behind it.
//
// So a start job is idempotent past its claim: any start execution that finds
// the broadcast `sending` with no cursor, no dispatches and NO chunk job (in
// any status) finishes the hand-off itself, using the STORED cutoff. Any job
// for this broadcast may do that safely, not only the one that claimed it:
//
//   - the cutoff is frozen by the claim and is never re-stamped, so the
//     resumed hand-off pages exactly the population the claim defined;
//   - the recount is the same documented snapshot the fresh path takes
//     (`recipientsTargeted` means "targeted at send time", not a guarantee);
//   - if two executions race through the resume (a zombie whose lease was
//     reaped still running alongside its replacement), each may enqueue a
//     first chunk, and #459's cursor compare-and-swap in the chunk handler
//     collapses that to at most one page of duplicate deliveries.
//
// Side effect worth knowing operationally: a broadcast already stuck in
// `sending` from before this fix can be repaired by retrying its start job
// from the admin Jobs page.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from '@prisma/client';

import { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { JobsService } from '../../../jobs/jobs.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { BROADCAST_SUBJECT_TYPE, audienceWhere } from '../broadcast-audience';
import { broadcastJobDeleteRefusal } from '../broadcast-job-delete-guard';
import { BROADCAST_CHUNK_TYPE } from './broadcast-chunk.handler';

/**
 * The handler key, and therefore the `Job.type` every broadcast start row
 * carries.
 *
 * Dotted, lowercase and PERMANENT per `JobHandler.type`'s contract: `jobs`
 * rows outlive the handler that produced them, so renaming this orphans every
 * historical row and every broadcast already scheduled under the old name —
 * which for this type means a scheduled announcement that silently never
 * fires.
 *
 * Exported because #324's API enqueues it by name, and two string literals is
 * one typo away from a "Send now" button that queues work no handler claims.
 */
export const BROADCAST_START_TYPE = 'admin.broadcast.start';

@Injectable()
export class BroadcastStartHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(BroadcastStartHandler.name);

  readonly type = BROADCAST_START_TYPE;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly registry: JobHandlerRegistry
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Refuses the admin delete of a still-runnable job whose broadcast is
   * `scheduled` or `sending` (#480): that row is what advances the broadcast,
   * and deleting it strands the broadcast. See `broadcast-job-delete-guard.ts`
   * — both broadcast handlers answer through the same function.
   */
  canDelete(job: Job): Promise<string | null> {
    return broadcastJobDeleteRefusal(this.prisma, job);
  }

  /**
   * Claims the broadcast, freezes its audience, counts it, and enqueues the
   * first chunk.
   *
   * THROWS TO FAIL. Every database call below is unguarded on purpose: a
   * connection error must reach the worker so it lands in `Job.lastError` and
   * is retried on the queue's budget. The compare-and-swap makes a retry
   * that fails BEFORE the claim safe, and `resumeHandOff` makes one that fails
   * AFTER it safe (#469) — see the file header.
   */
  async process(job: Job): Promise<void> {
    const broadcastId = job.subjectId;

    if (!broadcastId) {
      // A start job with no subject names no broadcast. Nothing to do, and
      // nothing a retry would fix, so this is a completed no-op rather than a
      // throw that would burn the whole attempt budget on a malformed row.
      this.logger.warn(`Broadcast start job ${job.id} carries no subjectId; nothing to send`);

      return;
    }

    const broadcast = await this.prisma.notificationBroadcast.findUnique({
      where: { id: broadcastId },
      select: {
        id: true,
        status: true,
        audienceCutoff: true,
        cursorUserId: true,
        recipientsDispatched: true,
      },
    });

    if (!broadcast) {
      // A DELETED BROADCAST IS A NO-OP, NOT A FAILURE. #324 lets an admin
      // delete a broadcast, and a scheduled start job for it is still sitting
      // in the queue — deleting the `jobs` row instead would race with a
      // claim. Returning normally is the honest outcome: there is nothing to
      // send, retrying will not make the row reappear, and a `failed` job with
      // "broadcast not found" would ask an operator to investigate a state the
      // system deliberately allows.
      this.logger.log(
        `Broadcast ${broadcastId} no longer exists; start job ${job.id} is a no-op`
      );

      return;
    }

    // ALREADY CLAIMED: finish an interrupted hand-off, or do nothing (#469).
    // The CAS below could only match nothing for a `sending` row, so going
    // straight to the resume path loses nothing — and the resume path's own
    // guards decide whether there is anything left to do.
    if (broadcast.status === 'sending') {
      await this.resumeHandOff(job, broadcast);

      return;
    }

    // ONE `now`, USED FOR BOTH TIMESTAMPS. `startedAt` and `audienceCutoff`
    // are two readings of the same instant — "the fan-out began here" and
    // "the audience is whoever existed here" — and two `new Date()` calls
    // would let a slow statement put microseconds between them. Nothing
    // observable breaks at that scale; taking the value once means nothing
    // has to be argued about it.
    const now = new Date();

    // =========================================================================
    // THE COMPARE-AND-SWAP. This is the real duplicate gate.
    // =========================================================================
    //
    // Everything else in this file is bookkeeping. This statement is the one
    // that guarantees a broadcast fans out exactly once, and it does so by
    // putting the CURRENT STATUS IN THE `WHERE` rather than in an `if`.
    //
    // WHY A READ-THEN-WRITE WOULD BE WRONG, concretely:
    //
    //     const b = await findUnique(...);          // status: 'scheduled'
    //     if (b.status !== 'scheduled') return;     // ← passes
    //     // ... an admin cancels here: status := 'canceled' ...
    //     await update({ data: { status: 'sending' } });   // ← resurrects it
    //
    // The window between the read and the write is small and it is real, and
    // what falls into it is a cancelled announcement going out to everybody.
    // Cancel is implemented (#324) as its own conditional write —
    // `updateMany({ where: { id, status: { in: ['scheduled', 'sending',
    // 'failed'] } } })` (`failed` since #459) — so the two statements race in the DATABASE, where exactly one of them
    // can win, instead of racing across a round trip in application code where
    // both can.
    //
    // `updateMany` rather than `update` is not a style choice: `update`
    // requires a unique `where` and throws `P2025` when it matches nothing,
    // which would turn "somebody already claimed this" into a failed job and a
    // retry. `updateMany` reports it as `count: 0`, which is a fact to branch
    // on rather than an exception to interpret.
    //
    // WHAT THIS BUYS, in order of importance:
    //
    //   1. TWO CONCURRENT START JOBS CANNOT BOTH PROCEED. Job-layer dedup
    //      makes that unlikely; this makes it impossible, including across
    //      replicas and including when a lease expired and another worker
    //      reclaimed the row while the first was still running.
    //   2. AN OPERATOR'S MANUAL RERUN OF A SUCCEEDED START JOB IS HARMLESS.
    //      The admin Jobs dashboard offers a rerun, and dedup does not cover
    //      an already-terminal row. On the rerun the broadcast is `sending`,
    //      `sent`, `failed` or `canceled` — never `scheduled` — so nothing is
    //      claimed and, crucially, nothing is re-stamped. A `sending` row is
    //      routed to `resumeHandOff` before this statement (#469), which only
    //      acts when the hand-off demonstrably never finished — no cursor, no
    //      dispatches, no chunk job — and then reuses the stored cutoff.
    //   3. `audienceCutoff` IS WRITTEN EXACTLY ONCE. It is set in the same
    //      statement that consumes the only status a claim can happen from, so
    //      no second execution can move it — the resume path reads it and
    //      never writes it. That matters more than it looks:
    //      the cutoff is the definition of the audience, and a rerun that
    //      re-stamped it mid-fan-out would silently redefine who the broadcast
    //      was for while the chunks were already walking the old population.
    //
    // `draft` is deliberately NOT accepted here. It is unreachable by any
    // route in #319 (see the enum's comment in schema.prisma) and a start job
    // for one would be a bug worth leaving visible as a no-op, not something
    // to paper over by widening the claim.
    const claimed = await this.prisma.notificationBroadcast.updateMany({
      where: { id: broadcastId, status: 'scheduled' },
      data: { status: 'sending', startedAt: now, audienceCutoff: now },
    });

    if (claimed.count === 0) {
      // The loser of two simultaneous claims (both read `scheduled`, one swap
      // won), a cancel that landed between the read and the swap, or a
      // non-`scheduled`, non-`sending` status. Nothing to do — the winner, if
      // any, owns the hand-off, and it is idempotent past its claim if it
      // fails (see the file header).
      this.logger.log(
        `Broadcast ${broadcastId} is '${broadcast.status}', not 'scheduled'; ` +
          `start job ${job.id} claimed nothing and is a no-op`
      );

      return;
    }

    const handedOff = await this.handOff(broadcastId, now);

    if (!handedOff) {
      this.logger.log(
        `Broadcast ${broadcastId} left 'sending' (canceled) after start job ${job.id} ` +
          `claimed it; no chunk queued`
      );

      return;
    }

    this.logger.log(
      `Broadcast ${broadcastId} claimed by start job ${job.id}: ` +
        `${handedOff.recipientsTargeted} recipient(s) targeted as of ${now.toISOString()}; ` +
        `first chunk queued as job ${handedOff.chunkJobId}`
    );
  }

  /**
   * Finishes the hand-off for a broadcast an earlier start attempt claimed but
   * never handed to a chunk chain (#469), or logs a no-op.
   *
   * Proceeds only when ALL FOUR hold, and every one of them is load-bearing:
   *
   *   - `audienceCutoff !== null` — the claim stamped it; without it there is
   *     no frozen population to resume against (and this is not a row a claim
   *     produced).
   *   - `cursorUserId === null` and `recipientsDispatched === 0` — no chunk
   *     has made progress. On their own these MISS a first chunk that is still
   *     `pending`, or one rate-limit-deferred at its very first recipient
   *     (#456), which has made no progress yet but is alive.
   *   - NO chunk job exists for this broadcast, in ANY status. On its own this
   *     MISSES a chain whose old chunk rows were deleted by the job history
   *     purge — which is why the cursor/dispatched checks stay. "Any status"
   *     is right because a chunk that ended `failed` already flipped the
   *     broadcast to `failed` through #459's listener, so a `failed` chunk row
   *     beside a `sending` broadcast is not a state this path needs to heal.
   *
   * The lookup is served by the `[subjectType, subjectId]` index on `jobs`.
   */
  private async resumeHandOff(
    job: Job,
    broadcast: {
      id: string;
      audienceCutoff: Date | null;
      cursorUserId: string | null;
      recipientsDispatched: number;
    }
  ): Promise<void> {
    const noOp = (why: string): void => {
      this.logger.log(
        `Broadcast ${broadcast.id} is 'sending' (${why}); ` +
          `start job ${job.id} claimed nothing and is a no-op`
      );
    };

    if (broadcast.audienceCutoff === null) {
      noOp('no audience cutoff');

      return;
    }

    if (broadcast.cursorUserId !== null || broadcast.recipientsDispatched > 0) {
      noOp('fan-out already in progress');

      return;
    }

    const existingChunk = await this.prisma.job.findFirst({
      where: {
        type: BROADCAST_CHUNK_TYPE,
        subjectType: BROADCAST_SUBJECT_TYPE,
        subjectId: broadcast.id,
      },
      select: { id: true },
    });

    if (existingChunk) {
      noOp(`chunk job ${existingChunk.id} already exists`);

      return;
    }

    // The STORED cutoff, never a fresh `now`: the claim froze the audience,
    // and resuming against a later instant would silently widen it.
    const handedOff = await this.handOff(broadcast.id, broadcast.audienceCutoff);

    if (!handedOff) {
      this.logger.log(
        `Broadcast ${broadcast.id} left 'sending' (canceled) before start job ${job.id} ` +
          `could resume its hand-off; no chunk queued`
      );

      return;
    }

    this.logger.log(
      `Start job ${job.id} resumed hand-off for broadcast ${broadcast.id} claimed by an ` +
        `earlier attempt: ${handedOff.recipientsTargeted} recipient(s) targeted as of ` +
        `${broadcast.audienceCutoff.toISOString()}; first chunk queued as job ${handedOff.chunkJobId}`
    );
  }

  /**
   * The three hand-off steps — count, record `recipientsTargeted`, enqueue the
   * first chunk — shared by the fresh-claim path (with the `now` it just
   * stamped) and the resume path (with the stored cutoff), so the two cannot
   * drift apart.
   *
   * Returns `null`, having enqueued nothing, when the broadcast is no longer
   * `sending` by the time `recipientsTargeted` is written — a cancel won.
   */
  private async handOff(
    broadcastId: string,
    cutoff: Date
  ): Promise<{ recipientsTargeted: number; chunkJobId: string } | null> {
    // Counted with the SAME predicate the chunks page with — see
    // `broadcast-audience.ts` for why that is one exported function and not
    // two hand-written `where` clauses. Counted against the cutoff the claim
    // stamped (the fresh path passes the value it just wrote; the resume path
    // passes the stored one).
    //
    // A SNAPSHOT, NOT A GUARANTEE: users deactivated mid-fan-out are skipped
    // by later pages, so `recipientsDispatched` may legitimately finish below
    // this number. The column means "targeted at send time"; the schema says
    // so too.
    const recipientsTargeted = await this.prisma.user.count({ where: audienceWhere(cutoff) });

    // CONDITIONAL on `sending`, like every other write that races a cancel. If
    // an admin cancelled between the claim and here, this matches nothing and
    // no chunk is queued — the cancel wins cleanly instead of being left for
    // the first chunk's own status check to notice.
    const recorded = await this.prisma.notificationBroadcast.updateMany({
      where: { id: broadcastId, status: 'sending' },
      data: { recipientsTargeted },
    });

    if (recorded.count === 0) {
      return null;
    }

    // The handoff. From here the start job is done: every recipient is
    // dispatched by chunk jobs, each of which enqueues its successor.
    //
    // `skipDedup: true` even on the FIRST chunk, and it is the same
    // requirement the chunk handler's header explains at length: a chunk
    // enqueues its successor from inside its own `process()` while it is
    // itself still `running`, so chunks of one broadcast are legitimately
    // distinct work sharing a subject — precisely the case `skipDedup`
    // exists for. Setting it here as well keeps every chunk enqueue in the
    // fan-out identical, so nobody reading one of them has to work out
    // whether this one is the exception.
    const chunkJob = await this.jobs.enqueue({
      type: BROADCAST_CHUNK_TYPE,
      // `backfill`, reused rather than extended. `JobReason` has exactly three
      // values (`upload` | `rerun` | `backfill`) and it is a Prisma enum, so
      // adding `broadcast` would be a migration, plus the web-side
      // `JOB_REASONS` array, plus DTO and OpenAPI churn — all for a display
      // string. `job-history-purge.task.ts` already makes this trade for the
      // same reason; the friendly type label in `job-type-labels.ts` is what
      // actually carries the meaning to a human reading the dashboard.
      reason: 'backfill',
      subjectType: BROADCAST_SUBJECT_TYPE,
      subjectId: broadcastId,
      skipDedup: true,
    });

    return { recipientsTargeted, chunkJobId: chunkJob.id };
  }
}
