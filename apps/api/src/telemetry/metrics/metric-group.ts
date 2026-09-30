import type { DashboardSqlFilters } from '../dashboard/telemetry-dashboard.sql';
import type { TelemetryQueryResult } from '../greptime/greptime.client';
import {
  familiesOf,
  familyByKey,
  HTTPCHECK_ERROR_TABLE,
  HTTPCHECK_STATUS_TABLE,
  ratiosOf,
  tablesOf,
  type CounterFamily,
  type GaugeFamily,
  type HistogramFamily,
  type MetricFamily,
  type MetricGroup,
  type MetricRatio,
  type MetricRef,
  type MetricTables,
  type MetricTableSpec,
  type MetricUnit,
  type TileAggregate,
} from './metric-catalog';
import {
  counterSeriesSql,
  gaugeSeriesSql,
  histogramIncreaseSql,
  latestByKeySql,
  METRIC_HISTOGRAM_MAX_ROWS,
  METRIC_MAX_GROUPS,
  METRIC_MIN_BUCKET_SECONDS,
  METRIC_TABLE_MAX_ROWS,
  uptimeErrorsSql,
  uptimeStatusSql,
  type LatestPart,
} from './metric-sql';
import {
  histogramQuantile,
  instantMs,
  numOrNull,
  roundForDisplay,
  rowObjects,
  strOrNull,
} from './metric-values';

// =============================================================================
// One metric group, computed (issue #126, epic #576)
// =============================================================================
//
// `computeMetricGroup` renders every family, ratio and table of a group into
// statements (`metric-sql.ts`), runs them all at once through the dashboard's
// statement runner, and shapes the rows into:
//
//   tiles   one per family/ratio (or per listed group value): the latest value
//           of the current window for a gauge, the rate/total over the window
//           for a counter, the quantile for a histogram — with the same
//           measure over the previous window and a per-bucket sparkline;
//   series  one per family and group value, over the current window;
//   tables  one row per key (mountpoint, node, URL, job type…).
//
// A family whose table or columns are absent is listed in `skipped`, as is a
// ratio over a skipped family and a table none of whose parts exist.
//
// DELTA GAUGES. The API's gauges are exported with delta temporality
// (docs §11.13): a job type with nothing pending simply stops being reported.
// A group's "latest" value therefore counts only when it is within one bucket
// of the family's latest bucket; an older one is a drained series, not the
// current reading. A table cell read as `last` follows the same rule with
// `METRIC_FRESH_MS`.
// =============================================================================

/** A `last` table cell older than its part's newest reading by more than this is not current. */
export const METRIC_FRESH_MS = 150_000;

export interface MetricGroupWindow {
  from: Date;
  to: Date;
  previousFrom: Date;
  /** The dashboard's bucket size; metric statements use at least `METRIC_MIN_BUCKET_SECONDS`. */
  bucketSeconds: number;
}

export interface MetricRunner {
  maybe(sql: string | null): Promise<TelemetryQueryResult | null>;
}

export interface MetricTile {
  key: string;
  label: string;
  value: number | string | null;
  previous: number | string | null;
  unit: string;
  sparkline: (number | null)[];
}

export interface MetricSeries {
  key: string;
  label: string;
  unit: MetricUnit;
  /** The label column the series is split by, or null for a single series. */
  dimension: string | null;
  /** This series' value of `dimension`, or null. */
  groupBy: string | null;
  points: { t: string; v: number | null }[];
}

export type MetricCell = string | number | boolean | null;

export interface MetricTableColumn {
  key: string;
  label: string;
  unit: MetricUnit;
}

export interface MetricTable {
  key: string;
  label: string;
  columns: MetricTableColumn[];
  rows: Record<string, MetricCell>[];
}

export interface MetricGroupResult {
  bucketSeconds: number;
  available: boolean;
  truncated: boolean;
  tiles: MetricTile[];
  series: MetricSeries[];
  tables: MetricTable[];
  skipped: string[];
}

export function metricBucketSeconds(bucketSeconds: number): number {
  return Math.max(bucketSeconds, METRIC_MIN_BUCKET_SECONDS);
}

