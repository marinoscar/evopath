import type { SystemTelemetryValue } from '../../common/schemas/settings.schema';
import { TelemetryConnectionService } from '../connection/telemetry-connection.service';
import { GreptimeClient } from '../greptime/greptime.client';
import { TelemetrySchemaService } from '../query/telemetry-schema.service';
import { TelemetryDashboardService } from './telemetry-dashboard.service';

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
// =============================================================================

const READER_URL = process.env.GREPTIME_TEST_URL;

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
      'lastDataAt',
    ]);
    expect(['healthy', 'degraded', 'critical', 'no_data']).toContain(summary.verdict.level);
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
