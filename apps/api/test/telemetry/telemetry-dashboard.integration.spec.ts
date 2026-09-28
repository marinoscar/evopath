import request from 'supertest';
import { JwtService } from '@nestjs/jwt';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockAdminUser, createMockViewerUser, authHeader } from '../helpers/auth-mock.helper';
import type { SystemTelemetryValue } from '../../src/common/schemas/settings.schema';
import { GreptimeClient } from '../../src/telemetry/greptime/greptime.client';
import { TelemetrySchemaService } from '../../src/telemetry/query/telemetry-schema.service';
import { TelemetrySettingsService } from '../../src/telemetry/telemetry-settings.service';
import {
  REQUIRED_LOG_COLUMNS,
  REQUIRED_TRACE_COLUMNS,
} from '../../src/telemetry/dashboard/telemetry-dashboard.sql';

// =============================================================================
// Telemetry dashboard over HTTP (issue #577)
// =============================================================================
//
// Through the REAL `AppModule` wiring: RBAC on every route (401 without a
// token, 403 with only `telemetry:read`, 200 with `telemetry:query`), the 409
// / 503 preconditions, query validation by the global Zod pipe, and the
// `{ data }` envelope. The GreptimeDB client, the telemetry policy and the
// schema read are stubbed on the real providers — no network.
// =============================================================================

const BASE = '/api/admin/telemetry/dashboard';

const ROUTES = [
  `${BASE}/summary`,
  `${BASE}/timeseries?panel=api`,
  `${BASE}/top?kind=routes`,
  `${BASE}/events`,
  `${BASE}/filters`,
];

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

const SCHEMA = {
  tables: [
    {
      name: 'opentelemetry_traces',
      rows: null,
      columns: REQUIRED_TRACE_COLUMNS.map((name) => ({ name, type: 'string', semanticType: null })),
    },
    {
      name: 'opentelemetry_logs',
      rows: null,
      columns: REQUIRED_LOG_COLUMNS.map((name) => ({ name, type: 'string', semanticType: null })),
    },
  ],
};

