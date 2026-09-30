import { describe, it, expect } from 'vitest';
import { signalsRange } from '../../hooks/useSignals';

describe('signalsRange', () => {
  it('starts on the Monday weeks - 1 weeks before asOf and ends on asOf', () => {
    // 2026-09-30 is a Wednesday; its Monday is 2026-09-28.
    expect(signalsRange('2026-09-30', 1)).toEqual({ from: '2026-09-28', to: '2026-09-30' });
    expect(signalsRange('2026-09-30', 8)).toEqual({ from: '2026-08-10', to: '2026-09-30' });
  });

  it('treats Monday and Sunday as the ends of an ISO week', () => {
    expect(signalsRange('2026-09-28', 1)).toEqual({ from: '2026-09-28', to: '2026-09-28' });
    expect(signalsRange('2026-10-04', 1)).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });

  it('ends on the week Sunday with toEndOfWeek', () => {
    expect(signalsRange('2026-09-30', 1, { toEndOfWeek: true })).toEqual({
      from: '2026-09-28',
      to: '2026-10-04',
    });
  });

  it('never exceeds 26 weeks of days, across a year boundary', () => {
    for (const asOf of ['2026-01-04', '2026-01-05', '2026-12-31', '2027-03-01']) {
      const { from, to } = signalsRange(asOf, 26);
      const days =
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(26 * 7);
      expect(new Date(`${from}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });
});
