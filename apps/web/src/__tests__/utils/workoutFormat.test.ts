/** `utils/workoutFormat.ts` (E4.3): set field text, durations, distance, volume and effort. */
import { describe, it, expect } from 'vitest';
import {
  EFFORT_RIR,
  distanceInputText,
  effortFromRir,
  effortOf,
  formatClock,
  formatDuration,
  formatVolume,
  parseClock,
  parseDistance,
  parseReps,
  setHasValues,
  weightInputText,
} from '../../utils/workoutFormat';

describe('utils/workoutFormat', () => {
  it('shows a stored weight in the display unit without trailing zeros', () => {
    expect(weightInputText(31.751, 'lb')).toBe('70');
    expect(weightInputText(31.751, 'kg')).toBe('31.75');
    expect(weightInputText(100, 'kg')).toBe('100');
    expect(weightInputText(null, 'kg')).toBe('');
  });

  it('parses reps as whole numbers in bounds; blank is no value', () => {
    expect(parseReps('10')).toEqual({ ok: true, value: 10 });
    expect(parseReps('')).toEqual({ ok: true, value: null });
    expect(parseReps('9.5').ok).toBe(false);
    expect(parseReps('1001').ok).toBe(false);
  });

  it('parses and formats durations as mm:ss, h:mm:ss or plain seconds', () => {
    expect(parseClock('1:30')).toEqual({ ok: true, value: 90 });
    expect(parseClock('90')).toEqual({ ok: true, value: 90 });
    expect(parseClock('1:02:05')).toEqual({ ok: true, value: 3725 });
    expect(parseClock('')).toEqual({ ok: true, value: null });
    expect(parseClock('1:75').ok).toBe(false);
    expect(parseClock('abc').ok).toBe(false);
    expect(formatClock(90)).toBe('1:30');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(null)).toBe('');
    expect(formatDuration(3900)).toBe('1 h 05 min');
    expect(formatDuration(2700)).toBe('45 min');
    expect(formatDuration(20)).toBe('under 1 min');
  });

  it('converts distances: km for metric users, miles for imperial ones', () => {
    expect(parseDistance('5', 'km')).toEqual({ ok: true, value: 5000 });
    expect(parseDistance('1', 'mi')).toEqual({ ok: true, value: 1609.34 });
    expect(parseDistance('5,5', 'km').ok).toBe(false);
    expect(distanceInputText(5000, 'km')).toBe('5');
    expect(distanceInputText(1609.34, 'mi')).toBe('1');
  });

  it('formats volume in whole display units', () => {
    // 70 lb x (10 + 10 + 9) reps.
    expect(formatVolume(31.751 * 29, 'lb')).toBe(`${(2030).toLocaleString()} lb`);
    expect(formatVolume(920.779, 'kg')).toBe('921 kg');
  });

  it('maps effort chips to RIR: Easy 3+, Right 1-2, Hard 0', () => {
    expect(EFFORT_RIR).toEqual({ easy: 3, right: 2, hard: 0 });
    expect(effortFromRir(5)).toBe('easy');
    expect(effortFromRir(3)).toBe('easy');
    expect(effortFromRir(2)).toBe('right');
    expect(effortFromRir(1)).toBe('right');
    expect(effortFromRir(0)).toBe('hard');
  });

  it('reads the chip from RIR, else from RPE, and an untouched set has none', () => {
    expect(effortOf({ rir: null, rpe: null })).toBeNull();
    expect(effortOf({ rir: 0, rpe: 6 })).toBe('hard');
    expect(effortOf({ rir: null, rpe: 8 })).toBe('right');
    expect(effortOf({ rir: null, rpe: 10 })).toBe('hard');
    expect(effortOf({ rir: null, rpe: 6.5 })).toBe('easy');
  });

  it('knows whether a set holds a typed value', () => {
    const empty = { weightKg: null, reps: null, durationSeconds: null, distanceMeters: null };
    expect(setHasValues(empty)).toBe(false);
    expect(setHasValues({ ...empty, reps: 8 })).toBe(true);
  });
});