/** Bucket starts covering `[from, to)`, aligned to the epoch like `date_bin`. */
function bucketStarts(from: number, to: number, bucketMs: number): number[] {
  const starts: number[] = [];
  for (let t = Math.floor(from / bucketMs) * bucketMs; t < to; t += bucketMs) starts.push(t);
  return starts;
}

// ---- parsed family data -------------------------------------------------------------

type Buckets = Map<number, number>;

interface FamilyData {
  family: MetricFamily;
  /** group value → bucket start (ms) → raw value (a counter's increase in that bucket). */
  groups: Map<string, Buckets>;
  /** Histograms: period → group → `le` → cumulative count increase. */
  histogram?: Map<string, Map<string, Map<string, number>>>;
}

/** Rows ordered by (g, t) into groups, keeping the first `maxGroups`. */
function parseGroups(
  result: TelemetryQueryResult | null,
  maxGroups: number
): { groups: Map<string, Buckets>; truncated: boolean } {
  const groups = new Map<string, Buckets>();
  let truncated = false;
  for (const row of rowObjects(result)) {
    const g = strOrNull(row.g) ?? '';
    const t = instantMs(row.t);
    const v = numOrNull(row.v);
    if (t === null) continue;
    let buckets = groups.get(g);
    if (!buckets) {
      if (groups.size >= maxGroups) {
        truncated = true;
        continue;
      }
      buckets = new Map();
      groups.set(g, buckets);
    }
    if (v !== null) buckets.set(t, v);
  }
  return { groups, truncated };
}

function parseHistogram(result: TelemetryQueryResult | null): {
  data: Map<string, Map<string, Map<string, number>>>;
  truncated: boolean;
} {
  const data = new Map<string, Map<string, Map<string, number>>>();
  const rows = rowObjects(result);
  for (const row of rows) {
    const period = String(row.period);
    const g = strOrNull(row.g) ?? '';
    const le = strOrNull(row.le);
    const v = numOrNull(row.v);
    if (!le || v === null) continue;
    if (!data.has(period)) data.set(period, new Map());
    const byGroup = data.get(period)!;
    if (!byGroup.has(g)) byGroup.set(g, new Map());
    byGroup.get(g)!.set(le, v);
  }
  return { data, truncated: rows.length > METRIC_HISTOGRAM_MAX_ROWS };
}

// ---- value shaping -----------------------------------------------------------------

interface Frame {
  bucketMs: number;
  /** Start of the first current bucket (buckets before it are the previous window). */
  currentStart: number;
  current: number[];
  previous: number[];
  spanSeconds: number;
  /** The reference "now" for ages: min(to, now). */
  nowMs: number;
}

/** A gauge's display value from its raw value at `refMs`. */
function gaugeDisplay(family: GaugeFamily, raw: number, refMs: number): number {
  if (family.transform === 'ageHours') return (refMs / 1000 - raw) / 3600;
  return raw * (family.scale ?? 1);
}

/** A counter's display value from an increase over `seconds`. */
function counterDisplay(family: CounterFamily, increase: number, seconds: number): number {
  const scale = family.scale ?? 1;
  if (family.rate === 'per_s') return (increase / seconds) * scale;
  if (family.rate === 'per_min') return (increase / (seconds / 60)) * scale;
  return increase * scale;
}

function combine(values: number[], how: TileAggregate): number | null {
  if (values.length === 0) return null;
  switch (how) {
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    case 'countPositive':
      return values.filter((v) => v > 0).length;
    case 'countZero':
      return values.filter((v) => v <= 0).length;
    default:
      return values.reduce((a, b) => a + b, 0);
  }
}

function rounded(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : roundForDisplay(value);
}

/**
 * Each group's latest raw value among `starts`, counting a group only when
 * its latest bucket is within one bucket of the newest bucket any group has
 * (delta gauges stop reporting a drained series; see the header).
 */
