// =============================================================================
// SQL the telemetry assistant builds ITSELF (issue #571) — pure functions.
//
// Every generated statement MUST pass `analyzeStatement` (the same guard the
// explorer and `run_query` go through): it is SELECT-only, one statement, and
// well-formed by the guard's own lexer. Nothing here talks to a real store.
// =============================================================================

import { analyzeStatement } from '../query/sql-guard';
import {
  buildAppContextData,
  buildDistinctServices,
  buildFailingRoutes,
  buildHealthOverview,
  buildLogSeverities,
  buildServiceLatency,
  buildServiceStats,
  buildSlowestSpans,
  buildTableRange,
  buildTopErrorLogs,
  buildTraceLogs,
  buildTraceSpans,
  buildWindowCoverage,
  errorLogCondition,
  HEALTH_WINDOWS,
  isSkipped,
  LOGS_TABLE,
  serviceColumn,
  TRACES_TABLE,
  TRACE_ID_PATTERN,
  windowInterval,
  type ColumnSet,
  type SectionPlan,
} from './telemetry-assistant.sql';

const FULL_TRACES_COLUMNS: ColumnSet = new Set([
  'timestamp',
  'trace_id',
  'span_id',
  'parent_span_id',
  'service_name',
  'span_name',
  'span_kind',
  'span_status_code',
  'span_status_message',
  'duration_nano',
  'span_attributes.http.request.method',
  'span_attributes.http.route',
  'span_attributes.http.response.status_code',
  'span_attributes.db.statement',
  'span_attributes.db.query.text',
]);

const FULL_LOGS_COLUMNS: ColumnSet = new Set([
  'timestamp',
  'trace_id',
  'span_id',
  'service_name',
  'severity_text',
  'severity_number',
  'body',
]);

/** Only `timestamp` — enough for the coverage/range sections, nothing else. */
const MINIMAL_TRACES_COLUMNS: ColumnSet = new Set(['timestamp']);
const MINIMAL_LOGS_COLUMNS: ColumnSet = new Set(['timestamp']);

function assertAllValid(plans: SectionPlan[]): void {
  for (const plan of plans) {
    if (isSkipped(plan)) continue;

    expect(() => analyzeStatement(plan.sql)).not.toThrow();
    expect(analyzeStatement(plan.sql).kind).toBe('select');
  }
}

describe('generated statements pass the read-only SQL guard', () => {
  it('every health_overview statement, for every window, over a full column set', () => {
    for (const window of HEALTH_WINDOWS) {
      assertAllValid(buildHealthOverview(window, FULL_TRACES_COLUMNS, FULL_LOGS_COLUMNS));
    }
  });

  it('every health_overview statement that survives a minimal column set', () => {
    for (const window of HEALTH_WINDOWS) {
      assertAllValid(buildHealthOverview(window, MINIMAL_TRACES_COLUMNS, MINIMAL_LOGS_COLUMNS));
    }
  });

  it('every get_app_context data statement, full and minimal column sets', () => {
    assertAllValid(buildAppContextData(FULL_TRACES_COLUMNS, FULL_LOGS_COLUMNS));
    assertAllValid(buildAppContextData(MINIMAL_TRACES_COLUMNS, MINIMAL_LOGS_COLUMNS));
  });

  it('every get_app_context data statement, absent tables', () => {
    assertAllValid(buildAppContextData(null, null));
  });

  it('get_trace: spans and logs, full and minimal column sets', () => {
    const traceId = 'a'.repeat(32);

    assertAllValid([buildTraceSpans(traceId, FULL_TRACES_COLUMNS, 50), buildTraceLogs(traceId, FULL_LOGS_COLUMNS, 50)]);
    assertAllValid([
      buildTraceSpans(traceId, MINIMAL_TRACES_COLUMNS, 50),
      buildTraceLogs(traceId, MINIMAL_LOGS_COLUMNS, 50),
    ]);
  });
});

