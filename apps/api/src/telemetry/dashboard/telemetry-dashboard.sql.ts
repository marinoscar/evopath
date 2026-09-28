// =============================================================================
// SQL the telemetry dashboard runs (issue #577, epic #576)
// =============================================================================
//
// PURE TEMPLATE FUNCTIONS. Every statement the dashboard sends is authored
// here, by the server, from:
//
//   - fixed identifiers (the constants below), quoted with doubled `"`;
//   - `Date` objects the request validation produced, rendered as ISO
//     literals (`'2026-09-27T22:00:00.000Z'`);
//   - `service` / `instance` values the SERVICE has already matched against
//     the distinct values seen in the range (cached list), then single-quoted
//     with doubled `'`;
//   - the event search text `q`, reduced by `likeContainsPattern` (control
//     characters stripped, capped at 200, `\` `%` `_` escaped, `'` doubled)
//     and used ONLY as `body ILIKE '%…%' ESCAPE '\'`;
//   - a pagination cursor whose timestamp and span id matched strict patterns.
//
// NO BIND PARAMETERS: GreptimeDB's Postgres wire refuses `$1` (spike #529).
// Every statement carries a literal top-level LIMIT (never a subquery wrapper
// for a row cap: GreptimeDB drops an inner ORDER BY through one, #554).
//
// -----------------------------------------------------------------------------
// STEP 0 FINDINGS (verified live on GreptimeDB v1.2.1, 2026-09-27)
// -----------------------------------------------------------------------------
// These override the issue text where they differ.
//
// Traces (`opentelemetry_traces`)
//   - Server spans: `span_kind = 'SPAN_KIND_SERVER'` (span_name is only the
//     method, e.g. `GET`).
//   - Status: `"span_attributes.http.response.status_code"` (bigint, no cast).
//     `"span_attributes.http.status_code"` does NOT exist. span_status_code is
//     STATUS_CODE_UNSET for 4xx, so classes come from the numeric column.
//   - Method: `"span_attributes.http.request.method"`.
//   - ROUTE: `"span_attributes.http.route"` is EMPTY on server spans (the
//     Fastify http instrumentation does not set it; only NestJS INTERNAL
//     spans carry it, and those are missing for requests rejected before the
//     handler). => routes are grouped by a NORMALIZED `"span_attributes.url.path"`
//     of the server span (always present; the collector already redacts the
//     query string): numeric, UUID and 24+ hex segments become `:id`
//     (`ROUTE_NORMALIZE_PATTERN`). The API field stays `route`, documented as
//     the normalized path.
//   - Service: `service_name`; instance: `"resource_attributes.app.instance.id"`.
//   - duration_nano: bigint unsigned (ns).
//
// Logs (`opentelemetry_logs`)
//   - Severity by `severity_number` (OTel standard / pino mapping), not by
//     `severity_text` (lower-case pino labels): error >= 17 (error 17,
//     fatal 21), warn 13..16, info 9..12, other < 9 (or NULL).
//   - Service and instance are NOT flattened columns: keys of the JSON column
//     `resource_attributes`, read with
//     `json_get_string(resource_attributes, '["service.name"]')` /
//     `'["app.instance.id"]'` (a bare 'service.name' path is NULL: `.` is a
//     path separator).
//   - Search: `body ILIKE '%<q>%' ESCAPE '\'` (predictable substring
//     semantics; `matches()` has query-language semantics — OR, quotes, `-`).
//     GreptimeDB string literals are standard SQL: `\` is not an escape
//     character in a literal, only `''` is.
//   - trace_id / span_id may be '' for a log outside a request.
//   - Timestamps arrive over the wire with microsecond text; the events query
//     selects `CAST("timestamp" AS STRING)` so a cursor keeps full precision.
//
// Runtime metrics (Prometheus-style tables, present when the runtime-node
// instrumentation is on)
//   - Columns: `greptime_timestamp` (time index), `greptime_value`,
//     `service_name`, … — NO instance column, so the instance filter does not
//     apply to runtime tiles.
//   - Heap used: `v8js_memory_heap_used_bytes` has one row per heap space per
//     export => SUM per `greptime_timestamp` first, then average per bucket.
//   - Event-loop delay: `nodejs_eventloop_delay_p99_seconds` (seconds; max per
//     bucket, converted to ms).
//   - Exported every 60 s, so runtime sparklines have 1-minute resolution.
//
// SQL verified on v1.2.1: `date_bin(INTERVAL 'n seconds', ts)`,
// `approx_percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_nano)` (ns),
// ISO timestamp literals, `regexp_replace(…, 'g')`, `ILIKE … ESCAPE '\'`,
// `UNION` + top-level `ORDER BY … LIMIT`, scalar subqueries, GROUP BY alias.
// =============================================================================

