import type { Page, Route } from '@playwright/test';

/**
 * Fixture API for the Telemetry Dashboard visual spec — issue #579, epic #576.
 *
 * The harness (`apps/web/visual/main.tsx`) has no API behind it; every other
 * spec screenshots surfaces whose `/api` fetches are allowed to fail. The
 * dashboard IS its data, so this answers the calls it makes with Playwright's
 * `page.route()`: the two feature flags (`/api/telemetry/config`,
 * `/api/ai/config`) and the five #577 dashboard endpoints. Anything else falls
 * through to the harness's Vite server exactly as before (`route.fallback()`).
 *
 * Every value is a pure function of the request and {@link FIXED_NOW}, and the
 * spec pins `Date.now()` to that instant (`page.clock.setFixedTime`), so each
 * run renders the same bars, tiles, relative times ("3m ago") and axis ticks.
 * Shapes follow `apps/web/src/services/telemetryDashboard.ts`.
 */

export const FIXED_NOW = Date.parse('2026-09-27T11:00:00.000Z');

export type DashboardScenario = 'critical' | 'no_data';

const HOUR_MS = 60 * 60_000;

/** A deterministic wobble in [-1, 1] — no randomness anywhere in a baseline. */
const wave = (i: number, period: number) => Math.sin((i / period) * Math.PI * 2);

function windowOf(url: URL) {
  const buckets = url.searchParams.get('buckets') === '30' ? 30 : 60;
  const to = FIXED_NOW;
  const from = to - HOUR_MS;
  const bucketSeconds = HOUR_MS / 1000 / buckets;
  const starts = Array.from({ length: buckets }, (_, i) => new Date(from + i * bucketSeconds * 1000).toISOString());
  return {
    buckets,
    starts,
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucketSeconds },
  };
}

const envelope = (url: URL, sql: string | string[]) => ({
  range: windowOf(url).range,
  generatedAt: new Date(FIXED_NOW).toISOString(),
  truncated: false,
  sql,
});

/** Bucket `i` of `n` as a fraction of the hour — so 30 and 60 buckets tell one story. */
const at = (i: number, n: number) => i / n;
/** The incident: 5xx and error logs spike over the last quarter of the hour. */
const incident = (x: number) => (x >= 0.72 && x < 0.9 ? 1 : 0);

function apiBuckets(url: URL, scenario: DashboardScenario) {
  if (scenario === 'no_data') return [];
  const { starts, buckets } = windowOf(url);
  const scale = 60 / buckets;
  return starts.map((t, i) => {
    const x = at(i, buckets);
    // A phone asks for 30 buckets: each covers twice the time, so twice the count.
    const s2xx = Math.round((180 + 40 * wave(i * scale, 23)) * scale);
    const s5xx = Math.round((incident(x) * (26 + 8 * wave(i * scale, 5)) + (i % 11 === 0 ? 1 : 0)) * scale);
    return {
      t,
      s2xx,
      s3xx: Math.round(6 * scale),
      s4xx: Math.round((9 + 4 * wave(i * scale, 7)) * scale),
      s5xx,
      p95Ms: Math.round(180 + 60 * wave(i * scale, 17) + incident(x) * 2200),
    };
  });
}

function logBuckets(url: URL, scenario: DashboardScenario) {
  if (scenario === 'no_data') return [];
  const { starts, buckets } = windowOf(url);
  const scale = 60 / buckets;
  return starts.map((t, i) => {
    const x = at(i, buckets);
    return {
      t,
      error: Math.round((incident(x) * (5 + 2 * wave(i * scale, 4)) + (i % 17 === 0 ? 1 : 0)) * scale),
      warn: Math.round((2 + 2 * wave(i * scale, 9) + incident(x) * 4) * scale),
      info: Math.round((30 + 8 * wave(i * scale, 13)) * scale),
      other: 0,
    };
  });
}

function spark(n: number, fn: (i: number) => number | null) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