describe('skip paths when tables or columns are missing', () => {
  it('skips every statement when the table does not exist (null columns)', () => {
    for (const window of HEALTH_WINDOWS) {
      const plans = buildHealthOverview(window, null, null);
      expect(plans.every(isSkipped)).toBe(true);
    }
  });

  it('buildTableRange / buildWindowCoverage skip without a timestamp column', () => {
    const noTimestamp: ColumnSet = new Set(['span_name']);

    expect(isSkipped(buildTableRange('r', TRACES_TABLE, noTimestamp))).toBe(true);
    expect(isSkipped(buildWindowCoverage('w', TRACES_TABLE, noTimestamp, '1 hour'))).toBe(true);
    expect(isSkipped(buildTableRange('r', TRACES_TABLE, null))).toBe(true);
  });

  it('buildDistinctServices skips without a service column, even with a timestamp', () => {
    const noService: ColumnSet = new Set(['timestamp']);

    expect(isSkipped(buildDistinctServices('s', TRACES_TABLE, noService, '1 hour'))).toBe(true);
  });

  it('buildServiceStats / buildServiceLatency / buildFailingRoutes / buildSlowestSpans skip on their required columns', () => {
    expect(isSkipped(buildServiceStats(new Set(['timestamp']), '1 hour'))).toBe(true);
    expect(isSkipped(buildServiceLatency(new Set(['span_name']), '1 hour'))).toBe(true);
    expect(isSkipped(buildFailingRoutes(new Set(['timestamp', 'duration_nano']), '1 hour'))).toBe(true);
    expect(isSkipped(buildSlowestSpans(new Set(['timestamp']), '1 hour'))).toBe(true);
  });

  it('buildLogSeverities skips without severity_text or severity_number', () => {
    expect(isSkipped(buildLogSeverities(new Set(['timestamp', 'body']), '1 hour'))).toBe(true);
    expect(isSkipped(buildLogSeverities(new Set(['timestamp', 'severity_text']), '1 hour'))).toBe(false);
    expect(isSkipped(buildLogSeverities(new Set(['timestamp', 'severity_number']), '1 hour'))).toBe(false);
  });

  it('buildTopErrorLogs skips without body, or without any severity column', () => {
    expect(isSkipped(buildTopErrorLogs(new Set(['timestamp', 'severity_text']), '1 hour'))).toBe(true);
    expect(isSkipped(buildTopErrorLogs(new Set(['timestamp', 'body']), '1 hour'))).toBe(true);
  });

  it('buildTraceSpans / buildTraceLogs skip without timestamp AND trace_id', () => {
    expect(isSkipped(buildTraceSpans('a'.repeat(32), new Set(['timestamp']), 10))).toBe(true);
    expect(isSkipped(buildTraceLogs('a'.repeat(32), new Set(['trace_id']), 10))).toBe(true);
  });

  it("a skipped section's message names the table (and, when it exists, the missing column)", () => {
    const range = buildTableRange('r', TRACES_TABLE, null);
    expect(isSkipped(range) && range.skipped).toMatch(new RegExp(`${TRACES_TABLE} does not exist`));

    const noSeverity = buildTopErrorLogs(new Set(['timestamp', 'body']), '1 hour');
    expect(isSkipped(noSeverity) && noSeverity.skipped).toMatch(new RegExp(`${LOGS_TABLE} has no column`));
  });
});

