import type { SystemTelemetryValue } from '../../common/schemas/settings.schema';
import { TelemetryConnectionService } from '../connection/telemetry-connection.service';
import { GreptimeClient, type TelemetryQueryResult } from '../greptime/greptime.client';
import { METRIC_GROUPS, metricTablesOf } from '../metrics/metric-catalog';
import { VERDICT_PROBES, verdictInputsFrom, verdictProbeSql } from '../metrics/metric-verdict';
import { TelemetrySchemaService } from '../query/telemetry-schema.service';
import { VERIFIED_METRIC_TAGS } from '../testing/metric-schema.fixture';
import { TelemetryDashboardService } from './telemetry-dashboard.service';
import { computeVerdict } from './telemetry-dashboard.verdict';

// =============================================================================
// Telemetry dashboard against a REAL GreptimeDB (issue #577)
// =============================================================================
//
// Excluded from `npm test`; run with `npm run test:greptime` and
// GREPTIME_TEST_URL=postgres://reader:<pw>@host:4003/public (see
// ../telemetry.greptime.spec.ts). Point it at a store that has received this
// API's own telemetry (OTEL_ENABLED=true): every route runs every template
// whose table exists, so a template the store refuses fails here. Without
// GREPTIME_TEST_URL every test is skipped.
//
// The metric catalog block (#126) additionally needs GREPTIME_TEST_ADMIN_URL:
// on a store that has none of the catalog's tables (CI's fresh container) it
// creates look-alike tables with the verified tag columns
// (`../testing/metric-schema.fixture.ts`) and seeds 40 minutes of rows, then
// checks values end to end; on a store that already has them (a real
// deployment) it only checks that every group's statements run.
// =============================================================================

const READER_URL = process.env.GREPTIME_TEST_URL;
const ADMIN_URL = process.env.GREPTIME_TEST_ADMIN_URL;

const POLICY: SystemTelemetryValue = {
  enabled: true,
  retentionDays: 7,
  instanceId: null,
  query: { maxRows: 100, timeoutSeconds: 15 },
  assistant: {
    enabled: false,
    provider: null,
    modelId: null,
    shareResults: true,
    maxResultRowsToModel: 20,
    maxSteps: 6,
  },
};

const describeLive = READER_URL ? describe : describe.skip;