function summary(url: URL, scenario: DashboardScenario) {
  const n = windowOf(url).buckets;
  if (scenario === 'no_data') {
    return {
      ...envelope(url, ['SELECT /* api totals */ 1', 'SELECT /* log totals */ 1']),
      verdict: {
        level: 'no_data',
        reasons: ['No traces or logs have arrived in the last 15 minutes. Check that telemetry collection is running.'],
      },
      tiles: [
        { key: 'requestsPerMin', label: 'Requests / min', value: null, previous: null, unit: 'req/min', sparkline: [] },
        { key: 'errorRatePct', label: '5xx rate', value: null, previous: null, unit: '%', sparkline: [] },
        { key: 'p95Ms', label: 'p95 latency', value: null, previous: null, unit: 'ms', sparkline: [] },
        { key: 'errorLogs', label: 'Error logs', value: 0, previous: 0, unit: 'count', sparkline: [] },
        { key: 'warnLogs', label: 'Warning logs', value: 0, previous: 0, unit: 'count', sparkline: [] },
        { key: 'lastDataAt', label: 'Last data', value: null, previous: null, unit: 'timestamp', sparkline: [] },
      ],
    };
  }
  return {
    ...envelope(url, [
      "SELECT count(*) AS requests FROM opentelemetry_traces WHERE span_kind = 'SPAN_KIND_SERVER'",
      'SELECT count(*) FROM opentelemetry_logs',
    ]),
    verdict: {
      level: 'critical',
      reasons: [
        '5xx rate 14.2% on POST /api/jobs (critical above 5%)',
        'p95 latency 2.4 s on GET /api/reports/:id',
        '38 error logs, up from 4 in the previous window',
      ],
    },
    tiles: [
      { key: 'requestsPerMin', label: 'Requests / min', value: 214.6, previous: 198.2, unit: 'req/min', sparkline: spark(n, (i) => 200 + 30 * wave(i, 11)) },
      { key: 'errorRatePct', label: '5xx rate', value: 4.87, previous: 0.41, unit: '%', sparkline: spark(n, (i) => (incident(at(i, n)) ? 12 + 3 * wave(i, 4) : 0.3)) },
      { key: 'p95Ms', label: 'p95 latency', value: 1840, previous: 212, unit: 'ms', sparkline: spark(n, (i) => 200 + incident(at(i, n)) * 2200) },
      { key: 'errorLogs', label: 'Error logs', value: 38, previous: 4, unit: 'count', sparkline: spark(n, (i) => incident(at(i, n)) * 5) },
      { key: 'warnLogs', label: 'Warning logs', value: 112, previous: 96, unit: 'count', sparkline: spark(n, (i) => 2 + 2 * wave(i, 9)) },
      { key: 'lastDataAt', label: 'Last data', value: new Date(FIXED_NOW - 12_000).toISOString(), previous: null, unit: 'timestamp', sparkline: [] },
    ],
    runtime: [
      { key: 'heapUsedBytes', label: 'Heap used', value: 187_695_104, previous: 162_529_280, unit: 'bytes', sparkline: spark(n, (i) => 160 + i) },
      { key: 'eventLoopDelayP99Ms', label: 'Event-loop delay p99', value: 41.3, previous: 12.1, unit: 'ms', sparkline: spark(n, (i) => 12 + incident(at(i, n)) * 30) },
    ],
  };
}

const TRACE_IDS = [
  '4bf92f3577b34da6a3ce929d0e0e4736',
  '0af7651916cd43dd8448eb211c80319c',
  '5b8efff798038103d269b633813fc60c',
];

function topRoutes(scenario: DashboardScenario) {
  if (scenario === 'no_data') return [];
  return [
    { method: 'POST', route: '/api/jobs', count: 1842, errors: 262, errorRatePct: 14.22, p95Ms: 912 },
    { method: 'GET', route: '/api/reports/:id', count: 611, errors: 31, errorRatePct: 5.07, p95Ms: 2410 },
    { method: 'GET', route: '/api/users/:id', count: 4210, errors: 12, errorRatePct: 0.29, p95Ms: 84 },
    { method: 'PUT', route: '/api/admin/telemetry/config', count: 14, errors: 1, errorRatePct: 7.14, p95Ms: 133 },
    { method: 'GET', route: '/api/notifications', count: 2980, errors: 0, errorRatePct: 0, p95Ms: 41 },
    { method: 'POST', route: '/api/auth/refresh', count: 1204, errors: 0, errorRatePct: 0, p95Ms: 18.4 },
  ];
}

