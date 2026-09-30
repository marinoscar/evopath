import { Prisma } from '@prisma/client';

// =============================================================================
// Quick workout adaptation (E6.1): every number and code in one place
// =============================================================================
//
// The rule numbers are INITIAL VALUES a maintainer may tune here, and only
// here; the pure rules (`rules/adaptation-rules.ts`) and the graph read them.
// They are conservative ranges for a general adult population, not medical
// advice.
// =============================================================================

/** The queue job that executes one adaptation. PERMANENT once jobs of this type exist. */
export const ADAPTATION_RUN_JOB_TYPE = 'ai.training.adapt.run';

/** `jobs.subject_type` of an adaptation's job; `subject_id` is the adaptation id. */
export const ADAPTATION_SUBJECT_TYPE = 'training_adaptation';

/** The housekeeping job that deletes expired adaptations. PERMANENT once jobs of this type exist. */
export const ADAPTATIONS_PURGE_JOB_TYPE = 'training.adaptations.purge';

/** 03:20 every day: clear of the other purges' minutes. */
export const ADAPTATIONS_PURGE_CRON = '20 3 * * *';

/** Ids per purge batch: a lock-duration bound, not a throughput knob. */
export const ADAPTATIONS_PURGE_BATCH_SIZE = 5000;

/** Safety stop on the purge's batch loop; the next day's run continues. */
export const ADAPTATIONS_PURGE_MAX_BATCHES = 200;

/** How long an adaptation row lives (`expires_at = created_at + 30 days`). */
export const ADAPTATION_TTL_DAYS = 30;
export const ADAPTATION_TTL_MS = ADAPTATION_TTL_DAYS * 24 * 60 * 60 * 1000;

/** The job's profile: five minutes, one attempt (a model call is not safe to retry blindly). */
export const ADAPTATION_RUN_MAX_RUNTIME_MS = 5 * 60_000;

/** The run's own deadline, inside the job's so the handler records it cleanly. */
export const ADAPTATION_RUN_DEADLINE_MS = ADAPTATION_RUN_MAX_RUNTIME_MS - 20_000;

/** How often a running adaptation re-reads its run for a cancel made on another replica. */
export const ADAPTATION_CANCEL_POLL_MS = 1_000;

/** How often a running adaptation stamps its run's `heartbeat_at`. */
export const ADAPTATION_HEARTBEAT_MS = 15_000;

/** Critic-driven revisions: at most one second planner pass. */
export const ADAPT_MAX_REVISIONS = 1;

/** The per-run token cap (the user's `ai.training.maxRunTokens` lowers it, never raises it). */
export const ADAPTATION_MAX_RUN_TOKENS = 120_000;

/** Output-token ceilings per call (reasoning included on providers that count it there). */
export const ADAPT_PLANNER_MAX_OUTPUT_TOKENS = 16_000;
export const ADAPT_CRITIC_MAX_OUTPUT_TOKENS = 6_000;

/** Bump when a prompt's text changes meaningfully; recorded in `guardrail_report.promptVersion`. */
export const ADAPTATION_PROMPT_VERSION = 1;

/** Adaptation statuses (plain strings, like `ai_runs.status`). */
export const ADAPTATION_STATUSES = [
  'queued',
  'running',
  'ready',
  'failed',
  'cancelled',
  'blocked_safety',
  'applied',
  'discarded',
] as const;
export type AdaptationStatus = (typeof ADAPTATION_STATUSES)[number];

/** At most one adaptation per user in these (`workout_adaptations_active_per_user_uniq_idx`). */
export const ACTIVE_ADAPTATION_STATUSES: readonly AdaptationStatus[] = ['queued', 'running'];

/** The raw-SQL partial unique index that allows one active adaptation per user. */
export const ACTIVE_ADAPTATION_INDEX_NAME = 'workout_adaptations_active_per_user_uniq_idx';

export const APPLIED_AS = ['one_off', 'plan_change'] as const;
export type AppliedAs = (typeof APPLIED_AS)[number];

/** `details.reason` values and `error_code`s this feature answers with. */
export const ADAPTATION_REASONS = {
  /** 400: the request changes nothing. */
  NOTHING_TO_CHANGE: 'ADAPTATION_NOTHING_TO_CHANGE',
  /** 400: an `only` equipment type is not in the chosen gym. */
  EQUIPMENT_NOT_IN_GYM: 'ADAPTATION_EQUIPMENT_NOT_IN_GYM',
  /** 400: the chosen gym is temporary and has no equipment, and the request is not bodyweight-only (E6.2). */
  GYM_EQUIPMENT_UNCONFIRMED: 'ADAPTATION_GYM_EQUIPMENT_UNCONFIRMED',
  /** 409: another adaptation is queued or running (`details.adaptationId`). */
  IN_PROGRESS: 'ADAPTATION_IN_PROGRESS',
  /** 409: a role has no usable model (`details.role`, `details.state`), the E5 kit's reason. */
  ROLE_UNAVAILABLE: 'TRAINING_ROLE_UNAVAILABLE',
  /** 409: apply on an adaptation that is not `ready`. */
  NOT_READY: 'ADAPTATION_NOT_READY',
  /** 409: the other apply mode already succeeded. */
  ALREADY_APPLIED: 'ADAPTATION_ALREADY_APPLIED',
  /** 409: the proposal no longer passes the guardrails against current data. */
  STALE: 'ADAPTATION_STALE',
  /** 409: `apply/plan` on an adaptation that had no planned workout as its base. */
  NO_BASE: 'ADAPTATION_NO_BASE',
  /** 409: another workout is in progress (`details.workoutId`). */
  WORKOUT_IN_PROGRESS: 'WORKOUT_IN_PROGRESS',
  /** 409: cancel on a finished adaptation. */
  NOT_CANCELLABLE: 'ADAPTATION_NOT_CANCELLABLE',
  /** Run failure: the proposal broke a hard rule after repair. */
  INVALID: 'ADAPTATION_INVALID',
  /** Run failure: the lifts cannot fit the minutes. */
  CANNOT_FIT: 'ADAPTATION_CANNOT_FIT',
  /** Run failure: the chosen gym no longer exists. */
  GYM_NOT_FOUND: 'ADAPTATION_GYM_NOT_FOUND',
  /** Run failure: the run reached its deadline or the process stopped. */
  TIMEOUT: 'ADAPTATION_TIMEOUT',
  /** Run failure: the job ended without settling the adaptation. */
  RUN_LOST: 'ADAPTATION_RUN_LOST',
  /** A safety stop (urgent-symptom text). */
  SAFETY_STOP: 'TRAINING_SAFETY_STOP',
} as const;