export const TRACES_TABLE = 'opentelemetry_traces';
export const LOGS_TABLE = 'opentelemetry_logs';
export const HEAP_USED_TABLE = 'v8js_memory_heap_used_bytes';
export const EVENT_LOOP_P99_TABLE = 'nodejs_eventloop_delay_p99_seconds';

/** Trace columns the dashboard reads. Attribute columns exist only once an attribute was written. */
export const TRACE_COLUMNS = {
  timestamp: 'timestamp',
  kind: 'span_kind',
  service: 'service_name',
  instance: 'resource_attributes.app.instance.id',
  status: 'span_attributes.http.response.status_code',
  method: 'span_attributes.http.request.method',
  path: 'span_attributes.url.path',
  duration: 'duration_nano',
} as const;

/** The trace columns without which no API panel can be computed. */
export const REQUIRED_TRACE_COLUMNS: readonly string[] = [
  TRACE_COLUMNS.timestamp,
  TRACE_COLUMNS.kind,
  TRACE_COLUMNS.service,
  TRACE_COLUMNS.status,
  TRACE_COLUMNS.method,
  TRACE_COLUMNS.path,
  TRACE_COLUMNS.duration,
];

export const REQUIRED_LOG_COLUMNS: readonly string[] = [
  'timestamp',
  'severity_number',
  'body',
  'resource_attributes',
  'trace_id',
  'span_id',
];

export const SERVER_SPAN_KIND = 'SPAN_KIND_SERVER';

/** Numeric, UUID and long-hex path segments → `:id`. Applied with the `g` flag. */
export const ROUTE_NORMALIZE_PATTERN = '/([0-9]+|[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}|[0-9a-fA-F]{24,})(/|$)';
export const ROUTE_NORMALIZE_REPLACEMENT = '/:id$2';

/** Severity bands by `severity_number`. */
export const SEVERITY_BANDS = {
  error: 'severity_number >= 17',
  warn: '(severity_number >= 13 AND severity_number < 17)',
  info: '(severity_number >= 9 AND severity_number < 13)',
  other: '(severity_number IS NULL OR severity_number < 9)',
} as const;

export const EVENT_SEVERITIES = ['error', 'warn', 'info'] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

/** Allowed bucket sizes, ascending. A span/buckets quotient is rounded UP to one of these. */
export const BUCKET_SIZES_SECONDS = [10, 30, 60, 300, 600, 900, 1800, 3600, 10800, 21600] as const;

/** Top-N lists. */
export const TOP_N = 10;
/** Events page size. */
export const EVENTS_PAGE_SIZE = 50;
/** Distinct services / instances returned by `/filters`. */
export const DISTINCT_VALUES_MAX = 200;
/** Longest search text, after control characters are stripped. */
export const SEARCH_MAX_LENGTH = 200;
/** Characters of a log body a grouped error message keeps. */
export const ERROR_MESSAGE_CHARS = 200;

// ---- literals ----------------------------------------------------------------

/** Double-quotes an identifier (doubling `"`). Only ever called with the constants above. */
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
  return BUCKET_SIZES_SECONDS.find((size) => size >= wanted) ?? BUCKET_SIZES_SECONDS[BUCKET_SIZES_SECONDS.length - 1];
}

/**
 * The search text as the inside of an `ILIKE '%…%' ESCAPE '\'` literal:
 * control characters stripped, capped at `SEARCH_MAX_LENGTH`, LIKE
 * metacharacters (`\`, `%`, `_`) escaped with `\`, then `'` doubled.
 * Returns '' when nothing searchable remains.
 */
export function likeContainsPattern(q: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = q.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').slice(0, SEARCH_MAX_LENGTH);
  return cleaned.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/'/g, "''");
}

// ---- shared shapes -----------------------------------------------------------

export interface DashboardSqlWindow {
  from: Date;
  to: Date;
  bucketSeconds: number;
}

export interface DashboardSqlFilters {
  /** Already validated against the distinct services of the range. */
  service?: string | null;
  /** Already validated against the distinct instances of the range. */
  instance?: string | null;
  /**
   * Whether the traces table has the instance column. When it does not, an
   * instance filter matches no trace (the column only appears once an
   * instance id was written).
   */
  tracesHaveInstance?: boolean;
}

