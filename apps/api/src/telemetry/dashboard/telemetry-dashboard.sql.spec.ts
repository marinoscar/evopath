import { analyzeStatement, applyRowCap } from '../query/sql-guard';
import {
  apiTimeseriesSql,
  apiTotalsSql,
  bucketInterval,
  bucketRowLimit,
  bucketSecondsFor,
  distinctInstancesSql,
  distinctServicesSql,
  eventLoopDelayP99Sql,
  eventsSql,
  heapUsedSql,
  isStreamingRoute,
  LATENCY_P95_NS,
  lastDataSql,
  likeContainsPattern,
  literal,
  logsTimeseriesSql,
  logsTotalsSql,
  SEARCH_MAX_LENGTH,
  STREAM_SPAN_PREDICATE,
  timestampLiteral,
  topErrorsSql,
  topRoutesSql,
  type DashboardSqlFilters,
} from './telemetry-dashboard.sql';

// =============================================================================
// Dashboard SQL templates (issue #577)
// =============================================================================
//
// Snapshots pin the exact text of every statement, with and without filters —
// each was run against GreptimeDB v1.2.1 when written; a diff here means the
// new text needs the same check. The injection cases prove that caller text
// only ever lands inside ONE quoted literal of ONE read-only statement.
// =============================================================================

const FROM = new Date('2026-09-27T21:00:00.000Z');
const TO = new Date('2026-09-27T22:00:00.000Z');
const PREVIOUS_FROM = new Date('2026-09-27T20:00:00.000Z');
const WINDOW = { from: FROM, to: TO, bucketSeconds: 60 };
const NONE: DashboardSqlFilters = {};
const FILTERED: DashboardSqlFilters = { service: "my-app-api", instance: "node-1", tracesHaveInstance: true };
const BOTH = { traces: true, logs: true };

/** Every template must be exactly one SELECT the guard accepts, with a literal top-level LIMIT. */
function expectGuarded(sql: string): void {
  const statement = analyzeStatement(sql);
  expect(statement.kind).toBe('select');
  // A top-level literal LIMIT already present → the row cap keeps or clamps it, never appends one.
  expect(['kept', 'clamped']).toContain(applyRowCap(statement, 1_000_000).strategy);
}

describe('telemetry dashboard SQL templates', () => {
  const templates: Array<[string, (f: DashboardSqlFilters) => string]> = [
    ['apiTimeseries', (f) => apiTimeseriesSql(WINDOW, f)],
    ['apiTotals', (f) => apiTotalsSql(PREVIOUS_FROM, WINDOW, f)],
    ['topRoutes', (f) => topRoutesSql(WINDOW, f)],
    ['logsTimeseries', (f) => logsTimeseriesSql(WINDOW, f)],
    ['logsTotals', (f) => logsTotalsSql(PREVIOUS_FROM, WINDOW, f)],
    ['topErrors', (f) => topErrorsSql(WINDOW, f)],
    ['events', (f) => eventsSql(WINDOW, f, { severities: ['error', 'warn'] })],
    ['lastData', (f) => lastDataSql(PREVIOUS_FROM, TO, f, BOTH)],
    ['heapUsed', (f) => heapUsedSql(PREVIOUS_FROM, TO, 60, f.service)],
    ['eventLoopDelayP99', (f) => eventLoopDelayP99Sql(PREVIOUS_FROM, TO, 60, f.service)],
  ];

  describe.each(templates)('%s', (_name, build) => {
    it('matches the snapshot without filters', () => {
      const sql = build(NONE);
      expect(sql).toMatchSnapshot();
      expectGuarded(sql);
    });

    it('matches the snapshot with service and instance filters', () => {
      const sql = build(FILTERED);
      expect(sql).toMatchSnapshot();
      expectGuarded(sql);
    });
  });

  describe('streaming (SSE) exclusion', () => {
    const P95_ALL = 'approx_percentile_cont(0.95) WITHIN GROUP (ORDER BY "duration_nano")';

    it('is a suffix match on the server span path', () => {
      expect(STREAM_SPAN_PREDICATE).toBe(`"span_attributes.url.path" LIKE '%/stream'`);
      expect(LATENCY_P95_NS).toBe(
        `approx_percentile_cont(0.95) WITHIN GROUP (ORDER BY CASE WHEN ${STREAM_SPAN_PREDICATE} THEN NULL ELSE "duration_nano" END)`,
      );
    });

    it.each([
      ['apiTimeseries', apiTimeseriesSql(WINDOW, NONE)],
      ['apiTotals', apiTotalsSql(PREVIOUS_FROM, WINDOW, NONE)],
    ])('%s excludes streams from p95 only, never from counts', (_name, sql) => {
      expect(sql).toContain(`${LATENCY_P95_NS} AS p95_ns`);
      expect(sql).not.toContain(P95_ALL);
      // The predicate appears once: inside the percentile, not in WHERE or a count.
      expect(sql.split(STREAM_SPAN_PREDICATE)).toHaveLength(2);
      expect(sql).toMatch(/count\(\*\) AS (total|requests)/);
      const where = sql.slice(sql.indexOf(' WHERE '));
      expect(where).not.toContain('stream');
      for (const count of sql.match(/sum\(CASE WHEN [^)]*END\)/g) ?? []) expect(count).not.toContain('stream');
    });

    it('keeps streams (and their p95) in the per-route table', () => {
      const sql = topRoutesSql(WINDOW, NONE);
      expect(sql).toContain(`${P95_ALL} AS p95_ns`);
      expect(sql).not.toContain('stream');
    });

    it.each([
      ['/api/notifications/stream', true],
      ['/api/ai/responses/stream', true],
      ['/api/admin/telemetry/assistant/stream', true],
      ['/api/streams', false],
      ['/api/stream/:id', false],
      ['/api/users/:id', false],
      [null, false],
    ])('isStreamingRoute(%p) is %p', (route, expected) => {
      expect(isStreamingRoute(route)).toBe(expected);
    });
  });

  it('snapshots the distinct-value statements', () => {
    const services = distinctServicesSql(FROM, TO, BOTH) as string;
    const instances = distinctInstancesSql(FROM, TO, BOTH) as string;
    expect(services).toMatchSnapshot();
    expect(instances).toMatchSnapshot();
    expectGuarded(services);
    expectGuarded(instances);
  });

  it('snapshots events with every option', () => {
    const sql = eventsSql(WINDOW, FILTERED, {
      severities: ['info', 'error', 'warn'],
      q: 'timeout',
      cursor: { ts: '2026-09-27T21:59:59.123456789', spanId: 'abcdef0123456789' },
    });
    expect(sql).toMatchSnapshot();
    expectGuarded(sql);
  });

  it('leaves out tables that do not exist', () => {
    expect(lastDataSql(PREVIOUS_FROM, TO, NONE, { traces: false, logs: true })).toMatch(/^SELECT NULL AS traces_last/);
    expect(distinctServicesSql(FROM, TO, { traces: false, logs: false })).toBeNull();
    expect(distinctInstancesSql(FROM, TO, { traces: false, logs: true })).not.toContain('opentelemetry_traces');
  });

  it('turns an instance filter into "no trace" when the traces table has no instance column', () => {
    const sql = apiTotalsSql(PREVIOUS_FROM, WINDOW, { instance: 'node-1', tracesHaveInstance: false });
    expect(sql).toContain('AND 1 = 0');
    expect(sql).not.toContain('app.instance.id');
  });

  it('keeps the runtime metrics free of the instance filter (no such column)', () => {
    expect(heapUsedSql(FROM, TO, 60, 'svc')).not.toContain('instance');
    expect(heapUsedSql(FROM, TO, 60, null)).not.toContain('service_name =');
  });
});

