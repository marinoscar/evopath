import { z } from 'zod';

import { EXERCISE_NAME_MAX } from '../../exercises/exercises.constants';
import { SET_BOUNDS } from '../workouts.constants';

// =============================================================================
// A `workout_prefill` draft item's value (E4.5)
// =============================================================================
//
// One exercise with the sets the photo shows, in the API's canonical units
// (kilograms, metres). `exerciseSlug` is a library slug (or one of the
// caller's custom exercise slugs, picked in the review), or `null` for an
// exercise that is not in the library: `apply` then reuses the caller's custom
// exercise with the same name or creates one.
//
// `rawText` is the line as the model transcribed it, shown next to the guess.
// A user's own item may omit it and `sets` (both default to empty).
// =============================================================================

export const WORKOUT_PREFILL_ITEM_KIND = 'exercise';
export const WORKOUT_PREFILL_VALUE_SETS_MAX = 12;
export const WORKOUT_PREFILL_RAW_TEXT_MAX = 200;
export const EXERCISE_SLUG_MAX = 64;

/** A number in [min, max] with at most `decimals` fractional digits. */
function boundedDecimal(min: number, max: number, decimals: number) {
  const factor = 10 ** decimals;
  return z
    .number()
    .min(min)
    .max(max)
    .refine((value) => Math.abs(value * factor - Math.round(value * factor)) < 1e-6, {
      message: `At most ${decimals} decimal places`,
    });
}

export const workoutPrefillSetSchema = z
  .object({
    reps: z.number().int().min(SET_BOUNDS.reps.min).max(SET_BOUNDS.reps.max).nullable(),
    weightKg: boundedDecimal(SET_BOUNDS.weightKg.min, SET_BOUNDS.weightKg.max, SET_BOUNDS.weightKg.decimals)
      .nullable()
      .meta({ description: 'Kilograms, 0..1000, at most 3 decimals.' }),
    durationSeconds: z
      .number()
      .int()
      .min(SET_BOUNDS.durationSeconds.min)
      .max(SET_BOUNDS.durationSeconds.max)
      .nullable(),
    distanceMeters: boundedDecimal(
      SET_BOUNDS.distanceMeters.min,
      SET_BOUNDS.distanceMeters.max,
      SET_BOUNDS.distanceMeters.decimals,
    )
      .nullable()
      .meta({ description: 'Metres, 0..1,000,000, at most 2 decimals.' }),
  })
  .strict();

export const workoutPrefillValueSchema = z
  .object({
    exerciseSlug: z.string().trim().min(1).max(EXERCISE_SLUG_MAX).nullable().default(null),
    name: z.string().trim().min(1).max(EXERCISE_NAME_MAX),
    rawText: z.string().max(WORKOUT_PREFILL_RAW_TEXT_MAX).nullable().default(null),
    sets: z.array(workoutPrefillSetSchema).max(WORKOUT_PREFILL_VALUE_SETS_MAX).default([]),
  })
  .strict();

export type WorkoutPrefillSet = z.output<typeof workoutPrefillSetSchema>;
export type WorkoutPrefillValue = z.output<typeof workoutPrefillValueSchema>;

/**
 * The tracking mode a new custom exercise gets from its sets: any distance is
 * `distance_time`; durations with no weight and no reps are `time`; anything
 * else (no sets included) is `weight_reps`.
 */
export function inferTrackingMode(sets: readonly WorkoutPrefillSet[]): 'weight_reps' | 'time' | 'distance_time' {
  if (sets.some((set) => set.distanceMeters !== null)) return 'distance_time';

  const hasDuration = sets.some((set) => set.durationSeconds !== null);
  const hasWeightOrReps = sets.some((set) => set.weightKg !== null || set.reps !== null);

  return hasDuration && !hasWeightOrReps ? 'time' : 'weight_reps';
}
