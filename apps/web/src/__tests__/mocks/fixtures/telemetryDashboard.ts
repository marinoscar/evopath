/**
 * Telemetry Dashboard fixtures — issue #578, epic #576. Shapes follow
 * `packages/platform-api/src/telemetry/dto/telemetry-dashboard.dto.ts` (#577).
 *
 * `dashboardHandlers()` answers all seven endpoints (`/metrics`: #601/#602;
 * `/metric-groups`: #680); a test overrides one with `server.use(...)` after
 * it. Not part of the default handlers (only the dashboard suites need them),
 * except `/metric-groups`, which `mocks/handlers.ts` also answers.
 */
import { http, HttpResponse } from 'msw';
import type {
  DashboardApiTimeseries,
  DashboardEvent,
  DashboardEvents,
  DashboardFilters,
  DashboardLogsTimeseries,
  DashboardMetricGroup,
  DashboardMetricGroupMeta,
  DashboardMetrics,
  DashboardMetricSeries,
  DashboardSummary,
  DashboardTopErrors,
  DashboardTopRoutes,
} from '@marinoscar/platform-web/telemetry/headless';

const API_BASE = '*/api/admin/telemetry/dashboard';

const envelope = (sql: string | string[]) => ({
  range: { from: '2026-09-27T10:00:00.000Z', to: '2026-09-27T11:00:00.000Z', bucketSeconds: 60 },
  generatedAt: '2026-09-27T11:00:00.000Z',
  truncated: false,
  sql,
});

const starts = Array.from({ length: 4 }, (_, i) => new Date(Date.parse('2026-09-27T10:00:00.000Z') + i * 60_000).toISOString());

/**
 * The summary's two unknown-route statements (#650): at the end of the
 * summary's `sql` and, per-route first, on `unknownRoutes.sql`.
 */
export const mockUnknownRoutesTotalsSql =
  'SELECT /* unknown totals */ count(*) AS requests FROM t WHERE "span_attributes.app.route.matched" = false GROUP BY period';
export const mockUnknownRoutesTopSql =
  'SELECT /* unknown top */ method, route FROM t WHERE "span_attributes.app.route.matched" = false GROUP BY method, route';

export const mockDashboardSummary: DashboardSummary = {
  ...envelope(['SELECT 1 /* summary */', 'SELECT 2', mockUnknownRoutesTotalsSql, mockUnknownRoutesTopSql]),
  verdict: {
    level: 'degraded',
    reasons: [
      '5xx rate 3.2% on GET /api/users/:id',
      'p95 latency 1.4 s',
      '3 requests to unknown API routes (GET /api/coach/messages)',
    ],
  },
  tiles: [
    { key: 'requestsPerMin', label: 'Requests / min', value: 12.5, previous: 10, unit: 'req/min', sparkline: [10, null, 12, 14] },
    { key: 'errorRatePct', label: '5xx rate', value: 3.2, previous: 1.6, unit: '%', sparkline: [1, 2, null, 4] },
    { key: 'p95Ms', label: 'p95 latency', value: 1400, previous: 2000, unit: 'ms', sparkline: [900, 1200, 1400, 1500] },
    { key: 'errorLogs', label: 'Error logs', value: '7', previous: '7', unit: 'count', sparkline: [1, 2, 2, 2] },
    { key: 'warnLogs', label: 'Warning logs', value: 3, previous: 0, unit: 'count', sparkline: [0, 1, 1, 1] },
    { key: 'unknownRoutes', label: 'Unknown API routes', value: 15, previous: 10, unit: 'count', sparkline: [] },
    { key: 'lastDataAt', label: 'Last data', value: new Date().toISOString(), previous: null, unit: 'timestamp', sparkline: [] },
  ],
  runtime: [
    { key: 'heapUsedBytes', label: 'Heap used', value: 134217728, previous: 104857600, unit: 'bytes', sparkline: [1, 2, 3, 4] },
  ],
  unknownRoutes: {
    requests: 15,
    bearer: 3,
    anonymous: 12,
    previousRequests: 10,
    previousBearer: 0,
    topRoutes: [
      { method: 'GET', route: '/api/coach/messages', count: 3, bearer: 3, anonymous: 0 },
      { method: 'GET', route: '/api/.env', count: 12, bearer: 0, anonymous: 12 },
    ],
    truncated: false,
    sql: [mockUnknownRoutesTopSql, mockUnknownRoutesTotalsSql],
  },
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
    { method: 'GET', route: '/api/users/:id', count: 120, errors: 4, errorRatePct: 3.33, clientErrors: 6, unknownRequests: 0, unknown: false, p95Ms: 840 },
    { method: 'POST', route: '/api/jobs', count: 40, errors: 0, errorRatePct: 0, clientErrors: 0, unknownRequests: 0, unknown: false, p95Ms: null },
    { method: 'GET', route: '/api/coach/messages', count: 3, errors: 0, errorRatePct: 0, clientErrors: 3, unknownRequests: 3, unknown: true, p95Ms: 2.1 },
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
  hosts: ['vps-1', 'vps-2'],
};

