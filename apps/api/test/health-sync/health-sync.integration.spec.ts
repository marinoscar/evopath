// =============================================================================
// Integration: /api/health-sync and /api/sleep (epic #276, #278)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter, over a mocked Prisma: 401 without a token and 403 without the exact
// permission on every route, the health_data:write gate on measurements and
// sleep, Zod and day-window 400s, DEVICE_REVOKED, and the PAT a phone
// registers with being linked to its device. Upserts through the partial
// unique indexes, reconciliation and retention are proven in
// `health-sync.db.spec.ts`.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';

import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { HealthSyncController } from '../../src/health-sync/health-sync.controller';
import { SleepController } from '../../src/sleep/sleep.controller';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const DEVICE = '22222222-2222-4222-8222-222222222222';
const REPORT = '55555555-5555-4555-8555-555555555555';
const SLEEP = '66666666-6666-4666-8666-666666666666';
const INSTALLATION = '44444444-4444-4444-8444-444444444444';

const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const RUN = { trigger: 'manual', status: 'ok', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() };

function deviceRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: DEVICE,
    userId,
    installationId: INSTALLATION,
    name: 'Pixel 9',
    manufacturer: null,
    model: null,
    androidVersion: null,
    sdkInt: null,
    appVersion: null,
    healthConnectVersion: null,
    packageName: null,
    signingSha256: null,
    timezone: null,
    patId: null,
    status: 'active',
    lastSeenAt: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    pat: null,
    ...overrides,
  };
}

/** Removes one permission from one mocked user's roles. */
function stripPermission(prisma: any, userId: string, permission: string): void {
  const previous = prisma.user.findUnique.getMockImplementation();

  prisma.user.findUnique.mockImplementation(async (args: any) => {
    const user = await previous(args);
    if (!user || user.id !== userId) return user;
    return {
      ...user,
      userRoles: (user.userRoles ?? []).map((userRole: any) => ({
        ...userRole,
        role: {
          ...userRole.role,
          rolePermissions: (userRole.role.rolePermissions ?? []).filter((rp: any) => rp.permission.name !== permission),
        },
      })),
    };
  });
}

