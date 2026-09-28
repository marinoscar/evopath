// =============================================================================
// Announcing a settled job — the one place the containment rule lives (#468)
// =============================================================================
//
// `JOB_SETTLED_EVENT` is raised from two services today: `JobTerminalService`
// (a job that reported back, or failed on the in-process path) and
// `JobStuckService` (the lease reaper's phase-1 give-up, which marks a job
// `failed` on behalf of an executor that never came back). Both must announce
// the settlement in exactly the same way, so they share this function rather
// than each carrying a copy of it.
//
// ⚠ A LISTENER IS A BYSTANDER. `EventEmitter2` dispatches SYNCHRONOUSLY, so a
// listener that throws would otherwise throw out of the emitting call — into
// a worker that has already written a correct terminal row, or into a reaper
// sweep that still has rows to reclaim. Neither the row, nor the worker slot,
// nor the rest of the sweep may depend on a listener behaving. The try/catch
// below is that rule, and this file is the only place it is written down.
//
// Deliberately NOT in `events/job-settled.event.ts`: that file must keep
// importing only `@prisma/client` (see `notifications/ops/job-failure-notifier.ts`
// for why), and this helper needs `@nestjs/*`.
// =============================================================================

import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from '@prisma/client';

import { JobSettledEvent, JOB_SETTLED_EVENT } from './events/job-settled.event';

/**
 * Emits `JOB_SETTLED_EVENT` for a genuinely settled job. Never throws: a
 * listener error is logged and swallowed, and the job's row is unaffected.
 */
export function emitJobSettled(events: EventEmitter2, job: Job, logger: Logger): void {
  try {
    events.emit(JOB_SETTLED_EVENT, new JobSettledEvent(job));
  } catch (error) {
    logger.error(
      `A ${JOB_SETTLED_EVENT} listener threw for job ${job.id}; the job's ` +
        `${job.status} row is unaffected: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}
