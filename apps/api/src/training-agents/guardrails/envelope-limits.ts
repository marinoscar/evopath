// =============================================================================
// The adaptation envelope's limits (guardrail G10): code constants
// =============================================================================
//
// One file so a fork can tune them; the rules that read them are
// `envelope.ts` (E1 to E10). Out-of-bound operations are CLAMPED OR DROPPED
// and recorded, never turned into a question.
// =============================================================================

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const ENVELOPE_LIMITS = {
  /** E2: operations per adaptation (extras dropped in the model's order). */
  maxOperations: 8,
  /** E2: distinct exercises touched per adaptation. */
  maxDistinctExercises: 6,
  /** E3: no load, RPE or set increase with this many low-readiness days in a row. */
  increaseBlockedLowStreak: 3,
  /** E3: a pain flag on the exercise this recently (local days, inclusive) blocks an increase. */
  increasePainLookbackDays: 14,
  /** E4: weekly hard sets of a muscle may rise by at most this many sets ... */
  volumeRiseSets: 2,
  /** ... and this fraction (at least one set) ... */
  volumeRiseFraction: 0.15,
  /** ... and fall by at most this fraction (at least one set), deloads and pain responses excepted. */
  volumeFallFraction: 0.3,
  /** E5: swaps per workout per adaptation. */
  swapsPerWorkout: 2,
  /** E5: dropped workout slots per adaptation. */
  droppedWorkoutsPerAdaptation: 1,
  /** E5: workouts per week never below `max(minWorkoutsPerWeek, daysPerWeek - 1)`. */
  minWorkoutsPerWeek: 2,
  /** E5: every changed workout keeps at least this many exercises ... */
  minExercisesPerWorkout: 2,
  /** ... and at least one priority exercise when it had one. */
  minPriorityPerWorkout: 1,
  /** E7: one autonomous adaptation per plan per this window (recovery and pain responses exempt). */
  adaptationSpacingMs: 48 * HOUR_MS,
  /** E7: one `regenerate_remaining` per plan per this window. */
  regenerateSpacingMs: 14 * DAY_MS,
  /** E10: an escalation needs at least this many unstarted weeks. */
  regenerateMinUnstartedWeeks: 2,
  /** Value bounds an operation is clamped into before the guardrails see it. */
  bounds: {
    sets: { min: 1, max: 6 },
    reps: { min: 1, max: 30 },
    restSeconds: { min: 30, max: 300 },
    rpe: { min: 5, max: 10, step: 0.5 },
    loadKg: { min: 0, max: 1000 },
  },
} as const;