describe('Telemetry dashboard integration', () => {
  let context: TestContext;
  let greptime: GreptimeClient;
  let settings: TelemetrySettingsService;
  let schema: TelemetrySchemaService;
  let queryReader: jest.SpyInstance;
  let isConfigured: jest.SpyInstance;
  let getPolicy: jest.SpyInstance;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
    greptime = context.module.get(GreptimeClient);
    settings = context.module.get(TelemetrySettingsService);
    schema = context.module.get(TelemetrySchemaService);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    context.prismaMock.auditEvent.create.mockResolvedValue({} as never);

    isConfigured = jest.spyOn(greptime, 'isConfigured').mockReturnValue(true);
    getPolicy = jest.spyOn(settings, 'getPolicy').mockResolvedValue(POLICY);
    jest.spyOn(schema, 'getSchema').mockResolvedValue(SCHEMA);
    // Every statement answers with no rows; distinct values answer one service.
    queryReader = jest.spyOn(greptime, 'queryReader').mockImplementation(async (sql: string) =>
      sql.includes(' AS v ')
        ? { fields: [{ name: 'v', dataTypeID: 25 }], rows: sql.includes('instance') ? [] : [['my-app-api']] }
        : { fields: [], rows: [] },
    );
  });

  afterEach(() => jest.restoreAllMocks());

  /** A user holding ONLY `telemetry:read` (sees the store's status, not its data). */
  function telemetryReadOnlyUser(): string {
    const jwtService = context.module.get<JwtService>(JwtService);
    const id = 'telemetry-read-only';
    const email = 'telemetry-read-only@example.com';

    context.prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where?.id !== id && where?.email !== email) return null;
      return {
        id,
        email,
        displayName: null,
        providerDisplayName: 'Telemetry Read Only',
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [
          {
            role: {
              id: 'role-telemetry-readonly',
              name: 'telemetry-readonly',
              description: 'Telemetry status only',
              rolePermissions: [
                { permission: { id: 'perm-t-read', name: 'telemetry:read', description: 'View telemetry' } },
              ],
            },
          },
        ],
      };
    });

    return jwtService.sign({ sub: id, email, roles: ['telemetry-readonly'] });
  }

  describe('RBAC', () => {
    it.each(ROUTES)('%s is 401 without a token', async (route) => {
      await request(context.app.getHttpServer()).get(route).expect(401);
      expect(queryReader).not.toHaveBeenCalled();
    });

    it.each(ROUTES)('%s is 403 with only telemetry:read', async (route) => {
      const token = telemetryReadOnlyUser();
      await request(context.app.getHttpServer()).get(route).set(authHeader(token)).expect(403);
      expect(queryReader).not.toHaveBeenCalled();
    });

    it.each(ROUTES)('%s is 403 for a viewer', async (route) => {
      const viewer = await createMockViewerUser(context);
      await request(context.app.getHttpServer()).get(route).set(authHeader(viewer.accessToken)).expect(403);
    });

    it.each(ROUTES)('%s is 200 with telemetry:query, inside the envelope', async (route) => {
      const admin = await createMockAdminUser(context);
      const res = await request(context.app.getHttpServer()).get(route).set(authHeader(admin.accessToken)).expect(200);

      expect(res.body.data).toEqual(
        expect.objectContaining({
          range: expect.objectContaining({ bucketSeconds: 60 }),
          generatedAt: expect.any(String),
          truncated: false,
          sql: expect.anything(),
        }),
      );
    });
  });

  describe('preconditions', () => {
    it.each(ROUTES)('%s is 409 TELEMETRY_DISABLED when telemetry is off', async (route) => {
      const admin = await createMockAdminUser(context);
      getPolicy.mockResolvedValue({ ...POLICY, enabled: false });

      const res = await request(context.app.getHttpServer()).get(route).set(authHeader(admin.accessToken)).expect(409);
      expect(res.body.details.reason).toBe('TELEMETRY_DISABLED');
    });

    it.each(ROUTES)('%s is 503 TELEMETRY_NOT_CONFIGURED without a store', async (route) => {
      const admin = await createMockAdminUser(context);
      isConfigured.mockReturnValue(false);

      const res = await request(context.app.getHttpServer()).get(route).set(authHeader(admin.accessToken)).expect(503);
      expect(res.body.details.reason).toBe('TELEMETRY_NOT_CONFIGURED');
    });
  });

  describe('validation', () => {
    it.each([
      ['range with from/to', `${BASE}/summary?range=1h&from=2026-09-27T20:00:00Z&to=2026-09-27T21:00:00Z`],
      ['a span over 30 days', `${BASE}/summary?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z`],
      ['buckets 45', `${BASE}/summary?buckets=45`],
      ['an unknown range', `${BASE}/summary?range=2h`],
      ['a missing panel', `${BASE}/timeseries`],
      ['an unknown kind', `${BASE}/top?kind=slow`],
      ['an unknown severity', `${BASE}/events?severity=debug`],
      ['q over 200 characters', `${BASE}/events?q=${'x'.repeat(201)}`],
    ])('refuses %s with 400', async (_label, route) => {
      const admin = await createMockAdminUser(context);
      await request(context.app.getHttpServer()).get(route).set(authHeader(admin.accessToken)).expect(400);
      expect(queryReader).not.toHaveBeenCalled();
    });

    it('refuses a malformed cursor with 400 TELEMETRY_DASHBOARD_BAD_CURSOR', async () => {
      const admin = await createMockAdminUser(context);
      const res = await request(context.app.getHttpServer())
        .get(`${BASE}/events?cursor=bm90LWpzb24`)
        .set(authHeader(admin.accessToken))
        .expect(400);
      expect(res.body.details.reason).toBe('TELEMETRY_DASHBOARD_BAD_CURSOR');
    });

    it('refuses an unknown service with 400 TELEMETRY_DASHBOARD_BAD_FILTER', async () => {
      const admin = await createMockAdminUser(context);
      const res = await request(context.app.getHttpServer())
        .get(`${BASE}/summary?service=${encodeURIComponent("x' OR 1=1 --")}`)
        .set(authHeader(admin.accessToken))
        .expect(400);
      expect(res.body.details).toEqual({ field: 'service', reason: 'TELEMETRY_DASHBOARD_BAD_FILTER' });
    });

    it('accepts a known service', async () => {
      const admin = await createMockAdminUser(context);
      await request(context.app.getHttpServer())
        .get(`${BASE}/top?kind=errors&range=24h&service=my-app-api`)
        .set(authHeader(admin.accessToken))
        .expect(200);
    });
  });
});
