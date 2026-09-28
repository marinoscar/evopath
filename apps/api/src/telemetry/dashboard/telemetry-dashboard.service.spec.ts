import type { SystemTelemetryValue } from '../../common/schemas/settings.schema';
import {
  telemetryDashboardEventsQuerySchema,
  telemetryDashboardQuerySchema,
  telemetryDashboardTimeseriesQuerySchema,
} from '../dto/telemetry-dashboard.dto';
import type { TelemetrySchema } from '../dto/telemetry-query.dto';
import type { TelemetryQueryResult } from '../greptime/greptime.client';
import { TelemetryQueryFailedError, TelemetryQueryTimeoutError } from '../greptime/greptime.errors';
import { analyzeStatement } from '../query/sql-guard';
import { TelemetryHttpError } from '../query/telemetry-query.errors';
import {
  auditParams,
  catalogOf,
  DASHBOARD_RESULT_CACHE_MS,
  decodeCursor,
  encodeCursor,
  resolveWindow,
  TELEMETRY_DASHBOARD_AUDIT_ACTION,
  TelemetryDashboardService,
} from './telemetry-dashboard.service';
import { EVENTS_PAGE_SIZE, REQUIRED_LOG_COLUMNS, REQUIRED_TRACE_COLUMNS, TRACE_COLUMNS } from './telemetry-dashboard.sql';

// =============================================================================
// TelemetryDashboardService (issue #577)
// =============================================================================
//
// GreptimeDB is a fake that answers each template by its shape, so these tests
// cover the service's decisions: preconditions, validation (filters, cursor,
// window), the result cache and its shared in-flight promises, error mapping,
// composition of the summary, keyset pagination and the audit trail.
// =============================================================================

const POLICY: SystemTelemetryValue = {
  enabled: true,
  retentionDays: 7,
  instanceId: null,
  query: { maxRows: 1000, timeoutSeconds: 15 },
  assistant: {
    enabled: false,
    provider: null,
    modelId: null,
    shareResults: true,
    maxResultRowsToModel: 20,
    maxSteps: 6,
  },
};

function table(name: string, columns: readonly string[]) {
  return { name, rows: null, columns: columns.map((c) => ({ name: c, type: 'string', semanticType: null })) };
}

const FULL_SCHEMA: TelemetrySchema = {
  tables: [
    table('opentelemetry_traces', [...REQUIRED_TRACE_COLUMNS, TRACE_COLUMNS.instance]),
    table('opentelemetry_logs', REQUIRED_LOG_COLUMNS),
    table('v8js_memory_heap_used_bytes', ['greptime_timestamp', 'greptime_value']),
    table('nodejs_eventloop_delay_p99_seconds', ['greptime_timestamp', 'greptime_value']),
  ],
};

function result(names: string[], rows: unknown[][] = []): TelemetryQueryResult {
  return { fields: names.map((name) => ({ name, dataTypeID: 25 })), rows };
}

const NOW = Date.parse('2026-09-27T22:00:00.000Z');
/** A bucket start inside the default 1h window, as the store prints it. */
const BUCKET = '2026-09-27 21:59:00.000000';