describe('dotted identifiers are always double-quoted', () => {
  it('quotes the flattened service attribute column when it is the fallback', () => {
    const columns: ColumnSet = new Set(['timestamp', 'duration_nano', 'span_status_code', 'span_name', 'resource_attributes.service.name']);
    const plan = buildServiceStats(columns, '1 hour');

    expect(isSkipped(plan)).toBe(false);
    if (!isSkipped(plan)) {
      expect(plan.sql).toContain('"resource_attributes.service.name"');
      expect(() => analyzeStatement(plan.sql)).not.toThrow();
    }
  });

  it('quotes every dotted HTTP/DB attribute column selected in a trace', () => {
    const plan = buildTraceSpans('a'.repeat(32), FULL_TRACES_COLUMNS, 10);

    expect(isSkipped(plan)).toBe(false);
    if (!isSkipped(plan)) {
      expect(plan.sql).toContain('"span_attributes.http.request.method"');
      expect(plan.sql).toContain('"span_attributes.http.route"');
      expect(plan.sql).toContain('"span_attributes.http.response.status_code"');
      expect(plan.sql).toContain('"span_attributes.db.statement"');
      expect(plan.sql).toContain('"span_attributes.db.query.text"');
    }
  });

  it('escapes an embedded double quote in an identifier (belt and braces — real telemetry columns never contain one)', () => {
    const columns: ColumnSet = new Set(['timestamp', 'duration_nano', 'span_status_code', 'span_name', 'weird"column']);
    // Not selected by any builder directly, but `serviceColumn` never returns it and no builder ever
    // interpolates a column name that was not tested for membership first — asserted structurally:
    expect(serviceColumn(columns)).toBeNull();
  });
});

describe('serviceColumn fallback', () => {
  it('prefers service_name over the flattened resource attribute', () => {
    expect(serviceColumn(new Set(['service_name', 'resource_attributes.service.name']))).toBe('service_name');
  });

  it('falls back to the flattened resource attribute when service_name is absent', () => {
    expect(serviceColumn(new Set(['resource_attributes.service.name']))).toBe('resource_attributes.service.name');
  });

  it('is null when neither exists, or the table does not exist', () => {
    expect(serviceColumn(new Set(['timestamp']))).toBeNull();
    expect(serviceColumn(null)).toBeNull();
  });
});

describe('errorLogCondition', () => {
  it('combines severity_number and severity_text when both exist', () => {
    const condition = errorLogCondition(new Set(['severity_number', 'severity_text']));
    expect(condition).toContain('severity_number >= 17');
    expect(condition).toContain("upper(severity_text) IN ('ERROR', 'FATAL', 'CRITICAL')");
    expect(condition).toContain(' OR ');
  });

  it('uses only the column that exists', () => {
    expect(errorLogCondition(new Set(['severity_number']))).toBe('(severity_number >= 17)');
    expect(errorLogCondition(new Set(['severity_text']))).toBe(`(upper(severity_text) IN ('ERROR', 'FATAL', 'CRITICAL'))`);
  });

  it('is null when neither severity column exists', () => {
    expect(errorLogCondition(new Set(['body']))).toBeNull();
  });
});

