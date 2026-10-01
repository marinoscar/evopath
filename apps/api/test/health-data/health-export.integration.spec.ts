import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { HealthExportController } from '../../src/health-export/health-export.controller';
import {
  HEALTH_EXPORT_JOB_TYPE,
  HEALTH_EXPORT_PURGE_JOB_TYPE,
} from '../../src/health-export/health-export.constants';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// /api/health/exports integration (H7, #191)
// =============================================================================
//
// Through the REAL `AppModule` wiring over the mocked Prisma client: every
// route is `health_data:read`, 401 without a token, 403 without the exact
// permission, the 202 enqueue (subject = the caller, never deduplicated),
// request validation with nothing queued, the in-flight cap (429), the
// owner-scoped status read (404 for anything else), and both job types
// registered as server-only.
// =============================================================================

const BASE = '/api/health/exports';
const EXPORT_ID = '44444444-4444-4444-8444-444444444444';

const VALID = { format: 'pdf', from: '2026-01-01', to: '2026-09-30', datasets: ['labs', 'profile'] };

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
          rolePermissions: (userRole.role.rolePermissions ?? []).filter(
            (rp: any) => rp.permission.name !== permission,
          ),
        },
      })),
    };
  });
}

function jobRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: EXPORT_ID,
    status: 'pending',
    createdAt: new Date('2026-09-30T10:00:00.000Z'),
    finishedAt: null,
    payload: {
      userId,
      format: 'pdf',
      from: '2026-01-01',
      to: '2026-09-30',
      datasets: ['profile', 'labs'],
      includeHistory: false,
    },
    ...overrides,
  };
}

