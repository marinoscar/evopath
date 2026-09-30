// =============================================================================
// Continuous evaluation: triggers, per-user limits and due rules (E5.8)
// =============================================================================
//
// Code constants, not settings: the AI kill switch is the only global off.
// The scheduler (`training-evaluation.scheduler.ts`) reads the limits; the pure
// gate (`evaluation-gates.ts`) and due rules (`evaluation-due.ts`) are
// table-tested against them.
// =============================================================================

/** The triggers the scheduler creates evaluation runs for (`training_plan_runs.trigger`). */
export const AUTOMATIC_EVALUATION_TRIGGERS = ['workout_finished', 'weekly', 'missed_sessions'] as const;
export type AutomaticEvaluationTrigger = (typeof AUTOMATIC_EVALUATION_TRIGGERS)[number];

/** The trigger a user-started evaluation (`POST /api/ai/training/runs`, "Re-evaluate now") records. */
export const MANUAL_EVALUATION_TRIGGER = 'manual';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const EVALUATION_LIMITS = {
  /** Automatic evaluation runs per user per UTC day. */
  maxAutomaticPerUtcDay: 3,
  /** Between two automatic runs (the follow-up rule is exempt). */
  minAutomaticSpacingMs: 30 * MINUTE_MS,
  /** After a manual run, for any run (manual answers 409, automatic defers). */
  manualCooldownMs: 30 * MINUTE_MS,
} as const;

export const EVALUATION_DUE = {
  /** Weekly review: the user's local Sunday (ISO 7) from 18:00. */
  weeklyWeekday: 7,
  weeklyHour: 18,
  /** A weekly review is at least this far after the previous one. */
  weeklyMinGapMs: 6 * DAY_MS,
  /** The plan has been active (since `startDate`) at least this many days. */
  weeklyMinActiveDays: 5,
  /** `signals.adherence.missedStreak` at or above this is due. */
  missedStreakMin: 2,
  /** ... when the last evaluation is at least this old (or none). */
  missedSessionsMinIdleMs: 3 * DAY_MS,
  /** Checked at most once a day per plan: in the sweep pass that runs in this local hour. */
  missedSessionsCheckLocalHour: 6,
} as const;

/** The sweep's per-pass caps. */
export const EVALUATION_SWEEP = {
  /** Users (active programs) a pass evaluates at most. */
  maxUsers: 200,
  /** Runs a pass creates or cancels (expired proposals) at most. */
  maxRuns: 500,
  /** Active programs read per page while looking for due ones. */
  pageSize: 500,
  /** Pages a pass reads at most (a bound, not a target). */
  maxPages: 100,
} as const;

/** `details.reason` of the manual cooldown refusal (409, with `details.retryAfterSeconds`). */
export const EVALUATION_COOLDOWN_REASON = 'TRAINING_EVALUATION_COOLDOWN';

/** Why the scheduler did not create a run. */
export const EVALUATION_SKIP_REASONS = [
  'ai_disabled',
  'graph_not_ready',
  'no_active_program',
  'automation_paused',
  'evaluator_unavailable',
  'proposal_pending',
  'active_run',
  'covered_by_queued_run',
  'daily_cap',
  'manual_cooldown',
  'min_spacing',
] as const;
export type EvaluationSkipReason = (typeof EVALUATION_SKIP_REASONS)[number];
