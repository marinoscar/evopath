// =============================================================================
// Broadcast chunk: one cursor-paged page of the fan-out (issue #323, epic #319)
// =============================================================================
//
// The half that actually sends. One `admin.broadcast.chunk` job dispatches at
// most `BROADCAST_CHUNK_SIZE` recipients, commits its progress, and enqueues
// its own successor — so a broadcast of any size is a CHAIN of small, bounded,
// individually retryable jobs rather than one long-running one.
//
// WHY A CHAIN AND NOT THE TWO OBVIOUS ALTERNATIVES:
//
//   - ONE JOB PER RECIPIENT is genuinely right at a different scale, and wrong
//     here. Thousands of `jobs` rows per broadcast make the admin dashboard
//     unusable, give `job-history-purge` thousands of rows per send to grind
//     through, render `job_stats_rollup`'s per-type averages meaningless (an
//     "average broadcast job" would measure one email), and turn a single
//     "Send now" into thousands of inserts.
//   - ONE LONG-RUNNING JOB WITH AN IN-MEMORY LOOP resumes correctly enough,
//     and still fails on everything around it: it holds a worker slot for the
//     entire broadcast, starving a queue sized for human-triggered work; the
//     lease-expiry sweep would have to be tuned to a runtime nobody can
//     predict; and the Jobs page shows one perpetually-`running` row with no
//     progress in it.
//
// SERVER-ONLY — neither `nodeResultSchema` nor `persistNodeResult`, the
// default. A worker node has no database access and no mail credentials, and
// this handler needs both on every page.
//
// =============================================================================
// ⚠ THIS JOB TYPE MUST BE ENQUEUED WITH `skipDedup: true`. ALWAYS.
// =============================================================================
//
// Not a preference. Omitting it does not raise an error, fail a job, or log a
// warning — IT ENDS THE BROADCAST SILENTLY, and this is what that looks like:
//
//   1. Chunk n is claimed and its `jobs` row moves to `running`.
//   2. From inside its own `process()` — while it is still `running` — chunk n
//      enqueues chunk n+1 for the SAME `subjectType`/`subjectId`.
//   3. With dedup on, `buildDedupKey(type, subjectType, subjectId)` produces
//      the identical key, the active-dedup unique index rejects the insert,
//      and `JobsService.enqueue` resolves it by RETURNING THE JOB ALREADY IN
//      FLIGHT — which is chunk n, the job doing the enqueueing.
//   4. `enqueue` returned a job. Nothing threw. Chunk n returns normally and
//      its row goes `succeeded`.
//
// The broadcast stops dead after one page — 200 recipients out of however many
// — with every job row `succeeded`, `lastError` empty, and no exception
// anywhere to point at. The only visible symptom is a progress counter that
// stopped, which is indistinguishable from a send that finished.
//
// Chunks of one broadcast are the textbook case `skipDedup` exists for:
// several jobs of the same type against the same subject that are genuinely
// distinct work. Both enqueue sites pass it (here, and the first chunk in
// `broadcast-start.handler.ts`), and `broadcast-chunk.handler.spec.ts` asserts
// it explicitly on both — because the failure mode above is exactly the kind
// that no other test would notice.
//
// -----------------------------------------------------------------------------
// ORDERING AND IDEMPOTENCE: DUPLICATE OVER DROP, BOUNDED AT 200
// -----------------------------------------------------------------------------
//
// The queue is AT-LEAST-ONCE, never exactly-once: a job can run twice after a
// retry, or after a lease expired because the process executing it was killed
// mid-run. So the question is not whether a chunk can run twice — it is what
// happens when it does.
//
// THE CURSOR IS COMMITTED AFTER THE PAGE IS DISPATCHED, never before. A
// process killed halfway through a page therefore re-sends AT MOST
// `BROADCAST_CHUNK_SIZE` (200) recipients when the job is retried, because the
// cursor still points at the start of that page.
//
// (A PROVIDER THROTTLE is the one case that commits a PARTIAL page instead —
// the longest contiguous prefix that went out — and it keeps the same rule;
// see "A throttling provider is the one failure that stops a page" below.)
//
// That is a deliberate choice, and the alternative is strictly worse.
// Advancing the cursor FIRST would make the same crash SKIP up to 200 people:
//
//   - The duplicate is bounded (200), visible (recipients say so, and
//     `notification_deliveries` has two rows), and self-correcting (the send
//     completes).
//   - The drop is bounded by the same number but INVISIBLE and PERMANENT.
//     Nothing records who was skipped: the cursor moved, the job succeeded,
//     the counters look plausible, and the only evidence is 200 people who
//     never heard about the maintenance window. It cannot be detected after
//     the fact and it cannot be repaired without re-sending to everybody.
//
// TWO CHAINS COLLAPSE TO ONE WITHIN A PAGE (issue #459). The progress write
// is a COMPARE-AND-SWAP on the cursor this chunk read when it started:
// `WHERE id = ? AND cursor_user_id = <cursor read>` (`IS NULL` for the first
// page). Two executions can legitimately be walking the same broadcast at
// once — a Resume from the Broadcasts page plus an admin retrying the old
// failed chunk from the Jobs page, or a lease-expired chunk still running
// beside its re-claimed duplicate. Both read the same cursor and send the same
// page (that page is the duplicate, bounded at one page as above), but only
// the first to commit moves the cursor; the second matches zero rows, returns
// normally, and queues NO successor and writes NO finish. So a doubled chain
// dies at the end of the first page it shares instead of doubling every page
// after it. Losing that race on a throttled page (#456) also returns normally
// rather than throwing `RateLimitError` — the winning chain owns the
// broadcast now, and deferring the loser would only resurrect the duplicate.
//
// TIGHTENING THE BOUND IS A CONSTANT CHANGE, on purpose. The dispatch loop is
// already written as an outer walk over sub-groups of
// `STATUS_RECHECK_INTERVAL` recipients (that walk exists for cancel latency),
// so flushing the cursor at the end of each group instead of at the end of the
// page moves the duplicate bound from 200 to 25 without restructuring
// anything — one update call relocated inside the existing loop. It is not
// done today because each flush is a round trip per group, and 200 duplicate
// notifications on a crash is an acceptable worst case for a feature whose
// crash rate is a deploy.
//
// -----------------------------------------------------------------------------
// THROW TO FAIL — AND WHAT CANNOT FAIL
// -----------------------------------------------------------------------------
//
// Every database call here is unguarded: the page read, the progress update,
// the terminal write and the successor enqueue all propagate. That is the
// point of "throw to fail" — the worker records the message in `Job.lastError`
// and retries, and the retry resumes FROM THE PERSISTED CURSOR rather than
// from the beginning, because the cursor is durable state and not a loop
// variable. A `try/catch` that swallowed here would produce a `succeeded` job
// for a broadcast that stopped, which is the same silent failure the dedup
// warning above describes, arrived at a different way.
//
// `notifyNow` is the exception, and it is an exception BY CONSTRUCTION rather
// than by our catching it: it routes its work through `runContained`, which
// attaches a `.catch()` before the promise can reject, and every layer beneath
// it (the channel contract returns `{ success: false }`, the delivery service
// swallows its own database errors, `deliverOne` wraps every channel call
// anyway) is separately defensive. One recipient's dead mailbox therefore
// cannot fail a chunk, which is the property that matters: without it, a
// single unroutable address would burn the job's whole attempt budget and take
// the other 199 recipients of that page with it, over and over.
//
// -----------------------------------------------------------------------------
// A THROTTLING PROVIDER IS THE ONE FAILURE THAT STOPS A PAGE (issue #456)
// -----------------------------------------------------------------------------
//
// "One recipient's failure cannot fail a chunk" was, until #456, also true of
// a failure that was not about the recipient at all: the email provider
// saying "slow down". Every refusal became a failed delivery row, `notifyNow`
// resolved normally, and the chunk committed its cursor, queued its successor
// and carried on sending into a provider that was refusing everything — so
// the rest of the audience was written off, one failed row at a time, with
// nothing ever retrying them. The provider throttle gate could not help,
// because it trips only on a handler THROWING `RateLimitError`, and the email
// channel is contracted never to throw.
//
// The channel still never throws. Instead `notifyNow` now RESOLVES a
// `NotifyNowResult` saying whether any channel was refused by a throttling
// provider, and this handler is where that becomes a throw — the one layer
// that is allowed to raise, raising the one error the queue already knows how
// to handle. On the first rate-limited recipient of a page:
//
//   1. STOP LAUNCHING. No further sends start from this page; the ones
//      already in flight (at most `BROADCAST_SEND_CONCURRENCY - 1` others)
//      are allowed to finish, because an issued send cannot be recalled and
//      abandoning its promise would only lose the record of it.
//   2. COMMIT THE LONGEST CONTIGUOUS PREFIX. The cursor moves to the LAST id
//      of the longest run, from the start of the page in id order, of
//      recipients whose dispatch COMPLETED and was NOT rate-limited — and
//      `recipientsDispatched` advances by that run's length, in the same
//      single update as always. Recipients after it, INCLUDING ones that
//      finished successfully out of order behind a throttled one, are sent
//      again on resume. That is "duplicate over drop" applied to a partial
//      page: nobody is skipped, and the duplicate is bounded by the pool
//      size, since only sends already in flight can have landed past the
//      first throttled index.
//   3. NO SUCCESSOR, NO FINISH. The page is not done, so neither the chain
//      nor the terminal state may move.
//   4. THROW `RateLimitError` (with the longest `Retry-After` any recipient's
//      provider named). `JobTerminalService.completeFailed` classifies it
//      FIRST, ahead of any other rule, and defers THIS chunk's row back to
//      `pending` under the `JOBS_RATELIMIT_*` backoff — un-charging the
//      claim-time attempt, counting against `rateLimitHits` instead of
//      `attempts` — and trips `ProviderThrottleService` for every job type
//      mapped to `BROADCAST_EMAIL_PROVIDER_KEY` (see `onModuleInit`), so a
//      second broadcast's chunk waits out the same cooldown instead of
//      rediscovering it. When the deferred row is claimed again it re-reads
//      the broadcast, pages from the committed cursor exactly as any retry
//      does, and resumes with the first recipient that did not make it.
//
// A cancel still wins: if the status is no longer `sending` by the time the
// page stops, the chunk returns normally rather than throwing — deferring a
// chunk the status guard would only no-op on resume is a wasted claim and a
// misleading `rateLimitHits` on its row.
//
// ⚠ THE RATE-LIMIT BUDGET IS PER CHUNK ROW. `rateLimitHits` lives on the job
// that deferred, so a single page that is throttled more than
// `JOBS_RATELIMIT_MAX_HITS` times fails that chunk permanently, exactly like a
// chunk that spent its ordinary attempt budget.
//
// -----------------------------------------------------------------------------
// A PERMANENTLY FAILED CHUNK FAILS THE BROADCAST; RESUME CONTINUES IT (#459)
// -----------------------------------------------------------------------------
//
// This handler does not detect its own give-up — it cannot know which attempt
// is its last. `broadcast-failure.listener.ts` does, from `JOB_SETTLED_EVENT`:
// it moves the broadcast `sending` -> `failed` with a `lastError` naming the
// job. The cursor is left exactly where the last committed page put it, and
// nobody past it is marked as sent. `POST /api/admin/broadcasts/:id/resume`
// (`BroadcastsService.resume`) flips it back to `sending` and enqueues a fresh
// chunk (with `skipDedup: true`, per the warning above), which pages from
// that persisted cursor like any retry.
//
// -----------------------------------------------------------------------------
// CANCEL IS A STATUS, NOT A DELETION
// -----------------------------------------------------------------------------
//
// #324's cancel flips the status with `updateMany({ where: { id, status: { in:
// ['scheduled','sending','failed'] } } })` (`failed` since #459) and does NOT
// delete pending `jobs` rows — deleting one races with a claim, and letting
// the row run and no-op keeps the audit trail in `jobs` intact. This handler is the other side of that
// contract, in two places:
//
//   1. The status guard at the top: a chunk that finds anything other than
//      `sending` returns immediately, having sent nothing. That is also what
//      neutralises a replayed or stale chunk from a broadcast that has since
//      finished — or FAILED (#459): retrying the dead chunk from the Jobs page
//      does NOT resume a `failed` broadcast, it no-ops here. Resume is the
//      broadcast's own action (`POST /api/admin/broadcasts/:id/resume`),
//      because only it flips the status back and clears `lastError`.
//   2. The mid-page re-read every `STATUS_RECHECK_INTERVAL` recipients, so a
//      cancel does not have to wait out a whole page of sends before it takes
//      effect.
//
// Worst case one in-flight sub-group still goes out after the click. #324's
// API description and #325's confirm dialog both have to say so; there is no
// implementation that makes an already-issued send un-happen.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, NotificationBroadcast } from '@prisma/client';

