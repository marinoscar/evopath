// =============================================================================
// Today's planned workout (E5.7): limits and refusal reasons
// =============================================================================

/** The client's `date` must be within this many days of the server's today. */
export const TODAY_DATE_WINDOW_DAYS = 2;

/** `details.reason` values this feature answers with. */
export const TODAY_REASONS = {
  /** `date` more than `TODAY_DATE_WINDOW_DAYS` from the server's today. */
  DATE_OUT_OF_RANGE: 'TODAY_OUT_OF_RANGE',
  /** The program was paused, archived or completed before start. */
  PROGRAM_NOT_ACTIVE: 'PROGRAM_NOT_ACTIVE',
  /** A different workout is in progress; `details.workoutId` names it. */
  WORKOUT_IN_PROGRESS: 'WORKOUT_IN_PROGRESS',
  /** The planned workout has no exercises. */
  PROGRAM_WORKOUT_EMPTY: 'PROGRAM_WORKOUT_EMPTY',
} as const;
