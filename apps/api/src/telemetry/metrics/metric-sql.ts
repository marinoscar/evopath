import type { DashboardSqlFilters } from '../dashboard/telemetry-dashboard.sql';
import {
  between,
  bucketInterval,
  bucketRowLimit,
  ident,
  literal,
  positive,
  timestampLiteral,
} from '../dashboard/sql-literals';
import {
  HTTPCHECK_ERROR_TABLE,
  HTTPCHECK_STATUS_TABLE,
  METRIC_FILTER_COLUMNS,
  METRIC_TIME_COLUMN,
  METRIC_VALUE_COLUMN,
  type BucketAggregate,
  type CounterFamily,
  type GaugeFamily,
  type HistogramFamily,
  type MetricFilterKey,
  type MetricPredicate,
  type MetricTableInfo,
  type SeriesAggregate,
} from './metric-catalog';

// =============================================================================
// SQL for the metric catalog (issue #126, epic #576)
// =============================================================================
//
// PURE TEMPLATE FUNCTIONS, with the same discipline as
// `../dashboard/telemetry-dashboard.sql.ts` (docs/specs/telemetry.md §11.5):
//
//   - identifiers are catalog constants or column names the STORE reported
//     (`information_schema.columns`), quoted by `ident`;
//   - literal values are catalog constants (`state = 'idle'`) or
//     `service`/`instance`/`host` values the service already matched against
//     the distinct values seen in the range, quoted by `literal`;
//   - instants are validated `Date`s (`timestampLiteral`), bucket sizes come
//     from the closed list (`bucketInterval`);
//   - every statement ends in a literal top-level LIMIT; no bind parameters.
//
// Every builder takes the discovered `MetricTableInfo` of its table and
// returns NULL instead of a statement when the table or a column it needs is
// absent, so a store that has not received a source yet degrades to a
// skipped family, never to an error.
//
// Verified on GreptimeDB v1.2.1 against tables written by collector 0.145.0
// and the API's OTLP exporter (2026-09-30): `lag(v) OVER (PARTITION BY …
// ORDER BY greptime_timestamp)` in a subquery, `last_value(v ORDER BY ts)`,
// `date_bin` over a subquery, a constant `'' AS k` group, `UNION ALL` with a
// top-level `ORDER BY … LIMIT`, `count(DISTINCT …)`.
// =============================================================================

/** Metric tables are written every 30–60 s: a finer bucket would be half empty. */
export const METRIC_MIN_BUCKET_SECONDS = 60;
/** Series (group values) one family returns at most; the rest are cut, alphabetically. */
export const METRIC_MAX_GROUPS = 20;
/** Rows a per-key table returns at most. */
export const METRIC_TABLE_MAX_ROWS = 50;
/** Rows a histogram statement returns at most (periods × groups × `le`). */
export const METRIC_HISTOGRAM_MAX_ROWS = 4000;
/** Keys a verdict probe part reads at most. */
export const METRIC_PROBE_MAX_KEYS = 200;

const TS = ident(METRIC_TIME_COLUMN);
const VALUE = ident(METRIC_VALUE_COLUMN);

/** A window for metric statements: `[from, to)` bucketed by `bucketSeconds`. */
export interface MetricSqlWindow {
  from: Date;
  to: Date;
  bucketSeconds: number;
}

// ---- predicates ----------------------------------------------------------------

function predicate(p: MetricPredicate): string {
  return `${ident(p.column)} ${p.op} ${literal(p.value)}`;
}

/**
 * The request filters a family honours, as predicates. A filter set on a
 * table lacking its column matches nothing (`1 = 0`), the same rule as the
 * traces' instance filter.
 */
export function filterPredicates(
  info: MetricTableInfo,
  allowed: readonly MetricFilterKey[],
  filters: DashboardSqlFilters
): string[] {
  const parts: string[] = [];
  for (const key of allowed) {
    const value = filters[key];
    if (!value) continue;
    const column = METRIC_FILTER_COLUMNS[key];
    parts.push(info.columns.has(column) ? `${ident(column)} = ${literal(value)}` : '1 = 0');
  }
  return parts;
}

function whereOf(
  info: MetricTableInfo,
  from: Date,
  to: Date,
  where: readonly MetricPredicate[] | undefined,
  allowed: readonly MetricFilterKey[],
  filters: DashboardSqlFilters,
  extra: string[] = []
): string {
  return [
    between(METRIC_TIME_COLUMN, from, to),
    ...(where ?? []).map(predicate),
    ...filterPredicates(info, allowed, filters),
    ...extra,
  ].join(' AND ');
}

