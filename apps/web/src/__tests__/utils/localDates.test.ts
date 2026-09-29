import { describe, it, expect } from 'vitest';
import { formatDayLabel, formatLongDate } from '../../utils/localDates';

describe('utils/localDates', () => {
  it('formats a date-only value as the same calendar day, whatever the browser zone', () => {
    // Parsed as UTC midnight and formatted in UTC: never the day before.
    expect(formatLongDate('2026-09-29', 2026)).toBe('Tuesday, September 29');
    expect(formatLongDate('2026-01-01', 2026)).toBe('Thursday, January 1');
  });

  it('adds the year when it is not the reference year', () => {
    expect(formatLongDate('2025-12-31', 2026)).toBe('Wednesday, December 31, 2025');
  });

  it('returns anything that is not YYYY-MM-DD unchanged', () => {
    expect(formatLongDate('soon')).toBe('soon');
    expect(formatDayLabel('soon')).toBe('soon');
  });

  it('labels today and yesterday relative to the server day', () => {
    expect(formatDayLabel('2026-09-29', '2026-09-29')).toBe('Today');
    expect(formatDayLabel('2026-09-28', '2026-09-29')).toBe('Yesterday');
    expect(formatDayLabel('2026-09-27', '2026-09-29')).toBe('Sun, Sep 27');
    expect(formatDayLabel('2026-02-28', '2026-03-01')).toBe('Yesterday');
  });

  it('shows the year for another year and the short date without a reference', () => {
    expect(formatDayLabel('2025-12-30', '2026-01-02')).toBe('Tue, Dec 30, 2025');
    expect(formatDayLabel('2026-09-29')).toBe('Tue, Sep 29');
  });
});