function topErrors(scenario: DashboardScenario) {
  if (scenario === 'no_data') return [];
  const iso = (minutesAgo: number) => new Date(FIXED_NOW - minutesAgo * 60_000).toISOString();
  return [
    { message: 'Database connection refused: connect ECONNREFUSED 10.0.3.14:5432', count: 21, firstSeen: iso(16), lastSeen: iso(1), sampleTraceId: TRACE_IDS[0], service: 'my-app-api' },
    { message: 'Job export.csv failed: upload to object storage timed out after 30000 ms', count: 9, firstSeen: iso(15), lastSeen: iso(3), sampleTraceId: TRACE_IDS[1], service: 'my-app-worker' },
    { message: 'Report rendering exceeded its time budget', count: 5, firstSeen: iso(44), lastSeen: iso(7), sampleTraceId: null, service: 'my-app-api' },
    { message: 'Unhandled promise rejection in notification dispatch', count: 3, firstSeen: iso(52), lastSeen: iso(21), sampleTraceId: TRACE_IDS[2], service: 'my-app-api' },
  ];
}

function events(scenario: DashboardScenario) {
  if (scenario === 'no_data') return [];
  const rows: [number, string, string, string, string | null][] = [
    [8, 'error', 'my-app-api', 'Database connection refused: connect ECONNREFUSED 10.0.3.14:5432', TRACE_IDS[0]],
    [41, 'warn', 'my-app-api', 'Slow query on jobs (1,204 ms): SELECT … FROM jobs WHERE status = $1', TRACE_IDS[0]],
    [95, 'error', 'my-app-worker', 'Job export.csv failed: upload to object storage timed out after 30000 ms', TRACE_IDS[1]],
    [130, 'warn', 'my-app-worker', 'Retrying job 8812 (attempt 2 of 3)', null],
    [188, 'error', 'my-app-api', 'Report rendering exceeded its time budget', null],
    [260, 'warn', 'my-app-api', 'Connection pool at 92% of its limit', null],
    [402, 'error', 'my-app-api', 'Unhandled promise rejection in notification dispatch', TRACE_IDS[2]],
    [640, 'warn', 'my-app-api', 'Rate limit reached for client 203.0.113.7', null],
  ];
  return rows.map(([secondsAgo, severity, service, body, traceId], i) => ({
    timestamp: new Date(FIXED_NOW - secondsAgo * 1000).toISOString(),
    severity,
    service,
    body,
    traceId,
    spanId: traceId ? `${(i + 1).toString(16).padStart(16, '0')}` : null,
  }));
}

function answer(route: Route, data: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
}

/** Answer the dashboard's API with `scenario`. Call before `page.goto()`. */
export async function mockTelemetryDashboard(page: Page, scenario: DashboardScenario): Promise<void> {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    switch (path) {
      case '/telemetry/config':
        return answer(route, { available: true, enabled: true, assistantEnabled: true });
      case '/ai/config':
        return answer(route, {
          enabled: true,
          keyPolicy: 'org_only',
          allowBackgroundRuns: false,
          providers: [{ id: 'openai', displayName: 'OpenAI', enabled: true, hasOrgKey: true, supportsPreviousResponseId: true }],
        });
      case '/admin/telemetry/dashboard/summary':
        return answer(route, summary(url, scenario));
      case '/admin/telemetry/dashboard/timeseries': {
        const panel = url.searchParams.get('panel') === 'logs' ? 'logs' : 'api';
        return answer(route, {
          ...envelope(url, `SELECT /* ${panel} timeseries */ 1`),
          panel,
          buckets: panel === 'logs' ? logBuckets(url, scenario) : apiBuckets(url, scenario),
        });
      }
      case '/admin/telemetry/dashboard/top': {
        const kind = url.searchParams.get('kind') === 'errors' ? 'errors' : 'routes';
        return answer(route, {
          ...envelope(url, `SELECT /* top ${kind} */ 1`),
          kind,
          items: kind === 'errors' ? topErrors(scenario) : topRoutes(scenario),
        });
      }
      case '/admin/telemetry/dashboard/events': {
        const items = events(scenario);
        return answer(route, {
          ...envelope(url, 'SELECT /* events */ 1'),
          items,
          nextCursor: items.length > 0 ? 'next-page' : null,
        });
      }
      case '/admin/telemetry/dashboard/filters':
        return answer(route, {
          ...envelope(url, ['SELECT /* services */ 1', 'SELECT /* instances */ 1']),
          services: scenario === 'no_data' ? [] : ['my-app-api', 'my-app-worker'],
          instances: scenario === 'no_data' ? [] : ['api-1', 'worker-1'],
        });
      default:
        return route.fallback();
    }
  });
}
