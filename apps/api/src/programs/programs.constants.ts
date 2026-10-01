import { Prisma } from '@prisma/client';

// =============================================================================
// Training programs (E5.1): value sets, refusal reasons, limits
// =============================================================================

export const PROGRAM_STATUSES = ['draft', 'active', 'paused', 'archived', 'completed'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

export const PROGRAM_GOALS = ['strength', 'hypertrophy', 'fat_loss', 'general', 'endurance', 'custom'] as const;
export type ProgramGoal = (typeof PROGRAM_GOALS)[number];

export const PROGRAM_AUTONOMY = ['autonomous', 'ask_first'] as const;
export type ProgramAutonomy = (typeof PROGRAM_AUTONOMY)[number];

export const PROGRAM_SOURCES = ['ai', 'manual'] as const;
export type ProgramSource = (typeof PROGRAM_SOURCES)[number];

/** `program_versions.origin`. */
export const VERSION_ORIGINS = ['initial', 'ai_create', 'ai_adapt', 'manual_edit', 'revert', 'duplicate'] as const;
export type VersionOrigin = (typeof VERSION_ORIGINS)[number];

/** Origins `applyChange` writes; `initial` and `duplicate` are written by `createWithTree`. */
export type ChangeOrigin = Exclude<VersionOrigin, 'initial'>;

/**
 * `program_change_log.kind`. `reviewed` records an evaluation that changed
 * nothing (or a safety stop): `fromVersion = toVersion`, no version bump, and
 * it is never "the latest change" for revert, Today or the signals.
 */
export const CHANGE_KINDS = ['created', 'adapted', 'edited', 'reverted', 'reviewed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Kinds that record a review rather than a change of the tree. */
export const REVIEW_KINDS: readonly ChangeKind[] = ['reviewed'];

/** `program_change_log.actor`. `system` is the server itself (safety stops). */
export const CHANGE_ACTORS = ['ai', 'user', 'system'] as const;
export type ChangeActor = (typeof CHANGE_ACTORS)[number];

/** `programs.autonomy_paused_reason` (CHECK in migration SQL). */
export const AUTONOMY_PAUSE_REASONS = ['safety_text', 'pain_pattern', 'user_paused'] as const;
export type AutonomyPauseReason = (typeof AUTONOMY_PAUSE_REASONS)[number];

export const CHANGE_STATUSES = ['applied', 'proposed', 'rejected', 'reverted', 'superseded', 'expired'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

/**
 * Legal status transitions requested by a user. `active -> completed` is set by
 * the Today resolver, not through this table.
 */
export const PROGRAM_TRANSITIONS: Record<'activate' | 'pause' | 'archive', readonly ProgramStatus[]> = {
  activate: ['draft', 'paused'],
  pause: ['active'],
  archive: ['draft', 'active', 'paused', 'completed'],
};

/** `details.reason` values this module answers with. */
export const PROGRAM_REASONS = {
  STALE_PLAN: 'TRAINING_STALE_PLAN',
  NOT_LATEST: 'NOT_LATEST',
  NOT_REVERTIBLE: 'NOT_REVERTIBLE',
  SNAPSHOT_UNSUPPORTED: 'SNAPSHOT_UNSUPPORTED',
  IF_MATCH_REQUIRED: 'IF_MATCH_REQUIRED',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  NOT_SCHEDULABLE: 'PLAN_NOT_SCHEDULABLE',
  ACTIVE_PROGRAM_CONFLICT: 'ACTIVE_PROGRAM_CONFLICT',
  START_DATE_OUT_OF_RANGE: 'START_DATE_OUT_OF_RANGE',
  PROGRAM_ARCHIVED: 'PROGRAM_ARCHIVED',
  HAS_HISTORY: 'PROGRAM_HAS_HISTORY',
  UNKNOWN_EXERCISES: 'UNKNOWN_EXERCISES',
  /** A prescription's shape (reps vs duration/distance) does not fit the exercise's tracking mode. */
  PRESCRIPTION_SHAPE_MISMATCH: 'PRESCRIPTION_SHAPE_MISMATCH',
  ROW_ID_CONFLICT: 'ROW_ID_CONFLICT',
  INVALID_PLAN: 'INVALID_PLAN',
  NOT_PROPOSED: 'NOT_PROPOSED',
} as const;

/** The raw-SQL partial unique index: at most one active program per user. */
export const ACTIVE_PROGRAM_INDEX_NAME = 'programs_one_active_per_user_uniq_idx';

/** Activation `startDate` window around the server's today (UTC). */
export const START_DATE_PAST_DAYS = 7;
export const START_DATE_FUTURE_DAYS = 365;

export const CHANGE_LOG_PAGE_SIZE_DEFAULT = 20;
export const CHANGE_LOG_PAGE_SIZE_MAX = 100;

export const PROGRAM_NOTES_MAX = 2000;
export const CHANGE_SUMMARY_MAX = 300;
export const CHANGE_RATIONALE_MAX = 2000;

/** A full plan rewrite can touch thousands of rows. */
export const PROGRAM_TX_TIMEOUT_MS = 30_000;

/**
 * Whether `error` is the one-active-program index refusing an insert/update.
 * A positive match on the index name, never "any P2002".
 */
export function isActiveProgramConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;

  const meta = (error.meta ?? {}) as Record<string, unknown>;
  const cause = (meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined)?.cause;
  if (cause) {
    const constraint = cause.constraint as { index?: unknown } | undefined;
    if (constraint?.index === ACTIVE_PROGRAM_INDEX_NAME) return true;
    if (typeof cause.originalMessage === 'string' && cause.originalMessage.includes(ACTIVE_PROGRAM_INDEX_NAME)) return true;
  }

  const target = meta.target;
  if (typeof target === 'string') return target === ACTIVE_PROGRAM_INDEX_NAME;
  if (Array.isArray(target)) return target.some((entry) => String(entry) === ACTIVE_PROGRAM_INDEX_NAME);

  return typeof error.message === 'string' && error.message.includes(ACTIVE_PROGRAM_INDEX_NAME);
}
