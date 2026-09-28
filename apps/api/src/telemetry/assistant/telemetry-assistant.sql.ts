// =============================================================================
// SQL the telemetry assistant builds ITSELF (issue #571)
// =============================================================================
//
// `get_app_context`, `health_overview` and `get_trace` run statements built
// here, not written by the model. Pure functions of:
//
//   - the table's DISCOVERED column set (`TelemetrySchemaService`), so a
//     section whose table or columns are absent is skipped instead of failing
//     (attribute columns only exist once an attribute has been seen);
//   - an enum window (`HEALTH_WINDOWS`) mapped to a fixed interval literal;
//   - a trace id the tool's schema already matched against
//     `TRACE_ID_PATTERN` (hex only), lower-cased.
//
// NOTHING FREE-TEXT IS EVER INTERPOLATED. Every identifier is one of the
// constants below, quoted; column names read from the store are only ever
// tested for membership, never spliced in. Every statement still runs
// through `TelemetryQueryService.run` (guard, row cap, timeout, audit) — and
// must pass `analyzeStatement`, which the unit tests pin.
//
// `shareable` is the ALLOWLIST of output columns the model may see when
// `telemetry.assistant.shareResults` is off: numbers and timestamps this SQL
// computed (counts, durations, `is_error`), never a value the monitored
// system wrote (service names, routes, log bodies, trace ids).
// =============================================================================

export const TRACES_TABLE = 'opentelemetry_traces';
export const LOGS_TABLE = 'opentelemetry_logs';

export const HEALTH_WINDOWS = ['15m', '1h', '6h', '24h', '7d'] as const;
export type HealthWindow = (typeof HEALTH_WINDOWS)[number];

const WINDOW_INTERVALS: Record<HealthWindow, string> = {
  '15m': '15 minutes',
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
};

/** A W3C trace id is 32 hex characters; some exporters use 16. */
export const TRACE_ID_PATTERN = /^[0-9a-fA-F]{16,32}$/;

/** How many characters of a log body a grouped error message keeps. */
export const ERROR_MESSAGE_GROUP_CHARS = 200;

/** How many characters of a `db.statement` a trace step keeps. */
export const DB_STATEMENT_CHARS = 300;

/** Top-N sections. */
export const HEALTH_TOP_N = 10;

/** One statement the assistant runs on its own behalf. */
export interface AssistantSectionQuery {
  /** Key of the section in the tool output. */
  name: string;
  sql: string;
  /** Output columns the model may see when row sharing is off. */
  shareable: readonly string[];
  /** Row cap for this statement (before the model's own cap). */
  maxRows: number;
}

/** A section that could not be built because its table/columns are absent. */
export interface SkippedSection {
  name: string;
  skipped: string;
}

export type SectionPlan = AssistantSectionQuery | SkippedSection;

export function isSkipped(plan: SectionPlan): plan is SkippedSection {
  return 'skipped' in plan;
}

/** The column names of a table, or null when the table does not exist. */
export type ColumnSet = ReadonlySet<string> | null;

function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function windowInterval(window: HealthWindow): string {
  return WINDOW_INTERVALS[window];
}

function since(interval: string): string {
  return `timestamp > now() - INTERVAL '${interval}'`;
}

/** The service column of a table: `service_name`, else the flattened resource attribute, else null. */
export function serviceColumn(columns: ColumnSet): string | null {
  if (!columns) return null;
  if (columns.has('service_name')) return 'service_name';
  if (columns.has('resource_attributes.service.name')) return 'resource_attributes.service.name';
  return null;
}

function hasAll(columns: ColumnSet, names: string[]): columns is ReadonlySet<string> {
  return !!columns && names.every((name) => columns.has(name));
}

function missing(table: string, columns: ColumnSet, names: string[]): string {
  if (!columns) return `table ${table} does not exist`;
  const absent = names.filter((name) => !columns.has(name));
  return `table ${table} has no column ${absent.join(', ')}`;
}

// ---- data coverage (get_app_context, health_overview) ------------------------

/** Earliest/latest timestamp ever stored in a table. */
export function buildTableRange(name: string, table: string, columns: ColumnSet): SectionPlan {
  if (!hasAll(columns, ['timestamp'])) return { name, skipped: missing(table, columns, ['timestamp']) };

  return {
    name,
    sql: `SELECT min(timestamp) AS earliest, max(timestamp) AS latest FROM ${q(table)}`,
    shareable: ['earliest', 'latest'],
    maxRows: 1,
  };
}