import type { BroadcastEmailData } from '../../../email/templates/broadcast.email';
import { JobHandler } from '../../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../../jobs/job-handler.registry';
import { JobsService } from '../../../jobs/jobs.service';
import { ProviderThrottleService } from '../../../jobs/provider-throttle.service';
import { RateLimitError } from '../../../jobs/rate-limit.error';
import { PrismaService } from '../../../prisma/prisma.service';
import type { NotificationChannel } from '../../notification-events';
import type { NotifyNowResult, NotifyOptions } from '../../notification.types';
import { NotificationsService } from '../../notifications.service';
import {
  BROADCAST_CHUNK_SIZE,
  BROADCAST_SEND_CONCURRENCY,
  BROADCAST_SUBJECT_TYPE,
  audienceWhere,
} from '../broadcast-audience';
import { broadcastJobDeleteRefusal } from '../broadcast-job-delete-guard';

/**
 * The handler key, and therefore the `Job.type` every chunk row carries.
 *
 * Dotted, lowercase and PERMANENT, per `JobHandler.type` — renaming it strands
 * every chunk already queued for a broadcast mid-flight, which is the one
 * moment a broadcast cannot survive losing its successor.
 *
 * Exported because `broadcast-start.handler.ts` enqueues the first chunk by
 * name and this file enqueues every later one; two literals is one typo away
 * from a fan-out that stops after the start job.
 */