/** Answers each dashboard template by its shape. Override per test through `overrides`. */
function answer(sql: string, overrides: Record<string, TelemetryQueryResult> = {}): TelemetryQueryResult {
  const kind = classify(sql);
  if (overrides[kind]) return overrides[kind];

  switch (kind) {
    case 'instances':
      return result(['v'], [['node-1']]);
    case 'services':
      return result(['v'], [['my-app-api'], ['worker']]);
    case 'apiTotals':
      return result(
        ['period', 'requests', 'errors', 'p95_ns'],
        [
          ['current', '1000', '72', '3450000000'],
          ['previous', '800', '0', '1200000'],
        ],
      );
    case 'apiSeries':
      return result(['t', 'total', 's2xx', 's3xx', 's4xx', 's5xx', 'p95_ns'], [[BUCKET, '60', '50', '0', '4', '6', '2500000']]);
    case 'logsTotals':
      return result(
        ['period', 'error', 'warn'],
        [
          ['current', '45', '7'],
          ['previous', '3', '2'],
        ],
      );
    case 'logsSeries':
      return result(['t', 'error', 'warn', 'info', 'other'], [[BUCKET, '5', '1', '30', '0']]);
    case 'lastData':
      return result(['traces_last', 'logs_last'], [['2026-09-27 21:59:30.000000', '2026-09-27 21:59:50.000000']]);
    case 'topRoutes':
      return result(
        ['method', 'route', 'requests', 'errors', 'p95_ns'],
        [
          ['POST', '/api/jobs', '100', '70', '900000000'],
          ['GET', '/api/users/:id', '200', '2', '4000000000'],
        ],
      );
    case 'topErrors':
      return result(
        ['message', 'occurrences', 'first_seen', 'last_seen', 'sample_trace_id', 'service'],
        [['ECONNREFUSED', '40', '2026-09-27 21:10:00.000000', '2026-09-27 21:59:00.000000', 'abc', 'my-app-api']],
      );
    case 'heap':
      return result(['t', 'v'], [['2026-09-27 20:30:00.000000', '100.0'], [BUCKET, '131985188.4']]);
    case 'eventLoop':
      return result(['t', 'v'], [[BUCKET, '13.14']]);
    case 'events':
      return result(['ts', 'severity_number', 'severity_text', 'service', 'body', 'trace_id', 'span_id'], []);
    default:
      throw new Error(`unexpected SQL: ${sql}`);
  }
}

function classify(sql: string): string {
  if (sql.includes('v8js_memory_heap_used_bytes')) return 'heap';
  if (sql.includes('nodejs_eventloop_delay_p99_seconds')) return 'eventLoop';
  if (sql.includes(' AS v ') && sql.includes('app.instance.id')) return 'instances';
  if (sql.includes(' AS v ')) return 'services';
  if (sql.includes('traces_last')) return 'lastData';
  if (sql.includes('AS period') && sql.includes('opentelemetry_traces')) return 'apiTotals';
  if (sql.includes('AS period')) return 'logsTotals';
  if (sql.includes('AS s2xx')) return 'apiSeries';
  if (sql.includes('AS other')) return 'logsSeries';
  if (sql.includes('AS route')) return 'topRoutes';
  if (sql.includes('AS occurrences')) return 'topErrors';
  if (sql.includes('CAST("timestamp" AS STRING)')) return 'events';
  return 'unknown';
}

function setup(opts: { schema?: TelemetrySchema; overrides?: Record<string, TelemetryQueryResult> } = {}) {
  const greptime = {
    database: 'public',
    isConfigured: jest.fn().mockReturnValue(true),
    queryReader: jest.fn(async (sql: string) => answer(sql, opts.overrides)),
  };
  const settings = { getPolicy: jest.fn().mockResolvedValue(POLICY) };
  const schema = { getSchema: jest.fn().mockResolvedValue(opts.schema ?? FULL_SCHEMA) };
  const prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
  const service = new TelemetryDashboardService(greptime as never, settings as never, schema as never, prisma as never);
  const sqlOf = (kind: string) => greptime.queryReader.mock.calls.map(([sql]) => sql).filter((sql) => classify(sql) === kind);

  return { service, greptime, settings, schema, prisma, sqlOf };
}

async function rejection(promise: Promise<unknown>): Promise<TelemetryHttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TelemetryHttpError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function bodyOf(error: TelemetryHttpError): { message: string; details: Record<string, unknown> } {
  return error.getResponse() as never;
}

