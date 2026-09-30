import type { TelemetryQueryResult } from '../greptime/greptime.client';

// =============================================================================
// Row helpers for the metric catalog (issue #126)
// =============================================================================
//
// The reader pool returns int8/numeric and timestamps as the server's TEXT
// (`greptime.client.ts`): a count is `'60'`, an instant is
// `'2026-09-30 00:21:00.000000'` (UTC, no zone). These turn both into plain
// numbers. Pure functions.
// =============================================================================

/** A finite number, or null. */
export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A store instant (text or Date) as epoch ms, or null. */
export function instantMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const text = String(value).replace(' ', 'T');
  const ms = Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Row objects keyed by field name. */
export function rowObjects(result: TelemetryQueryResult | null): Record<string, unknown>[] {
  if (!result) return [];
  return result.rows.map((row) =>
    Object.fromEntries(result.fields.map((f, i) => [f.name, row[i]]))
  );
}

/** A string, or null when empty. */
export function strOrNull(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** Rounded for display: whole numbers for large magnitudes, otherwise two decimals (four below 0.01). */
export function roundForDisplay(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(value);
  if (abs > 0 && abs < 0.01) return Math.round(value * 10_000) / 10_000;
  return Math.round(value * 100) / 100;
}

/**
 * Histogram quantile from cumulative bucket counts (`le` → count, `le` as the
 * store writes it: `"0.05"`, `"1"`, `"inf"`), Prometheus `histogram_quantile`
 * style: linear interpolation inside the bucket that crosses the rank; the
 * `+Inf` bucket answers its lower bound. Null without observations.
 */
export function histogramQuantile(q: number, buckets: ReadonlyMap<string, number>): number | null {
  const bounds = [...buckets.entries()]
    .map(([le, count]) => ({ le: parseLe(le), count }))
    .filter((b): b is { le: number; count: number } => b.le !== null)
    .sort((a, b) => a.le - b.le);
  if (bounds.length === 0) return null;

  // Cumulative counts must be monotonic; a reset or a partial scrape can break
  // that, so enforce it rather than interpolate backwards.
  for (let i = 1; i < bounds.length; i++)
    bounds[i].count = Math.max(bounds[i].count, bounds[i - 1].count);

  const total = bounds[bounds.length - 1].count;
  if (!(total > 0)) return null;
  const rank = q * total;

  for (let i = 0; i < bounds.length; i++) {
    const { le, count } = bounds[i];
    if (count < rank) continue;
    if (le === Number.POSITIVE_INFINITY) return i > 0 ? bounds[i - 1].le : null;
    const lower = i > 0 ? bounds[i - 1].le : 0;
    const below = i > 0 ? bounds[i - 1].count : 0;
    const inBucket = count - below;
    if (inBucket <= 0) return le;
    return lower + (le - lower) * ((rank - below) / inBucket);
  }
  return bounds[bounds.length - 1].le;
}

function parseLe(le: string): number | null {
  const text = le.trim().toLowerCase();
  if (text === 'inf' || text === '+inf') return Number.POSITIVE_INFINITY;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
