import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Job } from '@prisma/client';

import {
  JOB_SETTLED_EVENT,
  type JobSettledEvent,
} from '../../jobs/events/job-settled.event';
import { PrismaService } from '../../prisma/prisma.service';
import { describeThrown } from '../describe-thrown';
import { BROADCAST_SUBJECT_TYPE } from './broadcast-audience';
import { BROADCAST_CHUNK_TYPE } from './handlers/broadcast-chunk.handler';
import { BROADCAST_START_TYPE } from './handlers/broadcast-start.handler';

// =============================================================================
// BroadcastFailureListener — a permanently failed fan-out job fails its
// broadcast (issue #459, epic #319)
// =============================================================================
//
// Before #459, an `admin.broadcast.chunk` job that spent its attempt budget
// (or its rate-limit budget, #456) left the broadcast `sending` forever: the
// chain had no successor, nobody ever wrote a terminal status, and the admin
// list showed a send "in progress" that nothing would ever progress. This
// listener closes that: when a broadcast's fan-out job GIVES UP, the broadcast
// moves `sending` -> `failed`, with `lastError` saying which job, after how
// many attempts, and why. `BroadcastsService.resume` is the way back.
//
// -----------------------------------------------------------------------------
// 1. WHY A `job.settled` LISTENER AND NOT A HOOK ON THE HANDLER
// -----------------------------------------------------------------------------
//
// The obvious alternative is an `onPermanentFailure(job)` member on
// `JobHandler`, called by `JobTerminalService`. Rejected: it widens the
// interface every job type implements for one feature's benefit, and it puts
// a feature's database write inside the queue's terminal chokepoint — the
// method whose own failures are swallowed on purpose so a worker slot is
// never stranded (see `job-failure-notifier.ts` section 1 for the same
// argument about a `notify()` call there). `JOB_SETTLED_EVENT` is the
// documented seam for "tell me when a job is over"; `JobFailureNotifier` is
// the precedent, and this listener follows it line for line: a file import of
// `job-settled.event.ts` (which imports only `@prisma/client`), no module
// dependency on anything in `jobs/` beyond what `BroadcastsModule` already
// imports, and `EventEmitterModule.forRoot()` in `app.module.ts` (global) as
// the wiring.
//
// -----------------------------------------------------------------------------
// 2. WHY THIS IS NOT A VIOLATION OF "EVERY LONG-RUNNING ACTIVITY IS A QUEUE JOB"
// -----------------------------------------------------------------------------
//
// CLAUDE.md rule 1 forbids an `@OnEvent` body that does long-running work.
// This one issues ONE bounded, single-row, indexed compare-and-swap
// (`UPDATE ... WHERE id = $1 AND status = 'sending'`) and nothing else — no
// sweep, no network round trip per row, no duration worth accounting for.
// That is the same class as the existing settle listeners (the node-secret
// revocation listener, `JobFailureNotifier`'s detached dispatch). Enqueueing a
// job to perform one UPDATE would add a queue round trip, a second failure
// mode (the marker job itself failing), and no accounting value.
//
// It is still DETACHED: `EventEmitter2` dispatches synchronously inside the
// worker's completion path, so the handler only schedules the write and
// returns; nothing is awaited and nothing can throw back into
// `JobTerminalService` (section 3 of `job-failure-notifier.ts`).
//
// -----------------------------------------------------------------------------
// 3. WHY THE START TYPE IS INCLUDED
// -----------------------------------------------------------------------------
//
// `admin.broadcast.start` flips `scheduled` -> `sending` in its first
// statement and enqueues the first chunk afterwards. A FINAL start attempt
// that claims the broadcast and then throws (the chunk enqueue failing, say)
// leaves exactly the same stranded `sending` row a chunk does. A start job
// that fails without having claimed leaves the broadcast `scheduled`, which
// the `sending`-only `WHERE` below leaves alone — a scheduled broadcast with
// no live job is visible and cancelable/deletable, and is not what #459 is
// about.
//
// Since #469 only the FINAL attempt matters here. A NON-final start attempt
// that claims and then throws heals itself: its retry finds the broadcast
// `sending` with no cursor, no dispatches and no chunk job, and finishes the
// hand-off against the stored cutoff. This listener is the backstop for the
// attempt budget running out before that retry succeeds.
//
// -----------------------------------------------------------------------------
// 4. THE `sending`-ONLY MATCH IS WHAT MAKES A RACING CANCEL WIN
// -----------------------------------------------------------------------------
//
// An admin can cancel while the last chunk is failing. Whichever conditional
// write lands first wins; the other matches zero rows. A `canceled` or `sent`
// broadcast is never rewritten to `failed`, and a second failure event for a
// broadcast already `failed` (a start and a chunk both giving up, an operator
// retrying the dead chunk from the Jobs page and it failing again) is a no-op.
//
// The lease reaper's permanent give-up now emits `JOB_SETTLED_EVENT` too (#468),
// so a chunk whose executor died on every attempt fails its broadcast here.
// =============================================================================

