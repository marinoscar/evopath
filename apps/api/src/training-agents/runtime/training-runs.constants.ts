import { Prisma } from '@prisma/client';

// =============================================================================
// Training run constants: the job type, the status sets, the limits
// =============================================================================

/** The queue job that executes a run. PERMANENT once jobs of this type exist. */
export const TRAINING_RUN_JOB_TYPE = 'ai.training.plan.run';

/** `jobs.subject_type` of a run's jobs; `subject_id` is the run id. */
export const TRAINING_RUN_SUBJECT_TYPE = 'training_run';

export const TRAINING_RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'interrupted',
  'succeeded',
  'failed',
  'cancelled',
  'blocked_safety',
] as const;

export type TrainingRunStatus = (typeof TRAINING_RUN_STATUSES)[number];

/** At most one run per user in these (`training_plan_runs_active_per_user_uniq_idx`). */
export const ACTIVE_RUN_STATUSES: readonly TrainingRunStatus[] = ['queued', 'running', 'awaiting_approval'];

/** A run in one of these is finished for good. */
export const TERMINAL_RUN_STATUSES: readonly TrainingRunStatus[] = ['succeeded', 'failed', 'cancelled', 'blocked_safety'];

/** Statuses a cancel applies to. */
export const CANCELLABLE_RUN_STATUSES: readonly TrainingRunStatus[] = [
  'queued',
  'running',
  'awaiting_approval',
  'interrupted',
];

export const TRAINING_RUN_TRIGGERS = ['user', 'weekly', 'workout_finished', 'manual', 'resume', 'system'] as const;

export type TrainingRunTrigger = (typeof TRAINING_RUN_TRIGGERS)[number];

/** The raw-SQL partial unique index that allows one active run per user. */
export const ACTIVE_RUN_INDEX_NAME = 'training_plan_runs_active_per_user_uniq_idx';

/** Resumes a run may take in total (`resume_count`); the next is `TRAINING_RUN_NOT_RESUMABLE`. */
export const MAX_RUN_RESUMES = 3;

/** Automatic resumes after a lost job, counted in the same `resume_count`; past it the run fails `TRAINING_RUN_LOST`. */
export const MAX_AUTO_RESUMES = 2;

/** How long a pending approval waits (`expires_at`). */
export const APPROVAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** The job's profile: 25 minutes, one attempt (a model call is not safe to retry blindly). */
export const TRAINING_RUN_MAX_RUNTIME_MS = 25 * 60_000;

/** The run's own deadline, inside the job's so the handler records it cleanly. */
export const TRAINING_RUN_DEADLINE_MS = TRAINING_RUN_MAX_RUNTIME_MS - 30_000;

/** How often a running run re-reads its row for a cancel made on another replica. */
export const TRAINING_RUN_CANCEL_POLL_MS = 2_000;

/** How often a running run stamps `heartbeat_at`. */
export const TRAINING_RUN_HEARTBEAT_MS = 15_000;

/** The reasons a run's routes and records carry in `details.reason` / `error_code`. */
export const TRAINING_REASONS = {
  RUN_ACTIVE: 'TRAINING_RUN_ACTIVE',
  ROLE_UNAVAILABLE: 'TRAINING_ROLE_UNAVAILABLE',
  NOT_IMPLEMENTED: 'TRAINING_NOT_IMPLEMENTED',
  NOT_RESUMABLE: 'TRAINING_RUN_NOT_RESUMABLE',
  NOT_AWAITING_DECISION: 'TRAINING_RUN_NOT_AWAITING_DECISION',
  BUDGET_EXCEEDED: 'TRAINING_RUN_BUDGET_EXCEEDED',
  RUN_LOST: 'TRAINING_RUN_LOST',
  SAFETY_STOP: 'TRAINING_SAFETY_STOP',
  CONTEXT_TOO_LARGE: 'TRAINING_CONTEXT_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/**
 * Whether `error` is a unique violation on the ACTIVE-RUN index specifically.
 *
 * Positive matching on the index name, like `isActiveDedupConflict`: any other
 * `P2002` (or anything else) propagates untouched. Both metadata shapes are
 * read: the driver adapter's (`driverAdapterError.cause`: the constraint's
 * index, or the original message naming it) and the classic engine's
 * (`meta.target`).
 */
export function isActiveRunConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const meta = (error.meta ?? {}) as Record<string, unknown>;
  const cause = (meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined)?.cause;

  if (cause) {
    const constraint = cause.constraint as { index?: unknown } | undefined;
    if (constraint?.index === ACTIVE_RUN_INDEX_NAME) return true;
    if (typeof cause.originalMessage === 'string' && cause.originalMessage.includes(ACTIVE_RUN_INDEX_NAME)) {
      return true;
    }
  }

  const target = meta.target;
  if (typeof target === 'string') return target === ACTIVE_RUN_INDEX_NAME;
  if (Array.isArray(target)) return target.some((entry) => String(entry) === ACTIVE_RUN_INDEX_NAME);

  return typeof error.message === 'string' && error.message.includes(ACTIVE_RUN_INDEX_NAME);
}
