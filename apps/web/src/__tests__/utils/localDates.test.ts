import { describe, it, expect } from 'vitest';
import { formatDayLabel, formatLongDate, localDateIn } from '../../utils/localDates';

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

  it('gives today in an IANA time zone, else the browser day (E4.6)', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    expect(localDateIn('Pacific/Kiritimati', now)).toBe('2026-09-30');
    expect(localDateIn('Pacific/Pago_Pago', now)).toBe('2026-09-29');
    expect(localDateIn('America/New_York', new Date('2026-09-30T02:00:00Z'))).toBe('2026-09-29');
    const local = new Date(2026, 0, 5, 12);
    expect(localDateIn(null, local)).toBe('2026-01-05');
    expect(localDateIn('Not/A_Zone', local)).toBe('2026-01-05');
  });
});
