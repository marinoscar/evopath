import request from 'supertest';

import {
  GreptimeClient,
  REQUIRED_LOG_COLUMNS,
  REQUIRED_TRACE_COLUMNS,
  TelemetrySchemaService,
  TelemetrySettingsService,
} from '@marinoscar/platform-api/telemetry';
import { metricTableSchema } from '@marinoscar/platform-api/telemetry/testing';

import type { SystemTelemetryValue } from '../../src/common/schemas/settings.schema';
import { COACH_METRIC_GROUP } from '../../src/coach/telemetry/coach-metric-group';
import { telemetryControllers, telemetryProviders } from '../../src/platform/telemetry/telemetry.config';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockAdminUser } from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// The `coach` metric group through the real HTTP stack (marinoscar/EnterpriseAppBase#719)
// =============================================================================
//
// The app's first extension of the platform dashboard, through the REAL
// `AppModule`: `/metric-groups` lists it after the six platform groups (the
// web renders it from that metadata, with no coach component), `/metrics`
// serves it, the route's OpenAPI `group` enum documents it, and a family whose
// table is absent is `skipped`, never an error. GreptimeDB is stubbed on the
// real providers (no network), as in telemetry-dashboard.integration.spec.ts;
// the live-store tier is the platform's own (`test:greptime` in
// EnterpriseAppBase), whose helpers this app does not get.
// =============================================================================

const BASE = '/api/admin/telemetry/dashboard';

const POLICY: SystemTelemetryValue = {
  enabled: true,
  retentionDays: 7,
  instanceId: null,
  query: { maxRows: 1000, timeoutSeconds: 15 },
  assistant: {
    enabled: false,
    provider: null,
    modelId: null,
    shareResults: false,
    maxResultRowsToModel: 20,
    maxSteps: 6,
  },
};

const STORE_TABLES = [
  { name: 'opentelemetry_traces', rows: null, columns: REQUIRED_TRACE_COLUMNS.map((name) => ({ name, type: 'string', semanticType: null })) },
  { name: 'opentelemetry_logs', rows: null, columns: REQUIRED_LOG_COLUMNS.map((name) => ({ name, type: 'string', semanticType: null })) },
];

/** The tags the API's OTLP exporter writes on every `app.*` counter, plus the family's own label. */
function coachTables() {
  return COACH_METRIC_GROUP.families.map((family) =>
    metricTableSchema(family.table, ['app_instance_id', 'host_name', 'job', 'service_name', ...family.requiredColumns]),
  );
}

const FAMILY_KEYS = COACH_METRIC_GROUP.families.map((family) => family.key);

describe('Telemetry dashboard: the coach metric group', () => {
  let context: TestContext;
  let greptime: GreptimeClient;
  let schema: TelemetrySchemaService;
  let queryReader: jest.SpyInstance;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
    greptime = context.module.get(GreptimeClient);
    schema = context.module.get(TelemetrySchemaService);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    context.prismaMock.auditEvent.create.mockResolvedValue({} as never);
    jest.spyOn(greptime, 'isConfigured').mockReturnValue(true);
    jest.spyOn(context.module.get(TelemetrySettingsService), 'getPolicy').mockResolvedValue(POLICY);
    queryReader = jest.spyOn(greptime, 'queryReader').mockResolvedValue({ fields: [], rows: [] } as never);
    // The service caches results and schema reads for 15 s; every case starts cold.
    const dashboard = context.module.get(telemetryProviders.TelemetryDashboardService) as unknown as {
      results: { clear(): void };
      distinct: { clear(): void };
    };
    dashboard.results.clear();
    dashboard.distinct.clear();
  });

  afterEach(() => jest.restoreAllMocks());

  it('lists `coach` in /metric-groups after the six platform groups', async () => {
    jest.spyOn(schema, 'getSchema').mockResolvedValue({ tables: STORE_TABLES } as never);
    const admin = await createMockAdminUser(context);
    const res = await request(context.app.getHttpServer())
      .get(`${BASE}/metric-groups`)
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(res.body.data.map((group: { id: string }) => group.id)).toEqual([
      'host',
      'database',
      'queue',
      'nodes',
      'uptime',
      'pipeline',
      'coach',
    ]);
    expect(res.body.data.at(-1)).toEqual({ id: 'coach', label: 'Coach', title: 'AI Coach', order: 70 });
  });

  it('reports every family as skipped (not an error) while no coach table exists', async () => {
    jest.spyOn(schema, 'getSchema').mockResolvedValue({ tables: STORE_TABLES } as never);
    const admin = await createMockAdminUser(context);
    const res = await request(context.app.getHttpServer())
      .get(`${BASE}/metrics?group=coach`)
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(res.body.data).toMatchObject({ group: 'coach', available: false, skipped: FAMILY_KEYS, tiles: [], series: [] });
    const coachStatements = queryReader.mock.calls.filter(([sql]) => String(sql).includes('app_coach_'));
    expect(coachStatements).toEqual([]);
  });

  it('returns values for the coach families once their tables hold data', async () => {
    jest.spyOn(schema, 'getSchema').mockResolvedValue({ tables: [...STORE_TABLES, ...coachTables()] } as never);
    const now = new Date();
    const bucket = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 5 * 60_000).toISOString();
    queryReader.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "app_coach_nudge_sent_total"') && sql.includes(' AS g')) {
        return {
          fields: [
            { name: 't', dataTypeID: 1184 },
            { name: 'g', dataTypeID: 25 },
            { name: 'v', dataTypeID: 701 },
          ],
          rows: [[bucket, 'workout_reminder', '3']],
        };
      }
      return { fields: [], rows: [] };
    });

    const admin = await createMockAdminUser(context);
    const res = await request(context.app.getHttpServer())
      .get(`${BASE}/metrics?group=coach&range=1h`)
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(res.body.data).toMatchObject({ group: 'coach', available: true, skipped: [] });
    const statements = queryReader.mock.calls.map(([sql]) => String(sql));
    for (const family of COACH_METRIC_GROUP.families) {
      expect(statements.some((sql) => sql.includes(`FROM "${family.table}"`) && sql.includes(`"${family.groupBy}" AS k`))).toBe(
        true,
      );
    }

    const sent = res.body.data.series.find(
      (series: { key: string; groupBy?: string }) => series.key === 'coachNudgesSent' && series.groupBy === 'workout_reminder',
    );
    expect(sent).toBeDefined();
    expect(sent.points.some((point: { v: number | null }) => point.v === 3)).toBe(true);
    const tile = res.body.data.tiles.find((t: { key: string }) => t.key === 'coachNudgesSent');
    expect(tile).toMatchObject({ value: 3, unit: 'count' });
  });

  it("documents `coach` in the /metrics route's OpenAPI `group` enum", () => {
    const { TelemetryDashboardController } = telemetryControllers as Record<string, { prototype: Record<string, object> }>;
    const params = Reflect.getMetadata('swagger/apiParameters', TelemetryDashboardController.prototype.metrics) as Array<{
      name: string;
      schema?: { enum?: string[] };
    }>;

    expect(params.find((p) => p.name === 'group')?.schema?.enum).toEqual([
      'host',
      'database',
      'queue',
      'nodes',
      'uptime',
      'pipeline',
      'coach',
    ]);
  });
});