function latestPerGroup(
  groups: Map<string, Buckets>,
  starts: number[],
  bucketMs: number
): Map<string, number> {
  const latest = new Map<string, { t: number; v: number }>();
  for (const [g, buckets] of groups) {
    for (let i = starts.length - 1; i >= 0; i--) {
      const v = buckets.get(starts[i]);
      if (v !== undefined) {
        latest.set(g, { t: starts[i], v });
        break;
      }
    }
  }
  const newest = Math.max(-Infinity, ...[...latest.values()].map((x) => x.t));
  const out = new Map<string, number>();
  for (const [g, { t, v }] of latest) if (t >= newest - bucketMs) out.set(g, v);
  return out;
}

function sumOver(buckets: Buckets, starts: number[]): number | null {
  let seen = false;
  let total = 0;
  for (const t of starts) {
    const v = buckets.get(t);
    if (v !== undefined) {
      seen = true;
      total += v;
    }
  }
  return seen ? total : null;
}

// ---- tiles and series --------------------------------------------------------------------

function gaugeTiles(data: FamilyData, frame: Frame): MetricTile[] {
  const family = data.family as GaugeFamily;
  const how = family.tileAggregate ?? 'sum';
  const at = (starts: number[]) => latestPerGroup(data.groups, starts, frame.bucketMs);
  const refNow = frame.nowMs;
  const refPrevious = frame.currentStart;
  const display = (raw: number, ref: number) => gaugeDisplay(family, raw, ref);

  const sparkFor = (groups: string[] | null) =>
    frame.current.map((t) => {
      const values: number[] = [];
      for (const [g, buckets] of data.groups) {
        if (groups && !groups.includes(g)) continue;
        const v = buckets.get(t);
        if (v !== undefined) values.push(display(v, Math.min(t + frame.bucketMs, refNow)));
      }
      return rounded(combine(values, groups ? 'sum' : how));
    });

  const current = at(frame.current);
  const previous = at(frame.previous);

  if (family.tileGroups) {
    return family.tileGroups.map((g) => {
      const value = (latest: Map<string, number>, ref: number) =>
        latest.has(g) ? display(latest.get(g)!, ref) : latest.size > 0 ? 0 : null;
      return {
        key: `${family.key}.${g}`,
        label: `${family.label}: ${g}`,
        value: rounded(value(current, refNow)),
        previous: rounded(value(previous, refPrevious)),
        unit: family.unit,
        sparkline: sparkFor([g]),
      };
    });
  }

  const tileOf = (latest: Map<string, number>, ref: number) =>
    rounded(
      combine(
        [...latest.values()].map((v) => display(v, ref)),
        how
      )
    );
  return [
    {
      key: family.key,
      label: family.label,
      value: tileOf(current, refNow),
      previous: tileOf(previous, refPrevious),
      unit: family.unit,
      sparkline: sparkFor(null),
    },
  ];
}

function counterTiles(data: FamilyData, frame: Frame): MetricTile[] {
  const family = data.family as CounterFamily;
  const total = (starts: number[], groups: string[] | null) => {
    let seen = false;
    let sum = 0;
    for (const [g, buckets] of data.groups) {
      if (groups && !groups.includes(g)) continue;
      const s = sumOver(buckets, starts);
      if (s !== null) {
        seen = true;
        sum += s;
      }
    }
    return seen ? sum : null;
  };
  const spark = (groups: string[] | null) =>
    frame.current.map((t) => {
      const v = total([t], groups);
      return v === null ? null : rounded(counterDisplay(family, v, frame.bucketMs / 1000));
    });
  const tile = (key: string, label: string, groups: string[] | null): MetricTile => {
    const now = total(frame.current, groups);
    const before = total(frame.previous, groups);
    return {
      key,
      label,
      value: now === null ? null : rounded(counterDisplay(family, now, frame.spanSeconds)),
      previous: before === null ? null : rounded(counterDisplay(family, before, frame.spanSeconds)),
      unit: family.unit,
      sparkline: spark(groups),
    };
  };
  if (family.tileGroups)
    return family.tileGroups.map((g) => tile(`${family.key}.${g}`, `${family.label}: ${g}`, [g]));
  return [tile(family.key, family.label, null)];
}