export const BROADCAST_CHUNK_TYPE = 'admin.broadcast.chunk';

/**
 * The `ProviderThrottleService` quota key broadcast chunks draw on (#456).
 *
 * A KEY, NOT THE JOB TYPE, because the throttle gate keys by PROVIDER QUOTA:
 * a job type with no registered key makes `trip` and `acquire` silent no-ops,
 * so without this mapping a chunk's `RateLimitError` would defer its own row
 * but teach nothing to a concurrent broadcast's chunk, which would go and
 * collect its own refusal. Named for the transport rather than for
 * broadcasts so a future job type that also sends through the configured
 * email provider — the same account, the same quota — can register under it
 * and share the cooldown, which is exactly what the gate's key indirection is
 * for. The gate is in-memory and per process; the durable half of the
 * backpressure is the deferred `scheduled_for` on the chunk's row, which every
 * replica honours.
 */
export const BROADCAST_EMAIL_PROVIDER_KEY = 'notifications.email';

/**
 * How many recipients are dispatched between status re-reads.
 *
 * A CANCEL-LATENCY BOUND. Without it, "Cancel" clicked one recipient into a
 * page still sends the remaining 199 — technically correct (the guard at the
 * top of the next chunk stops the broadcast) and indefensible to the operator
 * watching it happen. With it, an admin waits for at most this many sends.
 *
 * Also the seam the file header names for tightening the duplicate bound: the
 * outer loop this constant drives is where a per-group cursor flush would go.
 *
 * 25 is one extra `SELECT status` per 25 sends — negligible next to the
 * network calls those sends make — and small enough that cancel feels
 * immediate at any realistic send rate.
 */
