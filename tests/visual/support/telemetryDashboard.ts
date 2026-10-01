import type { Page, Route } from '@playwright/test';

/**
 * Fixture API for the Telemetry Dashboard visual spec — issue #579, epic #576.
 *
 * The harness (`apps/web/visual/main.tsx`) has no API behind it; every other
 * spec screenshots surfaces whose `/api` fetches are allowed to fail. The
 * dashboard IS its data, so this answers the calls it makes with Playwright's
 * `page.route()`: the two feature flags (`/api/telemetry/config`,
 * `/api/ai/config`), the five #577 dashboard endpoints and `/metrics` (#126,
 * the six infrastructure sections of #127: every group available in the
 * `critical` scenario, none in `no_data`). Anything else falls
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

const UNKNOWN_TOTALS_SQL =
  'SELECT count(*) AS requests FROM opentelemetry_traces WHERE "span_attributes.app.route.matched" = false GROUP BY period';
const UNKNOWN_TOP_SQL =
  'SELECT method, route FROM opentelemetry_traces WHERE "span_attributes.app.route.matched" = false GROUP BY method, route';

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
        // #258: unknown, not zero — the store has no unknown-route column yet (no `unknownRoutes` block).
        { key: 'unknownRoutes', label: 'Unknown API routes', value: null, previous: null, unit: 'count', sparkline: [] },
        { key: 'lastDataAt', label: 'Last data', value: null, previous: null, unit: 'timestamp', sparkline: [] },
      ],
    };
  }
  return {
    ...envelope(url, [
      "SELECT count(*) AS requests FROM opentelemetry_traces WHERE span_kind = 'SPAN_KIND_SERVER'",
      'SELECT count(*) FROM opentelemetry_logs',
      // #258: the unknown-route statements, also on `unknownRoutes.sql` (per-route first).
      UNKNOWN_TOTALS_SQL,
      UNKNOWN_TOP_SQL,
    ]),
    verdict: {
      level: 'critical',
      reasons: [
        '5xx rate 14.2% on POST /api/jobs (critical above 5%)',
        'p95 latency 2.4 s on GET /api/reports/:id',
        '38 error logs, up from 4 in the previous window',
        'Disk 91.2% full (≥ 85%) — mountpoint: /',
        '7 requests to unknown API routes (GET /api/coach/messages)',
      ],
    },
    tiles: [
      { key: 'requestsPerMin', label: 'Requests / min', value: 214.6, previous: 198.2, unit: 'req/min', sparkline: spark(n, (i) => 200 + 30 * wave(i, 11)) },
      { key: 'errorRatePct', label: '5xx rate', value: 4.87, previous: 0.41, unit: '%', sparkline: spark(n, (i) => (incident(at(i, n)) ? 12 + 3 * wave(i, 4) : 0.3)) },
      { key: 'p95Ms', label: 'p95 latency', value: 1840, previous: 212, unit: 'ms', sparkline: spark(n, (i) => 200 + incident(at(i, n)) * 2200) },
      { key: 'errorLogs', label: 'Error logs', value: 38, previous: 4, unit: 'count', sparkline: spark(n, (i) => incident(at(i, n)) * 5) },
      { key: 'warnLogs', label: 'Warning logs', value: 112, previous: 96, unit: 'count', sparkline: spark(n, (i) => 2 + 2 * wave(i, 9)) },
      { key: 'unknownRoutes', label: 'Unknown API routes', value: 31, previous: 22, unit: 'count', sparkline: [] },
      { key: 'lastDataAt', label: 'Last data', value: new Date(FIXED_NOW - 12_000).toISOString(), previous: null, unit: 'timestamp', sparkline: [] },
    ],
    runtime: [
      { key: 'heapUsedBytes', label: 'Heap used', value: 187_695_104, previous: 162_529_280, unit: 'bytes', sparkline: spark(n, (i) => 160 + i) },
      { key: 'eventLoopDelayP99Ms', label: 'Event-loop delay p99', value: 41.3, previous: 12.1, unit: 'ms', sparkline: spark(n, (i) => 12 + incident(at(i, n)) * 30) },
    ],
    // #258: a web build calling a route its API lacks, plus anonymous scanner noise.
    unknownRoutes: {
      requests: 31,
      bearer: 7,
      anonymous: 24,
      previousRequests: 22,
      previousBearer: 0,
      topRoutes: [
        { method: 'GET', route: '/api/coach/messages', count: 7, bearer: 7, anonymous: 0 },
        { method: 'GET', route: '/api/.env', count: 14, bearer: 0, anonymous: 14 },
        { method: 'POST', route: '/api/wp-login.php', count: 10, bearer: 0, anonymous: 10 },
      ],
      truncated: false,
      sql: [UNKNOWN_TOP_SQL, UNKNOWN_TOTALS_SQL],
    },
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
    { method: 'POST', route: '/api/jobs', count: 1842, errors: 262, errorRatePct: 14.22, clientErrors: 18, unknownRequests: 0, unknown: false, p95Ms: 912 },
    { method: 'GET', route: '/api/reports/:id', count: 611, errors: 31, errorRatePct: 5.07, clientErrors: 4, unknownRequests: 0, unknown: false, p95Ms: 2410 },
    { method: 'GET', route: '/api/users/:id', count: 4210, errors: 12, errorRatePct: 0.29, clientErrors: 37, unknownRequests: 0, unknown: false, p95Ms: 84 },
    { method: 'PUT', route: '/api/admin/telemetry/config', count: 14, errors: 1, errorRatePct: 7.14, clientErrors: 0, unknownRequests: 0, unknown: false, p95Ms: 133 },
    { method: 'GET', route: '/api/coach/messages', count: 7, errors: 0, errorRatePct: 0, clientErrors: 7, unknownRequests: 7, unknown: true, p95Ms: 2.4 },
    { method: 'GET', route: '/api/notifications', count: 2980, errors: 0, errorRatePct: 0, clientErrors: 0, unknownRequests: 0, unknown: false, p95Ms: 41 },
    { method: 'POST', route: '/api/auth/refresh', count: 1204, errors: 0, errorRatePct: 0, clientErrors: 0, unknownRequests: 0, unknown: false, p95Ms: 18.4 },
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

// ---- metrics (#126 / #127) ------------------------------------------------------

type Unit = string;

function metricSeries(
  url: URL,
  key: string,
  label: string,
  unit: Unit,
  fn: (i: number, n: number) => number | null,
  split: { dimension: string; groupBy: string } | null = null,
) {
  const { starts, buckets } = windowOf(url);
  return {
    key,
    label: split ? `${label}: ${split.groupBy}` : label,
    unit,
    dimension: split?.dimension ?? null,
    groupBy: split?.groupBy ?? null,
    points: starts.map((t, i) => {
      const v = fn(i, buckets);
      return { t, v: v === null ? null : Math.round(v * 100) / 100 };
    }),
  };
}

function metricTile(key: string, label: string, value: number | null, previous: number | null, unit: Unit, n: number, fn?: (i: number) => number) {
  return { key, label, value, previous, unit, sparkline: fn ? spark(n, (i) => Math.round(fn(i) * 100) / 100) : [] };
}

const lastSeen = (secondsAgo: number) => new Date(FIXED_NOW - secondsAgo * 1000).toISOString();
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function metrics(url: URL, scenario: DashboardScenario) {
  const group = url.searchParams.get('group') ?? 'host';
  const n = windowOf(url).buckets;
  const base = {
    range: windowOf(url).range,
    generatedAt: new Date(FIXED_NOW).toISOString(),
    truncated: false,
    group,
  };
  if (scenario === 'no_data') {
    return { ...base, sql: [], available: false, tiles: [], series: [], tables: [], skipped: [] };
  }
  const sql = [`SELECT /* ${group} metrics */ 1`, `SELECT /* ${group} metrics */ 2`];
  const x = (i: number) => at(i, n);
  switch (group) {
    case 'host':
      return {
        ...base,
        sql,
        available: true,
        tiles: [
          metricTile('cpuUtilization', 'CPU utilization', 38.4, 21.7, '%', n, (i) => 22 + incident(x(i)) * 30 + 4 * wave(i, 9)),
          metricTile('memoryUtilization', 'Memory utilization', 71.2, 68.9, '%', n, (i) => 69 + 2 * wave(i, 17)),
          metricTile('load1m', 'Load (1 min)', 1.84, 0.92, 'load', n, (i) => 1 + incident(x(i)) + 0.2 * wave(i, 7)),
          metricTile('filesystemUtilization', 'Filesystem utilization', 91.2, 90.6, '%', n, (i) => 90.6 + (0.6 * i) / n),
        ],
        series: [
          metricSeries(url, 'cpuUtilization', 'CPU utilization', '%', (i) => 22 + incident(x(i)) * 30 + 4 * wave(i, 9)),
          metricSeries(url, 'memoryUtilization', 'Memory utilization', '%', (i) => 69 + 2 * wave(i, 17)),
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
              { key: '/', utilizationPct: 91.2, usedBytes: 73 * GB, freeBytes: 7 * GB, lastSeenAt: lastSeen(20) },
              { key: '/boot', utilizationPct: 34.5, usedBytes: 0.33 * GB, freeBytes: 0.63 * GB, lastSeenAt: lastSeen(20) },
              { key: '/var/lib/docker', utilizationPct: 62.8, usedBytes: 125 * GB, freeBytes: 74 * GB, lastSeenAt: lastSeen(20) },
            ],
          },
        ],
        skipped: [],
      };
    case 'database':
      return {
        ...base,
        sql,
        available: true,
        tiles: [
          metricTile('dbConnectionUtilization', 'Connections used', 46, 31, '%', n, (i) => 31 + incident(x(i)) * 20),
          metricTile('dbSize', 'Database size', 1.42 * GB, 1.41 * GB, 'bytes', n, (i) => 1.41 + i / n / 100),
          metricTile('dbCommits', 'Commits', 84.3, 79.1, 'per_s', n, (i) => 80 + 6 * wave(i, 11)),
          metricTile('dbCacheHitRatio', 'Cache hit ratio', 99.2, 99.6, '%', n, (i) => 99.4 - incident(x(i)) * 0.5),
        ],
        series: [
          metricSeries(url, 'dbConnections', 'Connections', 'count', (i) => Math.round(31 + incident(x(i)) * 20 + 3 * wave(i, 7))),
          metricSeries(url, 'dbConnectionMax', 'Max connections', 'count', () => 100),
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
              { key: 'jobs', sizeBytes: 612 * MB, lastSeenAt: lastSeen(40) },
              { key: 'ai_usage_events', sizeBytes: 288 * MB, lastSeenAt: lastSeen(40) },
              { key: 'notifications', sizeBytes: 141 * MB, lastSeenAt: lastSeen(40) },
              { key: 'audit_logs', sizeBytes: 97 * MB, lastSeenAt: lastSeen(40) },
              { key: 'users', sizeBytes: 4.2 * MB, lastSeenAt: lastSeen(40) },
            ],
          },
        ],
        skipped: [],
      };
    case 'queue':
      return {
        ...base,
        sql,
        available: true,
        tiles: [
          metricTile('queueDepth.pending', 'Queue depth: pending', 37, 4, 'count', n, (i) => 4 + incident(x(i)) * 30),
          metricTile('oldestPendingAge', 'Oldest pending job', 742, 35, 'seconds', n, (i) => 30 + incident(x(i)) * 700),
          metricTile('jobFailureRatio', 'Job failure ratio', 11.8, 0.9, '%', n, (i) => 1 + incident(x(i)) * 12),
          metricTile('jobDurationP95', 'Job duration p95', 18.6, 4.1, 'seconds', n),
          metricTile('backupAge', 'Last successful backup', 7.5, 6.5, 'hours', n),
        ],
        series: [
          metricSeries(url, 'jobsSettled', 'Jobs settled', 'per_min', (i) => 12 + 3 * wave(i, 13) - incident(x(i)) * 6, { dimension: 'outcome', groupBy: 'succeeded' }),
          metricSeries(url, 'jobsSettled', 'Jobs settled', 'per_min', (i) => 0.2 + incident(x(i)) * 4, { dimension: 'outcome', groupBy: 'failed' }),
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
              { key: 'db.backup', pending: 0, running: 0, oldestPendingSeconds: null, succeeded: 1, failed: 0, durationP95Seconds: 41.5, lastSeenAt: lastSeen(30) },
              { key: 'export.csv', pending: 31, running: 4, oldestPendingSeconds: 742, succeeded: 212, failed: 38, durationP95Seconds: 18.6, lastSeenAt: lastSeen(30) },
              { key: 'notifications.digest', pending: 6, running: 1, oldestPendingSeconds: 95, succeeded: 480, failed: 2, durationP95Seconds: 1.2, lastSeenAt: lastSeen(30) },
            ],
          },
        ],
        skipped: [],
      };
    case 'nodes':
      return {
        ...base,
        sql,
        available: true,
        tiles: [
          metricTile('nodesByHealth.healthy', 'Worker nodes: healthy', 2, 3, 'count', n, (i) => (x(i) < 0.72 ? 3 : 2)),
          metricTile('nodesByHealth.stale', 'Worker nodes: stale', 1, 0, 'count', n, (i) => (x(i) < 0.72 ? 0 : 1)),
          metricTile('nodesByHealth.offline', 'Worker nodes: offline', 0, 0, 'count', n, () => 0),
          metricTile('noEligibleNode', 'Job types without an eligible node', 0, 0, 'count', n, () => 0),
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
              { key: 'worker-eu-1', cpuCores: 1.62, rssBytes: 412 * MB, heapUsedBytes: 188 * MB, heapLimitBytes: 2048 * MB, stateDirFreeBytes: 31 * GB, stateDirTotalBytes: 40 * GB, slotsUsed: 4, slotsTotal: 4, heapPct: 9.2, stateDirFreePct: 77.5, lastSeenAt: lastSeen(15) },
              { key: 'worker-eu-2', cpuCores: 0.41, rssBytes: 268 * MB, heapUsedBytes: 1720 * MB, heapLimitBytes: 2048 * MB, stateDirFreeBytes: 3.1 * GB, stateDirTotalBytes: 40 * GB, slotsUsed: 1, slotsTotal: 4, heapPct: 84, stateDirFreePct: 7.8, lastSeenAt: lastSeen(15) },
              { key: 'worker-us-1', cpuCores: null, rssBytes: null, heapUsedBytes: null, heapLimitBytes: null, stateDirFreeBytes: null, stateDirTotalBytes: null, slotsUsed: null, slotsTotal: null, heapPct: null, stateDirFreePct: null, lastSeenAt: lastSeen(410) },
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
              { key: 'export.csv', noEligibleNode: false, lastSeenAt: lastSeen(15) },
              { key: 'media.thumbnail', noEligibleNode: false, lastSeenAt: lastSeen(15) },
            ],
          },
        ],
        skipped: [],
      };
    case 'uptime':
      return {
        ...base,
        sql,
        available: true,
        tiles: [
          metricTile('nginxConnections.active', 'nginx connections: active', 23, 19, 'count', n, (i) => 19 + 4 * wave(i, 9)),
          metricTile('nginxRequests', 'nginx requests', 3.9, 3.4, 'per_s', n, (i) => 3.4 + 0.5 * wave(i, 13)),
          metricTile('tlsDaysLeft', 'TLS certificate days left', 41.2, 42.2, 'days', n),
          metricTile('httpDuration', 'Check duration', 212, 48, 'ms', n, (i) => 48 + incident(x(i)) * 160),
        ],
        series: [
          metricSeries(url, 'nginxConnections', 'nginx connections', 'count', (i) => Math.round(19 + 4 * wave(i, 9)), { dimension: 'state', groupBy: 'active' }),
          metricSeries(url, 'nginxConnections', 'nginx connections', 'count', (i) => Math.round(2 + wave(i, 5)), { dimension: 'state', groupBy: 'reading' }),
          metricSeries(url, 'nginxConnections', 'nginx connections', 'count', (i) => Math.round(15 + 3 * wave(i, 11)), { dimension: 'state', groupBy: 'waiting' }),
          metricSeries(url, 'nginxConnections', 'nginx connections', 'count', (i) => Math.round(4 + 2 * wave(i, 7)), { dimension: 'state', groupBy: 'writing' }),
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
              { key: 'http://api:3000/api/health', durationMs: 4.1, tlsDaysLeft: null, up: true, statusCode: '200', checks: 60, failedChecks: 0, lastError: null, lastSeenAt: lastSeen(25) },
              { key: 'http://nginx/', durationMs: 212, tlsDaysLeft: null, up: false, statusCode: '502', checks: 60, failedChecks: 9, lastError: 'Bad Gateway', lastSeenAt: lastSeen(25) },
              { key: 'https://app.example.com/', durationMs: 96, tlsDaysLeft: 41.2, up: true, statusCode: '200', checks: 60, failedChecks: 0, lastError: null, lastSeenAt: lastSeen(25) },
            ],
          },
        ],
        skipped: [],
      };
    default:
      return {
        ...base,
        sql,
        available: true,
        tiles: [
          metricTile('exporterFailed', 'Metric points failed', 0, 0, 'count', n, () => 0),
          metricTile('exporterQueueUtilization', 'Exporter queue used', 3.1, 2.4, '%', n, (i) => 2.4 + 0.7 * wave(i, 9)),
          metricTile('receiverRefused', 'Metric points refused', 0, 0, 'count', n, () => 0),
          metricTile('scrapeTargetsDown', 'Scrape targets down', 0, 0, 'count', n, () => 0),
        ],
        series: [],
        tables: [
          {
            key: 'scrapeTargets',
            label: 'Scrape targets',
            columns: [
              { key: 'key', label: 'Scrape job', unit: 'text' },
              { key: 'up', label: 'Up', unit: 'boolean' },
              { key: 'lastSeenAt', label: 'Last reading', unit: 'timestamp' },
            ],
            rows: [
              { key: 'greptimedb', up: true, lastSeenAt: lastSeen(12) },
              { key: 'otelcol', up: true, lastSeenAt: lastSeen(12) },
            ],
          },
        ],
        skipped: ['greptimeWriteStalls'],
      };
  }
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
          hosts: scenario === 'no_data' ? [] : ['vps-1'],
        });
      case '/admin/telemetry/dashboard/metrics':
        return answer(route, metrics(url, scenario));
      default:
        return route.fallback();
    }
  });
}