/** Bucket counts per `le`, summed over groups (or one group). */
function histogramBuckets(data: FamilyData, period: string, group?: string): Map<string, number> {
  const sum = new Map<string, number>();
  const byGroup = data.histogram?.get(period);
  if (!byGroup) return sum;
  for (const [g, les] of byGroup) {
    if (group !== undefined && g !== group) continue;
    for (const [le, v] of les) sum.set(le, (sum.get(le) ?? 0) + v);
  }
  return sum;
}

function histogramValue(family: HistogramFamily, buckets: Map<string, number>): number | null {
  const q = histogramQuantile(family.quantile, buckets);
  return q === null ? null : rounded(q * (family.scale ?? 1));
}

function histogramTiles(data: FamilyData): MetricTile[] {
  const family = data.family as HistogramFamily;
  return [
    {
      key: family.key,
      label: family.label,
      value: histogramValue(family, histogramBuckets(data, 'current')),
      previous: histogramValue(family, histogramBuckets(data, 'previous')),
      unit: family.unit,
      sparkline: [],
    },
  ];
}

function familySeries(data: FamilyData, frame: Frame): MetricSeries[] {
  const family = data.family;
  if (family.kind === 'histogram') return [];
  return [...data.groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([g, buckets]) => ({
      key: family.key,
      label: family.groupBy ? `${family.label}: ${g}` : family.label,
      unit: family.unit,
      dimension: family.groupBy ?? null,
      groupBy: family.groupBy ? g : null,
      points: frame.current.map((t) => {
        const raw = buckets.get(t);
        let v: number | null = null;
        if (raw !== undefined) {
          v =
            family.kind === 'gauge'
              ? gaugeDisplay(family, raw, Math.min(t + frame.bucketMs, frame.nowMs))
              : counterDisplay(family, raw, frame.bucketMs / 1000);
        }
        return { t: new Date(t).toISOString(), v: rounded(v) };
      }),
    }));
}

// ---- ratios ------------------------------------------------------------------------

function refBucket(data: FamilyData, ref: MetricRef, t: number): number | null {
  let seen = false;
  let sum = 0;
  for (const [g, buckets] of data.groups) {
    if (ref.groups && !ref.groups.includes(g)) continue;
    const v = buckets.get(t);
    if (v !== undefined) {
      seen = true;
      sum += v;
    }
  }
  return seen ? sum : null;
}

function refsAt(
  refs: readonly MetricRef[],
  datas: Map<string, FamilyData>,
  t: number
): number | null {
  let seen = false;
  let sum = 0;
  for (const ref of refs) {
    const v = refBucket(datas.get(ref.family)!, ref, t);
    if (v !== null) {
      seen = true;
      sum += v;
    }
  }
  return seen ? sum : null;
}

function ratioParts(
  ratio: MetricRatio,
  datas: Map<string, FamilyData>,
  starts: number[]
): { num: number | null; den: number | null }[] {
  return starts.map((t) => {
    const num = refsAt(ratio.numerator, datas, t);
    const denOnly = refsAt(ratio.denominator, datas, t);
    const den = ratio.addNumerator
      ? num === null && denOnly === null
        ? null
        : (num ?? 0) + (denOnly ?? 0)
      : denOnly;
    return { num, den };
  });
}

function divide(num: number | null, den: number | null, scale: number): number | null {
  if (num === null || den === null || den <= 0) return null;
  return (num / den) * scale;
}

