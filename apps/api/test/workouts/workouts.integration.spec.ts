// =============================================================================
// Integration: /api/workouts (E4.2)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter, over a mocked Prisma: 401 without a token and 403 without the exact
// permission on every route; all three seeded roles are admitted; owner
// scoping (another user's workout, entry, set, exercise, gym and equipment
// type answer 404); Zod bounds answer 400; each refusal carries its
// `details.reason`; and the start/finish/set rules that need no real rows.
// Locks, indexes, CHECKs and cascades are proven in `workouts.db.spec.ts`.
// =============================================================================

import { Prisma } from '@prisma/client';
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

const WORKOUT = '11111111-1111-4111-8111-111111111111';
const WE = '22222222-2222-4222-8222-222222222222';
const SET = '33333333-3333-4333-8333-333333333333';
const EXERCISE = '44444444-4444-4444-8444-444444444444';
const GYM = '55555555-5555-4555-8555-555555555555';
const EQUIPMENT = '66666666-6666-4666-8666-666666666666';

const NOW = new Date();

function workoutRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: WORKOUT,
    userId,
    name: 'Tuesday workout',
    date: new Date('2026-09-29T00:00:00.000Z'),
    status: 'in_progress',
    startedAt: NOW,
    endedAt: null,
    durationSeconds: null,
    gymId: null,
    gym: null,
    notes: null,
    programWorkoutId: null,
    readinessSnapshot: null,
    exercises: [] as any[],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function setRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SET,
    workoutExerciseId: WE,
    setNumber: 1,
    weightKg: new Prisma.Decimal('31.75'),
    reps: 10,
    durationSeconds: null,
    distanceMeters: null,
    rpe: null,
    rir: null,
    restSeconds: null,
    isWarmup: false,
    completed: false,
    completedAt: null,
    painFlag: false,
    painNote: null,
    notes: null,
    ...overrides,
  };
}

function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WE,
    workoutId: WORKOUT,
    exerciseId: EXERCISE,
    position: 0,
    equipmentTypeId: null,
    equipmentType: null,
    notes: null,
    createdAt: NOW,
    exercise: {
      id: EXERCISE,
      slug: 'bench',
      name: 'Bench press',
      trackingMode: 'weight_reps',
      isBodyweight: false,
      isUnilateral: false,
      primaryMuscles: ['chest'],
      ownerUserId: null,
      status: 'active',
    },
    sets: [] as any[],
    ...overrides,
  };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
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

