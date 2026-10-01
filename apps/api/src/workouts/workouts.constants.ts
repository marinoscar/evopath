// =============================================================================
// Workouts (E4.2) — shared limits and refusal reasons
// =============================================================================
//
// One home for every bound the DTOs, the services and the tests agree on.
// Machine-readable refusal reasons go in `details.reason` (the error filter
// derives the top-level `code` from the status), as in the gyms and exercises
// modules. Weights are kilograms and distances metres everywhere in the API;
// the web converts for display from the Health Profile `unitSystem`.
// =============================================================================

export const WORKOUT_STATUSES = ['in_progress', 'completed'] as const;
export type WorkoutStatus = (typeof WORKOUT_STATUSES)[number];

export const WORKOUT_NAME_MAX = 80;
export const WORKOUT_NOTES_MAX = 1000;
export const SET_NOTES_MAX = 1000;
export const SET_PAIN_NOTE_MAX = 500;

/** A start date the client sends must be within this many days of the server's today. */
export const WORKOUT_DATE_WINDOW_DAYS = 2;
/** Clock skew tolerated on `startedAt` / `endedAt` in the future. */
export const WORKOUT_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Upper bound on an edited `durationSeconds` (7 days). */
export const WORKOUT_DURATION_MAX_SECONDS = 7 * 24 * 60 * 60;

export const MAX_EXERCISES_PER_WORKOUT = 30;
export const MAX_SETS_PER_EXERCISE = 40;

/** A previous completion older than this does not derive `restSeconds`. */
export const REST_DERIVATION_WINDOW_SECONDS = 15 * 60;

export const WORKOUT_LIST_PAGE_SIZE_DEFAULT = 20;
export const WORKOUT_LIST_PAGE_SIZE_MAX = 50;

/** Set field bounds (mirrored by the `set_logs_ranges_chk` CHECK). */
export const SET_BOUNDS = {
  weightKg: { min: 0, max: 1000, decimals: 3 },
  reps: { min: 0, max: 1000 },
  durationSeconds: { min: 0, max: 86_400 },
  distanceMeters: { min: 0, max: 1_000_000, decimals: 2 },
  rpe: { min: 1, max: 10, step: 0.5 },
  rir: { min: 0, max: 10 },
  restSeconds: { min: 0, max: 7200 },
} as const;

/** `details.reason` values this module answers with. */
export const WORKOUT_REFUSALS = {
  WORKOUT_DATE_OUT_OF_RANGE: 'WORKOUT_DATE_OUT_OF_RANGE',
  TIME_IN_FUTURE: 'TIME_IN_FUTURE',
  ENDED_BEFORE_STARTED: 'ENDED_BEFORE_STARTED',
  WORKOUT_NOT_COMPLETED: 'WORKOUT_NOT_COMPLETED',
  WORKOUT_EXERCISE_LIMIT: 'WORKOUT_EXERCISE_LIMIT',
  WORKOUT_SET_LIMIT: 'WORKOUT_SET_LIMIT',
  EXERCISE_PENDING_REVIEW: 'EXERCISE_PENDING_REVIEW',
  /** `GET /api/workouts/summary?today=` more than 2 days from the server's today. */
  TODAY_OUT_OF_RANGE: 'TODAY_OUT_OF_RANGE',
  /** `POST /api/workouts/quick-cardio` `performedAt` more than 7 days ago. */
  PERFORMED_AT_OUT_OF_RANGE: 'PERFORMED_AT_OUT_OF_RANGE',
} as const;

/** `GET /api/exercises/:id/history` `limit` (recent workouts). */
export const EXERCISE_HISTORY_LIMIT_DEFAULT = 3;
export const EXERCISE_HISTORY_LIMIT_MAX = 10;

// -----------------------------------------------------------------------------
// Quick cardio log (E8 F4, #264): a gym-free walk, run or hike in one call
// -----------------------------------------------------------------------------

/** The seeded `distance_time` exercises `POST /api/workouts/quick-cardio` accepts, by slug. */
export const QUICK_CARDIO_EXERCISE_KEYS = ['outdoor_walk', 'outdoor_run', 'hike'] as const;
export type QuickCardioExerciseKey = (typeof QUICK_CARDIO_EXERCISE_KEYS)[number];

export const QUICK_CARDIO_DURATION_SECONDS = { min: 60, max: 36_000 } as const;
export const QUICK_CARDIO_DISTANCE_METERS_MAX = 100_000;
/** `performedAt` may be at most this many days in the past. */
export const QUICK_CARDIO_BACKDATE_DAYS = 7;
export const QUICK_CARDIO_NOTE_MAX = 280;
