// =============================================================================
// Integration: GET /api/workouts/summary (E4.6)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter, over a mocked Prisma: 401 without a token, 403 without
// `workouts:read`, all three seeded roles admitted; the route is not shadowed
// by `GET /api/workouts/:id`; every read is scoped to the caller; the empty
// shape for a new user; the in-progress and last blocks; `?today=` bounds.
// The week boundary and the queries over real rows are proven in
// `workout-summary.db.spec.ts`.
// =============================================================================

import { Prisma } from '@prisma/client';
import request from 'supertest';

import { addDays, localDateInZone } from '../../src/check-ins/local-date';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const IN_PROGRESS = '11111111-1111-4111-8111-111111111111';
const LAST = '22222222-2222-4222-8222-222222222222';
const GYM = '55555555-5555-4555-8555-555555555555';

const utcToday = () => localDateInZone(new Date(), 'UTC');

function set(overrides: Record<string, unknown> = {}) {
  return { setNumber: 1, weightKg: new Prisma.Decimal(100), reps: 5, completed: true, isWarmup: false, ...overrides };
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

describe('GET /api/workouts/summary (integration)', () => {
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
    // No Health Profile (UTC), no workouts.
    prisma.healthProfile.findUnique.mockResolvedValue(null);
    prisma.workout.findFirst.mockResolvedValue(null);
    prisma.workout.count.mockResolvedValue(0);
  });

  /** Answers the in-progress and last reads by `where.status`. */
  function rows(inProgress: unknown, last: unknown) {
    prisma.workout.findFirst.mockImplementation(async ({ where }: any) =>
      where.status === 'in_progress' ? inProgress : where.status === 'completed' ? last : null,
    );
  }

  // ---------------------------------------------------------------------------
  // Access control
  // ---------------------------------------------------------------------------

  it('returns 401 without a token', async () => {
    await request(server()).get('/api/workouts/summary').expect(401);
  });

  it('returns 403 without workouts:read, touching no workout data', async () => {
    const user = await createMockContributorUser(context);
    stripPermission(prisma, user.id, 'workouts:read');

    const response = await request(server()).get('/api/workouts/summary').set(authHeader(user.accessToken)).expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
    expect(prisma.workout.findFirst).not.toHaveBeenCalled();
    expect(prisma.workout.count).not.toHaveBeenCalled();
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role', async (_role, create) => {
    const user = await create(context);
    await request(server()).get('/api/workouts/summary').set(authHeader(user.accessToken)).expect(200);
  });

  // ---------------------------------------------------------------------------
  // Route order
  // ---------------------------------------------------------------------------

  it('is not shadowed by GET /api/workouts/:id (no UUID 400, no lookup by id)', async () => {
    const user = await createMockContributorUser(context);

    const response = await request(server()).get('/api/workouts/summary').set(authHeader(user.accessToken)).expect(200);

    expect(response.body.data).toHaveProperty('thisWeek');
    for (const [args] of prisma.workout.findFirst.mock.calls) {
      expect(args.where).not.toHaveProperty('id');
    }
  });

  it('still routes a UUID to GET /api/workouts/:id', async () => {
    const user = await createMockContributorUser(context);

    await request(server()).get(`/api/workouts/${LAST}`).set(authHeader(user.accessToken)).expect(404);

    expect(prisma.workout.findFirst.mock.calls[0][0].where).toEqual({ id: LAST, userId: user.id });
  });

  // ---------------------------------------------------------------------------
  // Shapes and ownership
  // ---------------------------------------------------------------------------

  it('answers the empty shape for a new user, scoping every read to the caller', async () => {
    const user = await createMockContributorUser(context);

    const response = await request(server())
      .get('/api/workouts/summary')
      .query({ today: utcToday() })
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(response.body.data).toEqual({
      inProgress: null,
      last: null,
      thisWeek: { workoutCount: 0, weekStart: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      daysSinceLast: null,
    });
    expect(new Date(`${response.body.data.thisWeek.weekStart}T00:00:00Z`).getUTCDay()).toBe(1);

    const wheres = prisma.workout.findFirst.mock.calls.map(([args]: any) => args.where);
    expect(wheres).toEqual(
      expect.arrayContaining([
        { userId: user.id, status: 'in_progress' },
        { userId: user.id, status: 'completed' },
      ]),
    );
    expect(prisma.workout.count.mock.calls[0][0].where).toMatchObject({ userId: user.id, status: 'completed' });
  });

  it('fills inProgress with the gym, exercise count and completed sets', async () => {
    const user = await createMockContributorUser(context);
    const startedAt = new Date(Date.now() - 20 * 60_000);
    rows(
      {
        id: IN_PROGRESS,
        name: 'Tuesday workout',
        startedAt,
        gym: { id: GYM, name: 'Home' },
        exercises: [{ _count: { sets: 3 } }, { _count: { sets: 0 } }],
      },
      null,
    );

    const response = await request(server()).get('/api/workouts/summary').set(authHeader(user.accessToken)).expect(200);

    expect(response.body.data.inProgress).toEqual({
      id: IN_PROGRESS,
      name: 'Tuesday workout',
      startedAt: startedAt.toISOString(),
      gym: { id: GYM, name: 'Home' },
      exerciseCount: 2,
      completedSetCount: 3,
    });
    const select = prisma.workout.findFirst.mock.calls.find(([args]: any) => args.where.status === 'in_progress')[0].select;
    expect(select.exercises.select._count.select.sets).toEqual({ where: { completed: true } });
  });

  it('fills last from a completed workout 3 days ago: totals exclude warm-ups and uncompleted sets, at most 3 top lifts', async () => {
    const user = await createMockContributorUser(context);
    const today = utcToday();
    const date = addDays(today, -3);
    rows(null, {
      id: LAST,
      name: 'Push day',
      date: new Date(`${date}T00:00:00.000Z`),
      durationSeconds: 3600,
      gym: null, // deleted gym: SetNull
      exercises: [
        {
          exercise: { name: 'Bench press' },
          sets: [
            set({ setNumber: 1, weightKg: new Prisma.Decimal(60), reps: 10, isWarmup: true }),
            set({ setNumber: 2, weightKg: new Prisma.Decimal(100), reps: 5 }),
            set({ setNumber: 3, weightKg: new Prisma.Decimal(120), reps: 5, completed: false }),
          ],
        },
        { exercise: { name: 'Squat' }, sets: [set({ weightKg: new Prisma.Decimal(140), reps: 3 })] },
        { exercise: { name: 'Curl' }, sets: [set({ weightKg: new Prisma.Decimal(20), reps: 12 })] },
        { exercise: { name: 'Deadlift' }, sets: [set({ weightKg: new Prisma.Decimal(180), reps: 1 })] },
        { exercise: { name: 'Plank' }, sets: [] },
      ],
    });
    prisma.workout.count.mockResolvedValue(2);

    const response = await request(server())
      .get('/api/workouts/summary')
      .query({ today })
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(response.body.data).toMatchObject({
      inProgress: null,
      last: {
        id: LAST,
        name: 'Push day',
        date,
        durationSeconds: 3600,
        gym: null,
        exerciseCount: 5,
        setCount: 4,
        // 100x5 + 140x3 + 20x12 + 180x1: no warm-up, no uncompleted set.
        volumeKg: 500 + 420 + 240 + 180,
        topLifts: [
          { exerciseName: 'Deadlift', weightKg: 180, reps: 1 },
          { exerciseName: 'Squat', weightKg: 140, reps: 3 },
          { exerciseName: 'Bench press', weightKg: 100, reps: 5 },
        ],
      },
      thisWeek: { workoutCount: 2 },
      daysSinceLast: 3,
    });
    const lastArgs = prisma.workout.findFirst.mock.calls.find(([args]: any) => args.where.status === 'completed')[0];
    expect(lastArgs.orderBy).toEqual([{ date: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }]);
  });

  it('counts the ISO week containing today, Monday to Sunday inclusive', async () => {
    const user = await createMockContributorUser(context);
    const today = utcToday();
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const monday = addDays(today, -((weekday + 6) % 7));

    const response = await request(server())
      .get('/api/workouts/summary')
      .query({ today })
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(response.body.data.thisWeek.weekStart).toBe(monday);
    expect(prisma.workout.count.mock.calls[0][0].where.date).toEqual({
      gte: new Date(`${monday}T00:00:00.000Z`),
      lte: new Date(`${addDays(monday, 6)}T00:00:00.000Z`),
    });
  });

  // ---------------------------------------------------------------------------
  // ?today=
  // ---------------------------------------------------------------------------

  it('accepts today within 2 days of the server date', async () => {
    const user = await createMockContributorUser(context);

    for (const offset of [-2, 2]) {
      await request(server())
        .get('/api/workouts/summary')
        .query({ today: addDays(utcToday(), offset) })
        .set(authHeader(user.accessToken))
        .expect(200);
    }
  });

  it('400s today more than 2 days away with TODAY_OUT_OF_RANGE, reading no workout', async () => {
    const user = await createMockContributorUser(context);

    for (const offset of [-4, 4]) {
      const response = await request(server())
        .get('/api/workouts/summary')
        .query({ today: addDays(utcToday(), offset) })
        .set(authHeader(user.accessToken))
        .expect(400);

      expect(response.body.details).toMatchObject({ reason: 'TODAY_OUT_OF_RANGE', path: 'today' });
    }
    expect(prisma.workout.findFirst).not.toHaveBeenCalled();
  });

  it('400s a malformed today', async () => {
    const user = await createMockContributorUser(context);

    for (const today of ['2026-02-30', 'yesterday']) {
      await request(server()).get('/api/workouts/summary').query({ today }).set(authHeader(user.accessToken)).expect(400);
    }
  });
});
