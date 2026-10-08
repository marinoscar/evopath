// =============================================================================
// Integration: /api/programs (E5.1)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter, over a mocked Prisma: 401 without a token and 403 without the exact
// permission on every route; all three seeded roles (Viewer included: manual
// plans need no AI) are admitted; another user's program is a 404; the
// `If-Match` requirement and its 409; Zod bounds answer 400 with field paths;
// literal sub-routes are not parsed as ids. The chokepoint's concurrency and
// history rules are proven in `programs.db.spec.ts`.
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

const PROGRAM = '11111111-1111-4111-8111-111111111111';
const LOG = '22222222-2222-4222-8222-222222222222';
const EXERCISE = '44444444-4444-4444-8444-444444444444';
const NOW = new Date();

function programRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: PROGRAM,
    userId,
    name: 'Plan',
    goal: 'strength',
    status: 'draft',
    source: 'manual',
    autonomy: 'autonomous',
    startDate: null,
    gymId: null,
    gym: null,
    intake: null,
    notes: null,
    rationale: null,
    currentVersion: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const VALID_TREE = {
  blocks: [
    {
      position: 0,
      name: 'Base',
      weeks: [
        {
          weekNumber: 1,
          workouts: [
            {
              position: 0,
              weekday: 1,
              name: 'Upper',
              exercises: [{ exerciseId: EXERCISE, position: 0, targetSets: 3, repMin: 8, repMax: 12, restSeconds: 90 }],
            },
          ],
        },
      ],
    },
  ],
};

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