let now = NOW;
beforeEach(() => {
  now = NOW;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

describe('request validation (DTO)', () => {
  const parse = (value: Record<string, string>) => telemetryDashboardQuerySchema.safeParse(value);

  it('accepts a range, an absolute window, or neither', () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ range: '7d', buckets: '30' }).success).toBe(true);
    expect(parse({ from: '2026-09-27T20:00:00Z', to: '2026-09-27T21:00:00Z' }).success).toBe(true);
  });

  it.each([
    ['range and from/to together', { range: '1h', from: '2026-09-27T20:00:00Z', to: '2026-09-27T21:00:00Z' }],
    ['range and from', { range: '1h', from: '2026-09-27T20:00:00Z' }],
    ['from without to', { from: '2026-09-27T20:00:00Z' }],
    ['to without from', { to: '2026-09-27T20:00:00Z' }],
    ['from after to', { from: '2026-09-27T21:00:00Z', to: '2026-09-27T20:00:00Z' }],
    ['from equal to', { from: '2026-09-27T21:00:00Z', to: '2026-09-27T21:00:00Z' }],
    ['a span over 30 days', { from: '2026-08-28T21:59:59Z', to: '2026-09-27T22:00:00Z' }],
    ['to more than a minute ahead', { from: '2026-09-27T21:00:00Z', to: '2026-09-27T22:01:01Z' }],
    ['a range that is not listed', { range: '2h' }],
    ['buckets 45', { buckets: '45' }],
    ['buckets 0', { buckets: '0' }],
    ['a non-ISO from', { from: 'yesterday', to: '2026-09-27T21:00:00Z' }],
    ['an instance over 200 characters', { instance: 'x'.repeat(201) }],
  ])('refuses %s', (_label, value) => {
    expect(parse(value).success).toBe(false);
  });

  it('allows exactly 30 days and to up to one minute ahead', () => {
    expect(parse({ from: '2026-08-28T22:00:00Z', to: '2026-09-27T22:00:00Z' }).success).toBe(true);
    expect(parse({ from: '2026-09-27T21:00:00Z', to: '2026-09-27T22:01:00Z' }).success).toBe(true);
  });

  it('requires panel on timeseries', () => {
    expect(telemetryDashboardTimeseriesQuerySchema.safeParse({}).success).toBe(false);
    expect(telemetryDashboardTimeseriesQuerySchema.safeParse({ panel: 'db' }).success).toBe(false);
    expect(telemetryDashboardTimeseriesQuerySchema.safeParse({ panel: 'logs' }).success).toBe(true);
  });

  it('validates the events severity list and caps q at 200 characters', () => {
    const events = (value: Record<string, string>) => telemetryDashboardEventsQuerySchema.safeParse(value).success;
    expect(events({ severity: 'error,warn,info' })).toBe(true);
    expect(events({ severity: 'error,debug' })).toBe(false);
    expect(events({ severity: 'error,' })).toBe(false);
    expect(events({ q: 'x'.repeat(200) })).toBe(true);
    expect(events({ q: 'x'.repeat(201) })).toBe(false);
  });
});

describe('resolveWindow', () => {
  it('defaults to the last hour in 60 buckets', () => {
    const window = resolveWindow({}, NOW);
    expect(window.from.toISOString()).toBe('2026-09-27T21:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-09-27T22:00:00.000Z');
    expect(window.previousFrom.toISOString()).toBe('2026-09-27T20:00:00.000Z');
    expect(window.bucketSeconds).toBe(60);
    expect(window.key).toBe('range=1h&buckets=60');
  });

  it('keys an absolute window by its instants', () => {
    const window = resolveWindow({ from: '2026-09-20T00:00:00Z', to: '2026-09-27T00:00:00Z', buckets: '30' }, NOW);
    expect(window.key).toBe('from=2026-09-20T00:00:00.000Z&to=2026-09-27T00:00:00.000Z&buckets=30');
    expect(window.bucketSeconds).toBe(21600);
  });
});