/** Every column the statement touches exists. */
function hasColumns(
  info: MetricTableInfo | null,
  columns: readonly (string | undefined)[]
): info is MetricTableInfo {
  return !!info && columns.every((c) => c === undefined || info.columns.has(c));
}

function keyExpr(column: string | null | undefined): string {
  return column ? ident(column) : "''";
}

function aggregate(fn: SeriesAggregate | BucketAggregate, expr: string): string {
  return `${fn}(${expr})`;
}

/** `lag` over one series: every tag column, ordered by time. */
function lagOver(info: MetricTableInfo): string {
  const partition = info.tags.length ? `PARTITION BY ${info.tags.map(ident).join(', ')} ` : '';
  return `lag(${VALUE}) OVER (${partition}ORDER BY ${TS})`;
}

/** Reset-aware increase of one point over its predecessor `p` (0 without one). */
export const COUNTER_DELTA = 'CASE WHEN p IS NULL THEN 0 WHEN v >= p THEN v - p ELSE v END';

function groupRowLimit(window: MetricSqlWindow, maxGroups: number): number {
  return bucketRowLimit(window.from, window.to, window.bucketSeconds) * positive(maxGroups) + 1;
}

// ---- families --------------------------------------------------------------------

/**
 * A gauge per bucket and group: combined across series per timestamp
 * (`seriesAggregate`), then per bucket (`bucketAggregate`). Columns: t, g
 * (group value, '' without `groupBy`), v. Ordered by group then time, so a row
 * cap cuts whole trailing groups (at most `maxGroups` + a partial one).
 */
export function gaugeSeriesSql(
  family: GaugeFamily,
  info: MetricTableInfo | null,
  window: MetricSqlWindow,
  filters: DashboardSqlFilters,
  maxGroups = METRIC_MAX_GROUPS
): string | null {
  if (
    !hasColumns(info, [
      ...family.requiredColumns,
      family.groupBy,
      ...(family.where ?? []).map((p) => p.column),
    ])
  ) {
    return null;
  }
  const value = family.valueSql ?? VALUE;
  return (
    `SELECT date_bin(${bucketInterval(window.bucketSeconds)}, ts) AS t, k AS g, ${aggregate(family.bucketAggregate, 'v')} AS v FROM (` +
    `SELECT ${TS} AS ts, ${keyExpr(family.groupBy)} AS k, ${aggregate(family.seriesAggregate, value)} AS v ` +
    `FROM ${ident(family.table)} WHERE ${whereOf(info, window.from, window.to, family.where, family.filters, filters)} ` +
    'GROUP BY ts, k' +
    `) GROUP BY t, g ORDER BY g, t LIMIT ${groupRowLimit(window, maxGroups)}`
  );
}

/**
 * A cumulative counter's increase per bucket and group: the reset-aware delta
 * of each point over its predecessor IN THE SAME SERIES (`lag` partitioned by
 * every tag column), summed. Columns: t, g, v (the increase in that bucket).
 */
export function counterSeriesSql(
  family: CounterFamily,
  info: MetricTableInfo | null,
  window: MetricSqlWindow,
  filters: DashboardSqlFilters,
  maxGroups = METRIC_MAX_GROUPS
): string | null {
  if (
    !hasColumns(info, [
      ...family.requiredColumns,
      family.groupBy,
      ...(family.where ?? []).map((p) => p.column),
    ])
  ) {
    return null;
  }
  return (
    `SELECT date_bin(${bucketInterval(window.bucketSeconds)}, ts) AS t, k AS g, sum(${COUNTER_DELTA}) AS v FROM (` +
    `SELECT ${TS} AS ts, ${keyExpr(family.groupBy)} AS k, ${VALUE} AS v, ${lagOver(info)} AS p ` +
    `FROM ${ident(family.table)} WHERE ${whereOf(info, window.from, window.to, family.where, family.filters, filters)}` +
    `) GROUP BY t, g ORDER BY g, t LIMIT ${groupRowLimit(window, maxGroups)}`
  );
}

/**
 * A histogram's bucket increases per period, group and `le`, over
 * `[window.from, window.to)` where `currentFrom` splits 'previous' from
 * 'current'. Columns: period, g, le, v. The quantile is interpolated by the
 * caller (`histogramQuantile`).
 */
