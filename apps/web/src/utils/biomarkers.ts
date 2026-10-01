/**
 * Presentation helpers for the biomarker views, H5 (#189). Pure functions,
 * unit-tested on their own: grouping, number and change formatting, and the
 * geometry of the per-event reference band the detail chart draws.
 *
 * No decisions live here: the flag, the range and the delta come from the API
 * (docs/specs/health-records.md §2.12); this only lays them out.
 */
import { LAB_PANELS, formatLabNumber, type LabFlag, type LabPanel } from '../services/labReport';
import type { BiomarkerSummaryItem, LabRangeContext } from '../services/biomarkers';
import { roundTo } from './measurementUnits';

/** The flags the out-of-range filter keeps (mirrors the API's `outOfRange=true`). */
export const OUT_OF_RANGE_FLAGS: readonly LabFlag[] = ['low', 'high', 'critical'];

export function isOutOfRange(flag: LabFlag | null | undefined): boolean {
  return !!flag && OUT_OF_RANGE_FLAGS.includes(flag);
}

/** A canonical value with the analyte's display decimals; any number without them. */
export function formatLabValue(value: number, decimals?: number): string {
  if (decimals === undefined) return formatLabNumber(value);
  return roundTo(value, decimals).toFixed(decimals);
}

export type DeltaDirection = 'up' | 'down' | 'flat';

/** Which way the latest result moved; `null` without a previous one. */
export function deltaDirection(delta: number | null, decimals?: number): DeltaDirection | null {
  if (delta === null) return null;
  const rounded = decimals === undefined ? delta : roundTo(delta, decimals);
  if (rounded > 0) return 'up';
  if (rounded < 0) return 'down';
  return 'flat';
}

/** `+12.0`, `−3.5` (a true minus sign) or `No change`; `null` without a previous result. */
export function formatDelta(delta: number | null, decimals?: number): string | null {
  const direction = deltaDirection(delta, decimals);
  if (direction === null) return null;
  if (direction === 'flat') return 'No change';
  const magnitude = formatLabValue(Math.abs(delta!), decimals);
  return `${direction === 'up' ? '+' : '−'}${magnitude}`;
}

/** Summary items grouped by panel, in `LAB_PANELS` order; empty panels are left out. */
export function groupSummaryByPanel(
  items: readonly BiomarkerSummaryItem[],
): { panel: LabPanel; items: BiomarkerSummaryItem[] }[] {
  const panelOf = (item: BiomarkerSummaryItem): LabPanel =>
    (LAB_PANELS as readonly string[]).includes(item.panel) ? item.panel : 'other';
  return LAB_PANELS.map((panel) => ({ panel, items: items.filter((item) => panelOf(item) === panel) })).filter(
    (group) => group.items.length > 0,
  );
}

// -----------------------------------------------------------------------------
// The detail chart's reference band
// -----------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** A point the chart and the band read: the instant, the value and the lab's range. */
export interface BandInputPoint extends Pick<LabRangeContext, 'referenceLow' | 'referenceHigh'> {
  id: string;
  measuredAt: string;
  value: number;
}

/**
 * One step of the reference band: the range the lab printed for ONE result,
 * drawn from halfway to the previous result to halfway to the next one (the
 * chart's edges for the first and the last). A one-sided range (`≤ high`,
 * `≥ low`) has `low` or `high` null: the chart extends it to the plot's edge.
 * A result without limits has no step, so the band shows a gap there rather
 * than borrowing a neighbour's range.
 */
export interface ReferenceBandStep {
  id: string;
  /** Epoch milliseconds. */
  x0: number;
  x1: number;
  low: number | null;
  high: number | null;
}

/** The time axis: every result with a margin, at least three days each side. */
export function biomarkerXDomain(points: readonly Pick<BandInputPoint, 'measuredAt'>[]): { min: number; max: number } | null {
  const times = points.map((p) => Date.parse(p.measuredAt)).filter(Number.isFinite);
  if (times.length === 0) return null;
  const first = Math.min(...times);
  const last = Math.max(...times);
  const pad = Math.max((last - first) * 0.05, 3 * DAY_MS);
  return { min: first - pad, max: last + pad };
}

/** The value axis: every value AND every printed limit, so the band is in view. */
export function biomarkerYDomain(points: readonly BandInputPoint[]): { min: number; max: number } | null {
  const values = points.flatMap((p) => [p.value, p.referenceLow, p.referenceHigh]);
  const finite = values.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  if (finite.length === 0) return null;
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  const pad = high === low ? Math.max(Math.abs(high) * 0.1, 1) : (high - low) * 0.1;
  // Lab values are never negative: do not invent a negative axis for the padding.
  return { min: low >= 0 ? Math.max(0, low - pad) : low - pad, max: high + pad };
}

/**
 * The band, one step per result that has a limit. `points` must be in time
 * order (the series is oldest first); `domain` is the time axis.
 */
export function referenceBands(
  points: readonly BandInputPoint[],
  domain: { min: number; max: number },
): ReferenceBandStep[] {
  const times = points.map((p) => Date.parse(p.measuredAt));
  const steps: ReferenceBandStep[] = [];
  points.forEach((point, i) => {
    if (point.referenceLow === null && point.referenceHigh === null) return;
    const x0 = i === 0 ? domain.min : (times[i - 1] + times[i]) / 2;
    const x1 = i === points.length - 1 ? domain.max : (times[i] + times[i + 1]) / 2;
    steps.push({ id: point.id, x0, x1, low: point.referenceLow, high: point.referenceHigh });
  });
  return steps;
}