const STATUS_RECHECK_INTERVAL = 25;

/** The columns a chunk reads. Everything the page, the payload and the guard need. */
const BROADCAST_SELECT = {
  id: true,
  title: true,
  body: true,
  link: true,
  ctaLabel: true,
  eventKey: true,
  channels: true,
  status: true,
  audienceCutoff: true,
  cursorUserId: true,
} as const;

type ChunkBroadcast = Pick<NotificationBroadcast, keyof typeof BROADCAST_SELECT>;

/**
 * What one sub-group's dispatch reports back to `process()` (#456).
 *
 * `completedPrefix` is the length of the longest run, from the START of the
 * group in id order, of recipients whose `notifyNow` completed and was not
 * rate-limited. It equals the group's length on every ordinary run; it is
 * shorter only when a recipient hit a throttling provider, and then it is the
 * number of recipients the cursor may safely move past.
 */
interface GroupDispatchOutcome {
  completedPrefix: number;
  rateLimited: boolean;
  /** The longest provider-named wait seen in this group; `null` when none. */
  retryAfterMs: number | null;
}

@Injectable()
export class BroadcastChunkHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(BroadcastChunkHandler.name);

  readonly type = BROADCAST_CHUNK_TYPE;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobsService,
    private readonly config: ConfigService,
    private readonly registry: JobHandlerRegistry,
    private readonly throttle: ProviderThrottleService
  ) {}

  /**
   * Self-registration — plus, since #456, the provider-quota mapping that
   * lets this type's `RateLimitError` trip the shared throttle gate. See
   * `BROADCAST_EMAIL_PROVIDER_KEY`; the pairing of the two calls is the
   * pattern `provider-throttle.service.ts`'s header prescribes.
   */
  onModuleInit(): void {
    this.registry.register(this);
    this.throttle.registerProviderKey(this.type, BROADCAST_EMAIL_PROVIDER_KEY);
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
   * Dispatches one page of the audience, commits progress, and either
   * enqueues the successor or finishes the broadcast.
   *
   * THROWS TO FAIL on every database error; see the file header for why the
   * `notifyNow` calls cannot fail it, and for the ordering that makes a retry
   * resume from the persisted cursor.
   *
   * THROWS `RateLimitError` when a recipient's provider throttled us (#456),
   * after committing the longest contiguous dispatched prefix and without
   * queueing a successor — see the file header's throttling section.
   */
  async process(job: Job): Promise<void> {
    const broadcastId = job.subjectId;

    if (!broadcastId) {
      this.logger.warn(`Broadcast chunk job ${job.id} carries no subjectId; nothing to send`);

      return;
    }

    const broadcast = await this.prisma.notificationBroadcast.findUnique({
      where: { id: broadcastId },
      select: BROADCAST_SELECT,
    });

    if (!broadcast) {
      // Deleted mid-fan-out. A no-op, for the same reason the start handler
      // gives: there is nothing to send and no retry can bring the row back.
      this.logger.log(
        `Broadcast ${broadcastId} no longer exists; chunk job ${job.id} is a no-op`
      );

      return;
    }

    // THE GUARD THAT MAKES CANCEL WORK, and the one that neutralises a
    // replayed or stale chunk. `sending` is the ONLY status a chunk may act
    // on: `canceled` means an admin stopped it, `sent` means a duplicate
    // chunk from a lease expiry arrived after the fan-out finished,
    // `scheduled` means this chunk somehow outran its own start job, and
    // `failed` (#459) means the fan-out gave up and has not been resumed — an
    // admin retrying the dead chunk from the Jobs page lands here, and must
    // use Resume instead, which is what flips the status back. Every wrong
    // answer has the same right response — send nothing, return normally,
    // leave the status alone.
    if (broadcast.status !== 'sending') {
      this.logger.log(
        `Broadcast ${broadcastId} is '${broadcast.status}', not 'sending'; ` +
          `chunk job ${job.id} sent nothing`
      );

      return;
    }

    if (!broadcast.audienceCutoff) {
      // Structurally impossible — the start handler's compare-and-swap writes
      // `audienceCutoff` in the same statement that sets `sending`, so the two
      // cannot disagree. Handled anyway rather than asserted with a `!`,
      // because paging without a cutoff would silently widen the audience to
      // every user who exists at page time, which is the one failure this
      // column exists to prevent. A no-op is the safe reading.
      this.logger.error(
        `Broadcast ${broadcastId} is 'sending' with no audienceCutoff; ` +
          `chunk job ${job.id} refuses to page an unfrozen audience`
      );

      return;
    }

    // KEYSET PAGINATION on the primary key, not `skip`/`take`. An OFFSET grows
    // linearly more expensive with every page and — worse — SHIFTS when a row
    // ahead of the cursor is deleted, which silently skips a recipient. `id >
    // cursor` with `ORDER BY id ASC` is stable under concurrent inserts and
    // deletes, costs the same on page 1 and page 500, and is the reason the
    // cursor is a durable column rather than an in-memory index.
    const users = await this.prisma.user.findMany({
      where: {
        ...audienceWhere(broadcast.audienceCutoff),
        ...(broadcast.cursorUserId ? { id: { gt: broadcast.cursorUserId } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BROADCAST_CHUNK_SIZE,
    });

    if (users.length === 0) {
      // The audience is exhausted. Reached when the previous chunk's page was
      // exactly full — it enqueued a successor because it could not know it
      // was the last — and also when every remaining candidate was deactivated
      // since the count.
      await this.finish(broadcast.id, job.id);

      return;
    }

    const payload = this.buildPayload(broadcast);
    const options: NotifyOptions = {
      // NARROWING ONLY, and that is the entire contract of this option — see
      // `NotifyOptions`. It is intersected AFTER the admin policy filter and
      // AFTER the user-preference filter, so passing the broadcast's stored
      // channels cannot resurrect a channel the kill switch dropped or the
      // recipient muted; it can only remove ones the admin did not choose for
      // this send. The cast is to the union the column is constrained to by
      // #324's DTO — `channels` is `String[]` in Postgres because Prisma has
      // no array-of-enum ergonomics worth the migration, and an unrecognised
      // string here is simply an element the intersection drops.
      channels: broadcast.channels as NotificationChannel[],
    };

    // The cursor this execution paged from — the compare side of the progress
    // CAS below (#459). Captured here, from the same read the page was built
    // on, so "the cursor I started from" cannot drift from "the page I sent".
    const cursorAtStart = broadcast.cursorUserId;

    let dispatched = 0;
    let lastDispatchedId: string | null = null;
    let canceledMidPage = false;
    let rateLimited = false;
    let retryAfterMs: number | null = null;

    // The outer walk over sub-groups exists for cancel latency (see
    // `STATUS_RECHECK_INTERVAL`) and is also the seam for tightening the
    // duplicate bound; the inner pool bounds concurrency.
    for (let offset = 0; offset < users.length; offset += STATUS_RECHECK_INTERVAL) {
      if (offset > 0 && !(await this.stillSending(broadcast.id))) {
        canceledMidPage = true;
        break;
      }

      const group = users.slice(offset, offset + STATUS_RECHECK_INTERVAL);

      const outcome = await this.dispatchGroup(
        group.map((user) => user.id),
        broadcast.eventKey,
        payload,
        options
      );

      // Only the contiguous completed prefix counts (#456). On an ordinary
      // group that is the whole group, and this is the pre-#456 arithmetic
      // exactly. Every EARLIER group ran to completion un-throttled — the
      // loop stops at the first throttled one — so prefix-of-this-group
      // appended to all-of-the-earlier-groups is still one contiguous run
      // from the start of the page, which is what makes it safe to commit.
      if (outcome.completedPrefix > 0) {
        dispatched += outcome.completedPrefix;
        lastDispatchedId = group[outcome.completedPrefix - 1].id;
      }

      if (outcome.rateLimited) {
        rateLimited = true;
        retryAfterMs = outcome.retryAfterMs;
        break;
      }
    }

    if (lastDispatchedId) {
      // ONE UPDATE, AFTER THE SENDS. The cursor and the counter describe the
      // same event ("these recipients have been dispatched") and are written
      // together so no reader can see one without the other — a cursor ahead
      // of its counter reports progress that did not happen, and a counter
      // ahead of its cursor double-counts on the next page.
      //
      // `increment`, not an absolute value: the counter accumulates across
      // every page of the chain, and an absolute write would need a read
      // first. The CAS on the cursor (below) is what guarantees exactly one
      // increment per page even when two executions sent the same one.
      //
      // A COMPARE-AND-SWAP ON THE CURSOR THIS CHUNK READ (#459) — `null` reads
      // as `IS NULL` in a Prisma `where`, which is the first page. If another
      // execution already committed this page (a resumed chain racing an admin
      // retry of the old failed chunk, or a lease-expired duplicate), the
      // cursor has moved, this matches zero rows, and this execution stops
      // below without a successor or a finish. See the file header's "TWO
      // CHAINS COLLAPSE TO ONE WITHIN A PAGE".
      //
      // Deliberately NOT conditioned on `status: 'sending'`. If a cancel
      // landed mid-page, these notifications were still sent, and the counter
      // must say so — suppressing the write would leave `recipientsDispatched`
      // understating what recipients actually received, which is the number an
      // operator reaches for first when asking "how far did it get before I
      // stopped it?".
      //
      // ON A THROTTLED PAGE (#456) this is the same write with smaller
      // numbers: the cursor and the counter both describe the committed
      // prefix, not everything that happened to go out. A recipient who got
      // the message out of order behind a throttled one is deliberately NOT
      // counted here — they will be dispatched (and counted) again on resume,
      // and counting them now as well would double-count them then.
      const committed = await this.prisma.notificationBroadcast.updateMany({
        where: { id: broadcast.id, cursorUserId: cursorAtStart },
        data: {
          cursorUserId: lastDispatchedId,
          recipientsDispatched: { increment: dispatched },
        },
      });

      if (committed.count === 0) {
        // LOST THE RACE (or the row was deleted). Another execution owns the
        // chain from here; returning normally — no successor, no finish, and
        // on a throttled page no `RateLimitError` — is what collapses two
        // chains to one. The page this execution sent is the bounded
        // duplicate the file header accepts.
        this.logger.warn(
          `Broadcast ${broadcast.id}: chunk job ${job.id} sent ${dispatched} recipient(s) ` +
            `from cursor ${cursorAtStart ?? '(start)'}, but another execution had already ` +
            `moved the cursor; this chain stops here (no successor queued)`
        );

        return;
      }
    }

    if (canceledMidPage) {
      // The status was changed out from under us. Do NOT enqueue a successor
      // and do NOT mark the broadcast `sent` — whoever changed it owns the
      // terminal state now.
      this.logger.log(
        `Broadcast ${broadcast.id} stopped mid-chunk after ${dispatched} recipient(s) ` +
          `in job ${job.id}; no successor queued`
      );

      return;
    }

    if (rateLimited) {
      // A CANCEL STILL WINS. The page stopped because the provider refused
      // us, but if an admin canceled meanwhile there is nothing to come back
      // for: the deferred chunk would only be claimed, hit the status guard
      // and no-op. Returning normally ends it now, with the progress above
      // already committed. One extra read, on a path that only runs during a
      // throttle.
      if (!(await this.stillSending(broadcast.id))) {
        this.logger.log(
          `Broadcast ${broadcast.id} was rate-limited and is no longer 'sending'; ` +
            `chunk job ${job.id} stopped after ${dispatched} recipient(s) without deferring`
        );

        return;
      }

      // NO SUCCESSOR AND NO FINISH — this page is not done. The throw is the
      // whole mechanism: the worker hands it to `JobTerminalService`, which
      // defers THIS row (same job id, same subject) and trips the throttle
      // gate. See the file header for what happens on resume.
      throw new RateLimitError(
        `Email provider rate-limited broadcast ${broadcast.id}; chunk job ${job.id} ` +
          `committed ${dispatched} recipient(s) up to ` +
          `${lastDispatchedId ? `user ${lastDispatchedId}` : 'the previous cursor'} ` +
          `and will resume from there`,
        retryAfterMs ?? undefined
      );
    }

    if (users.length < BROADCAST_CHUNK_SIZE) {
      // A SHORT PAGE MEANS THE AUDIENCE IS EXHAUSTED — `take` returned fewer
      // rows than it was allowed to, so there is nothing after the cursor.
      // Finishing here rather than enqueueing one more chunk to discover an
      // empty page saves a whole round trip through the queue on every
      // broadcast.
      await this.finish(broadcast.id, job.id);

      return;
    }

    const nextJob = await this.jobs.enqueue({
      type: BROADCAST_CHUNK_TYPE,
      // `backfill` — see the note in `broadcast-start.handler.ts`. `JobReason`
      // is a Prisma enum with three values and adding a fourth is a migration
      // plus web and OpenAPI churn for a display string.
      reason: 'backfill',
      subjectType: BROADCAST_SUBJECT_TYPE,
      subjectId: broadcast.id,
      // ⚠ LOAD-BEARING. Without it this enqueue returns the job that is
      // calling it — see the file header. The broadcast would stop here, with
      // every job row `succeeded` and no error anywhere.
      skipDedup: true,
    });

    this.logger.log(
      `Broadcast ${broadcast.id} chunk job ${job.id} dispatched ${dispatched} recipient(s) ` +
        `up to user ${lastDispatchedId}; next chunk queued as job ${nextJob.id}`
    );
  }

  /**
   * Dispatches one sub-group through a bounded pool.
   *
   * A FIXED NUMBER OF WORKERS PULLING FROM A SHARED INDEX, not
   * `Promise.all(group.map(...))`. The `Promise.all` version is shorter and
   * opens as many concurrent transports as the group has members, which is the
   * thing `BROADCAST_SEND_CONCURRENCY` exists to prevent; it is rejected for
   * the same reason the dispatcher's own per-recipient work is sequential —
   * multiplying concurrent load on the mail provider wins latency nobody is
   * waiting for.
   *
   * `Promise.all` over the WORKERS is safe and is not the same thing: there
   * are exactly `BROADCAST_SEND_CONCURRENCY` of them regardless of group size,
   * and none of them can reject, because `notifyNow` never rejects.
   *
   * ---------------------------------------------------------------------------
   * STOPPING ON A THROTTLE (#456)
   * ---------------------------------------------------------------------------
   *
   * The first rate-limited result raises `stop`, and every worker checks it
   * BEFORE taking its next index — so no new send starts, while the ones
   * already in flight run to completion (`Promise.all` still waits for them).
   * Each index's outcome is recorded in `settled`, and because indices are
   * handed out in order and every handed-out index has finished by the time
   * `Promise.all` resolves, the committed prefix is simply the number of
   * leading `'ok'` entries. An index that was never launched is `undefined`,
   * a throttled one is `'rate-limited'`; either ends the prefix.
   */
  private async dispatchGroup(
    userIds: string[],
    eventKey: string,
    payload: BroadcastEmailData,
    options: NotifyOptions
  ): Promise<GroupDispatchOutcome> {
    let next = 0;
    let stop = false;
    let retryAfterMs: number | null = null;
    const settled: Array<'ok' | 'rate-limited' | undefined> = new Array(userIds.length);

    const worker = async (): Promise<void> => {
      for (;;) {
        // Checked BEFORE claiming an index, so a stopped pool leaves the
        // remaining indices unlaunched (`undefined` in `settled`) rather than
        // claimed-and-skipped, which would be indistinguishable from sent.
        if (stop) {
          return;
        }

        const index = next;
        next += 1;

        if (index >= userIds.length) {
          return;
        }

        // AWAITED — this is `notifyNow`, not `notify`. `notify` is detached:
        // it schedules the send on a microtask and returns, which inside a job
        // handler means the job reports `succeeded` for work that has not
        // happened and that a restart moments later would lose with no record
        // of who was missed. `notifyNow` is the same dispatch — same
        // preference gate, same policy filter, same delivery rows — with the
        // promise handed back, which is the only shape a fan-out can apply
        // backpressure to.
        const result = readThrottle(
          await this.notifications.notifyNow(eventKey, userIds[index], payload, options)
        );

        if (result.rateLimited) {
          settled[index] = 'rate-limited';
          stop = true;

          if (
            result.retryAfterMs !== null &&
            (retryAfterMs === null || result.retryAfterMs > retryAfterMs)
          ) {
            retryAfterMs = result.retryAfterMs;
          }
        } else {
          settled[index] = 'ok';
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(BROADCAST_SEND_CONCURRENCY, userIds.length) }, () => worker())
    );

    let completedPrefix = 0;

    while (completedPrefix < userIds.length && settled[completedPrefix] === 'ok') {
      completedPrefix += 1;
    }

    return { completedPrefix, rateLimited: stop, retryAfterMs };
  }

  /**
   * The payload every channel renders this broadcast from.
   *
   * ANNOTATED WITH THE TEMPLATE'S OWN TYPE ON PURPOSE. `notifyNow` takes `data:
   * unknown` — one untyped entry point for every event, so no call site has to
   * import a per-event payload type — which means THIS IS THE ONLY PLACE the
   * shape is checked at all. Drop the annotation and a renamed field in
   * `broadcast.email.ts` becomes a runtime render failure recorded as a failed
   * delivery for every recipient, with nothing red in a build anywhere.
   *
   * One payload serves every channel: email uses `ctaUrl`, browser and push
   * use the root-relative `link`, and both are carried rather than split
   * per-channel — see `BroadcastEmailData.link` for why splitting would put
   * the burden of building both on every call site and let the two drift.
   */
  private buildPayload(broadcast: ChunkBroadcast): BroadcastEmailData {
    const ctaUrl = this.ctaUrl(broadcast.link);

    return {
      title: broadcast.title,
      body: broadcast.body,
      // Spread-if-present rather than `?? undefined`: these are optional
      // fields on the template's interface, and an explicit `undefined` and an
      // absent key are the same to the template but not to a test asserting on
      // the payload.
      ...(broadcast.link ? { link: broadcast.link } : {}),
      ...(broadcast.ctaLabel ? { ctaLabel: broadcast.ctaLabel } : {}),
      ...(ctaUrl ? { ctaUrl } : {}),
      // The registry key is what makes a broadcast critical — `mandatory: true`
      // lives on `admin.broadcast_critical` in `NOTIFICATION_EVENTS` and
      // nowhere else, so this flag is derived from it rather than stored
      // alongside it. A stored copy is a second source of truth that can
      // disagree with the gate that actually decides whether a recipient may
      // mute this.
      critical: broadcast.eventKey === 'admin.broadcast_critical',
    };
  }

  /**
   * The absolute CTA URL, or `undefined` when there is nothing to link to.
   *
   * ABSOLUTE, because `safeUrl` in the email layout rejects anything else —
   * mail clients have no origin to resolve `/settings` against. Built HERE
   * rather than in the template for the reason `users.service.ts`'s private
   * `appUrl()` gives: a template is a pure function of its input and has no
   * business reading configuration.
   *
   * Trailing slashes are stripped exactly as that method does, so a configured
   * `http://localhost:3535/` and the stored root-relative `/settings` cannot
   * produce `http://localhost:3535//settings`.
   *
   * `undefined` when either half is missing — no link, or an unconfigured
   * `APP_URL`. The layout then omits the button entirely rather than rendering
   * one that goes nowhere, and `BroadcastEmailData.ctaLabel` is dropped with
   * it because a label with no destination is worse than no button.
   */
  private ctaUrl(link: string | null): string | undefined {
    if (!link) {
      return undefined;
    }

    const appUrl = this.config.get<string>('appUrl');

    if (!appUrl) {
      return undefined;
    }

    return `${appUrl.replace(/\/+$/, '')}${link}`;
  }

  /** Whether the broadcast is still `sending`. The mid-page cancel check. */
  private async stillSending(broadcastId: string): Promise<boolean> {
    const current = await this.prisma.notificationBroadcast.findUnique({
      where: { id: broadcastId },
      select: { status: true },
    });

    return current?.status === 'sending';
  }

  /**
   * Marks the broadcast finished.
   *
   * CONDITIONAL ON `sending`, like the start handler's claim and for the same
   * reason: an unconditional `update` would let a chunk that raced a cancel
   * overwrite `canceled` with `sent`, reporting a completed send for a
   * broadcast an admin stopped. `count === 0` means somebody else already
   * decided how this broadcast ends, which is not an error.
   */
  private async finish(broadcastId: string, jobId: string): Promise<void> {
    const finished = await this.prisma.notificationBroadcast.updateMany({
      where: { id: broadcastId, status: 'sending' },
      data: { status: 'sent', finishedAt: new Date() },
    });

    if (finished.count === 0) {
      this.logger.log(
        `Broadcast ${broadcastId} was no longer 'sending' when chunk job ${jobId} ` +
          `tried to finish it; its status was left alone`
      );

      return;
    }

    this.logger.log(`Broadcast ${broadcastId} finished sending (chunk job ${jobId})`);
  }
}

/**
 * Normalises a `notifyNow` result into a throttle verdict.
 *
 * TOLERANT OF `undefined`, deliberately. `notifyNow` is typed to resolve a
 * `NotifyNowResult` and the real one always does, but it is the single call
 * this handler makes whose failure must never fail a chunk (see the file
 * header), and a stand-in — a test double, a fork's decorator around
 * `NotificationsService` — that resolves nothing must read as "not
 * throttled", which is exactly the pre-#456 behaviour, rather than throwing a
 * `TypeError` out of a worker and failing the whole page over it.
 */
function readThrottle(result: NotifyNowResult | undefined): NotifyNowResult {
  if (!result || result.rateLimited !== true) {
    return { rateLimited: false, retryAfterMs: null };
  }

  return {
    rateLimited: true,
    retryAfterMs:
      typeof result.retryAfterMs === 'number' &&
      Number.isFinite(result.retryAfterMs) &&
      result.retryAfterMs > 0
        ? result.retryAfterMs
        : null,
  };
}
