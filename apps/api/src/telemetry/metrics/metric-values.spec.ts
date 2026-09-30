import { histogramQuantile, instantMs, numOrNull, roundForDisplay } from './metric-values';

// =============================================================================
// Metric row helpers (issue #126)
// =============================================================================

describe('metric values', () => {
  describe('histogramQuantile', () => {
    const buckets = (entries: Array<[string, number]>) => new Map(entries);

    it('interpolates inside the bucket that crosses the rank', () => {
      // 100 observations: 50 ≤ 1 s, 90 ≤ 2 s, 100 ≤ 4 s. p95 = rank 95 → (2, 4], 5 of 10 in → 3 s.
      expect(
        histogramQuantile(
          0.95,
          buckets([
            ['1', 50],
            ['2', 90],
            ['4', 100],
            ['inf', 100],
          ])
        )
      ).toBeCloseTo(3);
      // p50 = rank 50 → the first bucket, all of it → 1 s.
      expect(
        histogramQuantile(
          0.5,
          buckets([
            ['1', 50],
            ['2', 90],
            ['4', 100],
            ['inf', 100],
          ])
        )
      ).toBeCloseTo(1);
    });

    it('answers the highest finite bound when the rank falls in +Inf', () => {
      expect(
        histogramQuantile(
          0.95,
          buckets([
            ['1', 10],
            ['inf', 100],
          ])
        )
      ).toBe(1);
      expect(
        histogramQuantile(
          0.95,
          buckets([
            ['1', 10],
            ['+Inf', 100],
          ])
        )
      ).toBe(1);
    });

    it('is null without observations', () => {
      expect(
        histogramQuantile(
          0.95,
          buckets([
            ['1', 0],
            ['inf', 0],
          ])
        )
      ).toBeNull();
      expect(histogramQuantile(0.95, new Map())).toBeNull();
    });

    it('sorts `le` numerically and forces monotonic counts', () => {
      expect(
        histogramQuantile(
          0.5,
          buckets([
            ['10', 100],
            ['2.5', 40],
            ['inf', 100],
            ['5', 30],
          ])
        )
      ).toBeCloseTo(5 + 5 * (10 / 60));
    });
  });

  describe('instantMs', () => {
    it('reads the store text as UTC', () => {
      expect(instantMs('2026-09-30 00:21:00.000000')).toBe(Date.parse('2026-09-30T00:21:00.000Z'));
      expect(instantMs('2026-09-30T00:21:00Z')).toBe(Date.parse('2026-09-30T00:21:00.000Z'));
      expect(instantMs(new Date('2026-09-30T00:21:00Z'))).toBe(
        Date.parse('2026-09-30T00:21:00.000Z')
      );
      expect(instantMs(null)).toBeNull();
      expect(instantMs('nope')).toBeNull();
    });
  });

  it('numOrNull parses text numbers', () => {
    expect(numOrNull('60')).toBe(60);
    expect(numOrNull('')).toBeNull();
    expect(numOrNull('x')).toBeNull();
    expect(numOrNull(null)).toBeNull();
  });

  it('roundForDisplay keeps sensible precision', () => {
    expect(roundForDisplay(1234.56)).toBe(1235);
    expect(roundForDisplay(12.3456)).toBe(12.35);
    expect(roundForDisplay(0.001234)).toBe(0.0012);
    expect(roundForDisplay(0)).toBe(0);
  });
});