function clientFor(readerUrl: string, adminUrl?: string): GreptimeClient {
  const reader = new URL(readerUrl);
  const admin = adminUrl ? new URL(adminUrl) : undefined;
  const config = {
    host: reader.hostname,
    pgPort: Number(reader.port || 4003),
    database: reader.pathname.replace(/^\//, '') || 'public',
    readerUser: decodeURIComponent(reader.username),
    readerPassword: decodeURIComponent(reader.password),
    adminUser: admin ? decodeURIComponent(admin.username) : '',
    adminPassword: admin ? decodeURIComponent(admin.password) : '',
    available: true,
  };
  return new GreptimeClient(new TelemetryConnectionService({ get: () => config } as never, {} as never, {} as never));
}

describeLive('telemetry dashboard — live GreptimeDB', () => {
  let greptime: GreptimeClient;
  let dashboard: TelemetryDashboardService;

  beforeAll(() => {
    const reader = new URL(READER_URL!);
    const config = {
      host: reader.hostname,
      pgPort: Number(reader.port || 4003),
      database: reader.pathname.replace(/^\//, '') || 'public',
      readerUser: decodeURIComponent(reader.username),
      readerPassword: decodeURIComponent(reader.password),
      adminUser: '',
      adminPassword: '',
      available: true,
    };
    greptime = new GreptimeClient(
      new TelemetryConnectionService({ get: () => config } as never, {} as never, {} as never),
    );
    const settings = { getPolicy: jest.fn().mockResolvedValue(POLICY) };
    const schema = new TelemetrySchemaService(greptime, settings as never);
    const prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
    dashboard = new TelemetryDashboardService(greptime, settings as never, schema, prisma as never);
  });

  afterAll(async () => {
    await greptime?.onModuleDestroy();
  });

  it('computes the summary', async () => {
    const summary = await dashboard.summary('u1', { range: '24h' });
    expect(summary.tiles.map((t) => t.key)).toEqual([
      'requestsPerMin',
      'errorRatePct',
      'p95Ms',
      'errorLogs',
      'warnLogs',
      'unknownRoutes',
      'lastDataAt',
    ]);
    expect(['healthy', 'degraded', 'critical', 'no_data']).toContain(summary.verdict.level);
  });

  // #258: runs the unknown-route statements whenever the store has recorded
  // an unknown route (the API's onRequest hook wrote `app.route.matched`);
  // on a store that has not, proves the summary degrades to "unknown".
  it('counts unknown API routes when the store can tell', async () => {
    const schema = await new TelemetrySchemaService(greptime, { getPolicy: async () => POLICY } as never).getSchema();
    const traces = schema.tables.find((t) => t.name === 'opentelemetry_traces');
    const hasMatched = !!traces?.columns.some((c) => c.name === 'span_attributes.app.route.matched');

    const summary = await dashboard.summary('u1', { range: '7d' });
    const tile = summary.tiles.find((t) => t.key === 'unknownRoutes');
    if (!hasMatched) {
      expect(tile?.value).toBeNull();
      expect(summary.unknownRoutes).toBeUndefined();
      return;
    }
    expect(summary.unknownRoutes).toBeDefined();
    const block = summary.unknownRoutes!;
    expect(tile?.value).toBe(block.requests);
    expect(block.bearer + block.anonymous).toBe(block.requests);
    expect(block.topRoutes.length).toBeLessThanOrEqual(5);

    const top = await dashboard.top('u1', { kind: 'routes', range: '7d' });
    for (const item of top.items) {
      if (!('clientErrors' in item)) continue;
      expect(item.unknown).toBe(item.unknownRequests > 0);
      expect(item.clientErrors).toBeGreaterThanOrEqual(item.unknownRequests);
    }
  });

  it.each(['api', 'logs'] as const)('computes the %s time series', async (panel) => {
    const series = await dashboard.timeseries('u1', { panel, range: '6h', buckets: '30' });
    expect(series.buckets.length).toBeGreaterThan(0);
  });

  it.each(['routes', 'errors'] as const)('computes the top %s', async (kind) => {
    const top = await dashboard.top('u1', { kind, range: '7d' });
    expect(top.items.length).toBeLessThanOrEqual(10);
  });

  it('pages through events with a search and a known service', async () => {
    const filters = await dashboard.filters('u1', { range: '7d' });
    const service = filters.services[0];

    const first = await dashboard.events('u1', {
      range: '7d',
      severity: 'error,warn,info',
      q: "a'%_\\",
      ...(service ? { service } : {}),
    });
    expect(first.items).toEqual([]);

    const page = await dashboard.events('u1', { range: '7d', severity: 'error,warn,info' });
    if (page.nextCursor) {
      const next = await dashboard.events('u1', { range: '7d', severity: 'error,warn,info', cursor: page.nextCursor });
      const seen = new Set(page.items.map((i) => `${i.timestamp}|${i.spanId}|${i.body}`));
      expect(next.items.some((i) => seen.has(`${i.timestamp}|${i.spanId}|${i.body}`))).toBe(false);
    }
  });
});

// ---- the metric catalog (#126) ---------------------------------------------------------

const describeSeeded = READER_URL && ADMIN_URL ? describe : describe.skip;

describeSeeded('telemetry dashboard metrics — live GreptimeDB', () => {
  let greptime: GreptimeClient;
  let dashboard: TelemetryDashboardService;
  let schema: TelemetrySchemaService;
  let seeded = false;

  const HOST = 'live-host';
  /** The last whole minute, minus one: every seeded row is inside a `1h` window ending now. */
  const base = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
  const POINTS = 40;
  const at = (i: number) => new Date(base - (POINTS - 1 - i) * 60_000).toISOString();

  const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const insert = async (table: string, tags: Record<string, string>, values: number[]) => {
    const columns = [...Object.keys(tags), 'greptime_value', 'greptime_timestamp'].map((c) => `"${c}"`).join(', ');
    const offset = POINTS - values.length;
    const rows = values
      .map((v, i) => `(${[...Object.values(tags).map(quote), String(v), quote(at(offset + i))].join(', ')})`)
      .join(', ');
    await greptime.queryAdmin(`INSERT INTO "${table}" (${columns}) VALUES ${rows}`, { timeoutMs: 15_000 });
  };
  const gauge = (table: string, tags: Record<string, string>, value: number) =>
    insert(table, tags, Array.from({ length: POINTS }, () => value));
  const counter = (table: string, tags: Record<string, string>, step: number) =>
    insert(table, tags, Array.from({ length: POINTS }, (_, i) => i * step));

  beforeAll(async () => {
    greptime = clientFor(READER_URL!, ADMIN_URL);
    const settings = { getPolicy: jest.fn().mockResolvedValue(POLICY) };
    schema = new TelemetrySchemaService(greptime, settings as never);
    const prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
    dashboard = new TelemetryDashboardService(greptime, settings as never, schema, prisma as never);

    const existing = await schema.getSchema({ fresh: true });
    seeded = !existing.tables.some((t) => t.name in VERIFIED_METRIC_TAGS);
    if (!seeded) return;

    for (const [table, tags] of Object.entries(VERIFIED_METRIC_TAGS)) {
      await greptime.queryAdmin(
        `CREATE TABLE IF NOT EXISTS "${table}" (greptime_timestamp TIMESTAMP(3) TIME INDEX, greptime_value DOUBLE, ` +
          `${tags.map((t) => `"${t}" STRING`).join(', ')}, PRIMARY KEY (${tags.map((t) => `"${t}"`).join(', ')}))`,
        { timeoutMs: 15_000 },
      );
    }

    const app = { app_instance_id: 'inst-1', host_name: 'api-ctr', job: 'my-app-api', service_name: 'my-app-api' };
    const col = {
      host_name: HOST,
      instance: 'otelcol:8888',
      job: 'otelcol-contrib',
      service_instance_id: 'col-1',
      service_name: 'otelcol-contrib',
      service_version: '0.145.0',
    };
    const pg = { host_name: HOST, instance: 'db:5432', service_instance_id: 'db:5432' };
    const node = (name: string) => ({ ...app, node_id: `id-${name}`, node_name: name });

    // host
    await gauge('system_cpu_utilization_ratio', { cpu: 'cpu0', host_name: HOST, state: 'idle' }, 0.8);
    await gauge('system_memory_utilization_ratio', { host_name: HOST, state: 'used' }, 0.5);
    await gauge('system_cpu_load_average_1m', { host_name: HOST }, 1.5);
    const fs = { device: '/dev/sda1', host_name: HOST, mode: 'rw', mountpoint: '/', type: 'ext4' };
    await gauge('system_filesystem_utilization_ratio', fs, 0.96);
    await gauge('system_filesystem_usage_bytes', { ...fs, state: 'used' }, 96e9);
    await gauge('system_filesystem_usage_bytes', { ...fs, state: 'free' }, 4e9);
    await counter('system_disk_io_bytes_total', { device: 'sda', direction: 'read', host_name: HOST }, 600);
    await counter('system_network_io_bytes_total', { device: 'eth0', direction: 'receive', host_name: HOST }, 60);
    // database
    await gauge('postgresql_backends', { ...pg, postgresql_database_name: 'app' }, 85);
    await gauge('postgresql_connection_max', pg, 100);
    await gauge('postgresql_db_size_bytes', { ...pg, postgresql_database_name: 'app' }, 5e8);
    await counter('postgresql_commits_total', { ...pg, postgresql_database_name: 'app' }, 10);
    await counter('postgresql_rollbacks_total', { ...pg, postgresql_database_name: 'app' }, 0);
    // A reset (server restart) between 2 and 1: increases 0 + 2 + 0 + 1 + 2 = 5.
    await insert('postgresql_deadlocks_total', { ...pg, postgresql_database_name: 'app' }, [0, 0, 2, 2, 1, 3]);
    await counter('postgresql_blks_hit_total', { ...pg, postgresql_database_name: 'app' }, 99);
    await counter('postgresql_blks_read_total', { ...pg, postgresql_database_name: 'app' }, 1);
    await gauge('postgresql_table_size_bytes', { ...pg, postgresql_database_name: 'app', postgresql_table_name: 'public.jobs' }, 9e6);
    await gauge('postgresql_table_size_bytes', { ...pg, postgresql_database_name: 'app', postgresql_table_name: 'public.users' }, 1e6);
    // queue
    await gauge('app_jobs_queue_depth', { ...app, job_type: 'export.csv', status: 'pending' }, 7);
    await gauge('app_jobs_oldest_pending_age_seconds', { ...app, job_type: 'export.csv' }, 1900);
    const settled = { ...app, executor: 'server', job_type: 'export.csv' };
    await counter('app_jobs_settled_total', { ...settled, outcome: 'succeeded' }, 19);
    await counter('app_jobs_settled_total', { ...settled, outcome: 'failed' }, 1);
    for (const [le, step] of [['1', 50], ['2', 90], ['4', 100], ['inf', 100]] as const) {
      await counter('app_jobs_duration_seconds_bucket', { ...settled, outcome: 'succeeded', le }, step);
    }
    await gauge('app_backup_last_success_timestamp_seconds', app, Math.floor(Date.now() / 1000) - 30 * 3600);
    // nodes
    for (const [status, health, count] of [['online', 'healthy', 2], ['online', 'stale', 1], ['offline', 'offline', 0]] as const) {
      await gauge('app_nodes_count', { ...app, health, status }, count);
    }
    await gauge('app_nodes_types_no_eligible_node', { ...app, job_type: 'export.csv' }, 1);
    await gauge('app_nodes_cpu_utilization', node('node-a'), 0.5);
    await gauge('app_nodes_heap_used_bytes', node('node-a'), 50);
    await gauge('app_nodes_heap_limit_bytes', node('node-a'), 100);
    // uptime
    const ok = 'http://nginx/api/health/live';
    const bad = 'http://nginx/down';
    for (const cls of ['1xx', '2xx', '3xx', '4xx', '5xx']) {
      await gauge('httpcheck_status', { host_name: HOST, http_method: 'GET', http_status_class: cls, http_status_code: cls === '2xx' ? '200' : '', http_url: ok }, cls === '2xx' ? 1 : 0);
      await gauge('httpcheck_status', { host_name: HOST, http_method: 'GET', http_status_class: cls, http_status_code: '', http_url: bad }, 0);
    }
    await gauge('httpcheck_error', { error_message: 'dial tcp: connection refused', host_name: HOST, http_url: bad }, 1);
    await gauge('httpcheck_duration_milliseconds', { host_name: HOST, http_url: ok }, 4);
    await gauge(
      'httpcheck_tls_cert_remaining_seconds',
      { host_name: HOST, http_tls_cn: 'app.example.com', http_tls_issuer: 'R3', http_url: 'https://app.example.com/api/health/live' },
      5 * 86_400,
    );
    await counter('nginx_requests_total', { host_name: HOST }, 120);
    await gauge('nginx_connections_current', { host_name: HOST, state: 'active' }, 3);
    // pipeline
    await counter('otelcol_exporter_sent_metric_points_total', { ...col, exporter: 'otlphttp/greptime' }, 98);
    await counter('otelcol_exporter_send_failed_metric_points_total', { ...col, exporter: 'otlphttp/greptime' }, 2);
    await gauge('otelcol_exporter_queue_size', { ...col, data_type: 'metrics', exporter: 'otlphttp/greptime' }, 250);
    await gauge('otelcol_exporter_queue_capacity', { ...col, data_type: 'metrics', exporter: 'otlphttp/greptime' }, 1000);
    await counter('otelcol_receiver_refused_metric_points_total', { ...col, receiver: 'otlp', transport: 'http' }, 0);
    await gauge('greptime_mito_write_stalling_count', { host_name: HOST, instance: 'greptimedb:4000', job: 'greptimedb', service_instance_id: 'g', service_name: 'greptimedb', worker: '0' }, 0);
    await gauge('up', { ...col, instance: 'greptimedb:4000', job: 'greptimedb', service_name: 'greptimedb' }, 1);
    await gauge('up', { ...col, instance: 'dead:9999', job: 'dead', service_name: 'dead' }, 0);

    schema.invalidateCache();
  }, 120_000);

  afterAll(async () => {
    await greptime?.onModuleDestroy();
  });

  it.each(METRIC_GROUPS)('runs every statement of the %s group', async (group) => {
    const metrics = await dashboard.metrics('u1', { group, range: '1h' });
    expect(metrics.available).toBe(true);
    expect(metrics.sql.length).toBeGreaterThan(0);
    if (seeded) expect(metrics.skipped).toEqual([]);
  });

  it('lists the seeded host in /filters and filters by it', async () => {
    const filters = await dashboard.filters('u1', { range: '1h' });
    const host = seeded ? HOST : filters.hosts[0];
    if (!host) return;
    if (seeded) expect(filters.hosts).toEqual([HOST]);
    const metrics = await dashboard.metrics('u1', { group: 'host', range: '1h', host });
    expect(metrics.sql.every((sql) => sql.includes(`"host_name" = '${host}'`))).toBe(true);
  });

  const tile = (tiles: { key: string; value: unknown }[], key: string) => tiles.find((t) => t.key === key)?.value;

  it('computes the seeded values end to end', async () => {
    if (!seeded) return;
    const [host, database, queue, nodes, uptime, pipeline] = await Promise.all(
      METRIC_GROUPS.map((group) => dashboard.metrics('u1', { group, range: '1h' })),
    );

    expect(tile(host.tiles, 'cpuUtilization')).toBe(20);
    expect(tile(host.tiles, 'memoryUtilization')).toBe(50);
    expect(tile(host.tiles, 'load1m')).toBe(1.5);
    expect(tile(host.tiles, 'filesystemUtilization')).toBe(96);
    // 600 B per minute; the first point has no predecessor: 39 × 600 B over the hour.
    expect(tile(host.tiles, 'diskIo')).toBe(6.5);
    expect(host.tables[0].rows[0]).toMatchObject({ key: '/', utilizationPct: 96, usedBytes: 96e9, freeBytes: 4e9 });

    expect(tile(database.tiles, 'dbConnectionUtilization')).toBe(85);
    expect(tile(database.tiles, 'dbDeadlocks')).toBe(5);
    expect(tile(database.tiles, 'dbCacheHitRatio')).toBe(99);
    expect(database.tables[0].rows.map((r) => r.key)).toEqual(['public.jobs', 'public.users']);

    expect(tile(queue.tiles, 'queueDepth.pending')).toBe(7);
    expect(tile(queue.tiles, 'oldestPendingAge')).toBe(1900);
    expect(tile(queue.tiles, 'jobDurationP95')).toBe(3);
    expect(tile(queue.tiles, 'jobFailureRatio')).toBe(5);
    expect(tile(queue.tiles, 'backupAge')).toBeCloseTo(30, 0);
    expect(queue.tables[0].rows[0]).toMatchObject({ key: 'export.csv', pending: 7, durationP95Seconds: 3 });

    expect(tile(nodes.tiles, 'nodesByHealth.stale')).toBe(1);
    expect(tile(nodes.tiles, 'noEligibleNode')).toBe(1);
    expect(nodes.tables.find((t) => t.key === 'nodes')!.rows[0]).toMatchObject({ key: 'node-a', cpuCores: 0.5, heapPct: 50 });

    expect(tile(uptime.tiles, 'tlsDaysLeft')).toBe(5);
    const targets = uptime.tables.find((t) => t.key === 'uptimeTargets')!.rows;
    expect(targets.find((r) => r.key === 'http://nginx/api/health/live')).toMatchObject({ up: true, statusCode: '200', durationMs: 4 });
    expect(targets.find((r) => r.key === 'http://nginx/down')).toMatchObject({
      up: false,
      failedChecks: 40,
      lastError: 'dial tcp: connection refused',
    });

    expect(tile(pipeline.tiles, 'exporterFailed')).toBe(78);
    expect(tile(pipeline.tiles, 'exporterQueueUtilization')).toBe(25);
    expect(tile(pipeline.tiles, 'scrapeTargetsDown')).toBe(1);
  });

  it('runs the verdict probes inside the summary and fires the infrastructure rules', async () => {
    const summary = await dashboard.summary('u1', { range: '1h' });
    expect(['healthy', 'degraded', 'critical', 'no_data']).toContain(summary.verdict.level);

    // The seeded store has no traces or logs, so the summary itself is
    // `no_data`; judge the probes' inputs directly, as if data were fresh.
    const now = new Date();
    const tables = metricTablesOf(await schema.getSchema());
    const statements = verdictProbeSql(tables, { from: new Date(now.getTime() - 3_600_000), to: now });
    const results: Partial<Record<(typeof VERDICT_PROBES)[number], TelemetryQueryResult | null>> = {};
    for (const probe of VERDICT_PROBES) {
      const sql = statements[probe];
      results[probe] = sql ? await greptime.queryReader(sql, { timeoutMs: 15_000 }) : null;
    }
    const verdict = computeVerdict({
      now,
      lastDataAt: now,
      requests: 0,
      errors5xx: 0,
      p95Ms: null,
      errorLogs: 0,
      previousErrorLogs: 0,
      ...verdictInputsFrom(results, now),
    });
    if (!seeded) return;

    expect(verdict.level).toBe('critical');
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        'Disk 96% full (≥ 95%) — mountpoint: /',
        'Database connections at 85% of max (≥ 80%) — server: db:5432',
        'Oldest pending job waiting 31.7 min (≥ 30 min) — type: export.csv',
        '1 job type(s) have pending work and no eligible worker node — type: export.csv',
        '1 worker node(s) stale (missed heartbeats)',
        'TLS certificate expires in 5 days (< 7 days) — url: https://app.example.com/api/health/live',
        'Uptime check failing for every check in the lookback (1 URL(s)) — url: http://nginx/down',
        'Collector failed to export 78 points (2% of attempted) — exporter: otlphttp/greptime',
      ]),
    );
    expect(verdict.reasons.some((r) => r.startsWith('Last successful backup 30'))).toBe(true);
  });
});

