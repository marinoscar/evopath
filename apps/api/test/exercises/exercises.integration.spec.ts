// =============================================================================
// Integration: /api/exercises (E4.1)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter, over a mocked Prisma: 401 without a token and 403 without the exact
// permission on every route; owner-scoping (another user's exercise and a
// foreign gym are 404); library exercises are read-only (403
// LIBRARY_EXERCISE_READ_ONLY); filters reach the query; `availableOnly` needs
// `gymId`; pending AI proposals stay out of the picker and `availableOnly`
// until approved. Real-row behaviour is proven in `exercises.db.spec.ts`.
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

const EXERCISE = '11111111-1111-4111-8111-111111111111';
const GYM = '22222222-2222-4222-8222-222222222222';
const DUMBBELLS = '33333333-3333-4333-8333-333333333333';
const LEG_PRESS_CAP = '44444444-4444-4444-8444-444444444444';
const BENCH = '55555555-5555-4555-8555-555555555555';

const NOW = new Date('2026-09-29T10:00:00.000Z');

function reqRow(groupIndex: number, target: { equipment?: [string, string]; capability?: [string, string] }) {
  return {
    id: `req-${groupIndex}-${target.equipment?.[0] ?? target.capability?.[0]}`,
    exerciseId: EXERCISE,
    groupIndex,
    equipmentTypeId: target.equipment?.[0] ?? null,
    capabilityId: target.capability?.[0] ?? null,
    equipmentType: target.equipment ? { id: target.equipment[0], slug: 'x', name: target.equipment[1] } : null,
    capability: target.capability ? { id: target.capability[0], slug: 'x', name: target.capability[1] } : null,
  };
}

function exerciseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXERCISE,
    slug: 'custom-abcd1234',
    name: 'Sled push',
    ownerUserId: null as string | null,
    primaryMuscles: ['quads'],
    secondaryMuscles: [],
    movementPattern: 'carry',
    trackingMode: 'distance_time',
    isUnilateral: false,
    isBodyweight: false,
    aliases: [],
    notes: null,
    origin: 'seed',
    status: 'active',
    proposedByRunId: null,
    createdAt: NOW,
    updatedAt: NOW,
    requirements: [] as any[],
    ...overrides,
  };
}

const dumbbellPress = () =>
  exerciseRow({
    id: '66666666-6666-4666-8666-666666666661',
    name: 'Dumbbell press',
    requirements: [reqRow(0, { equipment: [DUMBBELLS, 'Dumbbells'] }), reqRow(1, { equipment: [BENCH, 'Flat bench'] })],
  });
const legPress = () =>
  exerciseRow({
    id: '66666666-6666-4666-8666-666666666662',
    name: 'Leg press',
    requirements: [reqRow(0, { capability: [LEG_PRESS_CAP, 'Leg press'] })],
  });
const pushUp = () => exerciseRow({ id: '66666666-6666-4666-8666-666666666663', name: 'Push-up' });

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
          rolePermissions: (userRole.role.rolePermissions ?? []).filter(
            (rp: any) => rp.permission.name !== permission,
          ),
        },
      })),
    };
  });
}