/** Row count and first/last timestamp inside a window. */
export function buildWindowCoverage(name: string, table: string, columns: ColumnSet, interval: string): SectionPlan {
  if (!hasAll(columns, ['timestamp'])) return { name, skipped: missing(table, columns, ['timestamp']) };

  return {
    name,
    sql:
      `SELECT count(*) AS rows_in_window, min(timestamp) AS first_in_window, max(timestamp) AS last_in_window, ` +
      `now() AS query_time FROM ${q(table)} WHERE ${since(interval)}`,
    shareable: ['rows_in_window', 'first_in_window', 'last_in_window', 'query_time'],
    maxRows: 1,
  };
}

/** Distinct service names seen in a window. */
export function buildDistinctServices(name: string, table: string, columns: ColumnSet, interval: string): SectionPlan {
  const service = serviceColumn(columns);

  if (!hasAll(columns, ['timestamp']) || !service) {
    return { name, skipped: columns ? `table ${table} has no service or timestamp column` : `table ${table} does not exist` };
  }

  return {
    name,
    sql:
      `SELECT ${q(service)} AS service, count(*) AS rows_in_window FROM ${q(table)} ` +
      `WHERE ${since(interval)} GROUP BY ${q(service)} ORDER BY rows_in_window DESC LIMIT 50`,
    shareable: ['rows_in_window'],
    maxRows: 50,
  };
}

// ---- health_overview: traces --------------------------------------------------

const ERROR_SPAN = `span_status_code = 'STATUS_CODE_ERROR'`;

/** Per-service span count, error span count, average and max duration. */
export function buildServiceStats(columns: ColumnSet, interval: string): SectionPlan {
  const name = 'services';
  const required = ['timestamp', 'span_status_code', 'duration_nano'];
  if (!hasAll(columns, required)) return { name, skipped: missing(TRACES_TABLE, columns, required) };

  const service = serviceColumn(columns);
  const select =
    `count(*) AS spans, sum(CASE WHEN ${ERROR_SPAN} THEN 1 ELSE 0 END) AS error_spans, ` +
    `avg(duration_nano) / 1000000.0 AS avg_ms, max(duration_nano) / 1000000.0 AS max_ms`;
  const shareable = ['spans', 'error_spans', 'avg_ms', 'max_ms'];

  if (!service) {
    return {
      name,
      sql: `SELECT ${select} FROM ${q(TRACES_TABLE)} WHERE ${since(interval)}`,
      shareable,
      maxRows: 1,
    };
  }

  return {
    name,
    sql:
      `SELECT ${q(service)} AS service, ${select} FROM ${q(TRACES_TABLE)} WHERE ${since(interval)} ` +
      `GROUP BY ${q(service)} ORDER BY spans DESC LIMIT 20`,
    shareable,
    maxRows: 20,
  };
}

/** Per-service p95 span duration — its own statement, so a dialect gap loses only this section. */
export function buildServiceLatency(columns: ColumnSet, interval: string): SectionPlan {
  const name = 'latencyP95';
  const required = ['timestamp', 'duration_nano'];
  if (!hasAll(columns, required)) return { name, skipped: missing(TRACES_TABLE, columns, required) };

  const service = serviceColumn(columns);
  const p95 = `approx_percentile_cont(duration_nano, 0.95) / 1000000.0 AS p95_ms`;

  if (!service) {
    return { name, sql: `SELECT ${p95} FROM ${q(TRACES_TABLE)} WHERE ${since(interval)}`, shareable: ['p95_ms'], maxRows: 1 };
  }

  return {
    name,
    sql:
      `SELECT ${q(service)} AS service, ${p95} FROM ${q(TRACES_TABLE)} WHERE ${since(interval)} ` +
      `GROUP BY ${q(service)} ORDER BY p95_ms DESC LIMIT 20`,
    shareable: ['p95_ms'],
    maxRows: 20,
  };
}

/** Top failing routes (or span names), with error count and HTTP status when known. */
export function buildFailingRoutes(columns: ColumnSet, interval: string): SectionPlan {
  const name = 'failingRoutes';
  const required = ['timestamp', 'span_status_code', 'span_name'];
  if (!hasAll(columns, required)) return { name, skipped: missing(TRACES_TABLE, columns, required) };

  const service = serviceColumn(columns);
  const route = columns.has('span_attributes.http.route')
    ? `coalesce(${q('span_attributes.http.route')}, span_name)`
    : 'span_name';
  const status = columns.has('span_attributes.http.response.status_code')
    ? q('span_attributes.http.response.status_code')
    : null;

  const selects = [
    ...(service ? [`${q(service)} AS service`] : []),
    `${route} AS route`,
    ...(status ? [`${status} AS http_status`] : []),
    'count(*) AS error_spans',
    'max(timestamp) AS last_seen',
  ];
  const groups = [...(service ? [q(service)] : []), route, ...(status ? [status] : [])];

  return {
    name,
    sql:
      `SELECT ${selects.join(', ')} FROM ${q(TRACES_TABLE)} WHERE ${since(interval)} AND ${ERROR_SPAN} ` +
      `GROUP BY ${groups.join(', ')} ORDER BY error_spans DESC LIMIT ${HEALTH_TOP_N}`,
    shareable: ['http_status', 'error_spans', 'last_seen'],
    maxRows: HEALTH_TOP_N,
  };
}