describe('cursor', () => {
  it('round-trips', () => {
    const cursor = { ts: '2026-09-27T21:59:59.123456789', spanId: 'abcdef0123456789' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(encodeCursor({ ts: '2026-09-27T21:59:59', spanId: '' }))).toEqual({
      ts: '2026-09-27T21:59:59',
      spanId: '',
    });
  });

  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it.each([
    ['not base64url', 'a+b/c='],
    ['not JSON', 'abc'],
    ['an array', b64(['2026-09-27T21:59:59', ''])],
    ['a missing key', b64({ ts: '2026-09-27T21:59:59' })],
    ['an extra key', b64({ ts: '2026-09-27T21:59:59', spanId: '', x: 1 })],
    ['a numeric ts', b64({ ts: 1, spanId: '' })],
    ['an injected ts', b64({ ts: "2026-09-27' OR 1=1 --", spanId: '' })],
    ['an injected span id', b64({ ts: '2026-09-27T21:59:59', spanId: "' OR '1'='1" })],
    ['an impossible date', b64({ ts: '2026-13-45T25:61:61', spanId: '' })],
    ['an empty string', ''],
  ])('refuses %s with 400 TELEMETRY_DASHBOARD_BAD_CURSOR', (_label, raw) => {
    let error: unknown;
    try {
      decodeCursor(raw);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TelemetryHttpError);
    expect((error as TelemetryHttpError).getStatus()).toBe(400);
    expect(bodyOf(error as TelemetryHttpError).details.reason).toBe('TELEMETRY_DASHBOARD_BAD_CURSOR');
  });

  it('is refused by the events route before any query', async () => {
    const { service, greptime } = setup();
    const error = await rejection(service.events('u1', { cursor: 'abc' }));
    expect(error.getStatus()).toBe(400);
    expect(greptime.queryReader).not.toHaveBeenCalled();
  });
});

describe('preconditions', () => {
  it('is 503 TELEMETRY_NOT_CONFIGURED without a store', async () => {
    const { service, greptime } = setup();
    greptime.isConfigured.mockReturnValue(false);
    const error = await rejection(service.summary('u1', {}));
    expect(error.getStatus()).toBe(503);
    expect(error.reason).toBe('TELEMETRY_NOT_CONFIGURED');
  });

  it('is 409 TELEMETRY_DISABLED when telemetry is off — even with a cached answer', async () => {
    const { service, settings, greptime } = setup();
    await service.top('u1', { kind: 'routes' });
    settings.getPolicy.mockResolvedValue({ ...POLICY, enabled: false });

    const error = await rejection(service.top('u1', { kind: 'routes' }));
    expect(error.getStatus()).toBe(409);
    expect(error.reason).toBe('TELEMETRY_DISABLED');
    expect(greptime.queryReader).toHaveBeenCalledTimes(1);
  });
});

describe('service / instance filters', () => {
  it('refuses an unknown service with 400 TELEMETRY_DASHBOARD_BAD_FILTER', async () => {
    const { service, sqlOf } = setup();
    const error = await rejection(service.summary('u1', { service: 'nope' }));
    expect(error.getStatus()).toBe(400);
    expect(bodyOf(error).details).toEqual({ field: 'service', reason: 'TELEMETRY_DASHBOARD_BAD_FILTER' });
    expect(sqlOf('apiTotals')).toHaveLength(0);
  });

  it('refuses an unknown instance', async () => {
    const { service } = setup();
    const error = await rejection(service.top('u1', { kind: 'routes', instance: "node-1' OR 1=1 --" }));
    expect(bodyOf(error).details).toEqual({ field: 'instance', reason: 'TELEMETRY_DASHBOARD_BAD_FILTER' });
  });

  it('applies known values as quoted literals', async () => {
    const { service, sqlOf } = setup();
    await service.top('u1', { kind: 'routes', service: 'my-app-api', instance: 'node-1' });
    const [sql] = sqlOf('topRoutes');
    expect(sql).toContain(`"service_name" = 'my-app-api'`);
    expect(sql).toContain(`"resource_attributes.app.instance.id" = 'node-1'`);
  });

  it('caches the distinct values for 60 seconds', async () => {
    const { service, sqlOf } = setup();
    await service.top('u1', { kind: 'routes', service: 'my-app-api' });
    await service.top('u1', { kind: 'errors', service: 'my-app-api' });
    expect(sqlOf('services')).toHaveLength(1);

    now += 61_000;
    await service.top('u1', { kind: 'routes', service: 'worker' });
    expect(sqlOf('services')).toHaveLength(2);
  });

  it('serves /filters from the same values', async () => {
    const { service } = setup();
    const filters = await service.filters('u1', {});
    expect(filters.services).toEqual(['my-app-api', 'worker']);
    expect(filters.instances).toEqual(['node-1']);
    expect(filters.sql).toHaveLength(2);
    expect(filters.truncated).toBe(false);
  });

  it('marks /filters truncated past 200 values', async () => {
    const many = result(['v'], Array.from({ length: 201 }, (_, i) => [`svc-${i}`]));
    const { service } = setup({ overrides: { services: many } });
    const filters = await service.filters('u1', {});
    expect(filters.services).toHaveLength(200);
    expect(filters.truncated).toBe(true);
  });
});

