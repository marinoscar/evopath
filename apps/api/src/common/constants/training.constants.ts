// =============================================================================
// Training vocabularies — muscles, movement patterns, tracking modes
// =============================================================================
//
// The one home of the fixed vocabularies the exercise library (E4.1) and the
// capability catalog (E3.2) share. Zod DTOs import them from here.
//
// `prisma/seed-data.ts` carries an identical copy on purpose: the seed runs
// under ts-node from `prisma/` alone (the production image copies `prisma/`
// but not `src/`), so it cannot import this file. `test/prisma/seed-data.spec.ts`
// asserts the two copies are equal, so they cannot drift silently.
//
// Every value is PERMANENT once stored: rows hold these strings as free text.
// Append new values; never rename or remove one.
// =============================================================================

export const MUSCLES = [
  'chest', 'upper_back', 'lats', 'traps', 'shoulders', 'rear_delts', 'biceps',
  'triceps', 'forearms', 'abs', 'obliques', 'lower_back', 'glutes', 'quads',
  'hamstrings', 'calves', 'hip_flexors', 'adductors', 'abductors', 'full_body',
] as const;
export type Muscle = (typeof MUSCLES)[number];

export const MOVEMENT_PATTERNS = [
  'squat', 'hinge', 'horizontal_push', 'vertical_push', 'horizontal_pull',
  'vertical_pull', 'lunge', 'carry', 'core', 'isolation', 'cardio',
] as const;
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];

/** How a set of the exercise is measured (matches the DB CHECK on `exercises.tracking_mode`). */
export const EXERCISE_TRACKING_MODES = [
  'weight_reps', 'bodyweight_reps', 'time', 'distance_time',
] as const;
export type ExerciseTrackingMode = (typeof EXERCISE_TRACKING_MODES)[number];

/** Who created an exercise row: the seed, the user by hand, or an AI proposal. */
export const EXERCISE_ORIGINS = ['seed', 'user', 'ai'] as const;
export type ExerciseOrigin = (typeof EXERCISE_ORIGINS)[number];

/** `pending_review` is an AI proposal the user has not approved yet. */
export const EXERCISE_STATUSES = ['active', 'pending_review'] as const;
export type ExerciseStatus = (typeof EXERCISE_STATUSES)[number];
