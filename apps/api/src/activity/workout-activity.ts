// =============================================================================
// Workout auto-credit — which activity entries a completed workout implies
// =============================================================================
//
// Pure. A COMPLETED workout materialises one `activity_entries` row per kind
// it credits (source 'workout', `workoutId` set, `occurredOn` = the workout's
// local `date`); `activity_entries_workout_kind_uniq_idx` makes that one row
// per (workout, kind). Anything not completed credits nothing.
//
//   workout_any   always; durationSeconds = the workout's duration
//   walk          an `outdoor_walk` or `hike` exercise with a completed set
//   run           an `outdoor_run` exercise with a completed set
//   cardio_any    any exercise of movement pattern `cardio` with a completed set
//
// durationSeconds / distanceMeters of walk, run and cardio_any are the sums
// over the matching exercises' COMPLETED sets (a prefilled target the user
// never ticked is not activity), null when no such set carries the value.
// Values are clamped to the table's CHECK ranges.
// =============================================================================

import {
  CARDIO_MOVEMENT_PATTERN,
  ENTRY_BOUNDS,
  RUN_EXERCISE_SLUGS,
  WALK_EXERCISE_SLUGS,
  type ActivityKindValue,
} from './activity.constants';

export interface CreditWorkout {
  id: string;
  /** Local day, `YYYY-MM-DD`. */
  date: string;
  status: string;
  durationSeconds: number | null;
  endedAt: Date | null;
  exercises: Array<{
    slug: string;
    movementPattern: string;
    sets: Array<{ completed: boolean; durationSeconds: number | null; distanceMeters: number | null }>;
  }>;
}

export interface DerivedEntry {
  activityKind: ActivityKindValue;
  occurredOn: string;
  occurredAt: Date | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
}

function clamp(value: number | null, bounds: { min: number; max: number }): number | null {
  if (value === null) return null;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

function sumSets(exercises: CreditWorkout['exercises']): { durationSeconds: number | null; distanceMeters: number | null } {
  let duration: number | null = null;
  let distance: number | null = null;
  for (const exercise of exercises) {
    for (const set of exercise.sets) {
      if (!set.completed) continue;
      if (set.durationSeconds !== null) duration = (duration ?? 0) + set.durationSeconds;
      if (set.distanceMeters !== null) distance = (distance ?? 0) + set.distanceMeters;
    }
  }
  return {
    durationSeconds: clamp(duration, ENTRY_BOUNDS.durationSeconds),
    distanceMeters: distance === null ? null : clamp(Math.round(distance * 100) / 100, ENTRY_BOUNDS.distanceMeters),
  };
}

/** The derived entries `workout` should have, by kind. Empty unless it is completed. */
export function derivedEntriesFor(workout: CreditWorkout): DerivedEntry[] {
  if (workout.status !== 'completed') return [];

  const base = { occurredOn: workout.date, occurredAt: workout.endedAt };
  const done = workout.exercises.filter((exercise) => exercise.sets.some((set) => set.completed));
  const entries: DerivedEntry[] = [
    {
      ...base,
      activityKind: 'workout_any',
      durationSeconds: clamp(workout.durationSeconds, ENTRY_BOUNDS.durationSeconds),
      distanceMeters: null,
    },
  ];

  const groups: Array<[ActivityKindValue, CreditWorkout['exercises']]> = [
    ['walk', done.filter((exercise) => WALK_EXERCISE_SLUGS.includes(exercise.slug))],
    ['run', done.filter((exercise) => RUN_EXERCISE_SLUGS.includes(exercise.slug))],
    ['cardio_any', done.filter((exercise) => exercise.movementPattern === CARDIO_MOVEMENT_PATTERN)],
  ];
  for (const [activityKind, exercises] of groups) {
    if (exercises.length > 0) entries.push({ ...base, activityKind, ...sumSets(exercises) });
  }

  return entries;
}