describe('literals and buckets', () => {
  it('doubles single quotes in literals', () => {
    expect(literal("it's")).toBe("'it''s'");
  });

  it('renders timestamps from Dates only', () => {
    expect(timestampLiteral(FROM)).toBe("'2026-09-27T21:00:00.000Z'");
    expect(() => timestampLiteral(new Date('nope'))).toThrow(RangeError);
  });

  it.each([
    [15 * 60_000, 60, 30],
    [15 * 60_000, 30, 30],
    [60 * 60_000, 60, 60],
    [60 * 60_000, 30, 300],
    [6 * 3_600_000, 60, 600],
    [24 * 3_600_000, 60, 1800],
    [7 * 86_400_000, 60, 10800],
    [30 * 86_400_000, 60, 21600],
    [30 * 86_400_000, 30, 21600],
    [5 * 60_000, 60, 10],
  ])('span %d ms / %d buckets → %d s', (span, buckets, expected) => {
    expect(bucketSecondsFor(span, buckets)).toBe(expected);
  });

  it('refuses a bucket size that is not allowed', () => {
    expect(() => bucketInterval(45)).toThrow(RangeError);
    expect(bucketInterval(300)).toBe("INTERVAL '300 seconds'");
  });

  it('bounds a series by its bucket count', () => {
    expect(bucketRowLimit(FROM, TO, 60)).toBe(62);
  });
});

describe('likeContainsPattern', () => {
  it('escapes LIKE metacharacters and doubles quotes', () => {
    expect(likeContainsPattern(`50%_off\\now 'x'`)).toBe(`50\\%\\_off\\\\now ''x''`);
  });

  it('strips control characters and caps the length', () => {
    expect(likeContainsPattern('a\u0000b\nc\u007fd e')).toBe('abcde');
    expect(likeContainsPattern('x'.repeat(500))).toHaveLength(SEARCH_MAX_LENGTH);
    expect(likeContainsPattern('\u0000\u0001')).toBe('');
  });
});

describe('eventsSql injection', () => {
  const INJECTIONS = [
    "a'; DROP TABLE x; --",
    "' OR 1=1 --",
    '\u0000',
    "x'); SELECT * FROM users; /*",
    "\\'; DROP TABLE x; --",
    'x'.repeat(SEARCH_MAX_LENGTH + 1),
  ];

  it.each(INJECTIONS)('keeps %j inside one literal of one guarded statement', (q) => {
    const sql = eventsSql(WINDOW, NONE, { severities: ['error'], q });

    // Exactly one read-only statement (throws otherwise).
    expectGuarded(sql);

    // The search text is confined to the ILIKE literal, which ends at ESCAPE.
    const pattern = likeContainsPattern(q);
    if (pattern) {
      expect(sql).toContain(`body ILIKE '%${pattern}%' ESCAPE '\\' ORDER BY`);
      // Stripping the literal leaves no trace of the payload.
      const outside = sql.replace(`'%${pattern}%'`, "''");
      expect(outside).not.toMatch(/DROP|1=1|users/);
    } else {
      expect(sql).not.toContain('ILIKE');
    }
  });

  it('refuses an unvalidated cursor', () => {
    expect(() =>
      eventsSql(WINDOW, NONE, { severities: ['error'], cursor: { ts: "2026-09-27' OR 1=1 --", spanId: '' } }),
    ).toThrow(RangeError);
    expect(() =>
      eventsSql(WINDOW, NONE, { severities: ['error'], cursor: { ts: '2026-09-27T21:00:00', spanId: "x'" } }),
    ).toThrow(RangeError);
  });

  it('needs a severity', () => {
    expect(() => eventsSql(WINDOW, NONE, { severities: [] })).toThrow(RangeError);
  });
});
