/**
 * Trace-id validation and the one browser-built SQL (issue #579, epic #576).
 */
import { describe, expect, it } from 'vitest';
import { isTraceId, traceExplorerSql } from '../../../../components/telemetry/dashboard/traceLink';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('isTraceId', () => {
  it('accepts exactly 32 lower-case hex digits', () => {
    expect(isTraceId(TRACE)).toBe(true);
  });

  it.each([
    ['upper case', TRACE.toUpperCase()],
    ['too short', TRACE.slice(1)],
    ['too long', `${TRACE}0`],
    ['non-hex', `${TRACE.slice(0, 31)}g`],
    ['a quote', `${TRACE.slice(0, 31)}'`],
    ['an injection', "' OR 1=1 --"],
    ['empty', ''],
    ['padded', ` ${TRACE}`],
    ['with a newline', `${TRACE}\n`],
  ])('rejects %s', (_label, value) => {
    expect(isTraceId(value)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isTraceId(null)).toBe(false);
    expect(isTraceId(42)).toBe(false);
  });
});

describe('traceExplorerSql', () => {
  it('selects every span of the trace, oldest first, capped at 1000', () => {
    expect(traceExplorerSql(TRACE)).toBe(
      `SELECT * FROM opentelemetry_traces WHERE trace_id = '${TRACE}' ORDER BY "timestamp" LIMIT 1000`,
    );
  });

  it('refuses anything that is not a trace id', () => {
    expect(() => traceExplorerSql("x' OR '1'='1")).toThrow();
  });
});
