/**
 * The biomarker presentation helpers (H5, #189): panel grouping, the change
 * text and arrow, and the per-result reference band the detail chart draws.
 */
import { describe, expect, it } from 'vitest';
import {
  biomarkerXDomain,
  biomarkerYDomain,
  deltaDirection,
  formatDelta,
  formatLabValue,
  groupSummaryByPanel,
  isOutOfRange,
  referenceBands,
  type BandInputPoint,
} from '../../utils/biomarkers';
import { mockBiomarkerSummary } from '../mocks/fixtures/biomarkers';

const DAY_MS = 24 * 60 * 60 * 1000;

function point(id: string, measuredAt: string, value: number, low: number | null, high: number | null): BandInputPoint {
  return { id, measuredAt, value, referenceLow: low, referenceHigh: high };
}

describe('groupSummaryByPanel', () => {
  it('groups in panel order and leaves empty panels out', () => {
    const shuffled = [mockBiomarkerSummary[3], mockBiomarkerSummary[2], mockBiomarkerSummary[0], mockBiomarkerSummary[1]];
    const groups = groupSummaryByPanel(shuffled);
    expect(groups.map((g) => g.panel)).toEqual(['lipids', 'glycemic', 'thyroid']);
    expect(groups[0].items.map((i) => i.analyteKey)).toEqual(['ldl_cholesterol', 'hdl_cholesterol']);
  });

  it('puts an unknown panel under Other', () => {
    const odd = { ...mockBiomarkerSummary[3], panel: 'mystery' as never };
    expect(groupSummaryByPanel([odd]).map((g) => g.panel)).toEqual(['other']);
  });
});

describe('change formatting', () => {
  it('reads the direction from the delta, rounded to the display decimals', () => {
    expect(deltaDirection(12, 0)).toBe('up');
    expect(deltaDirection(-3.5, 1)).toBe('down');
    expect(deltaDirection(0.04, 1)).toBe('flat');
    expect(deltaDirection(null)).toBeNull();
  });

  it('signs the delta with a true minus and says No change when flat', () => {
    expect(formatDelta(12, 1)).toBe('+12.0');
    expect(formatDelta(-3.5, 1)).toBe('−3.5');
    expect(formatDelta(0, 1)).toBe('No change');
    expect(formatDelta(null, 1)).toBeNull();
  });

  it('formats a value with the catalog decimals, or up to four without them', () => {
    expect(formatLabValue(97.2973, 0)).toBe('97');
    expect(formatLabValue(5.6, 1)).toBe('5.6');
    expect(formatLabValue(97.29734)).toBe('97.2973');
  });

  it('treats low, high and critical as out of range', () => {
    expect(['low', 'high', 'critical'].every((f) => isOutOfRange(f as never))).toBe(true);
    expect(isOutOfRange('normal')).toBe(false);
    expect(isOutOfRange('unknown')).toBe(false);
    expect(isOutOfRange(null)).toBe(false);
  });
});

describe('referenceBands', () => {
  const t = (iso: string) => Date.parse(iso);
  const points = [
    point('a', '2026-01-01T12:00:00.000Z', 120, 0, 130),
    point('b', '2026-03-01T12:00:00.000Z', 125, 0, 130),
    point('c', '2026-05-01T12:00:00.000Z', 118, null, null),
    point('d', '2026-07-01T12:00:00.000Z', 142, null, 100),
  ];
  const domain = { min: t('2025-12-01T00:00:00.000Z'), max: t('2026-08-01T00:00:00.000Z') };

  it('draws one step per result with a range, each with its own limits', () => {
    const steps = referenceBands(points, domain);
    expect(steps.map((s) => s.id)).toEqual(['a', 'b', 'd']);
    expect(steps.map((s) => [s.low, s.high])).toEqual([
      [0, 130],
      [0, 130],
      [null, 100],
    ]);
  });

  it('runs each step from halfway to the previous result to halfway to the next', () => {
    const [a, b, d] = referenceBands(points, domain);
    expect(a.x0).toBe(domain.min);
    expect(a.x1).toBe((t(points[0].measuredAt) + t(points[1].measuredAt)) / 2);
    expect(b.x0).toBe(a.x1);
    expect(b.x1).toBe((t(points[1].measuredAt) + t(points[2].measuredAt)) / 2);
    // `c` has no range: a gap between `b` and `d`, never a borrowed range.
    expect(d.x0).toBe((t(points[2].measuredAt) + t(points[3].measuredAt)) / 2);
    expect(d.x0).toBeGreaterThan(b.x1);
    expect(d.x1).toBe(domain.max);
  });

  it('covers the whole axis for a single result', () => {
    const [only] = referenceBands([points[0]], domain);
    expect([only.x0, only.x1]).toEqual([domain.min, domain.max]);
  });

  it('draws nothing when no result has a range', () => {
    expect(referenceBands([points[2]], domain)).toEqual([]);
  });
});

describe('chart domains', () => {
  it('pads the time axis by at least three days each side', () => {
    const domain = biomarkerXDomain([{ measuredAt: '2026-09-15T12:00:00.000Z' }])!;
    const at = Date.parse('2026-09-15T12:00:00.000Z');
    expect(domain).toEqual({ min: at - 3 * DAY_MS, max: at + 3 * DAY_MS });
    expect(biomarkerXDomain([])).toBeNull();
  });

  it('keeps every value and every printed limit in view, never below zero for positive data', () => {
    const domain = biomarkerYDomain([
      point('a', '2026-01-01T12:00:00.000Z', 142, null, 100),
      point('b', '2026-02-01T12:00:00.000Z', 90, 40, 200),
    ])!;
    expect(domain.min).toBeLessThanOrEqual(40);
    expect(domain.min).toBeGreaterThanOrEqual(0);
    expect(domain.max).toBeGreaterThanOrEqual(200);
  });

  it('widens a flat series', () => {
    const domain = biomarkerYDomain([point('a', '2026-01-01T12:00:00.000Z', 5.6, null, null)])!;
    expect(domain.max).toBeGreaterThan(5.6);
    expect(domain.min).toBeLessThan(5.6);
  });
});
