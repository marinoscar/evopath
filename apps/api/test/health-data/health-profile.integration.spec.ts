// =============================================================================
// Integration: /api/health-profile (E2.1, #47) — mocked Prisma
// =============================================================================
//
// The HTTP contract end to end through the real guards, pipes, interceptor and
// exception filter: 401 without a token, 403 without the exact `health_data:*`
// permission, 200 in the `{ data }` envelope, 400 for every validation rule,
// 409 for a stale `If-Match`. Prisma is mocked; the unique index and cascade
// are proven against a real database in `health-profile.db.spec.ts`.
// =============================================================================

import request from 'supertest';

import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const PATH = '/api/health-profile';

const VALID = {
  dateOfBirth: '1990-06-15',
  sexAtBirth: 'female',
  heightMm: 1778,
  unitSystem: 'imperial',
  timeZone: 'Europe/Madrid',
  bio: 'Runs on weekends.',
};

function storedRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `hp-${userId}`,
    userId,
    dateOfBirth: new Date('1990-06-15T00:00:00.000Z'),
    sexAtBirth: 'female',
    heightMm: 1778,
    unitSystem: 'imperial',
    timeZone: 'Europe/Madrid',
    bio: 'Runs on weekends.',
    labUnits: 'conventional',
    version: 1,
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    updatedAt: new Date('2026-09-29T10:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Removes one permission from a mock user's role for every request. The JWT
 * strategy re-reads the user per request, so narrowing that read proves the
 * permissions guard refuses (see the same helper in
 * `db-backup-restore.integration.spec.ts`).
 */
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

describe('Health profile (integration)', () => {
  let context: TestContext;

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
  });

  describe('GET /api/health-profile', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get(PATH).expect(401);
    });

    it('returns 403 to a user without health_data:read', async () => {
      const viewer = await createMockViewerUser(context);
      stripPermission(context.prismaMock, viewer.id, 'health_data:read');

      const response = await request(server())
        .get(PATH)
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(context.prismaMock.healthProfile.findUnique).not.toHaveBeenCalled();
    });

    it('returns the empty profile in the envelope for a new user', async () => {
      const viewer = await createMockViewerUser(context);
      context.prismaMock.healthProfile.findUnique.mockResolvedValue(null);

      const response = await request(server())
        .get(PATH)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({
        dateOfBirth: null,
        sexAtBirth: null,
        heightMm: null,
        unitSystem: 'metric',
        timeZone: null,
        bio: null,
        labUnits: 'conventional',
        version: 0,
        updatedAt: null,
      });
      expect(response.body.meta?.timestamp).toBeDefined();
    });

    it('reads only the caller\'s row', async () => {
      const viewer = await createMockViewerUser(context);
      context.prismaMock.healthProfile.findUnique.mockResolvedValue(storedRow(viewer.id));

      const response = await request(server())
        .get(PATH)
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({ dateOfBirth: '1990-06-15', version: 1 });
      expect(context.prismaMock.healthProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: viewer.id },
      });
    });

    it.each([
      ['admin', createMockAdminUser],
      ['contributor', createMockContributorUser],
      ['viewer', createMockViewerUser],
    ])('admits the seeded %s role', async (_role, create) => {
      const user = await create(context);
      context.prismaMock.healthProfile.findUnique.mockResolvedValue(null);

      await request(server()).get(PATH).set(authHeader(user.accessToken)).expect(200);
    });
  });

  describe('PUT /api/health-profile', () => {
    it('returns 401 without a token', async () => {
      await request(server()).put(PATH).send(VALID).expect(401);
    });

    it('returns 403 to a user without health_data:write, and writes nothing', async () => {
      const viewer = await createMockViewerUser(context);
      stripPermission(context.prismaMock, viewer.id, 'health_data:write');

      await request(server()).put(PATH).set(authHeader(viewer.accessToken)).send(VALID).expect(403);

      expect(context.prismaMock.healthProfile.create).not.toHaveBeenCalled();
      expect(context.prismaMock.healthProfile.updateMany).not.toHaveBeenCalled();
    });

    it('still lets that user read (control for the case above)', async () => {
      const viewer = await createMockViewerUser(context);
      stripPermission(context.prismaMock, viewer.id, 'health_data:write');
      context.prismaMock.healthProfile.findUnique.mockResolvedValue(null);

      await request(server()).get(PATH).set(authHeader(viewer.accessToken)).expect(200);
    });

    it('creates the first profile and returns version 1 in the envelope', async () => {
      const viewer = await createMockViewerUser(context);
      context.prismaMock.healthProfile.findUnique.mockResolvedValue(null);
      context.prismaMock.healthProfile.create.mockResolvedValue(storedRow(viewer.id));

      const response = await request(server())
        .put(PATH)
        .set(authHeader(viewer.accessToken))
        .send(VALID)
        .expect(200);

      expect(response.body.data).toEqual({
        ...VALID,
        labUnits: 'conventional',
        version: 1,
        updatedAt: '2026-09-29T10:00:00.000Z',
      });
      expect(context.prismaMock.healthProfile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: viewer.id, version: 1 }),
      });
      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'health_profile:update',
          targetType: 'health_profile',
          targetId: viewer.id,
        }),
      });
    });

    it('updates with a matching If-Match and returns version 2', async () => {
      const viewer = await createMockViewerUser(context);
      context.prismaMock.healthProfile.findUnique.mockResolvedValue(
        storedRow(viewer.id, { heightMm: 1700 }),
      );
      context.prismaMock.healthProfile.updateMany.mockResolvedValue({ count: 1 });
      context.prismaMock.healthProfile.findUniqueOrThrow.mockResolvedValue(
        storedRow(viewer.id, { version: 2 }),
      );

      const response = await request(server())
        .put(PATH)
        .set(authHeader(viewer.accessToken))
        .set('If-Match', '1')
        .send(VALID)
        .expect(200);

      expect(response.body.data.version).toBe(2);
      expect(context.prismaMock.healthProfile.updateMany).toHaveBeenCalledWith({
        where: { userId: viewer.id, version: 1 },
        data: expect.objectContaining({ version: { increment: 1 } }),
      });
    });

    it('saves labUnits and keeps it when a later PUT omits it', async () => {
      const viewer = await createMockViewerUser(context);
      context.prismaMock.healthProfile.findUnique.mockResolvedValue(storedRow(viewer.id));
      context.prismaMock.healthProfile.updateMany.mockResolvedValue({ count: 1 });
      context.prismaMock.healthProfile.findUniqueOrThrow.mockResolvedValue(
        storedRow(viewer.id, { version: 2, labUnits: 'si' }),
      );

      const response = await request(server())
        .put(PATH)
        .set(authHeader(viewer.accessToken))
        .send({ ...VALID, labUnits: 'si' })
        .expect(200);

      expect(response.body.data.labUnits).toBe('si');
      expect(context.prismaMock.healthProfile.updateMany).toHaveBeenLastCalledWith({
        where: { userId: viewer.id, version: 1 },
        data: expect.objectContaining({ labUnits: 'si' }),
      });
      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ meta: { fields: ['labUnits'] } }),
      });

      await request(server()).put(PATH).set(authHeader(viewer.accessToken)).send(VALID).expect(200);
      const data = (context.prismaMock.healthProfile.updateMany as jest.Mock).mock.calls.at(-1)[0].data;
      expect(data).not.toHaveProperty('labUnits');
    });

    it('returns 409 for a stale If-Match', async () => {
      const viewer = await createMockViewerUser(context);
      context.prismaMock.healthProfile.findUnique.mockResolvedValue(
        storedRow(viewer.id, { version: 2 }),
      );

      const response = await request(server())
        .put(PATH)
        .set(authHeader(viewer.accessToken))
        .set('If-Match', '1')
        .send(VALID)
        .expect(409);

      expect(response.body).toMatchObject({ statusCode: 409, code: 'CONFLICT', path: PATH });
      expect(context.prismaMock.healthProfile.updateMany).not.toHaveBeenCalled();
    });

    it('returns 400 for a malformed If-Match', async () => {
      const viewer = await createMockViewerUser(context);

      await request(server())
        .put(PATH)
        .set(authHeader(viewer.accessToken))
        .set('If-Match', 'abc')
        .send(VALID)
        .expect(400);

      expect(context.prismaMock.$transaction).not.toHaveBeenCalled();
    });

    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    it.each([
      ['dateOfBirth in the future', { dateOfBirth: future }],
      ['dateOfBirth more than 120 years ago', { dateOfBirth: '1850-01-01' }],
      ['dateOfBirth 2026-02-30', { dateOfBirth: '2026-02-30' }],
      ["sexAtBirth 'x'", { sexAtBirth: 'x' }],
      ['heightMm 100', { heightMm: 100 }],
      ['heightMm 3000', { heightMm: 3000 }],
      ['heightMm 1778.5', { heightMm: 1778.5 }],
      ["timeZone 'Mars/Base'", { timeZone: 'Mars/Base' }],
      ['bio over 1000 characters', { bio: 'b'.repeat(1001) }],
      ['an unknown extra property', { weightKg: 70 }],
      ["labUnits 'metric'", { labUnits: 'metric' }],
      ['labUnits null', { labUnits: null }],
      ['a missing unitSystem', { unitSystem: undefined }],
    ])('returns 400 for %s', async (_case, patch) => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .put(PATH)
        .set(authHeader(viewer.accessToken))
        .send({ ...VALID, ...patch })
        .expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
      expect(context.prismaMock.healthProfile.create).not.toHaveBeenCalled();
      expect(context.prismaMock.healthProfile.updateMany).not.toHaveBeenCalled();
    });

    it('does not echo the bio in a validation error', async () => {
      const viewer = await createMockViewerUser(context);
      const bio = `do-not-echo-${'b'.repeat(1000)}`;

      const response = await request(server())
        .put(PATH)
        .set(authHeader(viewer.accessToken))
        .send({ ...VALID, bio })
        .expect(400);

      expect(JSON.stringify(response.body)).not.toContain('do-not-echo');
    });

    it('returns 200 even when the audit write fails', async () => {
      const viewer = await createMockViewerUser(context);
      context.prismaMock.healthProfile.findUnique.mockResolvedValue(null);
      context.prismaMock.healthProfile.create.mockResolvedValue(storedRow(viewer.id));
      context.prismaMock.auditEvent.create.mockRejectedValue(new Error('audit down'));

      await request(server()).put(PATH).set(authHeader(viewer.accessToken)).send(VALID).expect(200);
    });
  });
});