describe('Programs (integration)', () => {
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
    // The caller owns nothing unless a test says so.
    prisma.program.findFirst.mockResolvedValue(null);
    prisma.program.findMany.mockResolvedValue([]);
    prisma.program.updateMany.mockResolvedValue({ count: 0 });
    prisma.program.deleteMany.mockResolvedValue({ count: 0 });
  });

  /** The caller owns PROGRAM with an empty tree at version 3. */
  function owns(userId: string, overrides: Record<string, unknown> = {}) {
    prisma.program.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === PROGRAM && where.userId === userId ? programRow(userId, overrides) : null,
    );
    for (const model of ['programBlock', 'programWeek', 'programWorkout', 'programExercise', 'workout', 'exercise']) {
      prisma[model].findMany.mockResolvedValue([]);
    }
    prisma.programVersion.findUnique.mockResolvedValue(null);
  }

  // ---------------------------------------------------------------------------
  // Access control, per route
  // ---------------------------------------------------------------------------

  // Activation accepts a start day at most 7 days back, so the fixture must not be a fixed date.
  const TODAY = new Date().toISOString().slice(0, 10);

  const ROUTES: Array<{ method: 'get' | 'post' | 'patch' | 'put' | 'delete'; path: string; permission: string; body?: unknown }> = [
    { method: 'get', path: '/api/programs', permission: 'programs:read' },
    { method: 'post', path: '/api/programs', permission: 'programs:write', body: { name: 'P', goal: 'strength' } },
    { method: 'get', path: `/api/programs/${PROGRAM}`, permission: 'programs:read' },
    { method: 'patch', path: `/api/programs/${PROGRAM}`, permission: 'programs:write', body: { name: 'X' } },
    { method: 'put', path: `/api/programs/${PROGRAM}/structure`, permission: 'programs:write', body: VALID_TREE },
    { method: 'post', path: `/api/programs/${PROGRAM}/activate`, permission: 'programs:write', body: { startDate: TODAY } },
    { method: 'post', path: `/api/programs/${PROGRAM}/pause`, permission: 'programs:write' },
    { method: 'post', path: `/api/programs/${PROGRAM}/archive`, permission: 'programs:write' },
    { method: 'post', path: `/api/programs/${PROGRAM}/autonomy/resume`, permission: 'programs:write' },
    { method: 'post', path: `/api/programs/${PROGRAM}/duplicate`, permission: 'programs:write' },
    { method: 'delete', path: `/api/programs/${PROGRAM}`, permission: 'programs:write' },
    { method: 'get', path: `/api/programs/${PROGRAM}/versions`, permission: 'programs:read' },
    { method: 'get', path: `/api/programs/${PROGRAM}/versions/1`, permission: 'programs:read' },
    { method: 'post', path: `/api/programs/${PROGRAM}/revert`, permission: 'programs:write', body: { toVersion: 1 } },
    { method: 'get', path: `/api/programs/${PROGRAM}/change-log`, permission: 'programs:read' },
    { method: 'post', path: `/api/programs/${PROGRAM}/change-log/seen`, permission: 'programs:write', body: { upToId: LOG } },
  ];

  describe.each(ROUTES)('$method $path ($permission)', ({ method, path, permission, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).send(body as object).expect(401);
    });

    it(`returns 403 without ${permission}, touching no program data`, async () => {
      const user = await createMockContributorUser(context);
      stripPermission(prisma, user.id, permission);

      const response = await request(server())[method](path).set(authHeader(user.accessToken)).send(body as object).expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.program.findFirst).not.toHaveBeenCalled();
      expect(prisma.program.findMany).not.toHaveBeenCalled();
      expect(prisma.program.create).not.toHaveBeenCalled();
      expect(prisma.program.updateMany).not.toHaveBeenCalled();
    });

    if (path !== '/api/programs') {
      it('returns 404 for another user\'s program', async () => {
        const owner = await createMockContributorUser(context);
        const other = await createMockContributorUser(context);
        owns(owner.id);

        await request(server())
          [method](path)
          .set({ ...authHeader(other.accessToken), 'If-Match': '3' })
          .send(body as object)
          .expect(404);
      });
    }
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role to list and create manual programs', async (_role, create) => {
    const user = await create(context);
    prisma.program.create.mockImplementation(async ({ data }: any) => programRow(user.id, { ...data, currentVersion: 1 }));
    prisma.programBlock.findMany.mockResolvedValue([]);
    prisma.programBlock.createMany.mockResolvedValue({ count: 1 });
    prisma.programWeek.createMany.mockResolvedValue({ count: 1 });
    prisma.programChangeLog.create.mockResolvedValue({ id: LOG });
    owns(user.id, { currentVersion: 1 });

    await request(server()).get('/api/programs').set(authHeader(user.accessToken)).expect(200);
    const response = await request(server())
      .post('/api/programs')
      .set(authHeader(user.accessToken))
      .send({ name: 'My plan', goal: 'strength' })
      .expect(201);

    expect(response.body.data).toMatchObject({ id: PROGRAM, currentVersion: 1 });
    expect(response.headers.etag).toBe('"1"');
    expect(prisma.programVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ versionNumber: 1, origin: 'initial' }),
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/programs/:id
  // ---------------------------------------------------------------------------

  it('GET /:id returns the program with an ETag of its version', async () => {
    const user = await createMockContributorUser(context);
    owns(user.id);

    const response = await request(server()).get(`/api/programs/${PROGRAM}`).set(authHeader(user.accessToken)).expect(200);

    expect(response.headers.etag).toBe('"3"');
    expect(response.body.data).toMatchObject({ id: PROGRAM, currentVersion: 3, tree: { blocks: [] } });
  });

  it('GET /:id answers 400 for a non-uuid id', async () => {
    const user = await createMockContributorUser(context);
    await request(server()).get('/api/programs/not-a-uuid').set(authHeader(user.accessToken)).expect(400);
  });

  // ---------------------------------------------------------------------------
  // PUT /api/programs/:id/structure
  // ---------------------------------------------------------------------------

  describe('PUT /:id/structure', () => {
    it('requires If-Match (400 IF_MATCH_REQUIRED) before touching the program', async () => {
      const user = await createMockContributorUser(context);
      owns(user.id);

      const response = await request(server())
        .put(`/api/programs/${PROGRAM}/structure`)
        .set(authHeader(user.accessToken))
        .send(VALID_TREE)
        .expect(400);

      expect(response.body.details.reason).toBe('IF_MATCH_REQUIRED');
      expect(prisma.program.updateMany).not.toHaveBeenCalled();
    });

    it('answers 409 TRAINING_STALE_PLAN with currentVersion on a stale If-Match', async () => {
      const user = await createMockContributorUser(context);
      owns(user.id);

      const response = await request(server())
        .put(`/api/programs/${PROGRAM}/structure`)
        .set({ ...authHeader(user.accessToken), 'If-Match': '"2"' })
        .send(VALID_TREE)
        .expect(409);

      expect(response.body.details).toEqual({ reason: 'TRAINING_STALE_PLAN', currentVersion: 3 });
      expect(prisma.program.updateMany).toHaveBeenCalledWith({
        where: { id: PROGRAM, userId: user.id, currentVersion: 2, status: { not: 'archived' } },
        data: { currentVersion: { increment: 1 } },
      });
      expect(prisma.programVersion.create).not.toHaveBeenCalled();
    });

    it.each([
      ['repMin above repMax', { repMin: 12, repMax: 8 }, 'repMax'],
      ['targetRpe off the grid', { targetRpe: 7.2 }, 'targetRpe'],
      ['restSeconds above 900', { restSeconds: 1000 }, 'restSeconds'],
    ])('answers 400 with a field path for %s, before any write', async (_label, patch, field) => {
      const user = await createMockContributorUser(context);
      const tree = structuredClone(VALID_TREE);
      Object.assign(tree.blocks[0].weeks[0].workouts[0].exercises[0], patch);

      const response = await request(server())
        .put(`/api/programs/${PROGRAM}/structure`)
        .set({ ...authHeader(user.accessToken), 'If-Match': '3' })
        .send(tree)
        .expect(400);

      expect(response.body.details.issues.map((issue: any) => issue.path).join()).toContain(field);
      expect(prisma.program.updateMany).not.toHaveBeenCalled();
    });

    it('answers 400 for a duplicate weekday in a week', async () => {
      const user = await createMockContributorUser(context);
      const tree = structuredClone(VALID_TREE);
      tree.blocks[0].weeks[0].workouts.push({ ...tree.blocks[0].weeks[0].workouts[0], position: 1 });

      const response = await request(server())
        .put(`/api/programs/${PROGRAM}/structure`)
        .set({ ...authHeader(user.accessToken), 'If-Match': '3' })
        .send(tree)
        .expect(400);

      expect(JSON.stringify(response.body.details.issues)).toMatch(/weekday/);
    });
  });

  // ---------------------------------------------------------------------------
  // Revert and lifecycle refusals
  // ---------------------------------------------------------------------------

  it('POST /:id/revert refuses both toVersion and changeLogId (400) and requires If-Match', async () => {
    const user = await createMockContributorUser(context);
    owns(user.id);

    await request(server())
      .post(`/api/programs/${PROGRAM}/revert`)
      .set({ ...authHeader(user.accessToken), 'If-Match': '3' })
      .send({ toVersion: 1, changeLogId: LOG })
      .expect(400);

    const missing = await request(server())
      .post(`/api/programs/${PROGRAM}/revert`)
      .set(authHeader(user.accessToken))
      .send({ toVersion: 1 })
      .expect(400);
    expect(missing.body.details.reason).toBe('IF_MATCH_REQUIRED');
  });

  it('POST /:id/autonomy/resume clears the automation pause, owner-scoped, and returns the program', async () => {
    const user = await createMockContributorUser(context);
    owns(user.id, { autonomyPausedAt: null, autonomyPausedReason: null });
    prisma.program.updateMany.mockResolvedValue({ count: 1 });

    const response = await request(server()).post(`/api/programs/${PROGRAM}/autonomy/resume`).set(authHeader(user.accessToken)).expect(200);

    expect(prisma.program.updateMany).toHaveBeenCalledWith({
      where: { id: PROGRAM, userId: user.id, autonomyPausedAt: { not: null } },
      data: { autonomyPausedAt: null, autonomyPausedReason: null },
    });
    expect(response.body.data).toMatchObject({ id: PROGRAM, autonomyPausedAt: null, autonomyPausedReason: null });
  });

  it('POST /:id/pause answers 409 ILLEGAL_TRANSITION for a draft', async () => {
    const user = await createMockContributorUser(context);
    owns(user.id);

    const response = await request(server()).post(`/api/programs/${PROGRAM}/pause`).set(authHeader(user.accessToken)).expect(409);
    expect(response.body.details).toEqual({ reason: 'ILLEGAL_TRANSITION', status: 'draft' });
  });

  it('DELETE /:id answers 409 PROGRAM_HAS_HISTORY when a logged workout links into it', async () => {
    const user = await createMockContributorUser(context);
    owns(user.id);
    prisma.workout.findFirst.mockResolvedValue({ id: 'w' });

    const response = await request(server()).delete(`/api/programs/${PROGRAM}`).set(authHeader(user.accessToken)).expect(409);
    expect(response.body.details.reason).toBe('PROGRAM_HAS_HISTORY');
    expect(prisma.program.deleteMany).not.toHaveBeenCalled();
  });

  it('GET /:id/change-log rejects a malformed cursor with 400', async () => {
    const user = await createMockContributorUser(context);
    owns(user.id);

    await request(server())
      .get(`/api/programs/${PROGRAM}/change-log?cursor=garbage`)
      .set(authHeader(user.accessToken))
      .expect(400);
  });

  it('GET /:id/versions/:n rejects a non-integer version with 400', async () => {
    const user = await createMockContributorUser(context);
    owns(user.id);

    await request(server()).get(`/api/programs/${PROGRAM}/versions/latest`).set(authHeader(user.accessToken)).expect(400);
  });
});