/** Rows a bucketed series over `[from, to)` can produce, plus alignment slack. */
export function bucketRowLimit(from: Date, to: Date, bucketSeconds: number): number {
  return Math.ceil((to.getTime() - from.getTime()) / 1000 / bucketSeconds) + 2;
}

function between(column: string, from: Date, to: Date): string {
  return `${ident(column)} >= ${timestampLiteral(from)} AND ${ident(column)} < ${timestampLiteral(to)}`;
}

function traceFilters(filters: DashboardSqlFilters): string {
  const parts: string[] = [];
  if (filters.service) parts.push(`${ident(TRACE_COLUMNS.service)} = ${literal(filters.service)}`);
  if (filters.instance) {
    parts.push(
      filters.tracesHaveInstance === false
        ? '1 = 0'
        : `${ident(TRACE_COLUMNS.instance)} = ${literal(filters.instance)}`,
    );
  }
  return parts.map((p) => ` AND ${p}`).join('');
}

const LOG_SERVICE = `json_get_string(resource_attributes, '["service.name"]')`;
const LOG_INSTANCE = `json_get_string(resource_attributes, '["app.instance.id"]')`;

function logFilters(filters: DashboardSqlFilters): string {
  const parts: string[] = [];
  if (filters.service) parts.push(`${LOG_SERVICE} = ${literal(filters.service)}`);
  if (filters.instance) parts.push(`${LOG_INSTANCE} = ${literal(filters.instance)}`);
  return parts.map((p) => ` AND ${p}`).join('');
}

function serverSpans(from: Date, to: Date, filters: DashboardSqlFilters): string {
  return (
    `FROM ${ident(TRACES_TABLE)} WHERE ${ident(TRACE_COLUMNS.kind)} = ${literal(SERVER_SPAN_KIND)} ` +
    `AND ${between(TRACE_COLUMNS.timestamp, from, to)}${traceFilters(filters)}`
  );
}

const STATUS = ident(TRACE_COLUMNS.status);

// ---- streaming (SSE) exclusion for latency -------------------------------------
//
// A Server-Sent Events route holds its request open for the life of the
// subscription, so its server span lasts seconds to hours (live: GET
// /api/notifications/stream at p95 5.38 s). Mixed into an overall p95 it
// measures connection lifetime, not responsiveness: with enough subscribers
// it pushes the window p95 over the verdict threshold (false Degraded /
// Critical) and gets named the "slowest route". Every SSE route of this API
// ends in `/stream` (GET /api/notifications/stream, POST /api/ai/responses/stream,
// POST /api/admin/telemetry/assistant/stream), so a path suffix identifies them.
//
// The exclusion applies ONLY to latency: the p95 tile (current and previous
// window, and its sparkline), the API time-series p95 line and the verdict's
// "slowest route" offender. Streams still count in requests, status classes,
// error rates and the top-routes table (whose per-route p95 is honest: it is
// the stream's own row).
//
// Implemented as a CASE inside the percentile's ORDER BY, in the same
// statement: the aggregate ignores NULLs (verified on GreptimeDB v1.2.1: the
// result equals a WHERE-filtered p95, and a stream-only group yields NULL).
// Written as `LIKE … THEN NULL ELSE duration` so a span without a path is kept.

/** Path suffix shared by every SSE route of the API. */
export const STREAM_PATH_SUFFIX = '/stream';

/** SQL predicate: the server span is a streaming (SSE) request. */
export const STREAM_SPAN_PREDICATE = `${ident(TRACE_COLUMNS.path)} LIKE ${literal(`%${STREAM_PATH_SUFFIX}`)}`;

/** Whether a (normalized) route is a streaming (SSE) route; the TS twin of `STREAM_SPAN_PREDICATE`. */
export function isStreamingRoute(route: string | null | undefined): boolean {
  return typeof route === 'string' && route.endsWith(STREAM_PATH_SUFFIX);
}

/** p95 (ns) of every server span in the group, streams included (per-route table). */
const P95_NS = `approx_percentile_cont(0.95) WITHIN GROUP (ORDER BY ${ident(TRACE_COLUMNS.duration)})`;