export function histogramIncreaseSql(
  family: HistogramFamily,
  info: MetricTableInfo | null,
  window: { from: Date; to: Date },
  currentFrom: Date,
  filters: DashboardSqlFilters,
  limit = METRIC_HISTOGRAM_MAX_ROWS + 1
): string | null {
  if (
    !hasColumns(info, [
      'le',
      ...family.requiredColumns,
      family.groupBy,
      ...(family.where ?? []).map((p) => p.column),
    ])
  ) {
    return null;
  }
  return (
    `SELECT CASE WHEN ts >= ${timestampLiteral(currentFrom)} THEN 'current' ELSE 'previous' END AS period, ` +
    `k AS g, le, sum(${COUNTER_DELTA}) AS v FROM (` +
    `SELECT ${TS} AS ts, ${keyExpr(family.groupBy)} AS k, ${ident('le')} AS le, ${VALUE} AS v, ${lagOver(info)} AS p ` +
    `FROM ${ident(family.table)} WHERE ${whereOf(info, window.from, window.to, family.where, family.filters, filters)}` +
    `) GROUP BY period, g, le ORDER BY period, g, le LIMIT ${positive(limit)}`
  );
}

// ---- latest per key ------------------------------------------------------------------

/** One part of a latest-per-key statement: one value per key of one table. */
export interface LatestPart {
  /** The part's name, returned as column `m`. A catalog constant. */
  name: string;
  table: string;
  info: MetricTableInfo | null;
  /** The key column (one row per value), or null for one row for the whole table. */
  keyColumn: string | null;
  requiredColumns?: readonly string[];
  valueSql?: string;
  where?: readonly MetricPredicate[];
  seriesAggregate: SeriesAggregate;
  over: 'last' | 'max' | 'min' | 'increase' | 'count';
  filters: readonly MetricFilterKey[];
}

function latestPartSql(
  part: LatestPart & { info: MetricTableInfo },
  from: Date,
  to: Date,
  filters: DashboardSqlFilters
): string {
  const key = keyExpr(part.keyColumn);
  const notNull = part.keyColumn ? [`${ident(part.keyColumn)} IS NOT NULL`] : [];
  const where = whereOf(part.info, from, to, part.where, part.filters, filters, notNull);
  const table = ident(part.table);

  if (part.over === 'increase') {
    return (
      `SELECT ${literal(part.name)} AS m, k, sum(${COUNTER_DELTA}) AS v, max(ts) AS at FROM (` +
      `SELECT ${TS} AS ts, ${key} AS k, ${VALUE} AS v, ${lagOver(part.info)} AS p FROM ${table} WHERE ${where}` +
      ') GROUP BY k'
    );
  }

  const over =
    part.over === 'last'
      ? 'last_value(v ORDER BY ts)'
      : part.over === 'count'
        ? 'count(v)'
        : `${part.over}(v)`;
  return (
    `SELECT ${literal(part.name)} AS m, k, ${over} AS v, max(ts) AS at FROM (` +
    `SELECT ${TS} AS ts, ${key} AS k, ${aggregate(part.seriesAggregate, part.valueSql ?? VALUE)} AS v ` +
    `FROM ${table} WHERE ${where} GROUP BY ts, k` +
    ') GROUP BY k'
  );
}

/** The parts whose table and columns exist. */
export function presentParts(
  parts: readonly LatestPart[]
): Array<LatestPart & { info: MetricTableInfo }> {
  return parts.filter((p): p is LatestPart & { info: MetricTableInfo } =>
    hasColumns(p.info, [
      p.keyColumn ?? undefined,
      ...(p.requiredColumns ?? []),
      ...(p.where ?? []).map((w) => w.column),
    ])
  );
}

/**
 * One value per (part, key) over `[from, to)`, as `UNION ALL` of the parts
 * that exist. Columns: m (part name), k (key, '' when keyless), v, at (the
 * key's latest timestamp). Ordered KEY-MAJOR (`k, m`) so a row cap cuts
 * whole trailing keys, never a part: `maxKeys` keys × parts rows + 1 (the
 * extra row shows truncation). With `orderByValue` (one part only) the rows
 * are ordered by value, descending: the top `maxKeys`. Null when no part exists.
 */