/** The slowest spans of the window. */
export function buildSlowestSpans(columns: ColumnSet, interval: string): SectionPlan {
  const name = 'slowestSpans';
  const required = ['timestamp', 'duration_nano', 'span_name'];
  if (!hasAll(columns, required)) return { name, skipped: missing(TRACES_TABLE, columns, required) };

  const service = serviceColumn(columns);
  const selects = [
    ...(service ? [`${q(service)} AS service`] : []),
    'span_name',
    'duration_nano / 1000000.0 AS duration_ms',
    ...(columns.has('span_status_code') ? [`${ERROR_SPAN} AS is_error`] : []),
    ...(columns.has('trace_id') ? ['trace_id'] : []),
    'timestamp',
  ];

  return {
    name,
    sql:
      `SELECT ${selects.join(', ')} FROM ${q(TRACES_TABLE)} WHERE ${since(interval)} ` +
      `ORDER BY duration_nano DESC LIMIT ${HEALTH_TOP_N}`,
    shareable: ['duration_ms', 'is_error', 'timestamp'],
    maxRows: HEALTH_TOP_N,
  };
}

// ---- health_overview: logs ----------------------------------------------------

/** Log records grouped by severity_text AND severity_number (shows an unpopulated one). */
export function buildLogSeverities(columns: ColumnSet, interval: string): SectionPlan {
  const name = 'logSeverities';
  if (!hasAll(columns, ['timestamp'])) return { name, skipped: missing(LOGS_TABLE, columns, ['timestamp']) };

  const keys = ['severity_text', 'severity_number'].filter((column) => columns.has(column));
  if (keys.length === 0) return { name, skipped: missing(LOGS_TABLE, columns, ['severity_text', 'severity_number']) };

  return {
    name,
    sql:
      `SELECT ${keys.join(', ')}, count(*) AS records FROM ${q(LOGS_TABLE)} WHERE ${since(interval)} ` +
      `GROUP BY ${keys.join(', ')} ORDER BY records DESC LIMIT 20`,
    shareable: ['severity_number', 'records'],
    maxRows: 20,
  };
}

/** The condition for "an ERROR-or-worse log record", from whichever severity columns exist. */
export function errorLogCondition(columns: ReadonlySet<string>): string | null {
  const parts = [
    ...(columns.has('severity_number') ? ['severity_number >= 17'] : []),
    ...(columns.has('severity_text') ? [`upper(severity_text) IN ('ERROR', 'FATAL', 'CRITICAL')`] : []),
  ];

  return parts.length === 0 ? null : `(${parts.join(' OR ')})`;
}

/** Top error log messages (truncated body), with a count and one sample trace id. */
export function buildTopErrorLogs(columns: ColumnSet, interval: string): SectionPlan {
  const name = 'topErrorLogs';
  const required = ['timestamp', 'body'];
  if (!hasAll(columns, required)) return { name, skipped: missing(LOGS_TABLE, columns, required) };

  const condition = errorLogCondition(columns);
  if (!condition) return { name, skipped: missing(LOGS_TABLE, columns, ['severity_text', 'severity_number']) };

  const service = serviceColumn(columns);
  const message = `substr(body, 1, ${ERROR_MESSAGE_GROUP_CHARS})`;
  const selects = [
    ...(service ? [`${q(service)} AS service`] : []),
    `${message} AS message`,
    'count(*) AS occurrences',
    'max(timestamp) AS last_seen',
    ...(columns.has('trace_id') ? ['max(trace_id) AS sample_trace_id'] : []),
  ];
  const groups = [...(service ? [q(service)] : []), message];

  return {
    name,
    sql:
      `SELECT ${selects.join(', ')} FROM ${q(LOGS_TABLE)} WHERE ${since(interval)} AND ${condition} ` +
      `GROUP BY ${groups.join(', ')} ORDER BY occurrences DESC LIMIT ${HEALTH_TOP_N}`,
    shareable: ['occurrences', 'last_seen'],
    maxRows: HEALTH_TOP_N,
  };
}

