/**
 * "View trace" from a dashboard log event — issue #579, epic #576.
 *
 * An OpenTelemetry trace id is 16 bytes, written as 32 lower-case hex digits
 * (W3C Trace Context). Only an id of exactly that shape gets a link.
 */

export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
}

/**
 * Every span of one trace, for the explorer.
 *
 * THE ONE STATEMENT THE BROWSER BUILDS. Every other dashboard → explorer
 * handoff carries SQL the API reported running; this one is written here
 * because no dashboard endpoint runs it. It is safe because:
 *
 *   1. the only interpolated value is `traceId`, and it is accepted only when
 *      it matches {@link TRACE_ID_PATTERN} — 32 characters from `[0-9a-f]`, so
 *      it cannot contain a quote, whitespace, a comment or anything else that
 *      could end the string literal; any other input throws;
 *   2. it is never run by the browser: it lands in the explorer's editor and
 *      runs only when the reader presses Run, as any typed statement would;
 *   3. the API's SQL guard, not this function, decides whether it may run
 *      (read-only, row and time limits) — exactly as for typed SQL.
 */
export function traceExplorerSql(traceId: string): string {
  if (!isTraceId(traceId)) throw new Error('Not an OpenTelemetry trace id');
  return `SELECT * FROM opentelemetry_traces WHERE trace_id = '${traceId}' ORDER BY "timestamp" LIMIT 1000`;
}