describe('result cache', () => {
  it('answers two identical calls within 15 s with one store query', async () => {
    const { service, greptime } = setup();
    const first = await service.top('u1', { kind: 'routes' });
    now += DASHBOARD_RESULT_CACHE_MS - 1;
    const second = await service.top('u2', { kind: 'routes' });

    expect(greptime.queryReader).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('reads again once the entry expired', async () => {
    const { service, greptime } = setup();
    await service.top('u1', { kind: 'routes' });
    now += DASHBOARD_RESULT_CACHE_MS;
    await service.top('u1', { kind: 'routes' });
    expect(greptime.queryReader).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight promise between concurrent identical calls', async () => {
    const { service, greptime } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    greptime.queryReader.mockImplementation(async (sql: string) => {
      await gate;
      return answer(sql);
    });

    const calls = [
      service.top('u1', { kind: 'routes' }),
      service.top('u2', { kind: 'routes' }),
      service.top('u3', { kind: 'routes' }),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [a, b, c] = await Promise.all(calls);

    expect(greptime.queryReader).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('keys by route and parameters', async () => {
    const { service, greptime } = setup();
    await service.top('u1', { kind: 'routes' });
    await service.top('u1', { kind: 'errors' });
    await service.top('u1', { kind: 'routes', range: '6h' });
    await service.top('u1', { kind: 'routes', buckets: '30' });
    await service.timeseries('u1', { panel: 'api' });
    expect(greptime.queryReader).toHaveBeenCalledTimes(5);
  });

  it('does not cache a failure', async () => {
    const { service, greptime } = setup();
    greptime.queryReader.mockRejectedValueOnce(new TelemetryQueryTimeoutError(15_000));
    await rejection(service.top('u1', { kind: 'routes' }));
    await service.top('u1', { kind: 'routes' });
    expect(greptime.queryReader).toHaveBeenCalledTimes(2);
  });
});

describe('store errors', () => {
  it.each([
    [new TelemetryQueryTimeoutError(15_000), 504, 'TELEMETRY_QUERY_TIMEOUT'],
    [new TelemetryQueryFailedError('column not found', '42703', 'server'), 400, 'TELEMETRY_QUERY_FAILED'],
    [new TelemetryQueryFailedError('ECONNREFUSED', 'ECONNREFUSED', 'connection'), 503, 'TELEMETRY_UNREACHABLE'],
  ])('maps %p to %d %s and audits it', async (thrown, status, reason) => {
    const { service, greptime, prisma } = setup();
    greptime.queryReader.mockRejectedValue(thrown);

    const error = await rejection(service.timeseries('u1', { panel: 'logs' }));
    expect(error.getStatus()).toBe(status);
    expect(error.reason).toBe(reason);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: TELEMETRY_DASHBOARD_AUDIT_ACTION,
        meta: expect.objectContaining({ route: 'timeseries', reason }),
      }),
    });
  });

  it('runs every statement with the policy timeout on the reader pool', async () => {
    const { service, greptime } = setup();
    await service.top('u1', { kind: 'errors' });
    expect(greptime.queryReader).toHaveBeenCalledWith(expect.any(String), { timeoutMs: 15_000 });
  });
});

describe('summary', () => {
  it('runs its statements concurrently', async () => {
    const { service, greptime } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    greptime.queryReader.mockImplementation(async (sql: string) => {
      await gate;
      return answer(sql);
    });

    const pending = service.summary('u1', {});
    await new Promise((resolve) => setImmediate(resolve));
    // Every statement is in flight before any has answered.
    expect(greptime.queryReader).toHaveBeenCalledTimes(9);
    release();
    await pending;
  });

  it('builds the verdict, tiles and runtime from the store', async () => {
    const { service } = setup();
    const summary = await service.summary('u1', {});

    expect(summary.verdict.level).toBe('critical');
    expect(summary.verdict.reasons).toEqual([
      '5xx rate 7.2% (> 5%) — top: POST /api/jobs',
      'p95 latency 3450 ms (> 3000 ms) — slowest: GET /api/users/:id',
      'Error logs 45 vs 3 in the previous window (15× ≥ 10×) — top: ECONNREFUSED',
    ]);

    const tiles = Object.fromEntries(summary.tiles.map((t) => [t.key, t]));
    expect(Object.keys(tiles)).toEqual(['requestsPerMin', 'errorRatePct', 'p95Ms', 'errorLogs', 'warnLogs', 'lastDataAt']);
    expect(tiles.requestsPerMin).toMatchObject({ value: 16.67, previous: 13.33, unit: 'req/min' });
    expect(tiles.errorRatePct).toMatchObject({ value: 7.2, previous: 0, unit: '%' });
    expect(tiles.p95Ms).toMatchObject({ value: 3450, previous: 1.2, unit: 'ms' });
    expect(tiles.errorLogs).toMatchObject({ value: 45, previous: 3 });
    expect(tiles.warnLogs).toMatchObject({ value: 7, previous: 2 });
    expect(tiles.lastDataAt).toMatchObject({ value: '2026-09-27T21:59:50.000Z', previous: null, sparkline: [] });

    // One sparkline value per bucket; the last bucket carries the fixture row.
    expect(tiles.requestsPerMin.sparkline).toHaveLength(60);
    expect(tiles.requestsPerMin.sparkline.at(-1)).toBe(60);
    expect(tiles.errorRatePct.sparkline.at(-1)).toBe(10);
    expect(tiles.errorRatePct.sparkline[0]).toBeNull();
    expect(tiles.p95Ms.sparkline.at(-1)).toBe(2.5);
    expect(tiles.errorLogs.sparkline.at(-1)).toBe(5);

    expect(summary.runtime?.map((t) => [t.key, t.value, t.previous])).toEqual([
      ['heapUsedBytes', 131985188, 100],
      ['eventLoopDelayP99Ms', 13.1, null],
    ]);

    expect(summary.range).toEqual({
      from: '2026-09-27T21:00:00.000Z',
      to: '2026-09-27T22:00:00.000Z',
      bucketSeconds: 60,
    });
    expect(summary.sql).toHaveLength(9);
    expect(summary.truncated).toBe(false);
  });

  it('never names a streaming (SSE) route as the slowest offender', async () => {
    const routes = result(
      ['method', 'route', 'requests', 'errors', 'p95_ns'],
      [
        ['POST', '/api/jobs', '100', '70', '900000000'],
        ['GET', '/api/notifications/stream', '50', '0', '600000000000'],
        ['POST', '/api/ai/responses/stream', '5', '0', '90000000000'],
        ['GET', '/api/users/:id', '200', '2', '4000000000'],
      ],
    );
    const { service } = setup({ overrides: { topRoutes: routes } });
    const summary = await service.summary('u1', {});
    const p95Reason = summary.verdict.reasons.find((r) => r.startsWith('p95 latency'));
    expect(p95Reason).toBe('p95 latency 3450 ms (> 3000 ms) — slowest: GET /api/users/:id');
    expect(summary.verdict.reasons.join('\n')).not.toContain('/stream');

    // Streams stay in the top-routes table, with their own p95.
    const top = await service.top('u1', { kind: 'routes' });
    expect(top.items.map((i) => ('route' in i ? i.route : null))).toContain('/api/notifications/stream');
  });

  it('names no slowest route when only streams are listed', async () => {
    const routes = result(
      ['method', 'route', 'requests', 'errors', 'p95_ns'],
      [['GET', '/api/notifications/stream', '50', '0', '600000000000']],
    );
    const { service } = setup({ overrides: { topRoutes: routes } });
    const summary = await service.summary('u1', {});
    expect(summary.verdict.reasons).toContain('p95 latency 3450 ms (> 3000 ms)');
  });

  it('is no_data when the latest record is older than 5 minutes', async () => {
    const { service } = setup({
      overrides: { lastData: result(['traces_last', 'logs_last'], [['2026-09-27 21:48:00.000000', null]]) },
    });
    const summary = await service.summary('u1', {});
    expect(summary.verdict).toEqual({ level: 'no_data', reasons: ['No telemetry received for 12 min'] });
  });

  it('degrades to empty panels and no runtime on a fresh store', async () => {
    const { service, greptime } = setup({ schema: { tables: [] } });
    const summary = await service.summary('u1', {});

    expect(greptime.queryReader).not.toHaveBeenCalled();
    expect(summary.runtime).toBeUndefined();
    expect(summary.verdict.level).toBe('no_data');
    expect(summary.tiles.find((t) => t.key === 'p95Ms')?.value).toBeNull();
    expect(summary.sql).toEqual([]);
  });

  it('omits runtime tiles without the runtime tables', async () => {
    const schema = { tables: FULL_SCHEMA.tables.slice(0, 2) };
    const { service } = setup({ schema });
    expect((await service.summary('u1', {})).runtime).toBeUndefined();
  });
});

describe('timeseries and top', () => {
  it('zero-fills the api panel', async () => {
    const { service } = setup();
    const series = await service.timeseries('u1', { panel: 'api' });
    expect(series.buckets).toHaveLength(60);
    expect(series.buckets[0]).toEqual({ t: '2026-09-27T21:00:00.000Z', s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, p95Ms: null });
    expect(series.buckets.at(-1)).toEqual({ t: '2026-09-27T21:59:00.000Z', s2xx: 50, s3xx: 0, s4xx: 4, s5xx: 6, p95Ms: 2.5 });
    expect(typeof series.sql).toBe('string');
  });

  it('returns the logs panel by severity band', async () => {
    const { service } = setup();
    const series = await service.timeseries('u1', { panel: 'logs' });
    expect(series.buckets.at(-1)).toEqual({ t: '2026-09-27T21:59:00.000Z', error: 5, warn: 1, info: 30, other: 0 });
  });

  it('shapes top routes', async () => {
    const { service } = setup();
    const top = await service.top('u1', { kind: 'routes' });
    expect(top.items[0]).toEqual({
      method: 'POST',
      route: '/api/jobs',
      count: 100,
      errors: 70,
      errorRatePct: 70,
      p95Ms: 900,
    });
    expect(top.truncated).toBe(false);
  });

  it('marks top lists truncated past 10', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ['GET', `/r${i}`, '1', '0', '1']);
    const { service } = setup({ overrides: { topRoutes: result(['method', 'route', 'requests', 'errors', 'p95_ns'], rows) } });
    const top = await service.top('u1', { kind: 'routes' });
    expect(top.items).toHaveLength(10);
    expect(top.truncated).toBe(true);
  });

  it('shapes top errors', async () => {
    const { service } = setup();
    const top = await service.top('u1', { kind: 'errors' });
    expect(top.items).toEqual([
      {
        message: 'ECONNREFUSED',
        count: 40,
        firstSeen: '2026-09-27T21:10:00.000Z',
        lastSeen: '2026-09-27T21:59:00.000Z',
        sampleTraceId: 'abc',
        service: 'my-app-api',
      },
    ]);
  });
});

