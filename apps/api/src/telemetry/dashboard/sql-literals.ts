// =============================================================================
// Literal helpers shared by every server-authored telemetry statement
// (issues #577, #126)
// =============================================================================
//
// The dashboard templates (`telemetry-dashboard.sql.ts`) and the metric
// catalog builders (`../metrics/metric-sql.ts`) render statements from:
//
//   - fixed identifiers, quoted with doubled `"` (`ident`);
//   - values the caller has already validated, single-quoted with doubled `'`
//     (`literal`);
//   - `Date`s the request validation produced, as ISO literals
//     (`timestampLiteral`);
//   - bucket sizes from a closed list (`bucketInterval`);
//   - literal row caps (`positive`).
//
// NO BIND PARAMETERS: GreptimeDB's Postgres wire refuses `$1` (spike #529).
// Pure functions; no Nest, no I/O.
// =============================================================================

/** Allowed bucket sizes, ascending. A span/buckets quotient is rounded UP to one of these. */
export const BUCKET_SIZES_SECONDS = [10, 30, 60, 300, 600, 900, 1800, 3600, 10800, 21600] as const;

/** Double-quotes an identifier (doubling `"`). Only ever called with server-side constants or discovered column names. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quotes a string literal (doubling `'`). Callers validate the value first. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** An ISO timestamp literal from a validated Date. */
export function timestampLiteral(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new RangeError('timestampLiteral needs a valid Date');
  }
  return `'${date.toISOString()}'`;
}

/** `INTERVAL 'n seconds'` for an allowed bucket size. */
export function bucketInterval(bucketSeconds: number): string {
  if (!(BUCKET_SIZES_SECONDS as readonly number[]).includes(bucketSeconds)) {
    throw new RangeError(`bucketSeconds must be one of ${BUCKET_SIZES_SECONDS.join(', ')}`);
  }
  return `INTERVAL '${bucketSeconds} seconds'`;
}

/** The bucket size for a span: span/buckets rounded UP to an allowed size (the largest when above all). */
export function bucketSecondsFor(spanMs: number, buckets: number): number {
  const wanted = spanMs / 1000 / buckets;
  return (
    BUCKET_SIZES_SECONDS.find((size) => size >= wanted) ??
    BUCKET_SIZES_SECONDS[BUCKET_SIZES_SECONDS.length - 1]
  );
}

/** Rows a bucketed series over `[from, to)` can produce, plus alignment slack. */
export function bucketRowLimit(from: Date, to: Date, bucketSeconds: number): number {
  return Math.ceil((to.getTime() - from.getTime()) / 1000 / bucketSeconds) + 2;
}

/** `"column" >= '<from>' AND "column" < '<to>'`. */
export function between(column: string, from: Date, to: Date): string {
  return `${ident(column)} >= ${timestampLiteral(from)} AND ${ident(column)} < ${timestampLiteral(to)}`;
}

/** A literal row cap: a positive safe integer, or a RangeError. */
export function positive(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  return limit;
}