/** The request's bounds. */
export const ADAPTATION_REQUEST_LIMITS = {
  minutes: { min: 10, max: 240 },
  soreMuscles: { min: 1, max: 8 },
  onlyEquipment: { min: 1, max: 12 },
  freeTextChars: 500,
} as const;

/** The stored proposal's bounds (`contracts/adapted-workout.contract.ts`). */
export const ADAPTED_WORKOUT_LIMITS = {
  titleChars: 80,
  summaryChars: 400,
  exercises: { min: 1, max: 12 },
  sets: { min: 1, max: 8 },
  reps: { min: 1, max: 30 },
  rpe: { min: 5, max: 10, step: 0.5 },
  restSeconds: { min: 0, max: 600 },
  noteChars: 160,
  rationale: { min: 1, max: 6, chars: 200 },
  uncertainty: { max: 6, chars: 200 },
} as const;

/** The context's size bounds. */
export const ADAPTATION_CONTEXT_LIMITS = {
  /** Candidate exercises the planner may swap to or add. */
  maxCandidates: 60,
  /** Pain flags on logged sets within this many days exclude the exercise. */
  painFlagDays: 28,
} as const;

/**
 * The adaptation rules (`rules/adaptation-rules.ts`), documented in the spec
 * as a table. Tune here only.
 */
export const ADAPTATION_RULES = {
  /** Every set count reduction stops at this floor. (Time: E5.5's duration model, `guardrails/duration.ts`.) */
  setFloor: 2,
  soreness: {
    /** Mild: prime-mover sets at most this share of the base (floor `setFloor`), RPE at most `rpeCap`. */
    mild: { setsFactor: 0.75, rpeCap: 8 },
    /** Moderate: a prime mover that is kept gets at most `maxSets` sets and RPE at most `rpeCap`. */
    moderate: { maxSets: 2, rpeCap: 6 },
  },
  lowEnergy: {
    /** RPE at most this everywhere. */
    rpeCap: 7,
    /** Non-priority sets at most base minus this (floor `setFloor`). */
    setsBelowBase: 1,
    /** A check-in energy score at or below this counts as low energy. */
    checkInEnergyAtMost: 2,
  },
  /** With no base RPE to compare against, an exercise's RPE is capped here. */
  defaultRpeCap: 8,
  /** Rest the model may prescribe, seconds (E5.5's range). */
  restSeconds: { min: 30, max: 300 },
  /** "Try N + this" in the cannot-fit message. */
  cannotFitSuggestionStep: 10,
} as const;

/** Run event types this feature registers (identifiers and counts only). */
export const ADAPTATION_EVENT_TYPES = {
  CONTEXT: 'workout_adaptation.context',
  PROPOSAL: 'workout_adaptation.proposal',
  GUARDRAILS: 'workout_adaptation.guardrails',
  CRITIQUE: 'workout_adaptation.critique',
  READY: 'workout_adaptation.ready',
} as const;

/** Machine warning codes the graph records (`AdaptRunState.warnings`). */
export const ADAPTATION_WARNINGS = {
  /** The revision broke a hard rule; the first, checked proposal was kept. */
  REVISION_REJECTED: 'revision_rejected',
  /** The critic could not be asked (token cap or an unusable answer). */
  CRITIC_SKIPPED: 'critic_skipped',
  /**
   * The critic asked for a revision the run's token cap could not pay for;
   * the first, checked proposal ships (E6.3).
   */
  REVISION_SKIPPED_TOKEN_CAP: 'revision_skipped_token_cap',
} as const;

/**
 * Whether `error` is a unique violation on the ACTIVE-ADAPTATION index
 * specifically (positive match on the index name, like `isActiveRunConflict`):
 * any other `P2002` propagates untouched.
 */
export function isActiveAdaptationConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;

  const meta = (error.meta ?? {}) as Record<string, unknown>;
  const cause = (meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined)?.cause;
  if (cause) {
    const constraint = cause.constraint as { index?: unknown } | undefined;
    if (constraint?.index === ACTIVE_ADAPTATION_INDEX_NAME) return true;
    if (typeof cause.originalMessage === 'string' && cause.originalMessage.includes(ACTIVE_ADAPTATION_INDEX_NAME)) return true;
  }

  const target = meta.target;
  if (typeof target === 'string') return target === ACTIVE_ADAPTATION_INDEX_NAME;
  if (Array.isArray(target)) return target.some((entry) => String(entry) === ACTIVE_ADAPTATION_INDEX_NAME);

  return typeof error.message === 'string' && error.message.includes(ACTIVE_ADAPTATION_INDEX_NAME);
}