describe('Health export (integration)', () => {
  let context: TestContext;
  let prisma: any;
  const server = () => context.app.getHttpServer();

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
    prisma = context.prismaMock;
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    prisma.job.count.mockResolvedValue(0);
    prisma.storageObject.findMany.mockResolvedValue([]);
  });

  it.each(['request', 'list', 'get'] as const)('%s requires exactly health_data:read', (method) => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, HealthExportController.prototype[method])).toEqual([
      'health_data:read',
    ]);
  });

  it('registers health.export and health.export.purge as server-only', () => {
    const registry = context.module.get(JobHandlerRegistry);
    for (const type of [HEALTH_EXPORT_JOB_TYPE, HEALTH_EXPORT_PURGE_JOB_TYPE]) {
      expect(registry.types()).toContain(type);
      expect(registry.serverOnlyTypes()).toContain(type);
    }
  });

  const ROUTES = [
    { method: 'post' as const, path: BASE, body: VALID },
    { method: 'get' as const, path: BASE, body: undefined },
    { method: 'get' as const, path: `${BASE}/${EXPORT_ID}`, body: undefined },
  ];

  describe.each(ROUTES)('$method $path', ({ method, path, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).send(body as object).expect(401);
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it('returns 403 without health_data:read, touching no job', async () => {
      const viewer = await createMockViewerUser(context);
      stripPermission(prisma, viewer.id, 'health_data:read');

      const res = await request(server())[method](path).set(authHeader(viewer.accessToken)).send(body as object).expect(403);

      expect(res.body.code).toBe('FORBIDDEN');
      expect(prisma.job.create).not.toHaveBeenCalled();
      expect(prisma.job.findFirst).not.toHaveBeenCalled();
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role', async (_role, create) => {
    const user = await create(context);
    prisma.job.findMany.mockResolvedValue([]);
    await request(server()).get(BASE).set(authHeader(user.accessToken)).expect(200);
  });

  describe('POST /api/health/exports', () => {
    it('queues a health.export for the caller and answers 202 with the pending export', async () => {
      const user = await createMockViewerUser(context);
      prisma.job.create.mockImplementation(async ({ data }: any) => ({
        id: EXPORT_ID,
        status: 'pending',
        createdAt: new Date('2026-09-30T10:00:00.000Z'),
        finishedAt: null,
        ...data,
      }));

      const res = await request(server()).post(BASE).set(authHeader(user.accessToken)).send(VALID).expect(202);

      expect(res.body.data).toMatchObject({
        id: EXPORT_ID,
        status: 'pending',
        format: 'pdf',
        from: '2026-01-01',
        to: '2026-09-30',
        // Canonical order, whatever the request said.
        datasets: ['profile', 'labs'],
        includeHistory: false,
        fileName: null,
        download: null,
      });
      expect(prisma.job.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: HEALTH_EXPORT_JOB_TYPE,
          subjectType: 'user',
          subjectId: user.id,
          dedupKey: null,
          payload: expect.objectContaining({ userId: user.id, format: 'pdf' }),
        }),
      });
    });

    it.each([
      ['an unknown format', { ...VALID, format: 'docx' }],
      ['no datasets', { ...VALID, datasets: [] }],
      ['an unknown dataset', { ...VALID, datasets: ['labs', 'workouts'] }],
      ['a repeated dataset', { ...VALID, datasets: ['labs', 'labs'] }],
      ['from after to', { ...VALID, from: '2026-10-01', to: '2026-09-01' }],
      ['a date that is not real', { ...VALID, from: '2026-02-30' }],
      ['a datetime instead of a date', { ...VALID, to: '2026-09-30T00:00:00Z' }],
      ['a range over ten years', { ...VALID, from: '2010-01-01' }],
      ['a range ending in the future', { ...VALID, to: '2099-01-01' }],
      ['an unknown property', { ...VALID, userId: '55555555-5555-4555-8555-555555555555' }],
      ['an unknown labUnits', { ...VALID, labUnits: 'metric' }],
    ])('refuses %s with 400 and queues nothing', async (_case, body) => {
      const user = await createMockViewerUser(context);

      const res = await request(server()).post(BASE).set(authHeader(user.accessToken)).send(body).expect(400);

      expect(res.body.code).toBe('BAD_REQUEST');
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    describe('labUnits (#234)', () => {
      beforeEach(() => {
        prisma.job.create.mockImplementation(async ({ data }: any) => ({
          id: EXPORT_ID,
          status: 'pending',
          createdAt: new Date('2026-09-30T10:00:00.000Z'),
          finishedAt: null,
          ...data,
        }));
      });

      it.each([
        ['the profile preference when omitted', { labUnits: 'si' }, undefined, 'si'],
        ['conventional without a profile', null, undefined, 'conventional'],
        ['the request over the profile', { labUnits: 'si' }, 'conventional', 'conventional'],
        ['si when asked', null, 'si', 'si'],
      ])('uses %s, stores it on the job and echoes it', async (_case, profile, requested, expected) => {
        const user = await createMockViewerUser(context);
        prisma.healthProfile.findUnique.mockResolvedValue(profile);

        const body = requested ? { ...VALID, labUnits: requested } : VALID;
        const res = await request(server()).post(BASE).set(authHeader(user.accessToken)).send(body).expect(202);

        expect(res.body.data.labUnits).toBe(expected);
        expect(prisma.job.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ payload: expect.objectContaining({ labUnits: expected }) }),
        });
        if (requested) expect(prisma.healthProfile.findUnique).not.toHaveBeenCalled();
        else
          expect(prisma.healthProfile.findUnique).toHaveBeenCalledWith({
            where: { userId: user.id },
            select: { labUnits: true },
          });
      });

      it('reads a job queued before the preference existed as conventional', async () => {
        const user = await createMockViewerUser(context);
        prisma.job.findMany.mockResolvedValue([jobRow(user.id)]);

        const res = await request(server()).get(BASE).set(authHeader(user.accessToken)).expect(200);

        expect(res.body.data.items[0].labUnits).toBe('conventional');
      });
    });

    it('answers 429 while three exports are in flight', async () => {
      const user = await createMockViewerUser(context);
      prisma.job.count.mockResolvedValue(3);

      await request(server()).post(BASE).set(authHeader(user.accessToken)).send(VALID).expect(429);

      expect(prisma.job.count).toHaveBeenCalledWith({
        where: {
          type: HEALTH_EXPORT_JOB_TYPE,
          subjectType: 'user',
          subjectId: user.id,
          status: { in: ['pending', 'running'] },
        },
      });
      expect(prisma.job.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/health/exports/:id', () => {
    it("reads only the caller's own export, and 404s anything else", async () => {
      const user = await createMockViewerUser(context);
      prisma.job.findFirst.mockResolvedValue(null);

      const res = await request(server()).get(`${BASE}/${EXPORT_ID}`).set(authHeader(user.accessToken)).expect(404);

      expect(res.body.code).toBe('NOT_FOUND');
      expect(prisma.job.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EXPORT_ID, type: HEALTH_EXPORT_JOB_TYPE, subjectType: 'user', subjectId: user.id },
        }),
      );
    });

    it('reports a failed export with a general message, never the job error', async () => {
      const user = await createMockViewerUser(context);
      prisma.job.findFirst.mockResolvedValue(jobRow(user.id, { status: 'failed', lastError: 'secret detail' }));

      const res = await request(server()).get(`${BASE}/${EXPORT_ID}`).set(authHeader(user.accessToken)).expect(200);

      expect(res.body.data).toMatchObject({ status: 'failed', download: null });
      expect(res.body.data.error).toBe('The export could not be created. Please try again.');
      expect(JSON.stringify(res.body)).not.toContain('secret detail');
    });

    it('is a 400 for an id that is not a UUID', async () => {
      const user = await createMockViewerUser(context);
      await request(server()).get(`${BASE}/not-a-uuid`).set(authHeader(user.accessToken)).expect(400);
      expect(prisma.job.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/health/exports', () => {
    it("lists the caller's recent exports, newest first, without URLs", async () => {
      const user = await createMockViewerUser(context);
      prisma.job.findMany.mockResolvedValue([jobRow(user.id, { status: 'running' })]);

      const res = await request(server()).get(BASE).set(authHeader(user.accessToken)).expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0]).toMatchObject({ id: EXPORT_ID, status: 'running', download: null });
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { type: HEALTH_EXPORT_JOB_TYPE, subjectType: 'user', subjectId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      );
    });
  });
});