/** The fan-out job types whose give-up fails the broadcast. */
const BROADCAST_FANOUT_TYPES: ReadonlySet<string> = new Set([
  BROADCAST_START_TYPE,
  BROADCAST_CHUNK_TYPE,
]);

/**
 * Cap on the job error quoted into `notification_broadcasts.last_error`.
 *
 * `Job.lastError` is unbounded text; the broadcast row is read by the admin
 * list on every page load. The operator needs the gist and the job id — the
 * full message stays on the job row, one click away on the Jobs page.
 */
const MAX_QUOTED_ERROR_LENGTH = 500;

@Injectable()
export class BroadcastFailureListener {
  private readonly logger = new Logger(BroadcastFailureListener.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A job settled. If it was a broadcast fan-out job that gave up, fail the
   * broadcast it was working on.
   *
   * RETURNS SYNCHRONOUSLY IN EVERY CASE — see section 2 of the header.
   */
  @OnEvent(JOB_SETTLED_EVENT)
  handleJobSettled(event: JobSettledEvent): void {
    try {
      const job = event.job;

      // `failed` only: a retry or a rate-limit deferral never emits this
      // event at all (see `job-settled.event.ts`), and a `succeeded` fan-out
      // job is the chain working as intended.
      if (job.status !== 'failed') return;
      if (!BROADCAST_FANOUT_TYPES.has(job.type)) return;
      if (job.subjectType !== BROADCAST_SUBJECT_TYPE || !job.subjectId) return;

      const broadcastId = job.subjectId;

      // DETACHED, with its own `.catch()`: the try/catch around this block
      // cannot see a rejected promise, and an unhandled rejection raised from
      // inside a synchronous emitter dispatch would surface against a worker
      // that did nothing wrong.
      void this.markFailed(broadcastId, job).catch((err: unknown) => {
        this.logger.error(
          `Could not mark broadcast ${broadcastId} failed after job ${job.id} ` +
            `failed permanently; it may still read 'sending': ${describeThrown(err)}`
        );
      });
    } catch (err) {
      this.logger.error(
        `Broadcast failure listener threw for job ${event.jobId}; the job's ` +
          `terminal row is unaffected: ${describeThrown(err)}`
      );
    }
  }

  /**
   * Moves the broadcast `sending` -> `failed`. Resolves `true` when this call
   * made the transition, `false` when the broadcast was not `sending` (already
   * canceled, sent or failed — left alone) or no longer exists.
   *
   * A COMPARE-AND-SWAP ON `sending`, never an unconditional update — see
   * section 4 of the header.
   */
  async markFailed(broadcastId: string, job: Job): Promise<boolean> {
    const kind = job.type === BROADCAST_START_TYPE ? 'Start' : 'Chunk';
    const cause = truncate(job.lastError ?? 'no error recorded', MAX_QUOTED_ERROR_LENGTH);

    const result = await this.prisma.notificationBroadcast.updateMany({
      where: { id: broadcastId, status: 'sending' },
      data: {
        status: 'failed',
        lastError:
          `${kind} job ${job.id} failed permanently after ${job.attempts} ` +
          `attempt(s): ${cause}`,
        // When the fan-out stopped — the terminal write that set the job
        // `failed` also set its `finishedAt`, so the two agree. Resume clears
        // it again.
        finishedAt: job.finishedAt ?? new Date(),
      },
    });

    if (result.count > 0) {
      this.logger.warn(
        `Broadcast ${broadcastId} marked 'failed': ${job.type} job ${job.id} ` +
          `failed permanently after ${job.attempts} attempt(s). Resume it from the ` +
          `Broadcasts page once the cause is fixed.`
      );

      return true;
    }

    this.logger.log(
      `${job.type} job ${job.id} failed permanently, but broadcast ${broadcastId} ` +
        `is not 'sending' (already canceled/sent/failed, or deleted); left alone`
    );

    return false;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