describe('events', () => {
  const COLUMNS = ['ts', 'severity_number', 'severity_text', 'service', 'body', 'trace_id', 'span_id'];
  const row = (i: number, span = i.toString(16).padStart(4, '0')) => [
    `2026-09-27T21:${String(59 - Math.floor(i / 60)).padStart(2, '0')}:${String(59 - (i % 60)).padStart(2, '0')}.123456789`,
    17,
    'error',
    'my-app-api',
    `boom ${i}`,
    '',
    span,
  ];

  it('defaults to error,warn and returns a cursor when more rows exist', async () => {
    const rows = Array.from({ length: EVENTS_PAGE_SIZE + 1 }, (_, i) => row(i, 'ab'));
    const { service, sqlOf } = setup({ overrides: { events: result(COLUMNS, rows) } });
    const page = await service.events('u1', {});

    const [sql] = sqlOf('events');
    expect(sql).toContain('(severity_number >= 17 OR (severity_number >= 13 AND severity_number < 17))');
    expect(sql).toContain(`LIMIT ${EVENTS_PAGE_SIZE + 1}`);
    expect(page.items).toHaveLength(EVENTS_PAGE_SIZE);
    expect(page.items[0]).toEqual({
      timestamp: '2026-09-27T21:59:59.123456789Z',
      severity: 'error',
      service: 'my-app-api',
      body: 'boom 0',
      traceId: null,
      spanId: 'ab',
    });
    expect(decodeCursor(page.nextCursor as string)).toEqual({ ts: rows[EVENTS_PAGE_SIZE - 1][0], spanId: 'ab' });
  });

  it('has no cursor on the last page', async () => {
    const { service } = setup({ overrides: { events: result(COLUMNS, [row(0)]) } });
    expect((await service.events('u1', {})).nextCursor).toBeNull();
  });

  it('ends a page before rows that share the next page\'s key', async () => {
    const rows = Array.from({ length: EVENTS_PAGE_SIZE + 1 }, (_, i) => row(i));
    // The last two rows of the page and the first of the next share (ts, span_id).
    rows[EVENTS_PAGE_SIZE - 2] = [...rows[EVENTS_PAGE_SIZE]];
    rows[EVENTS_PAGE_SIZE - 1] = [...rows[EVENTS_PAGE_SIZE]];
    const { service } = setup({ overrides: { events: result(COLUMNS, rows) } });

    const page = await service.events('u1', {});
    expect(page.items).toHaveLength(EVENTS_PAGE_SIZE - 2);
    expect(decodeCursor(page.nextCursor as string).spanId).toBe((EVENTS_PAGE_SIZE - 3).toString(16).padStart(4, '0'));
  });

  it('applies the cursor as a keyset condition', async () => {
    const { service, sqlOf } = setup();
    const cursor = encodeCursor({ ts: '2026-09-27T21:30:00.5', spanId: 'ff' });
    await service.events('u1', { cursor, severity: 'info' });
    expect(sqlOf('events')[0]).toContain(
      `("timestamp" < '2026-09-27T21:30:00.5Z' OR ("timestamp" = '2026-09-27T21:30:00.5Z' AND span_id < 'ff'))`,
    );
  });

  it.each([
    "a'; DROP TABLE x; --",
    "' OR 1=1 --",
    '\u0000',
    "x'); DELETE FROM opentelemetry_logs; --",
  ])('sends exactly one guarded statement for q = %j', async (q) => {
    const { service, greptime } = setup();
    await service.events('u1', { q });

    expect(greptime.queryReader).toHaveBeenCalledTimes(1);
    const [sql] = greptime.queryReader.mock.calls[0];
    expect(analyzeStatement(sql).kind).toBe('select');
  });

  it('refuses q over 200 characters at validation', () => {
    expect(telemetryDashboardEventsQuerySchema.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('audit', () => {
  it('writes one telemetry:dashboard row per store read, none for a cache hit', async () => {
    const { service, prisma } = setup();
    await service.top('u1', { kind: 'routes' });
    await service.top('u1', { kind: 'routes' });

    expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: 'u1',
        action: 'telemetry:dashboard',
        targetType: 'telemetry_store',
        targetId: 'public',
        meta: expect.objectContaining({ route: 'top', params: { kind: 'routes' }, statements: 1, truncated: false }),
      },
    });
  });

  it('keeps at most 64 characters of q, no control characters and no cursor value', () => {
    expect(auditParams({ q: `\u0000${'y'.repeat(100)}`, cursor: 'abc', service: 'a\u0000b', range: undefined })).toEqual({
      q: 'y'.repeat(64),
      cursor: true,
      service: 'ab',
    });
  });
});

describe('catalogOf', () => {
  it('needs every required column', () => {
    const partial = { tables: [table('opentelemetry_traces', ['timestamp', 'span_kind'])] };
    expect(catalogOf(partial)).toEqual({
      traces: false,
      tracesHaveInstance: false,
      logs: false,
      heap: false,
      eventLoop: false,
    });
    expect(catalogOf(FULL_SCHEMA)).toEqual({
      traces: true,
      tracesHaveInstance: true,
      logs: true,
      heap: true,
      eventLoop: true,
    });
  });
});