function ratioOutputs(
  ratio: MetricRatio,
  datas: Map<string, FamilyData>,
  frame: Frame
): { tile: MetricTile; series: MetricSeries } {
  const counters = [...ratio.numerator, ...ratio.denominator].every(
    (r) => datas.get(r.family)!.family.kind === 'counter'
  );
  const current = ratioParts(ratio, datas, frame.current);
  const previous = ratioParts(ratio, datas, frame.previous);

  const summarize = (parts: { num: number | null; den: number | null }[]) => {
    if (counters) {
      const num = parts.reduce<number | null>(
        (a, p) => (p.num === null ? a : (a ?? 0) + p.num),
        null
      );
      const den = parts.reduce<number | null>(
        (a, p) => (p.den === null ? a : (a ?? 0) + p.den),
        null
      );
      return divide(num, den, ratio.scale);
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const v = divide(parts[i].num, parts[i].den, ratio.scale);
      if (v !== null) return v;
    }
    return null;
  };

  const points = current.map((p) => rounded(divide(p.num, p.den, ratio.scale)));
  return {
    tile: {
      key: ratio.key,
      label: ratio.label,
      value: rounded(summarize(current)),
      previous: rounded(summarize(previous)),
      unit: ratio.unit,
      sparkline: points,
    },
    series: {
      key: ratio.key,
      label: ratio.label,
      unit: ratio.unit,
      dimension: null,
      groupBy: null,
      points: frame.current.map((t, i) => ({ t: new Date(t).toISOString(), v: points[i] })),
    },
  };
}

// ---- tables ------------------------------------------------------------------------

/** A table spec's parts as latest-per-key statement parts (also read by the telemetry assistant, #128). */
export function tableParts(spec: MetricTableSpec, tables: MetricTables): LatestPart[] {
  return spec.parts.map((p) => ({
    name: p.column,
    table: p.table,
    info: tables.get(p.table) ?? null,
    keyColumn: spec.keyColumn,
    requiredColumns: p.requiredColumns,
    valueSql: p.valueSql,
    where: p.where,
    seriesAggregate: p.seriesAggregate,
    over: p.over,
    filters: spec.filters,
  }));
}

export interface TableInputs {
  latest: TelemetryQueryResult | null;
  status?: TelemetryQueryResult | null;
  errors?: TelemetryQueryResult | null;
  histogram?: FamilyData | null;
}