export function latestByKeySql(
  parts: readonly LatestPart[],
  from: Date,
  to: Date,
  filters: DashboardSqlFilters,
  opts: { maxKeys?: number; orderByValue?: boolean; order?: 'key' | 'part' } = {}
): string | null {
  const present = presentParts(parts);
  if (present.length === 0) return null;
  const maxKeys = positive(opts.maxKeys ?? METRIC_TABLE_MAX_ROWS);
  const body = present.map((p) => latestPartSql(p, from, to, filters)).join(' UNION ALL ');

  if (opts.orderByValue) {
    if (present.length !== 1)
      throw new RangeError('latestByKeySql: orderByValue needs exactly one part');
    return `${body} ORDER BY v DESC, k LIMIT ${maxKeys + 1}`;
  }
  const order = opts.order === 'part' ? 'm, k' : 'k, m';
  return `${body} ORDER BY ${order} LIMIT ${maxKeys * present.length + 1}`;
}

// ---- uptime ------------------------------------------------------------------------

/**
 * Per URL over `[from, to)`: the latest check, the latest passing (2xx) check,
 * how many checks ran and passed, whether the latest passed, and its status
 * code. A check is one timestamp: five rows (one per class), value 1 on the
 * class that matched, all 0 when the request errored. Columns: k, last_at,
 * last_ok_at, checks, ok_checks, ok_now, code.
 */
export function uptimeStatusSql(
  info: MetricTableInfo | null,
  from: Date,
  to: Date,
  filters: DashboardSqlFilters,
  allowed: readonly MetricFilterKey[],
  maxKeys = METRIC_TABLE_MAX_ROWS
): string | null {
  if (!hasColumns(info, ['http_url', 'http_status_class'])) return null;
  const code = info.columns.has('http_status_code')
    ? `max(CASE WHEN ${VALUE} = 1 THEN ${ident('http_status_code')} END)`
    : 'NULL';
  const ok = `max(CASE WHEN ${ident('http_status_class')} = '2xx' AND ${VALUE} = 1 THEN 1 ELSE 0 END)`;
  return (
    'SELECT k, max(ts) AS last_at, max(CASE WHEN ok = 1 THEN ts END) AS last_ok_at, count(*) AS checks, ' +
    'sum(ok) AS ok_checks, last_value(ok ORDER BY ts) AS ok_now, last_value(code ORDER BY ts) AS code FROM (' +
    `SELECT ${TS} AS ts, ${ident('http_url')} AS k, ${ok} AS ok, ${code} AS code FROM ${ident(HTTPCHECK_STATUS_TABLE)} ` +
    `WHERE ${whereOf(info, from, to, undefined, allowed, filters)} GROUP BY ts, k` +
    `) GROUP BY k ORDER BY k LIMIT ${positive(maxKeys) + 1}`
  );
}

/** Characters of an `httpcheck_error` message kept. */
export const UPTIME_ERROR_CHARS = 200;

/** Per URL over `[from, to)`: failed checks and the latest error text. Columns: k, errors, message, at. */
export function uptimeErrorsSql(
  info: MetricTableInfo | null,
  from: Date,
  to: Date,
  filters: DashboardSqlFilters,
  allowed: readonly MetricFilterKey[],
  maxKeys = METRIC_TABLE_MAX_ROWS
): string | null {
  if (!hasColumns(info, ['http_url', 'error_message'])) return null;
  return (
    `SELECT ${ident('http_url')} AS k, count(*) AS errors, ` +
    `substr(last_value(${ident('error_message')} ORDER BY ${TS}), 1, ${UPTIME_ERROR_CHARS}) AS message, max(${TS}) AS at ` +
    `FROM ${ident(HTTPCHECK_ERROR_TABLE)} WHERE ${whereOf(info, from, to, undefined, allowed, filters)} ` +
    `GROUP BY k ORDER BY k LIMIT ${positive(maxKeys) + 1}`
  );
}

// ---- filter values ---------------------------------------------------------------

/** Distinct host names in `[from, to)` from one small host table. Column: v. */
export function distinctHostsSql(
  info: MetricTableInfo | null,
  table: string,
  from: Date,
  to: Date,
  limit: number
): string | null {
  if (!hasColumns(info, ['host_name'])) return null;
  const col = ident('host_name');
  return (
    `SELECT ${col} AS v FROM ${ident(table)} WHERE ${between(METRIC_TIME_COLUMN, from, to)} ` +
    `AND ${col} IS NOT NULL AND ${col} <> '' GROUP BY v ORDER BY v LIMIT ${positive(limit)}`
  );
}
