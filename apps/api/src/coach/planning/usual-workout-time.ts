import { localMinuteOf } from './coach-time';

// =============================================================================
// `usualWorkoutMinuteLocal` (E7.4; docs/specs/ai-coach.md §2.2)
// =============================================================================
//
// The median start minute of the local day over the last 4 weeks of
// completed workouts; null with fewer than 4 sessions. It anchors
// `streak_at_risk` (the 23.5-hour rule: the reminder lands 30 minutes before
// the user usually trains). Pure: the caller passes the start instants.
// =============================================================================

/** The look-back window, in days. */
export const USUAL_WORKOUT_WINDOW_DAYS = 28;

/** Fewer completed workouts than this in the window: no usual time. */
export const USUAL_WORKOUT_MIN_SESSIONS = 4;

/**
 * The median local start minute of `startedAt` (instants of completed
 * workouts already limited to the window), in `timeZone`. An even count takes
 * the mean of the two middle values, floored, so the result is always a whole
 * minute. Null below {@link USUAL_WORKOUT_MIN_SESSIONS}.
 */
export function usualWorkoutMinuteLocal(
  startedAt: readonly Date[],
  timeZone: string | null | undefined,
): number | null {
  if (startedAt.length < USUAL_WORKOUT_MIN_SESSIONS) return null;
  const minutes = startedAt.map((instant) => localMinuteOf(instant, timeZone)).sort((a, b) => a - b);
  const middle = Math.floor(minutes.length / 2);
  if (minutes.length % 2 === 1) return minutes[middle];
  return Math.floor((minutes[middle - 1] + minutes[middle]) / 2);
}