/** One per-key table from its statements' rows (also used by the telemetry assistant, #128). */
export function buildTable(
  spec: MetricTableSpec,
  inputs: TableInputs
): { table: MetricTable; truncated: boolean } {
  const columns: MetricTableColumn[] = [{ key: 'key', label: spec.keyLabel, unit: 'text' }];
  for (const p of spec.parts) columns.push({ key: p.column, label: p.label, unit: p.unit });
  for (const d of spec.derived ?? []) columns.push({ key: d.column, label: d.label, unit: d.unit });
  if (spec.histogram) {
    const family = familyByKey(spec.histogram.family);
    columns.push({
      key: spec.histogram.column,
      label: spec.histogram.label,
      unit: family?.unit ?? 'seconds',
    });
  }
  if (spec.httpcheck) {
    columns.push(
      { key: 'up', label: 'Up', unit: 'boolean' },
      { key: 'statusCode', label: 'Status', unit: 'text' },
      { key: 'checks', label: 'Checks', unit: 'count' },
      { key: 'failedChecks', label: 'Failed checks', unit: 'count' },
      { key: 'lastError', label: 'Last error', unit: 'text' }
    );
  }
  columns.push({ key: 'lastSeenAt', label: 'Last reading', unit: 'timestamp' });

  const rows = new Map<string, Record<string, MetricCell>>();
  const seen = new Map<string, number>();
  const order: string[] = [];
  const rowFor = (k: string) => {
    let row = rows.get(k);
    if (!row) {
      row = { key: k };
      for (const c of columns) if (c.key !== 'key') row[c.key] = null;
      rows.set(k, row);
      order.push(k);
    }
    return row;
  };
  const touch = (k: string, at: number | null) => {
    if (at !== null) seen.set(k, Math.max(seen.get(k) ?? -Infinity, at));
  };

  // Latest-per-key parts.
  const latestRows = rowObjects(inputs.latest);
  const newestByPart = new Map<string, number>();
  for (const r of latestRows) {
    const at = instantMs(r.at);
    if (at !== null)
      newestByPart.set(String(r.m), Math.max(newestByPart.get(String(r.m)) ?? -Infinity, at));
  }
  for (const r of latestRows) {
    const part = spec.parts.find((p) => p.column === r.m);
    const k = strOrNull(r.k);
    if (!part || k === null) continue;
    const at = instantMs(r.at);
    const raw = numOrNull(r.v);
    const stale =
      part.over === 'last' &&
      at !== null &&
      at < (newestByPart.get(part.column) ?? at) - METRIC_FRESH_MS;
    const row = rowFor(k);
    touch(k, at);
    if (raw === null || stale) continue;
    row[part.column] = part.unit === 'boolean' ? raw >= 1 : rounded(raw * (part.scale ?? 1));
  }

  // Uptime status and errors.
  if (spec.httpcheck) {
    const statusRows = rowObjects(inputs.status ?? null);
    const newestCheck = Math.max(
      -Infinity,
      ...statusRows.map((r) => instantMs(r.last_at) ?? -Infinity)
    );
    for (const r of statusRows) {
      const k = strOrNull(r.k);
      if (k === null) continue;
      const row = rowFor(k);
      const lastAt = instantMs(r.last_at);
      touch(k, lastAt);
      const checks = numOrNull(r.checks) ?? 0;
      row.checks = checks;
      row.failedChecks = checks - (numOrNull(r.ok_checks) ?? 0);
      row.statusCode = strOrNull(r.code);
      // A URL whose latest check is older than the newest check of any URL
      // is no longer probed: not "up".
      row.up =
        numOrNull(r.ok_now) === 1 && lastAt !== null && lastAt >= newestCheck - METRIC_FRESH_MS;
    }
    for (const r of rowObjects(inputs.errors ?? null)) {
      const k = strOrNull(r.k);
      if (k === null) continue;
      const row = rowFor(k);
      touch(k, instantMs(r.at));
      row.lastError = strOrNull(r.message);
    }
  }

  // Derived columns.
  for (const row of rows.values()) {
    for (const d of spec.derived ?? []) {
      const num = typeof row[d.numerator] === 'number' ? (row[d.numerator] as number) : null;
      const den = typeof row[d.denominator] === 'number' ? (row[d.denominator] as number) : null;
      row[d.column] = rounded(divide(num, den, d.scale));
    }
  }

  // Histogram quantile per key.
  if (spec.histogram && inputs.histogram) {
    const family = inputs.histogram.family as HistogramFamily;
    const byGroup = inputs.histogram.histogram?.get('current');
    for (const [g] of byGroup ?? []) {
      if (!rows.has(g)) continue;
      rows.get(g)![spec.histogram.column] = histogramValue(
        family,
        histogramBuckets(inputs.histogram, 'current', g)
      );
    }
  }

  for (const [k, at] of seen) rows.get(k)!.lastSeenAt = new Date(at).toISOString();

  const keys = spec.orderByValue ? order : [...order].sort((a, b) => a.localeCompare(b));
  return {
    table: {
      key: spec.key,
      label: spec.label,
      columns,
      rows: keys.slice(0, METRIC_TABLE_MAX_ROWS).map((k) => rows.get(k)!),
    },
    truncated: keys.length > METRIC_TABLE_MAX_ROWS,
  };
}

// ---- the group ------------------------------------------------------------------------

/**
 * Every statement of the group, run at once through `runner`, shaped into the
 * group response (minus the envelope). `now` is the request's clock.
 */