/** p95 (ns) of the group with streaming (SSE) spans left out; NULL when only streams. */
export const LATENCY_P95_NS =
  `approx_percentile_cont(0.95) WITHIN GROUP (ORDER BY CASE WHEN ${STREAM_SPAN_PREDICATE} ` +
  `THEN NULL ELSE ${ident(TRACE_COLUMNS.duration)} END)`;

function statusClass(low: number): string {
  return `sum(CASE WHEN ${STATUS} >= ${low} AND ${STATUS} < ${low + 100} THEN 1 ELSE 0 END)`;
}

// ---- API panel ---------------------------------------------------------------

/**
 * Server spans per bucket: status classes and p95 (ns, streams excluded).
 * Columns: t, total, s2xx, s3xx, s4xx, s5xx, p95_ns.
 */
export function apiTimeseriesSql(window: DashboardSqlWindow, filters: DashboardSqlFilters = {}): string {
  return (
    `SELECT date_bin(${bucketInterval(window.bucketSeconds)}, ${ident('timestamp')}) AS t, count(*) AS total, ` +
    `${statusClass(200)} AS s2xx, ${statusClass(300)} AS s3xx, ${statusClass(400)} AS s4xx, ` +
    `sum(CASE WHEN ${STATUS} >= 500 THEN 1 ELSE 0 END) AS s5xx, ${LATENCY_P95_NS} AS p95_ns ` +
    `${serverSpans(window.from, window.to, filters)} ` +
    `GROUP BY t ORDER BY t LIMIT ${bucketRowLimit(window.from, window.to, window.bucketSeconds)}`
  );
}

/**
 * Totals of the current window `[from, to)` and the previous one
 * `[previousFrom, from)` in one statement. Columns: period
 * ('current'|'previous'), requests, errors (5xx), p95_ns (streams excluded).
 */
export function apiTotalsSql(previousFrom: Date, window: DashboardSqlWindow, filters: DashboardSqlFilters = {}): string {
  return (
    `SELECT CASE WHEN ${ident('timestamp')} >= ${timestampLiteral(window.from)} THEN 'current' ELSE 'previous' END AS period, ` +
    `count(*) AS requests, sum(CASE WHEN ${STATUS} >= 500 THEN 1 ELSE 0 END) AS errors, ${LATENCY_P95_NS} AS p95_ns ` +
    `${serverSpans(previousFrom, window.to, filters)} ` +
    'GROUP BY period ORDER BY period LIMIT 2'
  );
}

/**
 * Top routes (normalized path) by 5xx count, then p95. Columns: method,
 * route, requests, errors, p95_ns. `limit` is TOP_N + 1 so truncation shows.
 * Streams stay in, with their own p95: the table is per route, so it is honest.
 */
export function topRoutesSql(window: DashboardSqlWindow, filters: DashboardSqlFilters = {}, limit = TOP_N + 1): string {
  return (
    `SELECT ${ident(TRACE_COLUMNS.method)} AS method, ` +
    `regexp_replace(${ident(TRACE_COLUMNS.path)}, ${literal(ROUTE_NORMALIZE_PATTERN)}, ${literal(ROUTE_NORMALIZE_REPLACEMENT)}, 'g') AS route, ` +
    `count(*) AS requests, sum(CASE WHEN ${STATUS} >= 500 THEN 1 ELSE 0 END) AS errors, ${P95_NS} AS p95_ns ` +
    `${serverSpans(window.from, window.to, filters)} ` +
    `GROUP BY method, route ORDER BY errors DESC, p95_ns DESC LIMIT ${positive(limit)}`
  );
}

// ---- logs panel --------------------------------------------------------------

function logsIn(from: Date, to: Date, filters: DashboardSqlFilters): string {
  return `FROM ${ident(LOGS_TABLE)} WHERE ${between('timestamp', from, to)}${logFilters(filters)}`;
}

function band(name: keyof typeof SEVERITY_BANDS): string {
  return `sum(CASE WHEN ${SEVERITY_BANDS[name]} THEN 1 ELSE 0 END)`;
}

/** Logs per bucket by severity band. Columns: t, error, warn, info, other. */
export function logsTimeseriesSql(window: DashboardSqlWindow, filters: DashboardSqlFilters = {}): string {
  return (
    `SELECT date_bin(${bucketInterval(window.bucketSeconds)}, ${ident('timestamp')}) AS t, ` +
    `${band('error')} AS error, ${band('warn')} AS warn, ${band('info')} AS info, ${band('other')} AS other ` +
    `${logsIn(window.from, window.to, filters)} ` +
    `GROUP BY t ORDER BY t LIMIT ${bucketRowLimit(window.from, window.to, window.bucketSeconds)}`
  );
}