describe('Exercises (integration)', () => {
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
    prisma.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
  });

  /** The caller owns GYM, which holds only dumbbells and a bench. */
  function mockDumbbellGym(userId: string) {
    prisma.gym.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === GYM && where.userId === userId ? { id: GYM, userId } : null,
    );
    prisma.gymEquipment.findMany.mockResolvedValue([{ equipmentTypeId: DUMBBELLS }, { equipmentTypeId: BENCH }]);
    prisma.equipmentTypeCapability.findMany.mockResolvedValue([]);
  }

  // ---------------------------------------------------------------------------
  // Access control, per route
  // ---------------------------------------------------------------------------

  const ROUTES: Array<{
    method: 'get' | 'post' | 'patch' | 'delete';
    path: string;
    permission: string;
    body?: unknown;
  }> = [
    { method: 'get', path: '/api/exercises', permission: 'exercises:read' },
    { method: 'get', path: `/api/exercises/${EXERCISE}`, permission: 'exercises:read' },
    {
      method: 'post',
      path: '/api/exercises',
      permission: 'exercises:write',
      body: { name: 'Sled push', primaryMuscles: ['quads'], movementPattern: 'carry' },
    },
    { method: 'patch', path: `/api/exercises/${EXERCISE}`, permission: 'exercises:write', body: { name: 'X' } },
    { method: 'delete', path: `/api/exercises/${EXERCISE}`, permission: 'exercises:write' },
    { method: 'post', path: `/api/exercises/${EXERCISE}/approve`, permission: 'exercises:write' },
  ];

  describe.each(ROUTES)('$method $path ($permission)', ({ method, path, permission, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).send(body as object).expect(401);
    });

    it(`returns 403 without ${permission}, touching no exercise data`, async () => {
      const user = await createMockContributorUser(context);
      stripPermission(prisma, user.id, permission);

      const response = await request(server())
        [method](path)
        .set(authHeader(user.accessToken))
        .send(body as object)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.exercise.findMany).not.toHaveBeenCalled();
      expect(prisma.exercise.findFirst).not.toHaveBeenCalled();
      expect(prisma.exercise.create).not.toHaveBeenCalled();
      expect(prisma.exercise.updateMany).not.toHaveBeenCalled();
      expect(prisma.exercise.deleteMany).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role to read and create exercises', async (_role, create) => {
    const user = await create(context);
    prisma.exercise.findMany.mockResolvedValue([]);
    prisma.exercise.count.mockResolvedValue(0);
    prisma.exercise.create.mockImplementation(async ({ data }: any) =>
      exerciseRow({ ...data, requirements: [], ownerUserId: user.id }),
    );

    await request(server()).get('/api/exercises').set(authHeader(user.accessToken)).expect(200);
    await request(server())
      .post('/api/exercises')
      .set(authHeader(user.accessToken))
      .send({ name: 'Sled push', primaryMuscles: ['quads'], movementPattern: 'carry' })
      .expect(201);
  });

  // ---------------------------------------------------------------------------
  // GET /api/exercises
  // ---------------------------------------------------------------------------

  describe('GET /api/exercises', () => {
    it('lists the library plus the caller\'s own, active only, in the { data } envelope', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findMany.mockResolvedValue([pushUp()]);

      const response = await request(server()).get('/api/exercises').set(authHeader(user.accessToken)).expect(200);

      expect(response.body.meta.timestamp).toBeDefined();
      expect(response.body.data).toEqual([
        expect.objectContaining({ name: 'Push-up', isCustom: false, origin: 'seed', status: 'active', requirements: [] }),
      ]);
      expect(response.body.data[0]).not.toHaveProperty('available');

      const where = prisma.exercise.findMany.mock.calls[0][0].where;
      expect(where.AND).toEqual(
        expect.arrayContaining([
          { OR: [{ ownerUserId: null }, { ownerUserId: user.id }] },
          { status: 'active' },
        ]),
      );
    });

    it('translates muscle, pattern, tracking and custom filters into the query', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findMany.mockResolvedValue([]);

      await request(server())
        .get('/api/exercises?muscle=chest&pattern=horizontal_push&tracking=weight_reps&custom=true')
        .set(authHeader(user.accessToken))
        .expect(200);

      const where = prisma.exercise.findMany.mock.calls[0][0].where;
      expect(where.AND).toEqual(
        expect.arrayContaining([
          { ownerUserId: user.id },
          { OR: [{ primaryMuscles: { has: 'chest' } }, { secondaryMuscles: { has: 'chest' } }] },
          { movementPattern: 'horizontal_push' },
          { trackingMode: 'weight_reps' },
        ]),
      );

      prisma.exercise.findMany.mockClear();
      await request(server()).get('/api/exercises?custom=false').set(authHeader(user.accessToken)).expect(200);
      expect(prisma.exercise.findMany.mock.calls[0][0].where.AND).toContainEqual({ ownerUserId: null });
    });

    it('matches q against the name and any alias, case-insensitively', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findMany.mockResolvedValue([
        dumbbellPress(),
        exerciseRow({ id: '66666666-6666-4666-8666-666666666664', name: 'Squat', aliases: ['Back Bench Thing'] }),
        legPress(),
      ]);

      const response = await request(server()).get('/api/exercises?q=BENCH').set(authHeader(user.accessToken)).expect(200);

      expect(response.body.data.map((e: any) => e.name)).toEqual(['Squat']);

      const byName = await request(server()).get('/api/exercises?q=press').set(authHeader(user.accessToken)).expect(200);
      expect(byName.body.data.map((e: any) => e.name)).toEqual(['Dumbbell press', 'Leg press']);
    });

    it('applies limit', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findMany.mockResolvedValue([pushUp(), legPress(), dumbbellPress()]);

      const response = await request(server()).get('/api/exercises?limit=2').set(authHeader(user.accessToken)).expect(200);
      expect(response.body.data).toHaveLength(2);
    });

    it('rejects an unknown muscle and an oversized limit with 400', async () => {
      const user = await createMockContributorUser(context);

      await request(server()).get('/api/exercises?muscle=wings').set(authHeader(user.accessToken)).expect(400);
      await request(server()).get('/api/exercises?limit=201').set(authHeader(user.accessToken)).expect(400);
      expect(prisma.exercise.findMany).not.toHaveBeenCalled();
    });

    it('answers 400 naming gymId for availableOnly without gymId', async () => {
      const user = await createMockContributorUser(context);

      const response = await request(server())
        .get('/api/exercises?availableOnly=true')
        .set(authHeader(user.accessToken))
        .expect(400);

      expect(JSON.stringify(response.body.details ?? response.body)).toContain('gymId');
      expect(prisma.exercise.findMany).not.toHaveBeenCalled();
    });

    it('answers 404 for a gymId that is not the caller\'s, before listing anything', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findFirst.mockResolvedValue(null);

      await request(server()).get(`/api/exercises?gymId=${GYM}`).set(authHeader(user.accessToken)).expect(404);
      await request(server())
        .get(`/api/exercises?gymId=${GYM}&availableOnly=true`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(prisma.gym.findFirst).toHaveBeenCalledWith({ where: { id: GYM, userId: user.id } });
      expect(prisma.exercise.findMany).not.toHaveBeenCalled();
    });

    it('with gymId adds available and missing to every item', async () => {
      const user = await createMockContributorUser(context);
      mockDumbbellGym(user.id);
      prisma.exercise.findMany.mockResolvedValue([dumbbellPress(), legPress(), pushUp()]);

      const response = await request(server())
        .get(`/api/exercises?gymId=${GYM}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const byName = Object.fromEntries(response.body.data.map((e: any) => [e.name, e]));
      expect(byName['Dumbbell press']).toMatchObject({ available: true, missing: [] });
      expect(byName['Push-up']).toMatchObject({ available: true, missing: [] });
      expect(byName['Leg press']).toMatchObject({ available: false });
      expect(byName['Leg press'].missing).toContain('Leg press');
    });

    it('availableOnly returns only the exercises the gym supports', async () => {
      const user = await createMockContributorUser(context);
      mockDumbbellGym(user.id);
      prisma.exercise.findMany.mockResolvedValue([dumbbellPress(), legPress(), pushUp()]);

      const response = await request(server())
        .get(`/api/exercises?gymId=${GYM}&availableOnly=true`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.map((e: any) => e.name)).toEqual(['Dumbbell press', 'Push-up']);
      expect(response.body.data.every((e: any) => e.available === true)).toBe(true);
    });

    it('excludes pending proposals by default, lists them with includePending, and never under availableOnly', async () => {
      const user = await createMockContributorUser(context);
      mockDumbbellGym(user.id);
      prisma.exercise.findMany.mockResolvedValue([]);

      await request(server()).get('/api/exercises').set(authHeader(user.accessToken)).expect(200);
      expect(prisma.exercise.findMany.mock.calls[0][0].where.AND).toContainEqual({ status: 'active' });

      prisma.exercise.findMany.mockClear();
      await request(server()).get('/api/exercises?includePending=true').set(authHeader(user.accessToken)).expect(200);
      const withPending = prisma.exercise.findMany.mock.calls[0][0].where.AND;
      expect(withPending).not.toContainEqual({ status: 'active' });
      expect(withPending).toContainEqual({});

      prisma.exercise.findMany.mockClear();
      await request(server())
        .get(`/api/exercises?includePending=true&gymId=${GYM}&availableOnly=true`)
        .set(authHeader(user.accessToken))
        .expect(200);
      expect(prisma.exercise.findMany.mock.calls[0][0].where.AND).toContainEqual({ status: 'active' });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/exercises/:id
  // ---------------------------------------------------------------------------

  describe('GET /api/exercises/:id', () => {
    it('expands requirement groups with names and slugs', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue(dumbbellPress());

      const response = await request(server())
        .get(`/api/exercises/${EXERCISE}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.requirements).toEqual([
        { groupIndex: 0, options: [{ kind: 'equipment', id: DUMBBELLS, slug: 'x', name: 'Dumbbells' }] },
        { groupIndex: 1, options: [{ kind: 'equipment', id: BENCH, slug: 'x', name: 'Flat bench' }] },
      ]);
      expect(prisma.exercise.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EXERCISE, OR: [{ ownerUserId: null }, { ownerUserId: user.id }] },
        }),
      );
    });

    it('answers 404 (never 403) for another user\'s exercise', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue(null);

      await request(server()).get(`/api/exercises/${EXERCISE}`).set(authHeader(user.accessToken)).expect(404);
    });

    it('answers 400 for a malformed id', async () => {
      const user = await createMockContributorUser(context);

      await request(server()).get('/api/exercises/not-a-uuid').set(authHeader(user.accessToken)).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/exercises
  // ---------------------------------------------------------------------------

  describe('POST /api/exercises', () => {
    it('creates a custom exercise owned by the caller with a custom- slug', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.count.mockResolvedValue(3);
      prisma.exercise.create.mockImplementation(async ({ data }: any) =>
        exerciseRow({ ...data, requirements: [], origin: data.origin, ownerUserId: user.id }),
      );

      const response = await request(server())
        .post('/api/exercises')
        .set(authHeader(user.accessToken))
        .send({ name: 'Sled push', primaryMuscles: ['quads'], movementPattern: 'carry', trackingMode: 'distance_time' })
        .expect(201);

      expect(response.body.data).toMatchObject({
        name: 'Sled push',
        isCustom: true,
        origin: 'user',
        status: 'active',
        trackingMode: 'distance_time',
      });
      const data = prisma.exercise.create.mock.calls[0][0].data;
      expect(data.ownerUserId).toBe(user.id);
      expect(data.slug).toMatch(/^custom-[a-z0-9]{8}$/);
      expect(data.origin).toBe('user');
      expect(data.status).toBe('active');
    });

    it('answers 400 for an unknown equipment type id and creates nothing', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.count.mockResolvedValue(0);
      prisma.equipmentType.findMany.mockResolvedValue([]);

      const response = await request(server())
        .post('/api/exercises')
        .set(authHeader(user.accessToken))
        .send({
          name: 'X',
          primaryMuscles: ['quads'],
          movementPattern: 'squat',
          requirements: [{ equipmentTypeIds: [DUMBBELLS] }],
        })
        .expect(400);

      expect(response.body.details.reason).toBe('UNKNOWN_EQUIPMENT_TYPE');
      expect(prisma.exercise.create).not.toHaveBeenCalled();
    });

    it('answers 400 EXERCISE_LIMIT at 200 custom exercises', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.count.mockResolvedValue(200);

      const response = await request(server())
        .post('/api/exercises')
        .set(authHeader(user.accessToken))
        .send({ name: 'X', primaryMuscles: ['quads'], movementPattern: 'squat' })
        .expect(400);

      expect(response.body.details.reason).toBe('EXERCISE_LIMIT');
      expect(prisma.exercise.create).not.toHaveBeenCalled();
    });

    it.each([
      ['0 primary muscles', { primaryMuscles: [] }, 'primaryMuscles'],
      ['5 primary muscles', { primaryMuscles: ['chest', 'lats', 'abs', 'quads', 'calves'] }, 'primaryMuscles'],
      ['an unknown muscle', { primaryMuscles: ['wings'] }, 'primaryMuscles'],
      ['an 81-character name', { name: 'a'.repeat(81) }, 'name'],
      ['an unknown pattern', { movementPattern: 'flying' }, 'movementPattern'],
    ])('answers 400 naming the field for %s', async (_label, override, field) => {
      const user = await createMockContributorUser(context);

      const response = await request(server())
        .post('/api/exercises')
        .set(authHeader(user.accessToken))
        .send({ name: 'Sled push', primaryMuscles: ['quads'], movementPattern: 'carry', ...override })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain(field);
      expect(prisma.exercise.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH / DELETE / approve: ownership and the read-only library
  // ---------------------------------------------------------------------------

  describe('ownership and the read-only library', () => {
    it.each([
      ['PATCH', (u: string) => request(server()).patch(`/api/exercises/${EXERCISE}`).send({ name: 'Renamed' })],
      ['DELETE', () => request(server()).delete(`/api/exercises/${EXERCISE}`)],
      ['approve', () => request(server()).post(`/api/exercises/${EXERCISE}/approve`)],
    ] as const)('%s on a library exercise is 403 LIBRARY_EXERCISE_READ_ONLY', async (_label, call) => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue(exerciseRow({ ownerUserId: null }));

      const response = await call(user.id).set(authHeader(user.accessToken)).expect(403);

      expect(response.body.details.reason).toBe('LIBRARY_EXERCISE_READ_ONLY');
      expect(prisma.exercise.updateMany).not.toHaveBeenCalled();
      expect(prisma.exercise.deleteMany).not.toHaveBeenCalled();
    });

    it.each([
      ['PATCH', () => request(server()).patch(`/api/exercises/${EXERCISE}`).send({ name: 'Renamed' })],
      ['DELETE', () => request(server()).delete(`/api/exercises/${EXERCISE}`)],
      ['approve', () => request(server()).post(`/api/exercises/${EXERCISE}/approve`)],
    ] as const)('%s on another user\'s exercise is 404', async (_label, call) => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue(null);

      await call().set(authHeader(user.accessToken)).expect(404);

      expect(prisma.exercise.updateMany).not.toHaveBeenCalled();
      expect(prisma.exercise.deleteMany).not.toHaveBeenCalled();
    });

    it('PATCH updates the caller\'s own exercise, scoped by owner', async () => {
      const user = await createMockContributorUser(context);
      const own = exerciseRow({ ownerUserId: user.id, origin: 'user' });
      prisma.exercise.findFirst.mockResolvedValue(own);
      prisma.exercise.updateMany.mockResolvedValue({ count: 1 });

      const response = await request(server())
        .patch(`/api/exercises/${EXERCISE}`)
        .set(authHeader(user.accessToken))
        .send({ name: 'Renamed' })
        .expect(200);

      expect(response.body.data.id).toBe(EXERCISE);
      expect(prisma.exercise.updateMany).toHaveBeenCalledWith({
        where: { id: EXERCISE, ownerUserId: user.id },
        data: { name: 'Renamed' },
      });
    });

    it('PATCH rejects an empty body and 81-character names with 400', async () => {
      const user = await createMockContributorUser(context);

      await request(server()).patch(`/api/exercises/${EXERCISE}`).set(authHeader(user.accessToken)).send({}).expect(400);
      await request(server())
        .patch(`/api/exercises/${EXERCISE}`)
        .set(authHeader(user.accessToken))
        .send({ name: 'a'.repeat(81) })
        .expect(400);
    });

    it('DELETE removes the caller\'s own exercise with 204, scoped by owner', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue(exerciseRow({ ownerUserId: user.id, origin: 'user' }));
      prisma.exercise.deleteMany.mockResolvedValue({ count: 1 });

      await request(server()).delete(`/api/exercises/${EXERCISE}`).set(authHeader(user.accessToken)).expect(204);

      expect(prisma.exercise.deleteMany).toHaveBeenCalledWith({ where: { id: EXERCISE, ownerUserId: user.id } });
    });

    it('approve activates the caller\'s pending proposal', async () => {
      const user = await createMockContributorUser(context);
      const pending = exerciseRow({ ownerUserId: user.id, origin: 'ai', status: 'pending_review' });
      prisma.exercise.findFirst
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce({ ...pending, status: 'active' });
      prisma.exercise.updateMany.mockResolvedValue({ count: 1 });

      const response = await request(server())
        .post(`/api/exercises/${EXERCISE}/approve`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({ status: 'active', origin: 'ai' });
      expect(prisma.exercise.updateMany).toHaveBeenCalledWith({
        where: { id: EXERCISE, ownerUserId: user.id },
        data: { status: 'active' },
      });
    });

    it('approve is idempotent on an already active exercise', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue(exerciseRow({ ownerUserId: user.id, origin: 'user' }));

      await request(server())
        .post(`/api/exercises/${EXERCISE}/approve`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prisma.exercise.updateMany).not.toHaveBeenCalled();
    });
  });
});
