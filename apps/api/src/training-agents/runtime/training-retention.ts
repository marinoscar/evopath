// =============================================================================
// Training run retention: how long finished runs keep their detail
// =============================================================================
//
// Code constants, not settings: the platform's other purge schedules are not
// configurable either. `training.runs.purge` (daily at 05:30) applies them to
// runs that FINISHED (`succeeded`, `failed`, `cancelled`, `blocked_safety`),
// measured from `completed_at`:
//
//   events and checkpoints   30 days   (the replayable detail and the graph state)
//   the run row itself       365 days  (the audit record; its events cascade)
//
// Checkpoints whose run no longer exists (the user was deleted, which cascades
// runs but not the un-keyed checkpoint tables) go after the same 30 days.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

export const TRAINING_RUN_EVENT_RETENTION_DAYS = 30;
export const TRAINING_RUN_CHECKPOINT_RETENTION_DAYS = 30;
export const TRAINING_RUN_RETENTION_DAYS = 365;

/** Ids per delete batch: a lock-duration bound, not a throughput knob. */
export const TRAINING_RUNS_PURGE_BATCH_SIZE = 5000;

/** Safety stop on each batch loop; the next day's run continues. */
export const TRAINING_RUNS_PURGE_MAX_BATCHES = 200;

/** 05:30 every day: after the 05:00 `ai.usage.purge`, never at the same minute. */
export const TRAINING_RUNS_PURGE_CRON = '30 5 * * *';

export function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY_MS);
}