/** Error and warn counts of the current and previous windows. Columns: period, error, warn. */
export function logsTotalsSql(previousFrom: Date, window: DashboardSqlWindow, filters: DashboardSqlFilters = {}): string {
  return (
    `SELECT CASE WHEN ${ident('timestamp')} >= ${timestampLiteral(window.from)} THEN 'current' ELSE 'previous' END AS period, ` +
    `${band('error')} AS error, ${band('warn')} AS warn ` +
    `${logsIn(previousFrom, window.to, filters)} ` +
    'GROUP BY period ORDER BY period LIMIT 2'
  );
}

/**
 * Most frequent error messages (first `ERROR_MESSAGE_CHARS` characters).
 * Columns: message, occurrences, first_seen, last_seen, sample_trace_id, service.
 */
export function topErrorsSql(window: DashboardSqlWindow, filters: DashboardSqlFilters = {}, limit = TOP_N + 1): string {
  return (
    `SELECT substr(body, 1, ${ERROR_MESSAGE_CHARS}) AS message, count(*) AS occurrences, ` +
    `min(${ident('timestamp')}) AS first_seen, max(${ident('timestamp')}) AS last_seen, ` +
    `max(trace_id) AS sample_trace_id, max(${LOG_SERVICE}) AS service ` +
    `${logsIn(window.from, window.to, filters)} AND ${SEVERITY_BANDS.error} ` +
    `GROUP BY message ORDER BY occurrences DESC, last_seen DESC LIMIT ${positive(limit)}`
  );
}

/** A decoded, validated events cursor: the last row of the previous page. */
export interface EventsCursor {
  /** `CAST("timestamp" AS STRING)` of that row, validated by `EVENT_CURSOR_TS_PATTERN`. */
  ts: string;
  /** Its span id: hex, possibly empty. */
  spanId: string;
}

export const EVENT_CURSOR_TS_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z?$/;
export const EVENT_CURSOR_SPAN_PATTERN = /^[0-9a-fA-F]{0,32}$/;

export interface EventsSqlOptions {
  severities: readonly EventSeverity[];
  /** Raw search text; reduced by `likeContainsPattern`. */
  q?: string | null;
  cursor?: EventsCursor | null;
  /** Rows to fetch: page size + 1. */
  limit?: number;
}

/**
 * Log events, newest first, keyset-paginated on (timestamp, span_id).
 * Columns: ts (full-precision text), severity_number, severity_text,
 * service, body, trace_id, span_id.
 */
export function eventsSql(window: DashboardSqlWindow, filters: DashboardSqlFilters, opts: EventsSqlOptions): string {
  const severities = EVENT_SEVERITIES.filter((s) => opts.severities.includes(s));
  if (severities.length === 0) throw new RangeError('eventsSql needs at least one severity');

  const where: string[] = [`(${severities.map((s) => SEVERITY_BANDS[s]).join(' OR ')})`];

  const pattern = opts.q ? likeContainsPattern(opts.q) : '';
  if (pattern) where.push(`body ILIKE '%${pattern}%' ESCAPE '\\'`);

  if (opts.cursor) {
    const { ts, spanId } = opts.cursor;
    if (!EVENT_CURSOR_TS_PATTERN.test(ts) || !EVENT_CURSOR_SPAN_PATTERN.test(spanId)) {
      throw new RangeError('eventsSql got an unvalidated cursor');
    }
    const at = literal(ts.endsWith('Z') ? ts : `${ts.replace(' ', 'T')}Z`);
    where.push(`(${ident('timestamp')} < ${at} OR (${ident('timestamp')} = ${at} AND span_id < ${literal(spanId)}))`);
  }

  return (
    `SELECT CAST(${ident('timestamp')} AS STRING) AS ts, severity_number, severity_text, ${LOG_SERVICE} AS service, ` +
    'body, trace_id, span_id ' +
    `${logsIn(window.from, window.to, filters)} AND ${where.join(' AND ')} ` +
    `ORDER BY ${ident('timestamp')} DESC, span_id DESC LIMIT ${positive(opts.limit ?? EVENTS_PAGE_SIZE + 1)}`
  );
}

// ---- freshness ---------------------------------------------------------------

/**
 * Latest trace and log timestamps since `since` (filters applied). Columns:
 * traces_last, logs_last — a table that does not exist is left out
 * (`NULL AS …`).
 */
