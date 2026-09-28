/**
 * Telemetry Dashboard fixtures — issue #578, epic #576. Shapes follow
 * `apps/api/src/telemetry/dto/telemetry-dashboard.dto.ts` (#577).
 *
 * `dashboardHandlers()` answers all five endpoints; a test overrides one with
 * `server.use(...)` after it. Not part of the default handlers: only the
 * dashboard suites need them.
 */
import { http, HttpResponse } from 'msw';
import type {
  DashboardApiTimeseries,
  DashboardEvent,
  DashboardEvents,
  DashboardFilters,
  DashboardLogsTimeseries,
  DashboardSummary,
  DashboardTopErrors,
  DashboardTopRoutes,
} from '../../../services/telemetryDashboard';

const API_BASE = '*/api/admin/telemetry/dashboard';

const envelope = (sql: string | string[]) => ({
  range: { from: '2026-09-27T10:00:00.000Z', to: '2026-09-27T11:00:00.000Z', bucketSeconds: 60 },
  generatedAt: '2026-09-27T11:00:00.000Z',
  truncated: false,
  sql,
});

const starts = Array.from({ length: 4 }, (_, i) => new Date(Date.parse('2026-09-27T10:00:00.000Z') + i * 60_000).toISOString());

export const mockDashboardSummary: DashboardSummary = {
  ...envelope(['SELECT 1 /* summary */', 'SELECT 2']),
  verdict: { level: 'degraded', reasons: ['5xx rate 3.2% on GET /api/users/:id', 'p95 latency 1.4 s'] },
  tiles: [
    { key: 'requestsPerMin', label: 'Requests / min', value: 12.5, previous: 10, unit: 'req/min', sparkline: [10, null, 12, 14] },
    { key: 'errorRatePct', label: '5xx rate', value: 3.2, previous: 1.6, unit: '%', sparkline: [1, 2, null, 4] },
    { key: 'p95Ms', label: 'p95 latency', value: 1400, previous: 2000, unit: 'ms', sparkline: [900, 1200, 1400, 1500] },
    { key: 'errorLogs', label: 'Error logs', value: '7', previous: '7', unit: 'count', sparkline: [1, 2, 2, 2] },
    { key: 'warnLogs', label: 'Warning logs', value: 3, previous: 0, unit: 'count', sparkline: [0, 1, 1, 1] },
    { key: 'lastDataAt', label: 'Last data', value: new Date().toISOString(), previous: null, unit: 'timestamp', sparkline: [] },
  ],
  runtime: [
    { key: 'heapUsedBytes', label: 'Heap used', value: 134217728, previous: 104857600, unit: 'bytes', sparkline: [1, 2, 3, 4] },
  ],
};

export const mockDashboardApiSeries: DashboardApiTimeseries = {
  ...envelope('SELECT /* api */ 1'),
  panel: 'api',
  buckets: starts.map((t, i) => ({ t, s2xx: 10 + i, s3xx: 1, s4xx: 2, s5xx: i, p95Ms: i === 1 ? null : 120 * (i + 1) })),
};

export const mockDashboardLogsSeries: DashboardLogsTimeseries = {
  ...envelope('SELECT /* logs */ 1'),
  panel: 'logs',
  buckets: starts.map((t, i) => ({ t, error: i, warn: 1, info: 5, other: 0 })),
};

export const mockDashboardTopRoutes: DashboardTopRoutes = {
  ...envelope('SELECT /* routes */ 1'),
  kind: 'routes',
  items: [
    { method: 'GET', route: '/api/users/:id', count: 120, errors: 4, errorRatePct: 3.33, p95Ms: 840 },
    { method: 'POST', route: '/api/jobs', count: 40, errors: 0, errorRatePct: 0, p95Ms: null },
  ],
};

export const mockDashboardTopErrors: DashboardTopErrors = {
  ...envelope('SELECT /* errors */ 1'),
  kind: 'errors',
  items: [
    {
      message: 'Database connection refused',
      count: 9,
      firstSeen: '2026-09-27T10:01:00.000Z',
      lastSeen: '2026-09-27T10:58:00.000Z',
      sampleTraceId: 'abc123',
      service: 'my-app-api',
    },
  ],
};

export function mockDashboardEvent(index: number, overrides: Partial<DashboardEvent> = {}): DashboardEvent {
  return {
    timestamp: new Date(Date.parse('2026-09-27T10:59:00.000Z') - index * 1000).toISOString(),
    severity: index % 2 === 0 ? 'error' : 'warn',
    service: 'my-app-api',
    body: `Event number ${index}`,
    traceId: `trace-${index}`,
    spanId: `span-${index}`,
    ...overrides,
  };
}

export const mockDashboardEventsPage1: DashboardEvents = {
  ...envelope('SELECT /* events */ 1'),
  items: [mockDashboardEvent(0), mockDashboardEvent(1)],
  nextCursor: 'cursor-2',
};

export const mockDashboardEventsPage2: DashboardEvents = {
  ...envelope('SELECT /* events */ 2'),
  items: [mockDashboardEvent(2)],
  nextCursor: null,
};

export const mockDashboardFilters: DashboardFilters = {
  ...envelope(['SELECT /* services */ 1', 'SELECT /* instances */ 2']),
  services: ['my-app-api', 'my-app-worker'],
  instances: ['node-1', 'node-2'],
};

export function dashboardHandlers() {
  return [
    http.get(`${API_BASE}/summary`, () => HttpResponse.json({ data: mockDashboardSummary })),
    http.get(`${API_BASE}/timeseries`, ({ request }) => {
      const panel = new URL(request.url).searchParams.get('panel');
      return HttpResponse.json({ data: panel === 'logs' ? mockDashboardLogsSeries : mockDashboardApiSeries });
    }),
    http.get(`${API_BASE}/top`, ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind');
      return HttpResponse.json({ data: kind === 'errors' ? mockDashboardTopErrors : mockDashboardTopRoutes });
    }),
    http.get(`${API_BASE}/events`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      return HttpResponse.json({ data: cursor ? mockDashboardEventsPage2 : mockDashboardEventsPage1 });
    }),
    http.get(`${API_BASE}/filters`, () => HttpResponse.json({ data: mockDashboardFilters })),
  ];
}