// ---- metrics (#601 / #602) ------------------------------------------------------

const metricEnvelope = (group: DashboardMetricGroup) => ({
  range: { from: '2026-09-27T10:00:00.000Z', to: '2026-09-27T11:00:00.000Z', bucketSeconds: 60 },
  generatedAt: '2026-09-27T11:00:00.000Z',
  truncated: false,
  sql: [`SELECT /* ${group} */ 1`, `SELECT /* ${group} */ 2`],
  group,
});

function metricSeries(
  key: string,
  label: string,
  unit: DashboardMetricSeries['unit'],
  values: (number | null)[],
  split: { dimension: string; groupBy: string } | null = null,
): DashboardMetricSeries {
  return {
    key,
    label: split ? `${label}: ${split.groupBy}` : label,
    unit,
    dimension: split?.dimension ?? null,
    groupBy: split?.groupBy ?? null,
    points: starts.map((t, i) => ({ t, v: values[i] ?? null })),
  };
}

const seen = '2026-09-27T10:59:30.000Z';

/** One response per group; `pipeline` is `available: false` (nothing of it collected). */
export const mockDashboardMetrics: Record<DashboardMetricGroup, DashboardMetrics> = {
  host: {
    ...metricEnvelope('host'),
    available: true,
    tiles: [
      { key: 'cpuUtilization', label: 'CPU utilization', value: 24.1, previous: 19.8, unit: '%', sparkline: [20, 22, null, 24] },
      { key: 'memoryUtilization', label: 'Memory utilization', value: 61.5, previous: 60, unit: '%', sparkline: [60, 61, 61, 62] },
      { key: 'load1m', label: 'Load (1 min)', value: 0.82, previous: 0.5, unit: 'load', sparkline: [0.5, 0.6, 0.7, 0.8] },
      { key: 'filesystemUtilization', label: 'Filesystem utilization', value: 91.2, previous: 90.8, unit: '%', sparkline: [90, 91, 91, 91] },
      { key: 'diskIo', label: 'Disk IO', value: 2048, previous: 1024, unit: 'bytes/s', sparkline: [1, 2, 3, 4] },
    ],
    series: [
      metricSeries('cpuUtilization', 'CPU utilization', '%', [20, 22, null, 24]),
      metricSeries('memoryUtilization', 'Memory utilization', '%', [60, 61, 61, 62]),
      metricSeries('filesystemUtilization', 'Filesystem utilization', '%', [90, 91, 91, 91], { dimension: 'mountpoint', groupBy: '/' }),
    ],
    tables: [
      {
        key: 'filesystems',
        label: 'Filesystems',
        columns: [
          { key: 'key', label: 'Mountpoint', unit: 'text' },
          { key: 'utilizationPct', label: 'Used', unit: '%' },
          { key: 'usedBytes', label: 'Used bytes', unit: 'bytes' },
          { key: 'freeBytes', label: 'Free bytes', unit: 'bytes' },
          { key: 'lastSeenAt', label: 'Last reading', unit: 'timestamp' },
        ],
        rows: [
          { key: '/', utilizationPct: 91.2, usedBytes: 45 * 1024 ** 3, freeBytes: 4.4 * 1024 ** 3, lastSeenAt: seen },
          { key: '/data', utilizationPct: null, usedBytes: null, freeBytes: null, lastSeenAt: seen },
        ],
      },
    ],
    skipped: ['networkIo'],
  },
  database: {
    ...metricEnvelope('database'),
    available: true,
    tiles: [
      { key: 'dbConnectionUtilization', label: 'Connections used', value: 42, previous: 40, unit: '%', sparkline: [40, 41, 42, 42] },
      { key: 'dbSize', label: 'Database size', value: 512 * 1024 ** 2, previous: 500 * 1024 ** 2, unit: 'bytes', sparkline: [] },
      { key: 'dbCommits', label: 'Commits', value: 12.5, previous: 10, unit: 'per_s', sparkline: [10, 11, 12, 13] },
      { key: 'dbCacheHitRatio', label: 'Cache hit ratio', value: 99.1, previous: 99.4, unit: '%', sparkline: [99, 99, 99, 99] },
    ],
    series: [
      metricSeries('dbConnections', 'Connections', 'count', [40, 41, 42, 42]),
      metricSeries('dbConnectionMax', 'Max connections', 'count', [100, 100, 100, 100]),
    ],
    tables: [
      {
        key: 'largestTables',
        label: 'Largest tables',
        columns: [
          { key: 'key', label: 'Table', unit: 'text' },
          { key: 'sizeBytes', label: 'Size', unit: 'bytes' },
          { key: 'lastSeenAt', label: 'Last reading', unit: 'timestamp' },
        ],
        rows: [
          { key: 'jobs', sizeBytes: 300 * 1024 ** 2, lastSeenAt: seen },
          { key: 'users', sizeBytes: 2 * 1024 ** 2, lastSeenAt: seen },
        ],
      },
    ],
    skipped: [],
  },
  queue: {
    ...metricEnvelope('queue'),
    available: true,
    tiles: [
      { key: 'queueDepth.pending', label: 'Queue depth: pending', value: 14, previous: 3, unit: 'count', sparkline: [3, 5, 9, 14] },
      { key: 'queueDepth.running', label: 'Queue depth: running', value: 2, previous: 2, unit: 'count', sparkline: [2, 2, 2, 2] },
      { key: 'oldestPendingAge', label: 'Oldest pending job', value: 900, previous: 30, unit: 'seconds', sparkline: [30, 300, 600, 900] },
      { key: 'jobFailureRatio', label: 'Job failure ratio', value: 12.5, previous: 0, unit: '%', sparkline: [0, 0, 10, 12.5] },
      { key: 'jobDurationP95', label: 'Job duration p95', value: 4.2, previous: 3.9, unit: 'seconds', sparkline: [] },
      { key: 'backupAge', label: 'Last successful backup', value: 30, previous: 6, unit: 'hours', sparkline: [] },
    ],
    series: [
      metricSeries('jobsSettled', 'Jobs settled', 'per_min', [4, 5, 6, 5], { dimension: 'outcome', groupBy: 'succeeded' }),
      metricSeries('jobsSettled', 'Jobs settled', 'per_min', [0, 0, 1, 1], { dimension: 'outcome', groupBy: 'failed' }),
    ],
    tables: [
      {
        key: 'jobTypes',
        label: 'Job types',
        columns: [
          { key: 'key', label: 'Job type', unit: 'text' },
          { key: 'pending', label: 'Pending', unit: 'count' },
          { key: 'running', label: 'Running', unit: 'count' },
          { key: 'oldestPendingSeconds', label: 'Oldest pending', unit: 'seconds' },
          { key: 'succeeded', label: 'Succeeded', unit: 'count' },
          { key: 'failed', label: 'Failed', unit: 'count' },
          { key: 'durationP95Seconds', label: 'Duration p95', unit: 'seconds' },
          { key: 'lastSeenAt', label: 'Last reading', unit: 'timestamp' },
        ],
        rows: [
          { key: 'export.csv', pending: 12, running: 1, oldestPendingSeconds: 900, succeeded: 40, failed: 6, durationP95Seconds: 4.2, lastSeenAt: seen },
          { key: 'db.backup', pending: 2, running: 1, oldestPendingSeconds: 45, succeeded: 1, failed: 0, durationP95Seconds: null, lastSeenAt: seen },
        ],
      },
    ],
    skipped: [],
  },
  nodes: {
    ...metricEnvelope('nodes'),
    available: true,
    tiles: [
      { key: 'nodesByHealth.healthy', label: 'Worker nodes: healthy', value: 2, previous: 3, unit: 'count', sparkline: [3, 3, 2, 2] },
      { key: 'nodesByHealth.stale', label: 'Worker nodes: stale', value: 1, previous: 0, unit: 'count', sparkline: [0, 0, 1, 1] },
      { key: 'nodesByHealth.offline', label: 'Worker nodes: offline', value: 0, previous: 0, unit: 'count', sparkline: [0, 0, 0, 0] },
      { key: 'noEligibleNode', label: 'Job types without an eligible node', value: 1, previous: 0, unit: 'count', sparkline: [0, 0, 1, 1] },
    ],
    series: [],
    tables: [
      {
        key: 'nodes',
        label: 'Nodes',
        columns: [
          { key: 'key', label: 'Node', unit: 'text' },
          { key: 'cpuCores', label: 'CPU', unit: 'cores' },
          { key: 'rssBytes', label: 'RSS', unit: 'bytes' },
          { key: 'heapUsedBytes', label: 'Heap used', unit: 'bytes' },
          { key: 'heapLimitBytes', label: 'Heap limit', unit: 'bytes' },
          { key: 'stateDirFreeBytes', label: 'Disk free', unit: 'bytes' },
          { key: 'stateDirTotalBytes', label: 'Disk size', unit: 'bytes' },
          { key: 'slotsUsed', label: 'Slots used', unit: 'count' },
          { key: 'slotsTotal', label: 'Slots', unit: 'count' },
          { key: 'heapPct', label: 'Heap used', unit: '%' },
          { key: 'stateDirFreePct', label: 'Disk free', unit: '%' },
          { key: 'lastSeenAt', label: 'Last reading', unit: 'timestamp' },
        ],
        rows: [
          {
            key: 'worker-a',
            cpuCores: 0.35,
            rssBytes: 256 * 1024 ** 2,
            heapUsedBytes: 90 * 1024 ** 2,
            heapLimitBytes: 100 * 1024 ** 2,
            stateDirFreeBytes: 5 * 1024 ** 3,
            stateDirTotalBytes: 20 * 1024 ** 3,
            slotsUsed: 2,
            slotsTotal: 4,
            heapPct: 90,
            stateDirFreePct: 25,
            lastSeenAt: seen,
          },
        ],
      },
      {
        key: 'noEligibleNodeTypes',
        label: 'Node-offered job types',
        columns: [
          { key: 'key', label: 'Job type', unit: 'text' },
          { key: 'noEligibleNode', label: 'No eligible node', unit: 'boolean' },
          { key: 'lastSeenAt', label: 'Last reading', unit: 'timestamp' },
        ],
        rows: [
          { key: 'export.csv', noEligibleNode: false, lastSeenAt: seen },
          { key: 'media.transcode', noEligibleNode: true, lastSeenAt: seen },
        ],
      },
    ],
    skipped: [],
  },
  uptime: {
    ...metricEnvelope('uptime'),
    available: true,
    tiles: [
      { key: 'nginxConnections.active', label: 'nginx connections: active', value: 7, previous: 5, unit: 'count', sparkline: [5, 6, 7, 7] },
      { key: 'nginxRequests', label: 'nginx requests', value: 3.4, previous: 3, unit: 'per_s', sparkline: [3, 3, 3, 3] },
      { key: 'tlsDaysLeft', label: 'TLS certificate days left', value: 12, previous: 13, unit: 'days', sparkline: [] },
      { key: 'httpDuration', label: 'Check duration', value: 48, previous: 40, unit: 'ms', sparkline: [40, 44, 48, 48] },
    ],
    series: [
      metricSeries('nginxConnections', 'nginx connections', 'count', [5, 6, 7, 7], { dimension: 'state', groupBy: 'active' }),
      metricSeries('nginxConnections', 'nginx connections', 'count', [1, 1, 2, 2], { dimension: 'state', groupBy: 'waiting' }),
    ],
    tables: [
      {
        key: 'uptimeTargets',
        label: 'Uptime targets',
        columns: [
          { key: 'key', label: 'URL', unit: 'text' },
          { key: 'durationMs', label: 'Duration', unit: 'ms' },
          { key: 'tlsDaysLeft', label: 'TLS days left', unit: 'days' },
          { key: 'up', label: 'Up', unit: 'boolean' },
          { key: 'statusCode', label: 'Status', unit: 'text' },
          { key: 'checks', label: 'Checks', unit: 'count' },
          { key: 'failedChecks', label: 'Failed checks', unit: 'count' },
          { key: 'lastError', label: 'Last error', unit: 'text' },
          { key: 'lastSeenAt', label: 'Last reading', unit: 'timestamp' },
        ],
        rows: [
          { key: 'http://nginx/', durationMs: 12, tlsDaysLeft: null, up: true, statusCode: '200', checks: 60, failedChecks: 0, lastError: null, lastSeenAt: seen },
          { key: 'https://app.example.com/', durationMs: 84, tlsDaysLeft: 12, up: false, statusCode: '503', checks: 60, failedChecks: 3, lastError: 'connection refused', lastSeenAt: seen },
        ],
      },
    ],
    skipped: [],
  },
  pipeline: {
    ...metricEnvelope('pipeline'),
    sql: [],
    available: false,
    tiles: [],
    series: [],
    tables: [],
    skipped: ['exporterSent', 'exporterFailed', 'scrapeTargets'],
  },
};

/**
 * `GET …/metric-groups` (#680): the API's six platform groups, with their API
 * labels and the section titles the page has always shown, in order.
 */
export const mockDashboardMetricGroups: DashboardMetricGroupMeta[] = [
  { id: 'host', label: 'Host', title: 'Infrastructure', order: 10 },
  { id: 'database', label: 'Database', title: 'Database', order: 20 },
  { id: 'queue', label: 'Job queue', title: 'Job queue', order: 30 },
  { id: 'nodes', label: 'Worker nodes', title: 'Worker nodes', order: 40 },
  { id: 'uptime', label: 'Uptime and edge', title: 'Uptime & dependencies', order: 50 },
  { id: 'pipeline', label: 'Telemetry pipeline', title: 'Telemetry pipeline', order: 60 },
];

export function dashboardHandlers() {
  return [
    http.get(`${API_BASE}/metric-groups`, () => HttpResponse.json({ data: mockDashboardMetricGroups })),
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
    http.get(`${API_BASE}/metrics`, ({ request }) => {
      const group = new URL(request.url).searchParams.get('group') as DashboardMetricGroup;
      return HttpResponse.json({ data: mockDashboardMetrics[group] ?? mockDashboardMetrics.host });
    }),
  ];
}