export function lastDataSql(
  since: Date,
  until: Date,
  filters: DashboardSqlFilters,
  tables: { traces: boolean; logs: boolean },
): string {
  const traces = tables.traces
    ? `(SELECT max(${ident('timestamp')}) FROM ${ident(TRACES_TABLE)} WHERE ${between('timestamp', since, until)}${traceFilters(filters)})`
    : 'NULL';
  const logs = tables.logs ? `(SELECT max(${ident('timestamp')}) ${logsIn(since, until, filters)})` : 'NULL';
  return `SELECT ${traces} AS traces_last, ${logs} AS logs_last LIMIT 1`;
}

// ---- filter values -----------------------------------------------------------

function distinctUnion(parts: string[], limit: number): string {
  return `${parts.join(' UNION ')} ORDER BY v LIMIT ${positive(limit)}`;
}

/** Distinct service names in `[from, to)` across traces and logs. Column: v. */
export function distinctServicesSql(
  from: Date,
  to: Date,
  tables: { traces: boolean; logs: boolean },
  limit = DISTINCT_VALUES_MAX + 1,
): string | null {
  const parts: string[] = [];
  if (tables.traces) {
    const col = ident(TRACE_COLUMNS.service);
    parts.push(`SELECT ${col} AS v FROM ${ident(TRACES_TABLE)} WHERE ${between('timestamp', from, to)} AND ${col} IS NOT NULL AND ${col} <> ''`);
  }
  if (tables.logs) {
    parts.push(`SELECT ${LOG_SERVICE} AS v ${logsIn(from, to, {})} AND ${LOG_SERVICE} IS NOT NULL AND ${LOG_SERVICE} <> ''`);
  }
  return parts.length ? distinctUnion(parts, limit) : null;
}

/** Distinct instance ids in `[from, to)` across traces (when the column exists) and logs. Column: v. */
export function distinctInstancesSql(
  from: Date,
  to: Date,
  tables: { traces: boolean; logs: boolean },
  limit = DISTINCT_VALUES_MAX + 1,
): string | null {
  const parts: string[] = [];
  if (tables.traces) {
    const col = ident(TRACE_COLUMNS.instance);
    parts.push(`SELECT ${col} AS v FROM ${ident(TRACES_TABLE)} WHERE ${between('timestamp', from, to)} AND ${col} IS NOT NULL AND ${col} <> ''`);
  }
  if (tables.logs) {
    parts.push(`SELECT ${LOG_INSTANCE} AS v ${logsIn(from, to, {})} AND ${LOG_INSTANCE} IS NOT NULL AND ${LOG_INSTANCE} <> ''`);
  }
  return parts.length ? distinctUnion(parts, limit) : null;
}

// ---- runtime -----------------------------------------------------------------

function metricWhere(from: Date, to: Date, service?: string | null): string {
  return `${between('greptime_timestamp', from, to)}${service ? ` AND service_name = ${literal(service)}` : ''}`;
}

/**
 * Heap used (bytes) per bucket over `[from, to)`: summed over heap spaces per
 * export, then averaged per bucket. Columns: t, v. The instance filter does
 * not apply (the metric tables have no instance column).
 */
export function heapUsedSql(from: Date, to: Date, bucketSeconds: number, service?: string | null): string {
  return (
    `SELECT date_bin(${bucketInterval(bucketSeconds)}, ts) AS t, avg(total) AS v FROM (` +
    `SELECT greptime_timestamp AS ts, sum(greptime_value) AS total FROM ${ident(HEAP_USED_TABLE)} ` +
    `WHERE ${metricWhere(from, to, service)} GROUP BY greptime_timestamp` +
    `) GROUP BY t ORDER BY t LIMIT ${bucketRowLimit(from, to, bucketSeconds)}`
  );
}

/** Event-loop delay p99 (ms), max per bucket over `[from, to)`. Columns: t, v. */
export function eventLoopDelayP99Sql(from: Date, to: Date, bucketSeconds: number, service?: string | null): string {
  return (
    `SELECT date_bin(${bucketInterval(bucketSeconds)}, greptime_timestamp) AS t, max(greptime_value) * 1000 AS v ` +
    `FROM ${ident(EVENT_LOOP_P99_TABLE)} WHERE ${metricWhere(from, to, service)} ` +
    `GROUP BY t ORDER BY t LIMIT ${bucketRowLimit(from, to, bucketSeconds)}`
  );
}

function positive(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
  return limit;
}