/** Every `health_overview` statement for one window, in output order. */
export function buildHealthOverview(
  window: HealthWindow,
  traces: ColumnSet,
  logs: ColumnSet,
): SectionPlan[] {
  const interval = windowInterval(window);

  return [
    buildWindowCoverage('tracesCoverage', TRACES_TABLE, traces, interval),
    buildTableRange('tracesRange', TRACES_TABLE, traces),
    buildServiceStats(traces, interval),
    buildServiceLatency(traces, interval),
    buildFailingRoutes(traces, interval),
    buildSlowestSpans(traces, interval),
    buildWindowCoverage('logsCoverage', LOGS_TABLE, logs, interval),
    buildTableRange('logsRange', LOGS_TABLE, logs),
    buildLogSeverities(logs, interval),
    buildTopErrorLogs(logs, interval),
  ];
}

/** `get_app_context`'s per-signal data range: all-time range, last-24h coverage, services. */
export function buildAppContextData(traces: ColumnSet, logs: ColumnSet): SectionPlan[] {
  const day = windowInterval('24h');

  return [
    buildTableRange('tracesRange', TRACES_TABLE, traces),
    buildWindowCoverage('tracesLast24h', TRACES_TABLE, traces, day),
    buildDistinctServices('traceServices', TRACES_TABLE, traces, day),
    buildTableRange('logsRange', LOGS_TABLE, logs),
    buildWindowCoverage('logsLast24h', LOGS_TABLE, logs, day),
    buildDistinctServices('logServices', LOGS_TABLE, logs, day),
  ];
}

// ---- get_trace ----------------------------------------------------------------

/** Every span of one trace, oldest first. `traceId` MUST already match `TRACE_ID_PATTERN`. */
export function buildTraceSpans(traceId: string, columns: ColumnSet, maxRows: number): SectionPlan {
  const name = 'spans';
  const required = ['timestamp', 'trace_id'];
  if (!hasAll(columns, required)) return { name, skipped: missing(TRACES_TABLE, columns, required) };
  assertTraceId(traceId);

  const service = serviceColumn(columns);
  const optional = (column: string, expression = column): string[] => (columns.has(column) ? [expression] : []);

  const selects = [
    'timestamp',
    ...optional('span_id'),
    ...optional('parent_span_id'),
    ...(service ? [`${q(service)} AS service`] : []),
    ...optional('span_name'),
    ...optional('span_kind'),
    ...optional('span_status_code', 'span_status_code AS status_code'),
    ...optional('span_status_code', `${ERROR_SPAN} AS is_error`),
    ...optional('span_status_message', 'span_status_message AS status_message'),
    ...optional('duration_nano', 'duration_nano / 1000000.0 AS duration_ms'),
    ...optional('span_attributes.http.request.method', `${q('span_attributes.http.request.method')} AS http_method`),
    ...optional('span_attributes.http.route', `${q('span_attributes.http.route')} AS http_route`),
    ...optional(
      'span_attributes.http.response.status_code',
      `${q('span_attributes.http.response.status_code')} AS http_status`,
    ),
    ...optional(
      'span_attributes.db.statement',
      `substr(${q('span_attributes.db.statement')}, 1, ${DB_STATEMENT_CHARS}) AS db_statement`,
    ),
    ...optional(
      'span_attributes.db.query.text',
      `substr(${q('span_attributes.db.query.text')}, 1, ${DB_STATEMENT_CHARS}) AS db_query_text`,
    ),
  ];

  return {
    name,
    sql:
      `SELECT ${selects.join(', ')} FROM ${q(TRACES_TABLE)} WHERE trace_id = '${traceId.toLowerCase()}' ` +
      `ORDER BY timestamp LIMIT ${maxRows}`,
    shareable: ['timestamp', 'is_error', 'duration_ms', 'http_status'],
    maxRows,
  };
}

/** Every log record of one trace, oldest first. `traceId` MUST already match `TRACE_ID_PATTERN`. */
export function buildTraceLogs(traceId: string, columns: ColumnSet, maxRows: number): SectionPlan {
  const name = 'logs';
  const required = ['timestamp', 'trace_id'];
  if (!hasAll(columns, required)) return { name, skipped: missing(LOGS_TABLE, columns, required) };
  assertTraceId(traceId);

  const service = serviceColumn(columns);
  const selects = [
    'timestamp',
    ...(service ? [`${q(service)} AS service`] : []),
    ...['severity_text', 'severity_number', 'span_id', 'body'].filter((column) => columns.has(column)),
  ];

  return {
    name,
    sql:
      `SELECT ${selects.join(', ')} FROM ${q(LOGS_TABLE)} WHERE trace_id = '${traceId.toLowerCase()}' ` +
      `ORDER BY timestamp LIMIT ${maxRows}`,
    shareable: ['timestamp', 'severity_number'],
    maxRows,
  };
}

/** Defence in depth: the tool schema already enforces this; a builder never trusts it. */
function assertTraceId(traceId: string): void {
  if (!TRACE_ID_PATTERN.test(traceId)) {
    throw new Error('A trace id must be 16 to 32 hexadecimal characters.');
  }
}
