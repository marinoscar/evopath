import { describe, it, expect } from 'vitest';
import {
  formatTakenAt,
  parseDateTimeLocalValue,
  toDateTimeLocalValue,
} from '../../utils/measurementDates';

// Local wall-clock instants, so the tests hold in any time zone.
const NOW = new Date(2026, 8, 29, 12, 0);

describe('measurementDates', () => {
  describe('formatTakenAt', () => {
    it('says Today for the same local day, and for a slightly future time', () => {
      expect(formatTakenAt(new Date(2026, 8, 29, 0, 5).toISOString(), NOW)).toBe('Today');
      expect(formatTakenAt(new Date(2026, 8, 29, 12, 3).toISOString(), NOW)).toBe('Today');
    });

    it('counts calendar days, not 24-hour blocks', () => {
      expect(formatTakenAt(new Date(2026, 8, 28, 23, 0).toISOString(), NOW)).toBe('Yesterday');
      expect(formatTakenAt(new Date(2026, 8, 26, 8, 0).toISOString(), NOW)).toBe('3 days ago');
      expect(formatTakenAt(new Date(2026, 7, 30, 8, 0).toISOString(), NOW)).toBe('30 days ago');
    });

    it('shows a date beyond 30 days', () => {
      const iso = new Date(2026, 7, 1, 8, 0).toISOString();
      expect(formatTakenAt(iso, NOW)).toBe(
        new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
      );
    });

    it('returns an unparseable input unchanged', () => {
      expect(formatTakenAt('not a date', NOW)).toBe('not a date');
    });
  });

  describe('datetime-local values', () => {
    it('formats and parses local wall-clock time', () => {
      expect(toDateTimeLocalValue(new Date(2026, 0, 5, 7, 9))).toBe('2026-01-05T07:09');
      expect(parseDateTimeLocalValue('2026-01-05T07:09')?.getTime()).toBe(new Date(2026, 0, 5, 7, 9).getTime());
    });

    it('rejects malformed and impossible dates', () => {
      expect(parseDateTimeLocalValue('')).toBeNull();
      expect(parseDateTimeLocalValue('2026-02-30T10:00')).toBeNull();
      expect(parseDateTimeLocalValue('yesterday')).toBeNull();
    });
  });
});
