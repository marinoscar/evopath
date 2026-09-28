/**
 * Pure helpers behind the AI usage UI (#444): the range, the day fill and
 * the formatting that keeps "nothing measured" distinct from "0%".
 */
import { describe, it, expect } from 'vitest';
import {
  fillDailySeries,
  formatFailureRate,
  formatUnits,
  formatUsageDay,
} from '../../../components/ai/usage';
import { aiUsageRangeForDays } from '../../../services/ai';
import { mockAiUsageReport } from '../../mocks/fixtures/ai';

describe('aiUsageRangeForDays', () => {
  it('is the last N UTC days, inclusive of today', () => {
    const now = new Date('2026-09-26T23:30:00.000Z');
    expect(aiUsageRangeForDays(30, now)).toEqual({ from: '2026-08-28', to: '2026-09-26' });
    expect(aiUsageRangeForDays(7, now)).toEqual({ from: '2026-09-20', to: '2026-09-26' });
    expect(aiUsageRangeForDays(90, now)).toEqual({ from: '2026-06-29', to: '2026-09-26' });
  });
});

describe('fillDailySeries', () => {
  it('fills every day of the range, in order, with zeros where the API had none', () => {
    const report = { ...mockAiUsageReport('day'), range: { from: '2026-09-22', to: '2026-09-26' } };
    const days = fillDailySeries(report);

    expect(days.map((day) => [day.key, day.requests])).toEqual([
      ['2026-09-22', 0],
      ['2026-09-23', 0],
      ['2026-09-24', 40],
      ['2026-09-25', 0],
      ['2026-09-26', 80],
    ]);
  });

  it('accepts full ISO timestamps as the range', () => {
    const report = {
      ...mockAiUsageReport('day'),
      range: { from: '2026-09-24T00:00:00.000Z', to: '2026-09-26T23:59:59.999Z' },
    };
    expect(fillDailySeries(report)).toHaveLength(3);
  });
});

describe('formatting', () => {
  it('shows a failure rate only when something was requested', () => {
    expect(formatFailureRate({ requests: 120, failed: 6 })).toBe('5.0%');
    expect(formatFailureRate({ requests: 0, failed: 0 })).toBe('—');
  });

  it('formats a day in UTC and lists non-zero units', () => {
    expect(formatUsageDay('2026-09-24')).toBe('Sep 24');
    expect(formatUnits({ images: 4, audioSeconds: 0 })).toBe('images: 4');
    expect(formatUnits({})).toBeNull();
  });
});
