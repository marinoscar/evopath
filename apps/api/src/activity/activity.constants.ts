// =============================================================================
// Activity goals and entries (epic #260; #266, #267, #268): vocabulary,
// bounds, refusal reasons and the goal templates.
// =============================================================================
//
// The value sets mirror the Prisma enums (`ActivityKind`, `GoalMetric`,
// `GoalPeriod`, `GoalStatus`, `ActivitySource`). `steps` is an entry-only
// kind: a goal refuses it (Zod here, `activity_goals_kind_chk` in SQL).
// Units are always metric: seconds and meters.
// =============================================================================

export const ACTIVITY_KINDS = ['walk', 'run', 'cardio_any', 'workout_any', 'custom', 'steps'] as const;
export type ActivityKindValue = (typeof ACTIVITY_KINDS)[number];

/** Kinds a goal may track: every kind but `steps`. */
export const GOAL_ACTIVITY_KINDS = ['walk', 'run', 'cardio_any', 'workout_any', 'custom'] as const;
export type GoalActivityKind = (typeof GOAL_ACTIVITY_KINDS)[number];

export const GOAL_METRICS = ['sessions', 'minutes', 'steps', 'distance_m'] as const;
export type GoalMetricValue = (typeof GOAL_METRICS)[number];

export const GOAL_PERIODS = ['week', 'day'] as const;
export type GoalPeriodValue = (typeof GOAL_PERIODS)[number];

export const GOAL_STATUSES = ['active', 'paused', 'archived'] as const;
export type GoalStatusValue = (typeof GOAL_STATUSES)[number];

export const ACTIVITY_SOURCES = ['manual', 'workout', 'integration'] as const;
export type ActivitySourceValue = (typeof ACTIVITY_SOURCES)[number];

// -----------------------------------------------------------------------------
// Bounds
// -----------------------------------------------------------------------------

export const GOAL_TITLE_MAX = 80;
export const GOAL_CUSTOM_LABEL_MAX = 80;
export const GOAL_TARGET_MIN = 1;
export const GOAL_TARGET_MAX = 1_000_000;
/** More ACTIVE goals than this is a 409 `GOAL_LIMIT_REACHED` (create and resume). */
export const MAX_ACTIVE_GOALS = 10;
/** `startsOn` may lie at most this many days before or after today (local). */
export const GOAL_STARTS_ON_WINDOW_DAYS = 366;

/** `GET /api/goals/:id/history?limit=`. */
export const GOAL_HISTORY_LIMIT_DEFAULT = 12;
export const GOAL_HISTORY_LIMIT_MAX = 100;

/**
 * How far back progress looks for streaks and history: periods starting before
 * `date - GOAL_LOOKBACK_DAYS` are not evaluated, so a streak is capped there.
 */
export const GOAL_LOOKBACK_DAYS = 400;

/** An entry's local day may be today or up to this many days earlier. */
export const ENTRY_MAX_DAYS_BACK = 7;
/** `GET /api/activity-entries?from&to`: at most this many days, inclusive. */
export const ENTRY_LIST_MAX_RANGE_DAYS = 400;
/** `POST /api/activity-entries/batch`. */
export const ENTRY_BATCH_MAX = 500;
export const ENTRY_NOTE_MAX = 280;
export const ENTRY_PROVIDER_MAX = 64;
export const ENTRY_EXTERNAL_ID_MAX = 200;

/** Mirrors the CHECKs on `activity_entries`. */
export const ENTRY_BOUNDS = {
  steps: { min: 0, max: 200_000 },
  durationSeconds: { min: 0, max: 86_400 },
  distanceMeters: { min: 0, max: 1_000_000, decimals: 2 },
} as const;

/** `GET /api/goals/progress?date=`: how far from the server's local today a date may be. */
export const PROGRESS_DATE_FUTURE_DAYS = 1;

/**
 * Workout-derived entries are re-checked against their workouts for this many
 * local days back (today included) on every progress or entry read, which
 * catches edits to a completed workout (sets, date) and workouts created
 * completed without a `workout.finished` event.
 */
export const DERIVED_RECONCILE_DAYS = 14;

// -----------------------------------------------------------------------------
// Refusals (`details.reason`)
// -----------------------------------------------------------------------------

export const ACTIVITY_REASONS = {
  GOAL_LIMIT_REACHED: 'GOAL_LIMIT_REACHED',
  IF_MATCH_REQUIRED: 'IF_MATCH_REQUIRED',
  GOAL_VERSION_MISMATCH: 'GOAL_VERSION_MISMATCH',
  GOAL_ARCHIVED: 'GOAL_ARCHIVED',
  ILLEGAL_TRANSITION: 'GOAL_ILLEGAL_TRANSITION',
  INVALID_GOAL: 'INVALID_GOAL',
  START_DATE_OUT_OF_RANGE: 'START_DATE_OUT_OF_RANGE',
  ENTRY_DATE_OUT_OF_RANGE: 'ENTRY_DATE_OUT_OF_RANGE',
  ENTRY_DERIVED: 'ENTRY_DERIVED',
  INVALID_ENTRY: 'INVALID_ENTRY',
  RANGE_TOO_LARGE: 'RANGE_TOO_LARGE',
  DATE_OUT_OF_RANGE: 'DATE_OUT_OF_RANGE',
} as const;

// -----------------------------------------------------------------------------
// Goal transitions and templates
// -----------------------------------------------------------------------------

export type GoalTransition = 'pause' | 'resume' | 'archive';

/** Legal source states per transition; the target state itself is an idempotent no-op. */
export const GOAL_TRANSITIONS: Record<GoalTransition, { from: readonly GoalStatusValue[]; to: GoalStatusValue }> = {
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  archive: { from: ['active', 'paused'], to: 'archived' },
};

export interface GoalTemplateData {
  key: string;
  title: string;
  activityKind: GoalActivityKind;
  metric: GoalMetricValue;
  target: number;
  period: GoalPeriodValue;
}

export const GOAL_TEMPLATES: readonly GoalTemplateData[] = Object.freeze([
  { key: 'walk_4x_week', title: 'Walk 4 times a week', activityKind: 'walk', metric: 'sessions', target: 4, period: 'week' },
  {
    key: 'cardio_150_min_week',
    title: '150 minutes of cardio a week',
    activityKind: 'cardio_any',
    metric: 'minutes',
    target: 150,
    period: 'week',
  },
  { key: 'steps_8000_day', title: '8,000 steps a day', activityKind: 'walk', metric: 'steps', target: 8000, period: 'day' },
  { key: 'workout_3x_week', title: 'Work out 3 times a week', activityKind: 'workout_any', metric: 'sessions', target: 3, period: 'week' },
]);

// -----------------------------------------------------------------------------
// Workout auto-credit (materialised entries, source 'workout')
// -----------------------------------------------------------------------------

/** Exercise slugs that credit a `walk` entry. */
export const WALK_EXERCISE_SLUGS: readonly string[] = ['outdoor_walk', 'hike'];
/** Exercise slugs that credit a `run` entry. */
export const RUN_EXERCISE_SLUGS: readonly string[] = ['outdoor_run'];
/** Exercises with this movement pattern credit a `cardio_any` entry. */
export const CARDIO_MOVEMENT_PATTERN = 'cardio';
