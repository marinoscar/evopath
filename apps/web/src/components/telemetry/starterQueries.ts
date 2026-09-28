/**
 * Starter queries for the Telemetry Explorer — issue #537, epic #528.
 *
 * Written against GreptimeDB's OpenTelemetry tables (`opentelemetry_traces`,
 * `opentelemetry_logs`). Span attribute columns are flattened with dots in
 * their names, so any such column must be double-quoted (see
 * {@link quoteIdentifier}).
 */

export interface StarterQuery {
  id: string;
  title: string;
  sql: string;
}

export const TRACE_ID_PLACEHOLDER = '<trace_id>';

export const STARTER_QUERIES: StarterQuery[] = [
  {
    id: 'recent-errors',
    title: 'Recent errors (24h)',
    sql: "SELECT timestamp, service_name, span_name, span_status_message, trace_id FROM opentelemetry_traces WHERE span_status_code = 'STATUS_CODE_ERROR' AND timestamp > now() - INTERVAL '24 hours' ORDER BY timestamp DESC LIMIT 200",
  },
  {
    id: 'slowest-routes',
    title: 'Slowest routes (p95, 1h)',
    sql: "SELECT span_name, count(*) AS calls, approx_percentile_cont(duration_nano / 1000000.0, 0.95) AS p95_ms, max(duration_nano) / 1000000.0 AS max_ms FROM opentelemetry_traces WHERE span_kind = 'SPAN_KIND_SERVER' AND timestamp > now() - INTERVAL '1 hour' GROUP BY span_name ORDER BY p95_ms DESC LIMIT 20",
  },
  {
    id: 'requests-per-service',
    title: 'Requests per service (24h)',
    sql: "SELECT service_name, count(*) AS spans FROM opentelemetry_traces WHERE timestamp > now() - INTERVAL '24 hours' GROUP BY service_name ORDER BY spans DESC",
  },
  {
    id: 'log-warnings',
    title: 'Recent warnings and errors in logs',
    sql: 'SELECT timestamp, severity_text, body, trace_id FROM opentelemetry_logs WHERE severity_number >= 13 ORDER BY timestamp DESC LIMIT 200',
  },
  {
    id: 'trace-by-id',
    title: 'Full trace by ID',
    sql: `SELECT timestamp, span_name, duration_nano / 1000000.0 AS ms, span_status_code, parent_span_id, span_id FROM opentelemetry_traces WHERE trace_id = '${TRACE_ID_PLACEHOLDER}' ORDER BY timestamp`,
  },
  {
    id: 'tables-and-sizes',
    title: 'Tables and sizes',
    sql: "SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_rows DESC",
  },
];

/** Escape a value for a single-quoted SQL string literal. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The query a click on a `trace_id` value runs: every span of the trace, then
 * every log line that carries it, in one result (a UNION over the shared
 * columns, labelled by `kind`).
 */
export function traceQuery(traceId: string): string {
  const id = sqlStringLiteral(traceId);
  // Only columns the OTLP logs table is known to carry (the starter queries'
  // own, plus `span_id`) are read from it; `ms` is a typed NULL for log rows
  // so the UNION's column types line up.
  return [
    "SELECT 'span' AS kind, timestamp, span_name AS name, duration_nano / 1000000.0 AS ms, span_status_code AS status, span_id",
    `FROM opentelemetry_traces WHERE trace_id = ${id}`,
    'UNION ALL',
    "SELECT 'log' AS kind, timestamp, body AS name, CAST(NULL AS DOUBLE) AS ms, severity_text AS status, span_id",
    `FROM opentelemetry_logs WHERE trace_id = ${id}`,
    'ORDER BY timestamp',
  ].join('\n');
}

const BARE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * An identifier as it must be written in SQL: bare when it is a plain
 * lower-case name, double-quoted (with `"` doubled) otherwise — which is every
 * flattened attribute column (`span_attributes.http.route`).
 */
export function quoteIdentifier(name: string): string {
  return BARE_IDENTIFIER.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}