export async function computeMetricGroup(input: {
  group: MetricGroup;
  window: MetricGroupWindow;
  filters: DashboardSqlFilters;
  tables: MetricTables;
  runner: MetricRunner;
  now: Date;
}): Promise<MetricGroupResult> {
  const { group, window, filters, tables, runner } = input;
  const bucketSeconds = metricBucketSeconds(window.bucketSeconds);
  const bucketMs = bucketSeconds * 1000;
  const seriesWindow = { from: window.previousFrom, to: window.to, bucketSeconds };

  const skipped: string[] = [];
  let truncated = false;

  // ---- statements ----
  const families = familiesOf(group);
  const familySql = families.map((f) => {
    const info = tables.get(f.table) ?? null;
    if (f.kind === 'gauge') return gaugeSeriesSql(f, info, seriesWindow, filters);
    if (f.kind === 'counter') return counterSeriesSql(f, info, seriesWindow, filters);
    return histogramIncreaseSql(
      f,
      info,
      { from: window.previousFrom, to: window.to },
      window.from,
      filters
    );
  });

  const specs = tablesOf(group);
  const tableSql = specs.map((spec) => ({
    latest: latestByKeySql(tableParts(spec, tables), window.from, window.to, filters, {
      orderByValue: spec.orderByValue,
    }),
    status: spec.httpcheck
      ? uptimeStatusSql(
          tables.get(HTTPCHECK_STATUS_TABLE) ?? null,
          window.from,
          window.to,
          filters,
          spec.filters
        )
      : null,
    errors: spec.httpcheck
      ? uptimeErrorsSql(
          tables.get(HTTPCHECK_ERROR_TABLE) ?? null,
          window.from,
          window.to,
          filters,
          spec.filters
        )
      : null,
  }));

  const [familyResults, tableResults] = await Promise.all([
    Promise.all(familySql.map((sql) => runner.maybe(sql))),
    Promise.all(
      tableSql.map(async (t) => {
        const [latest, status, errors] = await Promise.all([
          runner.maybe(t.latest),
          runner.maybe(t.status),
          runner.maybe(t.errors),
        ]);
        return { latest, status, errors };
      })
    ),
  ]);

  // ---- families ----
  const datas = new Map<string, FamilyData>();
  families.forEach((family, i) => {
    if (familySql[i] === null) {
      skipped.push(family.key);
      return;
    }
    if (family.kind === 'histogram') {
      const parsed = parseHistogram(familyResults[i]);
      truncated ||= parsed.truncated;
      datas.set(family.key, { family, groups: new Map(), histogram: parsed.data });
      return;
    }
    const parsed = parseGroups(familyResults[i], METRIC_MAX_GROUPS);
    truncated ||= parsed.truncated;
    datas.set(family.key, { family, groups: parsed.groups });
  });

  const nowMs = Math.min(window.to.getTime(), input.now.getTime());
  const currentStart = Math.floor(window.from.getTime() / bucketMs) * bucketMs;
  const all = bucketStarts(window.previousFrom.getTime(), window.to.getTime(), bucketMs);
  const frame: Frame = {
    bucketMs,
    currentStart,
    current: all.filter((t) => t >= currentStart),
    previous: all.filter((t) => t < currentStart),
    spanSeconds: (window.to.getTime() - window.from.getTime()) / 1000,
    nowMs,
  };

  const tiles: MetricTile[] = [];
  const series: MetricSeries[] = [];
  for (const family of families) {
    const data = datas.get(family.key);
    if (!data) continue;
    if (family.tile !== false) {
      if (family.kind === 'gauge') tiles.push(...gaugeTiles(data, frame));
      else if (family.kind === 'counter') tiles.push(...counterTiles(data, frame));
      else tiles.push(...histogramTiles(data));
    }
    if (family.series !== false) series.push(...familySeries(data, frame));
  }

  for (const ratio of ratiosOf(group)) {
    const refs = [...ratio.numerator, ...ratio.denominator];
    if (!refs.every((r) => datas.has(r.family))) {
      skipped.push(ratio.key);
      continue;
    }
    const out = ratioOutputs(ratio, datas, frame);
    tiles.push(out.tile);
    series.push(out.series);
  }

  // ---- tables ----
  const outTables: MetricTable[] = [];
  specs.forEach((spec, i) => {
    if (tableSql[i].latest === null && tableSql[i].status === null) {
      skipped.push(spec.key);
      return;
    }
    const built = buildTable(spec, {
      ...tableResults[i],
      histogram: spec.histogram ? (datas.get(spec.histogram.family) ?? null) : null,
    });
    truncated ||= built.truncated;
    outTables.push(built.table);
  });

  const ran =
    familySql.some((s) => s !== null) ||
    tableSql.some((t) => t.latest !== null || t.status !== null);

  return { bucketSeconds, available: ran, truncated, tiles, series, tables: outTables, skipped };
}