describe('Health sync (integration)', () => {
  let context: TestContext;
  let prisma: any;

  const server = () => context.app.getHttpServer();

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    prisma = context.prismaMock;
    prisma.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)));
    prisma.healthProfile.findUnique.mockResolvedValue(null); // UTC
    prisma.$queryRaw.mockResolvedValue([{ inserted: true, owned: null }]);
    prisma.$executeRaw.mockResolvedValue(0);
    prisma.healthSyncRun.create.mockResolvedValue({ id: randomUUID() });
    prisma.healthSyncDevice.update.mockResolvedValue({});
  });

  // ---------------------------------------------------------------------------
  // Access control
  // ---------------------------------------------------------------------------

  const ROUTES: Array<{ method: 'get' | 'post' | 'delete'; path: string; permission: string; body?: unknown }> = [
    { method: 'post', path: '/api/health-sync/devices', permission: 'goals:write', body: { installationId: INSTALLATION, name: 'P' } },
    { method: 'get', path: '/api/health-sync/devices', permission: 'goals:read' },
    { method: 'get', path: `/api/health-sync/devices/${DEVICE}`, permission: 'goals:read' },
    { method: 'delete', path: `/api/health-sync/devices/${DEVICE}`, permission: 'goals:write' },
    { method: 'post', path: `/api/health-sync/devices/${DEVICE}/sync`, permission: 'goals:write', body: { run: RUN, entries: [] } },
    { method: 'get', path: `/api/health-sync/devices/${DEVICE}/runs`, permission: 'goals:read' },
    { method: 'post', path: `/api/health-sync/devices/${DEVICE}/diagnostics`, permission: 'goals:write', body: { report: {} } },
    { method: 'get', path: `/api/health-sync/devices/${DEVICE}/diagnostics`, permission: 'goals:read' },
    { method: 'get', path: `/api/health-sync/devices/${DEVICE}/diagnostics/${REPORT}`, permission: 'goals:read' },
    { method: 'get', path: `/api/sleep?from=${daysAgo(13)}&to=${TODAY}`, permission: 'health_data:read' },
    { method: 'delete', path: `/api/sleep/${SLEEP}`, permission: 'health_data:write' },
  ];

  describe('declared permission metadata (the matrix)', () => {
    const matrix: Array<[keyof HealthSyncController, string]> = [
      ['register', 'goals:write'],
      ['list', 'goals:read'],
      ['get', 'goals:read'],
      ['unpair', 'goals:write'],
      ['sync', 'goals:write'],
      ['listRuns', 'goals:read'],
      ['uploadDiagnostics', 'goals:write'],
      ['listDiagnostics', 'goals:read'],
      ['getDiagnostics', 'goals:read'],
    ];

    it.each(matrix)('HealthSyncController.%s requires exactly %s', (method, permission) => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, HealthSyncController.prototype[method])).toEqual([permission]);
    });

    it.each([
      ['list', 'health_data:read'],
      ['remove', 'health_data:write'],
    ] as Array<[keyof SleepController, string]>)('SleepController.%s requires exactly %s', (method, permission) => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, SleepController.prototype[method])).toEqual([permission]);
    });
  });

  describe.each(ROUTES)('$method $path ($permission)', ({ method, path, permission, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).send(body as object).expect(401);
    });

    it(`returns 403 without ${permission}, touching nothing`, async () => {
      const user = await createMockContributorUser(context);
      stripPermission(prisma, user.id, permission);

      const response = await request(server())[method](path).set(authHeader(user.accessToken)).send(body as object).expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.healthSyncDevice.findFirst).not.toHaveBeenCalled();
      expect(prisma.healthSyncDevice.upsert).not.toHaveBeenCalled();
      expect(prisma.sleepSession.findMany).not.toHaveBeenCalled();
      expect(prisma.sleepSession.deleteMany).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role to list devices and sleep', async (_role, create) => {
    const user = await create(context);
    prisma.healthSyncDevice.findMany.mockResolvedValue([]);
    prisma.sleepSession.findMany.mockResolvedValue([]);
    await request(server()).get('/api/health-sync/devices').set(authHeader(user.accessToken)).expect(200);
    await request(server()).get(`/api/sleep?from=${daysAgo(13)}&to=${TODAY}`).set(authHeader(user.accessToken)).expect(200);
  });

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  describe('devices', () => {
    it('links the PAT a phone registers with; tokenExpiresAt comes from it', async () => {
      const user = await createMockContributorUser(context);
      const fullUser = await prisma.user.findUnique({ where: { id: user.id } });
      const rawToken = 'pat_health_sync_fixture';
      const patId = randomUUID();
      const expiresAt = new Date(Date.now() + 90 * 86_400_000);
      prisma.personalAccessToken.findUnique.mockImplementation(async ({ where }: any) =>
        where.tokenHash === createHash('sha256').update(rawToken).digest('hex')
          ? { id: patId, userId: user.id, expiresAt, revokedAt: null, user: fullUser }
          : null,
      );
      prisma.personalAccessToken.update.mockResolvedValue({});
      prisma.healthSyncDevice.upsert.mockImplementation(async ({ create }: any) =>
        deviceRow(user.id, { ...create, pat: { expiresAt, revokedAt: null } }),
      );

      const response = await request(server())
        .post('/api/health-sync/devices')
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ installationId: INSTALLATION, name: 'Pixel 9', timezone: 'America/Costa_Rica' })
        .expect(200);

      expect(prisma.healthSyncDevice.upsert.mock.calls[0][0].create).toMatchObject({ patId, userId: user.id });
      expect(response.body.data).toMatchObject({
        id: DEVICE,
        name: 'Pixel 9',
        status: 'active',
        userTimezone: null,
        tokenExpiresAt: expiresAt.toISOString(),
      });
    });

    it('refuses a malformed signing fingerprint and an unknown field', async () => {
      const user = await createMockContributorUser(context);
      for (const body of [
        { installationId: INSTALLATION, name: 'P', signingSha256: 'ab:cd' },
        { installationId: INSTALLATION, name: 'P', status: 'active' },
        { installationId: 'nope', name: 'P' },
      ]) {
        await request(server()).post('/api/health-sync/devices').set(authHeader(user.accessToken)).send(body).expect(400);
      }
      expect(prisma.healthSyncDevice.upsert).not.toHaveBeenCalled();
    });

    it("is a 404 for another user's device", async () => {
      const user = await createMockContributorUser(context);
      prisma.healthSyncDevice.findFirst.mockResolvedValue(null);
      await request(server()).get(`/api/health-sync/devices/${DEVICE}`).set(authHeader(user.accessToken)).expect(404);
      expect(prisma.healthSyncDevice.findFirst.mock.calls[0][0].where).toEqual({ id: DEVICE, userId: user.id });
    });

    it('unpairs with 204 and deleteEntries=true', async () => {
      const user = await createMockContributorUser(context);
      prisma.healthSyncDevice.findFirst.mockResolvedValue(deviceRow(user.id, { patId: randomUUID() }));
      prisma.personalAccessToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.activityEntry.deleteMany.mockResolvedValue({ count: 3 });
      prisma.sleepSession.deleteMany.mockResolvedValue({ count: 0 });
      prisma.measurement.updateMany.mockResolvedValue({ count: 0 });

      await request(server())
        .delete(`/api/health-sync/devices/${DEVICE}?deleteEntries=true`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(prisma.personalAccessToken.updateMany).toHaveBeenCalled();
      expect(prisma.activityEntry.deleteMany).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  describe('sync', () => {
    const path = `/api/health-sync/devices/${DEVICE}/sync`;

    it('upserts entries and answers the counts', async () => {
      const user = await createMockContributorUser(context);
      prisma.healthSyncDevice.findFirst.mockResolvedValue(deviceRow(user.id));

      const response = await request(server())
        .post(path)
        .set(authHeader(user.accessToken))
        .send({
          run: RUN,
          window: { from: daysAgo(6), to: TODAY },
          entries: [{ externalId: `steps:${TODAY}`, occurredOn: TODAY, activityKind: 'steps', steps: 9000 }],
        })
        .expect(200);

      expect(response.body.data).toMatchObject({
        created: 1,
        updated: 0,
        deleted: 0,
        measurements: { created: 0, updated: 0, deleted: 0 },
        sleep: { created: 0, updated: 0, deleted: 0 },
      });
      expect(typeof response.body.data.runId).toBe('string');
    });

    it('answers 403 for measurements without health_data:write', async () => {
      const user = await createMockContributorUser(context);
      stripPermission(prisma, user.id, 'health_data:write');

      const response = await request(server())
        .post(path)
        .set(authHeader(user.accessToken))
        .send({
          run: RUN,
          entries: [],
          measurements: [{ externalId: 'w1', metricKey: 'weight', value: 80, unit: 'kg', measuredAt: NOW.toISOString() }],
        })
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('answers 409 DEVICE_REVOKED for an unpaired device', async () => {
      const user = await createMockContributorUser(context);
      prisma.healthSyncDevice.findFirst.mockResolvedValue(deviceRow(user.id, { status: 'revoked' }));
      const response = await request(server()).post(path).set(authHeader(user.accessToken)).send({ run: RUN, entries: [] }).expect(409);
      expect(response.body.details.reason).toBe('DEVICE_REVOKED');
    });

    it('answers 400 ENTRY_DATE_OUT_OF_RANGE with the path, and WINDOW_TOO_LARGE', async () => {
      const user = await createMockContributorUser(context);
      prisma.healthSyncDevice.findFirst.mockResolvedValue(deviceRow(user.id));

      const old = await request(server())
        .post(path)
        .set(authHeader(user.accessToken))
        .send({ run: RUN, entries: [{ externalId: 'x', occurredOn: daysAgo(31), activityKind: 'walk' }] })
        .expect(400);
      expect(old.body.details).toMatchObject({ reason: 'ENTRY_DATE_OUT_OF_RANGE', path: 'entries.0.occurredOn' });

      const wide = await request(server())
        .post(path)
        .set(authHeader(user.accessToken))
        .send({ run: RUN, window: { from: daysAgo(30), to: daysAgo(-1) }, entries: [] })
        .expect(400);
      expect(wide.body.details).toMatchObject({ reason: 'WINDOW_TOO_LARGE' });
      expect(prisma.healthSyncRun.create).not.toHaveBeenCalled();
    });

    it('refuses a steps entry without steps and a reading in the wrong unit', async () => {
      const user = await createMockContributorUser(context);
      await request(server())
        .post(path)
        .set(authHeader(user.accessToken))
        .send({ run: RUN, entries: [{ externalId: 'x', occurredOn: TODAY, activityKind: 'steps' }] })
        .expect(400);
      await request(server())
        .post(path)
        .set(authHeader(user.accessToken))
        .send({
          run: RUN,
          entries: [],
          measurements: [{ externalId: 'w1', metricKey: 'weight', value: 180, unit: 'lb', measuredAt: NOW.toISOString() }],
        })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Runs, diagnostics, sleep
  // ---------------------------------------------------------------------------

  it('lists runs newest first with the limit, and caps it at 200', async () => {
    const user = await createMockContributorUser(context);
    prisma.healthSyncDevice.findFirst.mockResolvedValue(deviceRow(user.id));
    prisma.healthSyncRun.findMany.mockResolvedValue([]);

    await request(server()).get(`/api/health-sync/devices/${DEVICE}/runs?limit=10`).set(authHeader(user.accessToken)).expect(200);
    expect(prisma.healthSyncRun.findMany.mock.calls[0][0]).toMatchObject({ take: 10, where: { deviceId: DEVICE, userId: user.id } });

    await request(server()).get(`/api/health-sync/devices/${DEVICE}/runs?limit=201`).set(authHeader(user.accessToken)).expect(400);
  });

  it('stores a diagnostics report (201) and returns it in detail', async () => {
    const user = await createMockContributorUser(context);
    prisma.healthSyncDevice.findFirst.mockResolvedValue(deviceRow(user.id, { status: 'revoked' }));
    prisma.healthSyncDiagnosticReport.create.mockResolvedValue({ id: REPORT, createdAt: NOW });
    prisma.healthSyncDiagnosticReport.findFirst.mockResolvedValue({
      id: REPORT,
      deviceId: DEVICE,
      userId: user.id,
      summary: 'all green',
      report: { checks: [{ id: 'app.version', status: 'pass' }] },
      createdAt: NOW,
    });

    const created = await request(server())
      .post(`/api/health-sync/devices/${DEVICE}/diagnostics`)
      .set(authHeader(user.accessToken))
      .send({ summary: 'all green', report: { checks: [{ id: 'app.version', status: 'pass' }] } })
      .expect(201);
    expect(created.body.data).toEqual({ id: REPORT, createdAt: NOW.toISOString() });

    const detail = await request(server())
      .get(`/api/health-sync/devices/${DEVICE}/diagnostics/${REPORT}`)
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(detail.body.data).toMatchObject({ id: REPORT, summary: 'all green', report: { checks: [{ id: 'app.version' }] } });
  });

  it('lists sleep newest day first and refuses a range over 400 days', async () => {
    const user = await createMockContributorUser(context);
    prisma.sleepSession.findMany.mockResolvedValue([
      {
        id: SLEEP,
        userId: user.id,
        startAt: new Date(`${daysAgo(1)}T22:30:00Z`),
        endAt: new Date(`${TODAY}T06:30:00Z`),
        localDate: new Date(`${TODAY}T00:00:00Z`),
        durationMinutes: 450,
        awakeMinutes: 30,
        lightMinutes: 200,
        deepMinutes: 100,
        remMinutes: 150,
        unknownMinutes: null,
        origin: 'device',
        provider: `health_connect:${DEVICE}`,
        externalId: 'sleep-1',
        healthSyncDeviceId: DEVICE,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const response = await request(server())
      .get(`/api/sleep?from=${daysAgo(13)}&to=${TODAY}`)
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({ id: SLEEP, localDate: TODAY, durationMinutes: 450, origin: 'device', provider: `health_connect:${DEVICE}` }),
    ]);
    expect(prisma.sleepSession.findMany.mock.calls[0][0].orderBy[0]).toEqual({ localDate: 'desc' });

    await request(server()).get(`/api/sleep?from=${daysAgo(400)}&to=${TODAY}`).set(authHeader(user.accessToken)).expect(400);
  });

  it("deletes a sleep session, 404 for another user's", async () => {
    const user = await createMockContributorUser(context);
    prisma.sleepSession.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await request(server()).delete(`/api/sleep/${SLEEP}`).set(authHeader(user.accessToken)).expect(204);
    await request(server()).delete(`/api/sleep/${SLEEP}`).set(authHeader(user.accessToken)).expect(404);
    expect(prisma.sleepSession.deleteMany).toHaveBeenCalledWith({ where: { id: SLEEP, userId: user.id } });
  });
});