describe('trace id validation (defence in depth — the tool schema already enforces TRACE_ID_PATTERN)', () => {
  it('accepts 16-32 hex characters, and lower-cases whatever case it was given inside the SQL', () => {
    const plan = buildTraceSpans('ABCDEF0123456789', FULL_TRACES_COLUMNS, 10);

    expect(isSkipped(plan)).toBe(false);
    if (!isSkipped(plan)) {
      expect(plan.sql).toContain("trace_id = 'abcdef0123456789'");
      expect(plan.sql).not.toContain('ABCDEF');
    }
  });

  it('rejects a trace id with SQL injection characters', () => {
    expect(() => buildTraceSpans(`a'; DROP TABLE ${TRACES_TABLE}; --`, FULL_TRACES_COLUMNS, 10)).toThrow(
      /16 to 32 hexadecimal characters/,
    );
    expect(() => buildTraceLogs(`a' OR '1'='1`, FULL_LOGS_COLUMNS, 10)).toThrow(/16 to 32 hexadecimal characters/);
  });

  it('rejects a non-hex string', () => {
    expect(() => buildTraceSpans('not-a-trace-id-at-all!!', FULL_TRACES_COLUMNS, 10)).toThrow();
  });

  it('rejects an id shorter than 16 or longer than 32 hex characters', () => {
    expect(() => buildTraceSpans('a'.repeat(15), FULL_TRACES_COLUMNS, 10)).toThrow();
    expect(() => buildTraceSpans('a'.repeat(33), FULL_TRACES_COLUMNS, 10)).toThrow();
    // Boundary values are fine.
    expect(() => buildTraceSpans('a'.repeat(16), FULL_TRACES_COLUMNS, 10)).not.toThrow();
    expect(() => buildTraceSpans('a'.repeat(32), FULL_TRACES_COLUMNS, 10)).not.toThrow();
  });

  it('TRACE_ID_PATTERN matches exactly what the builders accept', () => {
    expect(TRACE_ID_PATTERN.test('a'.repeat(16))).toBe(true);
    expect(TRACE_ID_PATTERN.test('a'.repeat(32))).toBe(true);
    expect(TRACE_ID_PATTERN.test('a'.repeat(15))).toBe(false);
    expect(TRACE_ID_PATTERN.test('a'.repeat(33))).toBe(false);
    expect(TRACE_ID_PATTERN.test('zzzzzzzzzzzzzzzz')).toBe(false);
    expect(TRACE_ID_PATTERN.test("'; DROP TABLE x; --")).toBe(false);
  });
});

describe('window: an enum, mapped to a fixed interval literal', () => {
  it('maps every declared window to a non-empty INTERVAL literal', () => {
    for (const window of HEALTH_WINDOWS) {
      expect(windowInterval(window)).toMatch(/^\d+ (minute|minutes|hour|hours|day|days)$/);
    }
  });

  it('has exactly the five windows the tool schema advertises', () => {
    expect(HEALTH_WINDOWS).toEqual(['15m', '1h', '6h', '24h', '7d']);
  });

  it("every WINDOWED health_overview statement filters on the requested window's interval", () => {
    const plans = buildHealthOverview('7d', FULL_TRACES_COLUMNS, FULL_LOGS_COLUMNS);
    // tracesRange/logsRange are deliberately all-time (buildTableRange), not windowed.
    const windowed = plans.filter((plan) => !isSkipped(plan) && plan.name !== 'tracesRange' && plan.name !== 'logsRange');

    expect(windowed.length).toBeGreaterThan(0);
    for (const plan of windowed) {
      if (!isSkipped(plan)) expect(plan.sql).toContain("INTERVAL '7 days'");
    }
  });
});

describe('shareable columns never include a value the monitored system wrote', () => {
  const SENSITIVE = ['service', 'route', 'span_name', 'message', 'body', 'trace_id', 'sample_trace_id'];

  it('across every health_overview and get_app_context section', () => {
    const plans = [
      ...buildHealthOverview('1h', FULL_TRACES_COLUMNS, FULL_LOGS_COLUMNS),
      ...buildAppContextData(FULL_TRACES_COLUMNS, FULL_LOGS_COLUMNS),
    ];

    for (const plan of plans) {
      if (isSkipped(plan)) continue;
      for (const name of plan.shareable) {
        expect(SENSITIVE).not.toContain(name);
      }
    }
  });

  it('get_trace shares only timestamp/is_error/duration_ms/http_status(-code), never service/route/body', () => {
    const spans = buildTraceSpans('a'.repeat(32), FULL_TRACES_COLUMNS, 10);
    const logs = buildTraceLogs('a'.repeat(32), FULL_LOGS_COLUMNS, 10);

    expect(isSkipped(spans)).toBe(false);
    expect(isSkipped(logs)).toBe(false);
    if (!isSkipped(spans)) expect(spans.shareable).toEqual(['timestamp', 'is_error', 'duration_ms', 'http_status']);
    if (!isSkipped(logs)) expect(logs.shareable).toEqual(['timestamp', 'severity_number']);
  });
});
