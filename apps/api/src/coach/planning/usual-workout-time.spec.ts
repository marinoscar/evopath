import { usualWorkoutMinuteLocal } from './usual-workout-time';

// AC 11: the median local start minute over 4 weeks of completed workouts; null below 4 sessions.

const at = (iso: string) => new Date(iso);

describe('usualWorkoutMinuteLocal', () => {
  it('is null with fewer than 4 sessions', () => {
    expect(usualWorkoutMinuteLocal([], 'UTC')).toBeNull();
    expect(
      usualWorkoutMinuteLocal([at('2026-09-01T18:00:00Z'), at('2026-09-02T18:00:00Z'), at('2026-09-03T18:00:00Z')], 'UTC'),
    ).toBeNull();
  });

  it('is the middle value of an odd count, regardless of order', () => {
    const starts = ['19:00', '07:15', '18:00', '18:30', '06:00'].map((t, i) => at(`2026-09-0${i + 1}T${t}:00Z`));
    expect(usualWorkoutMinuteLocal(starts, 'UTC')).toBe(18 * 60);
  });

  it('is the floored mean of the two middle values of an even count', () => {
    const starts = ['17:00', '18:01', '18:00', '19:00'].map((t, i) => at(`2026-09-0${i + 1}T${t}:00Z`));
    // middle: 18:00 and 18:01 -> 18:00 (1080.5 floored)
    expect(usualWorkoutMinuteLocal(starts, 'UTC')).toBe(18 * 60);
  });

  it('reads the start minute in the user\'s zone, across a DST change', () => {
    // 18:00 local in New York, two sessions before and two after the 2026-03-08 spring-forward.
    const starts = [
      at('2026-03-05T23:00:00Z'), // 18:00 EST
      at('2026-03-06T23:00:00Z'), // 18:00 EST
      at('2026-03-09T22:00:00Z'), // 18:00 EDT
      at('2026-03-10T22:00:00Z'), // 18:00 EDT
    ];
    expect(usualWorkoutMinuteLocal(starts, 'America/New_York')).toBe(18 * 60);
    // The same instants read in UTC straddle 22:00 and 23:00.
    expect(usualWorkoutMinuteLocal(starts, 'UTC')).toBe(22 * 60 + 30);
  });

  it('reads a half-hour zone (Asia/Kolkata)', () => {
    const starts = [1, 2, 3, 4].map((d) => at(`2026-09-0${d}T01:00:00Z`)); // 06:30 IST
    expect(usualWorkoutMinuteLocal(starts, 'Asia/Kolkata')).toBe(6 * 60 + 30);
  });

  it('falls back to UTC for an unknown zone', () => {
    const starts = [1, 2, 3, 4].map((d) => at(`2026-09-0${d}T07:45:00Z`));
    expect(usualWorkoutMinuteLocal(starts, 'Not/AZone')).toBe(7 * 60 + 45);
  });
});