describe('Workouts (integration)', () => {
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
    // No Health Profile (UTC), no check-in, no default gym.
    prisma.healthProfile.findUnique.mockResolvedValue(null);
    prisma.measurement.findMany.mockResolvedValue([]);
    prisma.gym.findFirst.mockResolvedValue(null);
  });

  /** The caller owns WORKOUT (the lock finds it). */
  function lockFinds(userId: string, status = 'in_progress', startedAt = NOW) {
    prisma.$queryRaw.mockImplementation(async () => [{ id: WORKOUT, status, started_at: startedAt }]);
    return userId;
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
    { method: 'post', path: '/api/workouts', permission: 'workouts:write', body: {} },
    { method: 'get', path: '/api/workouts', permission: 'workouts:read' },
    { method: 'get', path: `/api/workouts/${WORKOUT}`, permission: 'workouts:read' },
    { method: 'patch', path: `/api/workouts/${WORKOUT}`, permission: 'workouts:write', body: { name: 'X' } },
    { method: 'post', path: `/api/workouts/${WORKOUT}/finish`, permission: 'workouts:write', body: {} },
    { method: 'delete', path: `/api/workouts/${WORKOUT}`, permission: 'workouts:write' },
    { method: 'post', path: `/api/workouts/${WORKOUT}/exercises`, permission: 'workouts:write', body: { exerciseId: EXERCISE } },
    { method: 'patch', path: `/api/workouts/${WORKOUT}/exercises/${WE}`, permission: 'workouts:write', body: { position: 0 } },
    { method: 'delete', path: `/api/workouts/${WORKOUT}/exercises/${WE}`, permission: 'workouts:write' },
    { method: 'post', path: `/api/workouts/${WORKOUT}/exercises/${WE}/sets`, permission: 'workouts:write', body: {} },
    { method: 'patch', path: `/api/workouts/${WORKOUT}/sets/${SET}`, permission: 'workouts:write', body: { reps: 5 } },
    { method: 'delete', path: `/api/workouts/${WORKOUT}/sets/${SET}`, permission: 'workouts:write' },
  ];

  describe.each(ROUTES)('$method $path ($permission)', ({ method, path, permission, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).send(body as object).expect(401);
    });

    it(`returns 403 without ${permission}, touching no workout data`, async () => {
      const user = await createMockContributorUser(context);
      stripPermission(prisma, user.id, permission);

      const response = await request(server())
        [method](path)
        .set(authHeader(user.accessToken))
        .send(body as object)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.workout.create).not.toHaveBeenCalled();
      expect(prisma.workout.findFirst).not.toHaveBeenCalled();
      expect(prisma.workout.findMany).not.toHaveBeenCalled();
      expect(prisma.workout.updateMany).not.toHaveBeenCalled();
      expect(prisma.workout.deleteMany).not.toHaveBeenCalled();
      expect(prisma.workoutExercise.create).not.toHaveBeenCalled();
      expect(prisma.setLog.create).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role to read and start workouts', async (_role, create) => {
    const user = await create(context);
    prisma.workout.count.mockResolvedValue(0);
    prisma.workout.findMany.mockResolvedValue([]);
    prisma.workout.create.mockImplementation(async () => workoutRow(user.id));

    await request(server()).get('/api/workouts').set(authHeader(user.accessToken)).expect(200);
    await request(server()).post('/api/workouts').set(authHeader(user.accessToken)).send({}).expect(201);
  });

  // ---------------------------------------------------------------------------
  // POST /api/workouts
  // ---------------------------------------------------------------------------

  describe('POST /api/workouts', () => {
    it('creates with a weekday name, the caller as owner and a null snapshot, without any pre-check', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.create.mockImplementation(async ({ data }: any) => workoutRow(user.id, { name: data.name }));

      const response = await request(server())
        .post('/api/workouts')
        .set(authHeader(user.accessToken))
        .send({ date: new Date().toISOString().slice(0, 10) })
        .expect(201);

      expect(response.body.data).toMatchObject({ existing: false, status: 'in_progress', readinessSnapshot: null });
      const data = prisma.workout.create.mock.calls[0][0].data;
      expect(data.userId).toBe(user.id);
      expect(data.name).toMatch(/^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day workout$/);
      // The partial unique index decides: no findFirst before the insert.
      expect(prisma.workout.findFirst).not.toHaveBeenCalled();
    });

    it('answers 200 with the winner and existing: true when the unique index refuses', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.create.mockRejectedValue(uniqueViolation());
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id, { id: WORKOUT }));

      const response = await request(server()).post('/api/workouts').set(authHeader(user.accessToken)).send({}).expect(200);

      expect(response.body.data).toMatchObject({ id: WORKOUT, existing: true });
      expect(prisma.workout.findFirst.mock.calls[0][0].where).toEqual({ userId: user.id, status: 'in_progress' });
    });

    it('retries the insert once when the winner finished in between', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.create.mockRejectedValueOnce(uniqueViolation()).mockResolvedValueOnce(workoutRow(user.id));
      prisma.workout.findFirst.mockResolvedValue(null);

      const response = await request(server()).post('/api/workouts').set(authHeader(user.accessToken)).send({}).expect(201);

      expect(response.body.data.existing).toBe(false);
      expect(prisma.workout.create).toHaveBeenCalledTimes(2);
    });

    it('defaults the gym to the caller\'s default gym', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findFirst.mockResolvedValue({ id: GYM });
      prisma.workout.create.mockImplementation(async ({ data }: any) => workoutRow(user.id, { gymId: data.gymId }));

      await request(server()).post('/api/workouts').set(authHeader(user.accessToken)).send({}).expect(201);

      expect(prisma.gym.findFirst.mock.calls[0][0].where).toEqual({ userId: user.id, isDefault: true });
      expect(prisma.workout.create.mock.calls[0][0].data.gymId).toBe(GYM);
    });

    it('copies today\'s check-in into readinessSnapshot by value', async () => {
      const user = await createMockContributorUser(context);
      const today = new Date().toISOString().slice(0, 10);
      prisma.workout.create.mockImplementation(async ({ data }: any) => workoutRow(user.id, { readinessSnapshot: data.readinessSnapshot }));
      prisma.measurement.findMany.mockResolvedValue([
        { id: 'm1', metricKey: 'energy', value: 4, notes: 'slept badly', localDate: new Date(`${today}T00:00:00.000Z`), createdAt: NOW, updatedAt: NOW },
        { id: 'm2', metricKey: 'stress', value: 2, notes: null, localDate: new Date(`${today}T00:00:00.000Z`), createdAt: NOW, updatedAt: NOW },
      ]);

      const response = await request(server()).post('/api/workouts').set(authHeader(user.accessToken)).send({}).expect(201);

      const snapshot = prisma.workout.create.mock.calls[0][0].data.readinessSnapshot;
      expect(snapshot).toMatchObject({ date: today, energy: 4, stress: 2, note: 'slept badly' });
      expect(response.body.data.readinessSnapshot).toMatchObject({ date: today, energy: 4, stress: 2, note: 'slept badly' });
    });

    it('never blocks starting when the check-in cannot be read', async () => {
      const user = await createMockContributorUser(context);
      prisma.measurement.findMany.mockRejectedValue(new Error('boom'));
      prisma.workout.create.mockImplementation(async () => workoutRow(user.id));

      const response = await request(server()).post('/api/workouts').set(authHeader(user.accessToken)).send({}).expect(201);

      expect(response.body.data.readinessSnapshot).toBeNull();
      expect(prisma.workout.create.mock.calls[0][0].data.readinessSnapshot).toBe(Prisma.DbNull);
    });

    it('404s a gym that is not the caller\'s and creates nothing', async () => {
      const user = await createMockContributorUser(context);
      prisma.gym.findFirst.mockResolvedValue(null);

      await request(server()).post('/api/workouts').set(authHeader(user.accessToken)).send({ gymId: GYM }).expect(404);

      expect(prisma.gym.findFirst.mock.calls[0][0].where).toEqual({ id: GYM, userId: user.id });
      expect(prisma.workout.create).not.toHaveBeenCalled();
    });

    it('400s a date more than 2 days from today with WORKOUT_DATE_OUT_OF_RANGE', async () => {
      const user = await createMockContributorUser(context);
      const far = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

      for (const date of [far(4), far(-4)]) {
        const response = await request(server())
          .post('/api/workouts')
          .set(authHeader(user.accessToken))
          .send({ date })
          .expect(400);
        expect(response.body.details).toMatchObject({ reason: 'WORKOUT_DATE_OUT_OF_RANGE', path: 'date' });
      }
      expect(prisma.workout.create).not.toHaveBeenCalled();
    });

    it('400s a startedAt more than 5 minutes ahead with TIME_IN_FUTURE, accepts 1 minute of skew', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.create.mockImplementation(async () => workoutRow(user.id));

      const response = await request(server())
        .post('/api/workouts')
        .set(authHeader(user.accessToken))
        .send({ startedAt: new Date(Date.now() + 10 * 60_000).toISOString() })
        .expect(400);
      expect(response.body.details).toMatchObject({ reason: 'TIME_IN_FUTURE', path: 'startedAt' });

      await request(server())
        .post('/api/workouts')
        .set(authHeader(user.accessToken))
        .send({ startedAt: new Date(Date.now() + 60_000).toISOString() })
        .expect(201);
    });

    it.each([
      [{ name: '' }],
      [{ name: 'x'.repeat(81) }],
      [{ date: '2026-02-30' }],
      [{ gymId: 'not-a-uuid' }],
      [{ userId: WORKOUT }],
    ])('400s invalid body %j', async (body) => {
      const user = await createMockContributorUser(context);
      await request(server()).post('/api/workouts').set(authHeader(user.accessToken)).send(body).expect(400);
      expect(prisma.workout.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/workouts and /:id
  // ---------------------------------------------------------------------------

  describe('GET /api/workouts', () => {
    it('scopes to the caller, translates filters, paginates and sums volume over completed working sets', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.count.mockResolvedValue(45);
      prisma.workout.findMany.mockResolvedValue([
        {
          ...workoutRow(user.id, { status: 'completed', durationSeconds: 3000 }),
          gym: { id: GYM, name: 'Home' },
          exercises: [
            {
              exercise: { id: EXERCISE, name: 'Bench press' },
              sets: [
                { weightKg: new Prisma.Decimal(100), reps: 5, completed: true, isWarmup: false },
                { weightKg: new Prisma.Decimal(60), reps: 10, completed: true, isWarmup: true },
                { weightKg: new Prisma.Decimal(100), reps: 5, completed: false, isWarmup: false },
              ],
            },
          ],
        },
      ]);

      const response = await request(server())
        .get(`/api/workouts?status=completed&gymId=${GYM}&from=2026-09-01&to=2026-09-30&exerciseId=${EXERCISE}&page=2&pageSize=20`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items[0]).toMatchObject({
        exerciseCount: 1,
        setCount: 1,
        volumeKg: 500,
        gym: { id: GYM, name: 'Home' },
        durationSeconds: 3000,
      });
      expect(response.body.data).toMatchObject({ total: 45, page: 2, pageSize: 20, totalPages: 3 });

      const args = prisma.workout.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({
        userId: user.id,
        status: 'completed',
        gymId: GYM,
        exercises: { some: { exerciseId: EXERCISE } },
      });
      expect(args.where.date.gte).toEqual(new Date('2026-09-01T00:00:00.000Z'));
      expect(args.where.date.lte).toEqual(new Date('2026-09-30T00:00:00.000Z'));
      expect(args.skip).toBe(20);
      expect(args.take).toBe(20);
      expect(args.orderBy[0]).toEqual({ date: 'desc' });
    });

    it.each(['pageSize=51', 'page=0', 'status=paused', 'from=2026-09-30&to=2026-09-01', 'gymId=x'])(
      '400s ?%s',
      async (query) => {
        const user = await createMockContributorUser(context);
        await request(server()).get(`/api/workouts?${query}`).set(authHeader(user.accessToken)).expect(400);
        expect(prisma.workout.findMany).not.toHaveBeenCalled();
      },
    );
  });

  describe('GET /api/workouts/:id', () => {
    it('returns exercises in position order with sets, kg as numbers', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.findFirst.mockResolvedValue(
        workoutRow(user.id, { exercises: [entryRow({ sets: [setRow(), setRow({ id: 'x', setNumber: 2, completed: true })] })] }),
      );

      const response = await request(server()).get(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).expect(200);

      expect(response.body.data.exercises[0].sets[0]).toMatchObject({ weightKg: 31.75, reps: 10, setNumber: 1 });
      expect(response.body.data.exercises[0].exercise).toMatchObject({ trackingMode: 'weight_reps', primaryMuscles: ['chest'] });
      expect(response.body.data.summary).toMatchObject({ exerciseCount: 1, setCount: 1, volumeKg: 317.5 });
      expect(prisma.workout.findFirst.mock.calls[0][0].where).toEqual({ id: WORKOUT, userId: user.id });
    });

    it('404s another user\'s workout and a non-uuid id is 400', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.findFirst.mockResolvedValue(null);

      const response = await request(server()).get(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
      await request(server()).get('/api/workouts/nope').set(authHeader(user.accessToken)).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/workouts/:id
  // ---------------------------------------------------------------------------

  describe('PATCH /api/workouts/:id', () => {
    it('404s another user\'s workout before writing', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.findFirst.mockResolvedValue(null);

      await request(server()).patch(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).send({ name: 'X' }).expect(404);

      expect(prisma.workout.updateMany).not.toHaveBeenCalled();
    });

    it('404s a foreign gym', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id));
      prisma.gym.findFirst.mockResolvedValue(null);

      await request(server()).patch(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).send({ gymId: GYM }).expect(404);

      expect(prisma.workout.updateMany).not.toHaveBeenCalled();
    });

    it('writes only the caller\'s row and accepts gymId null', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id));
      prisma.workout.updateMany.mockResolvedValue({ count: 1 });

      await request(server()).patch(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).send({ gymId: null, name: 'Legs' }).expect(200);

      expect(prisma.workout.updateMany.mock.calls[0][0]).toEqual({
        where: { id: WORKOUT, userId: user.id },
        data: { gymId: null, name: 'Legs' },
      });
    });

    it('refuses endedAt / durationSeconds on an in-progress workout (WORKOUT_NOT_COMPLETED)', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id));

      for (const body of [{ durationSeconds: 60 }, { endedAt: new Date().toISOString() }]) {
        const response = await request(server()).patch(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).send(body).expect(400);
        expect(response.body.details.reason).toBe('WORKOUT_NOT_COMPLETED');
      }
    });

    it('refuses endedAt before startedAt (ENDED_BEFORE_STARTED) and recomputes duration for a completed workout', async () => {
      const user = await createMockContributorUser(context);
      const startedAt = new Date(Date.now() - 3_600_000);
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id, { status: 'completed', startedAt, endedAt: NOW, durationSeconds: 3600 }));
      prisma.workout.updateMany.mockResolvedValue({ count: 1 });

      const bad = await request(server())
        .patch(`/api/workouts/${WORKOUT}`)
        .set(authHeader(user.accessToken))
        .send({ endedAt: new Date(startedAt.getTime() - 1000).toISOString() })
        .expect(400);
      expect(bad.body.details.reason).toBe('ENDED_BEFORE_STARTED');

      const endedAt = new Date(startedAt.getTime() + 1800_000);
      await request(server()).patch(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).send({ endedAt: endedAt.toISOString() }).expect(200);
      expect(prisma.workout.updateMany.mock.calls[0][0].data.durationSeconds).toBe(1800);
    });

    it('400s a date more than 2 days ahead and an empty body', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id));
      const ahead = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);

      const response = await request(server()).patch(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).send({ date: ahead }).expect(400);
      expect(response.body.details.reason).toBe('WORKOUT_DATE_OUT_OF_RANGE');
      await request(server()).patch(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).send({}).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /finish and DELETE
  // ---------------------------------------------------------------------------

  describe('POST /api/workouts/:id/finish', () => {
    it('404s another user\'s workout (the lock finds nothing) and changes nothing', async () => {
      const user = await createMockContributorUser(context);
      prisma.$queryRaw.mockResolvedValue([]);

      await request(server()).post(`/api/workouts/${WORKOUT}/finish`).set(authHeader(user.accessToken)).send({}).expect(404);

      expect(prisma.setLog.deleteMany).not.toHaveBeenCalled();
      expect(prisma.workout.update).not.toHaveBeenCalled();
    });

    it('completes, deletes only empty uncompleted sets and reports the summary', async () => {
      const user = await createMockContributorUser(context);
      const startedAt = new Date(Date.now() - 3_000_000);
      lockFinds(user.id, 'in_progress', startedAt);
      prisma.setLog.findMany.mockResolvedValue([]);
      prisma.workout.findFirst.mockResolvedValue(
        workoutRow(user.id, {
          status: 'completed',
          startedAt,
          endedAt: NOW,
          durationSeconds: 3000,
          exercises: [entryRow({ sets: [setRow({ completed: true })] })],
        }),
      );

      const response = await request(server())
        .post(`/api/workouts/${WORKOUT}/finish`)
        .set(authHeader(user.accessToken))
        .send({ notes: 'Good' })
        .expect(200);

      // No earlier workout (the grouped PR query finds no rows): the set is a first time.
      expect(response.body.data.summary).toEqual({
        durationSeconds: 3000,
        exerciseCount: 1,
        setCount: 1,
        volumeKg: 317.5,
        prs: [
          {
            exerciseId: EXERCISE,
            exerciseName: 'Bench press',
            workoutExerciseId: WE,
            setId: SET,
            setNumber: 1,
            type: 'first_time',
            value: 31.75,
            previous: null,
          },
        ],
      });
      expect(prisma.setLog.deleteMany.mock.calls[0][0].where).toEqual({
        workoutExercise: { workoutId: WORKOUT },
        completed: false,
        weightKg: null,
        reps: null,
        durationSeconds: null,
        distanceMeters: null,
      });
      const update = prisma.workout.update.mock.calls[0][0];
      expect(update.data).toMatchObject({ status: 'completed', notes: 'Good' });
      expect(update.data.durationSeconds).toBeGreaterThanOrEqual(2999);
    });

    it('is idempotent on a completed workout: no deletes, no update', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id, 'completed');
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id, { status: 'completed', endedAt: NOW, durationSeconds: 10 }));

      const response = await request(server()).post(`/api/workouts/${WORKOUT}/finish`).set(authHeader(user.accessToken)).send({}).expect(200);

      expect(response.body.data.status).toBe('completed');
      expect(prisma.setLog.deleteMany).not.toHaveBeenCalled();
      expect(prisma.workout.update).not.toHaveBeenCalled();
    });

    it('refuses an endedAt before startedAt and one in the future', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id, 'in_progress', new Date(Date.now() - 3_600_000));

      const before = await request(server())
        .post(`/api/workouts/${WORKOUT}/finish`)
        .set(authHeader(user.accessToken))
        .send({ endedAt: new Date(Date.now() - 7_200_000).toISOString() })
        .expect(400);
      expect(before.body.details.reason).toBe('ENDED_BEFORE_STARTED');

      const future = await request(server())
        .post(`/api/workouts/${WORKOUT}/finish`)
        .set(authHeader(user.accessToken))
        .send({ endedAt: new Date(Date.now() + 3_600_000).toISOString() })
        .expect(400);
      expect(future.body.details.reason).toBe('TIME_IN_FUTURE');
      expect(prisma.workout.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/workouts/:id', () => {
    it('deletes only the caller\'s row (204) and 404s when nothing matched', async () => {
      const user = await createMockContributorUser(context);
      prisma.workout.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      await request(server()).delete(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).expect(204);
      expect(prisma.workout.deleteMany.mock.calls[0][0]).toEqual({ where: { id: WORKOUT, userId: user.id } });
      await request(server()).delete(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Workout exercises
  // ---------------------------------------------------------------------------

  describe('POST /api/workouts/:id/exercises', () => {
    function exerciseFound(overrides: Record<string, unknown> = {}) {
      prisma.exercise.findFirst.mockResolvedValue({ id: EXERCISE, status: 'active', ...overrides });
    }

    it('looks the exercise up as library-or-own, so another user\'s custom exercise is 404', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue(null);

      await request(server()).post(`/api/workouts/${WORKOUT}/exercises`).set(authHeader(user.accessToken)).send({ exerciseId: EXERCISE }).expect(404);

      expect(prisma.exercise.findFirst.mock.calls[0][0].where).toEqual({
        id: EXERCISE,
        OR: [{ ownerUserId: null }, { ownerUserId: user.id }],
      });
      expect(prisma.workoutExercise.create).not.toHaveBeenCalled();
    });

    it('404s a foreign equipment type', async () => {
      const user = await createMockContributorUser(context);
      exerciseFound();
      prisma.equipmentType.findFirst.mockResolvedValue(null);

      await request(server())
        .post(`/api/workouts/${WORKOUT}/exercises`)
        .set(authHeader(user.accessToken))
        .send({ exerciseId: EXERCISE, equipmentTypeId: EQUIPMENT })
        .expect(404);

      expect(prisma.equipmentType.findFirst.mock.calls[0][0].where).toEqual({
        id: EQUIPMENT,
        OR: [{ ownerUserId: null }, { ownerUserId: user.id }],
      });
    });

    it('404s another user\'s workout (the lock finds nothing)', async () => {
      const user = await createMockContributorUser(context);
      exerciseFound();
      prisma.$queryRaw.mockResolvedValue([]);

      await request(server()).post(`/api/workouts/${WORKOUT}/exercises`).set(authHeader(user.accessToken)).send({ exerciseId: EXERCISE }).expect(404);

      expect(prisma.workoutExercise.create).not.toHaveBeenCalled();
    });

    it('409s a pending AI proposal (EXERCISE_PENDING_REVIEW)', async () => {
      const user = await createMockContributorUser(context);
      exerciseFound({ status: 'pending_review' });

      const response = await request(server())
        .post(`/api/workouts/${WORKOUT}/exercises`)
        .set(authHeader(user.accessToken))
        .send({ exerciseId: EXERCISE })
        .expect(409);
      expect(response.body.details.reason).toBe('EXERCISE_PENDING_REVIEW');
    });

    it('refuses the 31st exercise (WORKOUT_EXERCISE_LIMIT) and accepts the 30th', async () => {
      const user = await createMockContributorUser(context);
      exerciseFound();
      lockFinds(user.id);
      prisma.workoutExercise.findUnique.mockResolvedValue(entryRow());
      prisma.workoutExercise.create.mockResolvedValue({ id: WE });

      prisma.workoutExercise.count.mockResolvedValue(30);
      const response = await request(server())
        .post(`/api/workouts/${WORKOUT}/exercises`)
        .set(authHeader(user.accessToken))
        .send({ exerciseId: EXERCISE })
        .expect(400);
      expect(response.body.details).toMatchObject({ reason: 'WORKOUT_EXERCISE_LIMIT', max: 30 });
      expect(prisma.workoutExercise.create).not.toHaveBeenCalled();

      prisma.workoutExercise.count.mockResolvedValue(29);
      await request(server()).post(`/api/workouts/${WORKOUT}/exercises`).set(authHeader(user.accessToken)).send({ exerciseId: EXERCISE }).expect(201);
      expect(prisma.workoutExercise.create.mock.calls[0][0].data.position).toBe(29);
    });

    it('appends by default and shifts the rest when inserting at a position', async () => {
      const user = await createMockContributorUser(context);
      exerciseFound();
      lockFinds(user.id);
      prisma.workoutExercise.count.mockResolvedValue(3);
      prisma.workoutExercise.create.mockResolvedValue({ id: WE });
      prisma.workoutExercise.findUnique.mockResolvedValue(entryRow());

      await request(server()).post(`/api/workouts/${WORKOUT}/exercises`).set(authHeader(user.accessToken)).send({ exerciseId: EXERCISE }).expect(201);
      expect(prisma.workoutExercise.updateMany).not.toHaveBeenCalled();
      expect(prisma.workoutExercise.create.mock.calls[0][0].data).toMatchObject({ workoutId: WORKOUT, position: 3 });

      await request(server()).post(`/api/workouts/${WORKOUT}/exercises`).set(authHeader(user.accessToken)).send({ exerciseId: EXERCISE, position: 1 }).expect(201);
      expect(prisma.workoutExercise.updateMany).toHaveBeenCalledWith({
        where: { workoutId: WORKOUT, position: { gte: 1 } },
        data: { position: { increment: 1 } },
      });
      expect(prisma.workoutExercise.create.mock.calls[1][0].data.position).toBe(1);
    });
  });

  describe('PATCH/DELETE /api/workouts/:id/exercises/:weId', () => {
    it('404s another user\'s workout and a foreign entry', async () => {
      const user = await createMockContributorUser(context);

      prisma.$queryRaw.mockResolvedValue([]);
      await request(server()).patch(`/api/workouts/${WORKOUT}/exercises/${WE}`).set(authHeader(user.accessToken)).send({ position: 0 }).expect(404);
      await request(server()).delete(`/api/workouts/${WORKOUT}/exercises/${WE}`).set(authHeader(user.accessToken)).expect(404);

      lockFinds(user.id);
      prisma.workoutExercise.findMany.mockResolvedValue([{ id: 'other', position: 0 }]);
      prisma.workoutExercise.deleteMany.mockResolvedValue({ count: 0 });
      await request(server()).patch(`/api/workouts/${WORKOUT}/exercises/${WE}`).set(authHeader(user.accessToken)).send({ position: 0 }).expect(404);
      await request(server()).delete(`/api/workouts/${WORKOUT}/exercises/${WE}`).set(authHeader(user.accessToken)).expect(404);
      expect(prisma.workoutExercise.update).not.toHaveBeenCalled();
    });

    it('reorders densely: moving the last entry to the front renumbers all three', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.workoutExercise.findMany.mockResolvedValue([
        { id: 'a', position: 0 },
        { id: 'b', position: 1 },
        { id: WE, position: 2 },
      ]);
      prisma.workoutExercise.findUnique.mockResolvedValue(entryRow({ position: 0 }));

      await request(server()).patch(`/api/workouts/${WORKOUT}/exercises/${WE}`).set(authHeader(user.accessToken)).send({ position: 0 }).expect(200);

      const updates = prisma.workoutExercise.update.mock.calls.map((call: any) => [call[0].where.id, call[0].data.position]);
      expect(updates).toEqual([
        [WE, 0],
        ['a', 1],
        ['b', 2],
      ]);
    });

    it('renumbers the remaining entries after a delete', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.workoutExercise.deleteMany.mockResolvedValue({ count: 1 });
      prisma.workoutExercise.findMany.mockResolvedValue([
        { id: 'a', position: 0 },
        { id: 'c', position: 2 },
      ]);

      await request(server()).delete(`/api/workouts/${WORKOUT}/exercises/${WE}`).set(authHeader(user.accessToken)).expect(204);

      expect(prisma.workoutExercise.deleteMany.mock.calls[0][0]).toEqual({ where: { id: WE, workoutId: WORKOUT } });
      expect(prisma.workoutExercise.update).toHaveBeenCalledTimes(1);
      expect(prisma.workoutExercise.update.mock.calls[0][0]).toEqual({ where: { id: 'c' }, data: { position: 1 } });
    });
  });

  // ---------------------------------------------------------------------------
  // Sets
  // ---------------------------------------------------------------------------

  describe('POST /api/workouts/:id/exercises/:weId/sets', () => {
    const url = `/api/workouts/${WORKOUT}/exercises/${WE}/sets`;

    function setEcho() {
      prisma.setLog.create.mockImplementation(async ({ data }: any) =>
        setRow({ ...data, id: SET, weightKg: data.weightKg === null || data.weightKg === undefined ? null : new Prisma.Decimal(data.weightKg) }),
      );
    }

    it('404s another user\'s workout and a foreign entry', async () => {
      const user = await createMockContributorUser(context);

      prisma.$queryRaw.mockResolvedValue([]);
      await request(server()).post(url).set(authHeader(user.accessToken)).send({}).expect(404);

      lockFinds(user.id);
      prisma.workoutExercise.findFirst.mockResolvedValue(null);
      await request(server()).post(url).set(authHeader(user.accessToken)).send({}).expect(404);
      expect(prisma.workoutExercise.findFirst.mock.calls[0][0].where).toEqual({ id: WE, workoutId: WORKOUT });
      expect(prisma.setLog.create).not.toHaveBeenCalled();
    });

    it('with an empty body copies weight and reps from the previous set and takes max + 1', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.workoutExercise.findFirst.mockResolvedValue({ id: WE });
      prisma.setLog.count.mockResolvedValue(2);
      prisma.setLog.findFirst.mockResolvedValue({ setNumber: 2, weightKg: new Prisma.Decimal('31.75'), reps: 10, durationSeconds: null, distanceMeters: null });
      setEcho();

      const response = await request(server()).post(url).set(authHeader(user.accessToken)).send({}).expect(201);

      expect(response.body.data).toMatchObject({ setNumber: 3, weightKg: 31.75, reps: 10, completed: false, restSeconds: null });
    });

    it('lets an explicit value or null override the copy', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.workoutExercise.findFirst.mockResolvedValue({ id: WE });
      prisma.setLog.count.mockResolvedValue(1);
      prisma.setLog.findFirst.mockResolvedValue({ setNumber: 1, weightKg: new Prisma.Decimal(50), reps: 8, durationSeconds: null, distanceMeters: null });
      setEcho();

      await request(server()).post(url).set(authHeader(user.accessToken)).send({ weightKg: 60, reps: null }).expect(201);

      const data = prisma.setLog.create.mock.calls[0][0].data;
      expect(data.weightKg).toBe(60);
      expect(data.reps).toBeNull();
      expect(data.setNumber).toBe(2);
    });

    it('starts at 1 with nothing to copy', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.workoutExercise.findFirst.mockResolvedValue({ id: WE });
      prisma.setLog.count.mockResolvedValue(0);
      prisma.setLog.findFirst.mockResolvedValue(null);
      setEcho();

      await request(server()).post(url).set(authHeader(user.accessToken)).send({}).expect(201);

      expect(prisma.setLog.create.mock.calls[0][0].data).toMatchObject({ setNumber: 1, weightKg: null, reps: null });
    });

    it('refuses the 41st set (WORKOUT_SET_LIMIT) and accepts the 40th', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.workoutExercise.findFirst.mockResolvedValue({ id: WE });
      prisma.setLog.findFirst.mockResolvedValue(null);
      setEcho();

      prisma.setLog.count.mockResolvedValue(40);
      const response = await request(server()).post(url).set(authHeader(user.accessToken)).send({}).expect(400);
      expect(response.body.details).toMatchObject({ reason: 'WORKOUT_SET_LIMIT', max: 40 });
      expect(prisma.setLog.create).not.toHaveBeenCalled();

      prisma.setLog.count.mockResolvedValue(39);
      await request(server()).post(url).set(authHeader(user.accessToken)).send({}).expect(201);
    });

    it('retries once on a unique violation', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.workoutExercise.findFirst.mockResolvedValue({ id: WE });
      prisma.setLog.count.mockResolvedValue(0);
      prisma.setLog.findFirst.mockResolvedValue(null);
      prisma.setLog.create.mockRejectedValueOnce(uniqueViolation()).mockImplementation(async ({ data }: any) => setRow({ ...data }));

      await request(server()).post(url).set(authHeader(user.accessToken)).send({}).expect(201);

      expect(prisma.setLog.create).toHaveBeenCalledTimes(2);
    });

    it.each([
      [{ weightKg: 1000.001 }],
      [{ weightKg: -1 }],
      [{ weightKg: 10.1234 }],
      [{ rpe: 7.3 }],
      [{ rpe: 11 }],
      [{ rpe: 0.5 }],
      [{ rir: 11 }],
      [{ reps: 1001 }],
      [{ reps: 5.5 }],
      [{ durationSeconds: 86401 }],
      [{ distanceMeters: 1_000_001 }],
      [{ restSeconds: 7201 }],
      [{ notes: 'x'.repeat(1001) }],
      [{ painNote: 'x'.repeat(501) }],
      [{ setNumber: 4 }],
      [{ weightKg: '80' }],
    ])('400s body %j without touching the database', async (body) => {
      const user = await createMockContributorUser(context);
      await request(server()).post(url).set(authHeader(user.accessToken)).send(body).expect(400);
      expect(prisma.setLog.create).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/workouts/:id/sets/:setId', () => {
    const url = `/api/workouts/${WORKOUT}/sets/${SET}`;

    it('404s another user\'s workout and a set outside the workout', async () => {
      const user = await createMockContributorUser(context);

      prisma.$queryRaw.mockResolvedValue([]);
      await request(server()).patch(url).set(authHeader(user.accessToken)).send({ reps: 5 }).expect(404);

      lockFinds(user.id);
      prisma.setLog.findFirst.mockResolvedValue(null);
      await request(server()).patch(url).set(authHeader(user.accessToken)).send({ reps: 5 }).expect(404);
      expect(prisma.setLog.findFirst.mock.calls[0][0].where).toEqual({ id: SET, workoutExercise: { workoutId: WORKOUT } });
      expect(prisma.setLog.update).not.toHaveBeenCalled();
    });

    it('completing stamps completedAt and derives rest from a completion under 15 minutes old', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.setLog.findFirst
        .mockResolvedValueOnce(setRow())
        .mockResolvedValueOnce({ completedAt: new Date(Date.now() - 90_000) });
      prisma.setLog.update.mockImplementation(async ({ data }: any) => setRow({ ...data }));

      const response = await request(server()).patch(url).set(authHeader(user.accessToken)).send({ completed: true }).expect(200);

      const data = prisma.setLog.update.mock.calls[0][0].data;
      expect(data.completed).toBe(true);
      expect(data.completedAt).toBeInstanceOf(Date);
      expect(data.restSeconds).toBeGreaterThanOrEqual(89);
      expect(data.restSeconds).toBeLessThanOrEqual(92);
      expect(response.body.data.completedAt).toEqual(expect.any(String));
      // The previous completion is looked up excluding the set itself.
      expect(prisma.setLog.findFirst.mock.calls[1][0].where.id).toEqual({ not: SET });
    });

    it('leaves restSeconds null when the previous completion is 15 minutes old or absent', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.setLog.update.mockImplementation(async ({ data }: any) => setRow({ ...data }));

      prisma.setLog.findFirst.mockResolvedValueOnce(setRow()).mockResolvedValueOnce({ completedAt: new Date(Date.now() - 16 * 60_000) });
      await request(server()).patch(url).set(authHeader(user.accessToken)).send({ completed: true }).expect(200);
      expect(prisma.setLog.update.mock.calls[0][0].data.restSeconds).toBeNull();

      prisma.setLog.findFirst.mockResolvedValueOnce(setRow()).mockResolvedValueOnce(null);
      await request(server()).patch(url).set(authHeader(user.accessToken)).send({ completed: true }).expect(200);
      expect(prisma.setLog.update.mock.calls[1][0].data.restSeconds).toBeNull();
    });

    it('does not overwrite an explicit or already stored restSeconds', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.setLog.update.mockImplementation(async ({ data }: any) => setRow({ ...data }));

      prisma.setLog.findFirst.mockResolvedValueOnce(setRow());
      await request(server()).patch(url).set(authHeader(user.accessToken)).send({ completed: true, restSeconds: 120 }).expect(200);
      expect(prisma.setLog.update.mock.calls[0][0].data.restSeconds).toBe(120);

      prisma.setLog.findFirst.mockResolvedValueOnce(setRow({ restSeconds: 75 }));
      await request(server()).patch(url).set(authHeader(user.accessToken)).send({ completed: true }).expect(200);
      expect(prisma.setLog.update.mock.calls[1][0].data).not.toHaveProperty('restSeconds');
      expect(prisma.setLog.findFirst).toHaveBeenCalledTimes(2);
    });

    it('un-completing clears completedAt', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.setLog.findFirst.mockResolvedValue(setRow({ completed: true, completedAt: NOW }));
      prisma.setLog.update.mockImplementation(async ({ data }: any) => setRow({ ...data }));

      const response = await request(server()).patch(url).set(authHeader(user.accessToken)).send({ completed: false }).expect(200);

      expect(prisma.setLog.update.mock.calls[0][0].data).toMatchObject({ completed: false, completedAt: null });
      expect(response.body.data.completedAt).toBeNull();
    });

    it('re-sending completed: true on a completed set keeps its completedAt', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.setLog.findFirst.mockResolvedValue(setRow({ completed: true, completedAt: NOW }));
      prisma.setLog.update.mockImplementation(async ({ data }: any) => setRow({ ...data }));

      await request(server()).patch(url).set(authHeader(user.accessToken)).send({ completed: true, reps: 9 }).expect(200);

      expect(prisma.setLog.update.mock.calls[0][0].data).toEqual({ reps: 9 });
    });

    it.each([[{}], [{ weightKg: 1000.001 }], [{ rpe: 7.3 }], [{ rir: 11 }]])('400s %j', async (body) => {
      const user = await createMockContributorUser(context);
      await request(server()).patch(url).set(authHeader(user.accessToken)).send(body).expect(400);
      expect(prisma.setLog.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/workouts/:id/sets/:setId', () => {
    const url = `/api/workouts/${WORKOUT}/sets/${SET}`;

    it('404s another user\'s workout and a foreign set', async () => {
      const user = await createMockContributorUser(context);

      prisma.$queryRaw.mockResolvedValue([]);
      await request(server()).delete(url).set(authHeader(user.accessToken)).expect(404);

      lockFinds(user.id);
      prisma.setLog.findFirst.mockResolvedValue(null);
      await request(server()).delete(url).set(authHeader(user.accessToken)).expect(404);
      expect(prisma.setLog.delete).not.toHaveBeenCalled();
    });

    it('renumbers the remaining sets densely after deleting the middle one', async () => {
      const user = await createMockContributorUser(context);
      lockFinds(user.id);
      prisma.setLog.findFirst.mockResolvedValue({ id: SET, workoutExerciseId: WE });
      prisma.setLog.findMany.mockResolvedValue([
        { id: 's1', setNumber: 1 },
        { id: 's3', setNumber: 3 },
        { id: 's4', setNumber: 4 },
      ]);

      await request(server()).delete(url).set(authHeader(user.accessToken)).expect(204);

      expect(prisma.setLog.delete).toHaveBeenCalledWith({ where: { id: SET } });
      expect(prisma.setLog.update.mock.calls.map((c: any) => [c[0].where.id, c[0].data.setNumber])).toEqual([
        ['s3', 2],
        ['s4', 3],
      ]);
    });
  });
});
