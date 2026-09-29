// =============================================================================
// Integration: exercise history and PRs on the workouts API (E4.4)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and filter,
// over a mocked Prisma:
//   - GET /api/exercises/:id/history is gated by `workouts:read` (not
//     `exercises:read`), admits every seeded role, 404s another user's custom
//     exercise and another user's `workoutId`, validates its query, scopes
//     every read to the caller and answers the documented shape.
//   - Set writes carry `prs` for a completed set (computed after the write
//     from one grouped query scoped to the caller) and `[]` otherwise, with
//     no PR query for an uncompleted set.
//   - GET /api/workouts/:id carries per-set `prs` and `summary.prs`.
// The rules themselves are unit-tested in `workout-records.spec.ts`; the SQL
// against real rows (and two users) in `workout-history.db.spec.ts`.
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
const SET_2 = '33333333-3333-4333-8333-333333333334';
const EXERCISE = '44444444-4444-4444-8444-444444444444';
const GYM = '55555555-5555-4555-8555-555555555555';
const OTHER_GYM = '55555555-5555-4555-8555-555555555556';
const PAST_1 = '77777777-7777-4777-8777-777777777771';
const PAST_2 = '77777777-7777-4777-8777-777777777772';

const NOW = new Date();
const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

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

function setRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SET,
    workoutExerciseId: WE,
    setNumber: 1,
    weightKg: new Prisma.Decimal('65'),
    reps: 7,
    durationSeconds: null,
    distanceMeters: null,
    rpe: null,
    rir: null,
    restSeconds: null,
    isWarmup: false,
    completed: true,
    completedAt: NOW,
    painFlag: false,
    painNote: null,
    notes: null,
    ...overrides,
  };
}

function entryRow(sets: any[]) {
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
    sets,
  };
}

function workoutRow(userId: string, sets: any[]) {
  return {
    id: WORKOUT,
    userId,
    name: 'Tuesday workout',
    date: day('2026-09-22'),
    status: 'in_progress',
    startedAt: NOW,
    endedAt: null,
    durationSeconds: null,
    gymId: null,
    gym: null,
    notes: null,
    programWorkoutId: null,
    readinessSnapshot: null,
    exercises: [entryRow(sets)],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Prior history of the fixture (Sep 1, 8, 15) as the grouped query returns it. */
const FIXTURE_BUCKETS = [
  { exercise_id: EXERCISE, weight_kg: new Prisma.Decimal('60'), max_reps: 10, max_reps_e1rm: 10 },
  { exercise_id: EXERCISE, weight_kg: new Prisma.Decimal('62.5'), max_reps: 8, max_reps_e1rm: 8 },
  { exercise_id: EXERCISE, weight_kg: new Prisma.Decimal('65'), max_reps: 6, max_reps_e1rm: 6 },
];

const sqlText = (query: any): string => (query?.strings ?? []).join('?') || String(query?.sql ?? '');

describe('Exercise history and PRs (integration)', () => {
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
    prisma.healthProfile.findUnique.mockResolvedValue(null);
  });

  /** The lock finds WORKOUT; the grouped PR query answers `buckets`; records answer `records`. */
  function rawQueries(buckets: any[] = [], records: any[] = []) {
    prisma.$queryRaw.mockImplementation(async (query: any) => {
      const text = sqlText(query);
      if (text.includes('FOR UPDATE')) return [{ id: WORKOUT, status: 'in_progress', started_at: NOW }];
      if (text.includes('GROUP BY')) return buckets;
      if (text.includes('UNION ALL')) return records;
      return [];
    });
  }

  const historyUrl = `/api/exercises/${EXERCISE}/history`;

  // ---------------------------------------------------------------------------
  // GET /api/exercises/:id/history — access
  // ---------------------------------------------------------------------------

  describe('GET /api/exercises/:id/history access', () => {
    it('returns 401 without a token', async () => {
      await request(server()).get(historyUrl).expect(401);
    });

    it('returns 403 without workouts:read, reading nothing', async () => {
      const user = await createMockContributorUser(context);
      stripPermission(prisma, user.id, 'workouts:read');

      const response = await request(server()).get(historyUrl).set(authHeader(user.accessToken)).expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.exercise.findFirst).not.toHaveBeenCalled();
      expect(prisma.workout.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('needs workouts:read, not exercises:read', async () => {
      const user = await createMockContributorUser(context);
      stripPermission(prisma, user.id, 'exercises:read');
      prisma.exercise.findFirst.mockResolvedValue({ id: EXERCISE, trackingMode: 'weight_reps' });
      prisma.workout.findMany.mockResolvedValue([]);
      rawQueries();

      await request(server()).get(historyUrl).set(authHeader(user.accessToken)).expect(200);
    });

    it.each([
      ['admin', createMockAdminUser],
      ['contributor', createMockContributorUser],
      ['viewer', createMockViewerUser],
    ])('admits the seeded %s role', async (_role, create) => {
      const user = await create(context);
      prisma.exercise.findFirst.mockResolvedValue({ id: EXERCISE, trackingMode: 'weight_reps' });
      prisma.workout.findMany.mockResolvedValue([]);
      rawQueries();

      await request(server()).get(historyUrl).set(authHeader(user.accessToken)).expect(200);
    });

    it('404s an unknown or another user\'s custom exercise (looked up as library-or-own)', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue(null);

      await request(server()).get(historyUrl).set(authHeader(user.accessToken)).expect(404);

      expect(prisma.exercise.findFirst.mock.calls[0][0].where).toEqual({
        id: EXERCISE,
        OR: [{ ownerUserId: null }, { ownerUserId: user.id }],
      });
      expect(prisma.workout.findMany).not.toHaveBeenCalled();
    });

    it('404s a workoutId that is not the caller\'s', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue({ id: EXERCISE, trackingMode: 'weight_reps' });
      prisma.workout.findFirst.mockResolvedValue(null);

      await request(server()).get(`${historyUrl}?workoutId=${WORKOUT}`).set(authHeader(user.accessToken)).expect(404);

      expect(prisma.workout.findFirst.mock.calls[0][0].where).toEqual({ id: WORKOUT, userId: user.id });
      expect(prisma.workout.findMany).not.toHaveBeenCalled();
    });

    it.each([
      ['limit=11'],
      ['limit=0'],
      ['beforeDate=2026-02-30'],
      ['gymId=nope'],
      ['workoutId=nope'],
    ])('400s the query %s', async (query) => {
      const user = await createMockContributorUser(context);
      await request(server()).get(`${historyUrl}?${query}`).set(authHeader(user.accessToken)).expect(400);
      expect(prisma.exercise.findFirst).not.toHaveBeenCalled();
    });

    it('400s a non-uuid exercise id', async () => {
      const user = await createMockContributorUser(context);
      await request(server()).get('/api/exercises/nope/history').set(authHeader(user.accessToken)).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/exercises/:id/history — shape
  // ---------------------------------------------------------------------------

  describe('GET /api/exercises/:id/history shape', () => {
    const completedSet = (setNumber: number, weightKg: string, reps: number, over: Record<string, unknown> = {}) => ({
      setNumber,
      weightKg: new Prisma.Decimal(weightKg),
      reps,
      durationSeconds: null,
      distanceMeters: null,
      rpe: null,
      isWarmup: false,
      completed: true,
      ...over,
    });

    const candidates = [
      {
        id: PAST_2,
        date: day('2026-09-15'),
        gymId: OTHER_GYM,
        gym: { id: OTHER_GYM, name: 'Hotel gym' },
        exercises: [{ sets: [completedSet(1, '65', 6)] }],
      },
      {
        id: PAST_1,
        date: day('2026-09-08'),
        gymId: GYM,
        gym: { id: GYM, name: 'Home Gym' },
        exercises: [{ sets: [completedSet(1, '40', 10, { isWarmup: true }), completedSet(2, '62.5', 8), completedSet(3, '62.5', 8)] }],
      },
    ];

    const records = [
      { kind: 'weight', weight_kg: new Prisma.Decimal('65'), reps: 6, date: day('2026-09-15'), e1rm: null },
      { kind: 'reps', weight_kg: new Prisma.Decimal('60'), reps: 10, date: day('2026-09-01'), e1rm: null },
      { kind: 'e1rm', weight_kg: new Prisma.Decimal('60'), reps: 10, date: day('2026-09-01'), e1rm: new Prisma.Decimal('80.0') },
    ];

    it('answers lastTime, recent and records, scoped to the caller, as of beforeDate', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue({ id: EXERCISE, trackingMode: 'weight_reps' });
      prisma.workout.findMany.mockResolvedValue(candidates);
      rawQueries([], records);

      const response = await request(server())
        .get(`${historyUrl}?beforeDate=2026-09-22&limit=2`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({
        exerciseId: EXERCISE,
        lastTime: {
          workoutId: PAST_2,
          date: '2026-09-15',
          gym: { id: OTHER_GYM, name: 'Hotel gym' },
          sets: [{ setNumber: 1, weightKg: 65, reps: 6, durationSeconds: null, distanceMeters: null, rpe: null, isWarmup: false }],
        },
        recent: [
          { workoutId: PAST_2, date: '2026-09-15', topSet: { weightKg: 65, reps: 6 }, e1rmKg: 78 },
          { workoutId: PAST_1, date: '2026-09-08', topSet: { weightKg: 62.5, reps: 8 }, e1rmKg: 79.2 },
        ],
        records: {
          maxWeightKg: { value: 65, reps: 6, date: '2026-09-15' },
          maxReps: { value: 10, weightKg: 60, date: '2026-09-01' },
          bestE1rmKg: { value: 80, weightKg: 60, reps: 10, date: '2026-09-01' },
        },
      });

      const args = prisma.workout.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({
        userId: user.id,
        status: 'completed',
        date: { lte: day('2026-09-22') },
        exercises: { some: { exerciseId: EXERCISE, sets: { some: { completed: true } } } },
      });
      expect(args.orderBy).toEqual([{ date: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }]);

      const recordsQuery = prisma.$queryRaw.mock.calls.find((call: any[]) => sqlText(call[0]).includes('UNION ALL'))[0];
      expect(recordsQuery.values).toContain(user.id);
      expect(recordsQuery.values).toContain(EXERCISE);
    });

    it('prefers the gym when one of the two most recent workouts was there', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue({ id: EXERCISE, trackingMode: 'weight_reps' });
      prisma.workout.findMany.mockResolvedValue(candidates);
      rawQueries([], records);

      const response = await request(server())
        .get(`${historyUrl}?gymId=${GYM}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.lastTime).toMatchObject({ workoutId: PAST_1, gym: { id: GYM, name: 'Home Gym' } });
      expect(response.body.data.lastTime.sets.map((set: any) => [set.weightKg, set.reps, set.isWarmup])).toEqual([
        [40, 10, true],
        [62.5, 8, false],
        [62.5, 8, false],
      ]);
      // Default limit 3 (and at least two candidates for the gym preference).
      expect(prisma.workout.findMany.mock.calls[0][0].take).toBe(3);
    });

    it('with workoutId: history strictly before that workout, preferring its gym', async () => {
      const user = await createMockContributorUser(context);
      const startedAt = new Date('2026-09-22T17:00:00.000Z');
      prisma.exercise.findFirst.mockResolvedValue({ id: EXERCISE, trackingMode: 'weight_reps' });
      prisma.workout.findFirst.mockResolvedValue({ id: WORKOUT, date: day('2026-09-22'), startedAt, gymId: GYM });
      prisma.workout.findMany.mockResolvedValue(candidates);
      rawQueries([], records);

      const response = await request(server())
        .get(`${historyUrl}?workoutId=${WORKOUT}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.lastTime.workoutId).toBe(PAST_1);
      expect(prisma.workout.findMany.mock.calls[0][0].where).toMatchObject({
        userId: user.id,
        id: { not: WORKOUT },
        OR: [{ date: { lt: day('2026-09-22') } }, { date: day('2026-09-22'), startedAt: { lt: startedAt } }],
      });
    });

    it('first time: lastTime null, recent empty, records null', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue({ id: EXERCISE, trackingMode: 'weight_reps' });
      prisma.workout.findMany.mockResolvedValue([]);
      rawQueries([], []);

      const response = await request(server()).get(historyUrl).set(authHeader(user.accessToken)).expect(200);

      expect(response.body.data).toEqual({
        exerciseId: EXERCISE,
        lastTime: null,
        recent: [],
        records: { maxWeightKg: null, maxReps: null, bestE1rmKg: null },
      });
    });

    it('a time exercise has last-time durations but no records and no records query', async () => {
      const user = await createMockContributorUser(context);
      prisma.exercise.findFirst.mockResolvedValue({ id: EXERCISE, trackingMode: 'time' });
      prisma.workout.findMany.mockResolvedValue([
        {
          id: PAST_1,
          date: day('2026-09-08'),
          gymId: null,
          gym: null,
          exercises: [{ sets: [completedSet(1, '0', 0, { weightKg: null, reps: null, durationSeconds: 60 })] }],
        },
      ]);
      rawQueries();

      const response = await request(server()).get(historyUrl).set(authHeader(user.accessToken)).expect(200);

      expect(response.body.data.lastTime.sets[0]).toMatchObject({ durationSeconds: 60, weightKg: null, reps: null });
      expect(response.body.data.recent).toEqual([{ workoutId: PAST_1, date: '2026-09-08', topSet: null, e1rmKg: null }]);
      expect(response.body.data.records).toEqual({ maxWeightKg: null, maxReps: null, bestE1rmKg: null });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // PRs on set writes and the workout detail
  // ---------------------------------------------------------------------------

  describe('PRs on set writes', () => {
    const patchUrl = `/api/workouts/${WORKOUT}/sets/${SET}`;

    it('completing 65x7 after the fixture answers a rep PR and an e1RM PR, from one caller-scoped grouped query', async () => {
      const user = await createMockContributorUser(context);
      rawQueries(FIXTURE_BUCKETS);
      prisma.setLog.findFirst.mockResolvedValueOnce(setRow({ completed: false, completedAt: null })).mockResolvedValueOnce(null);
      prisma.setLog.update.mockImplementation(async ({ data }: any) => setRow({ ...data }));
      prisma.workoutExercise.findFirst.mockResolvedValue({ exerciseId: EXERCISE });
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id, [setRow()]));

      const response = await request(server()).patch(patchUrl).set(authHeader(user.accessToken)).send({ completed: true }).expect(200);

      expect(response.body.data.prs).toEqual([
        { type: 'reps', value: 7, previous: 6 },
        { type: 'e1rm', value: 80.2, previous: 80 },
      ]);
      expect(prisma.workoutExercise.findFirst.mock.calls[0][0].where).toEqual({
        id: WE,
        workoutId: WORKOUT,
        workout: { userId: user.id },
      });
      expect(prisma.workout.findFirst.mock.calls[0][0].where).toEqual({ id: WORKOUT, userId: user.id });

      const grouped = prisma.$queryRaw.mock.calls.filter((call: any[]) => sqlText(call[0]).includes('GROUP BY'));
      expect(grouped).toHaveLength(1);
      expect(grouped[0][0].values).toContain(user.id);
      expect(grouped[0][0].values).toContain(WORKOUT);
    });

    it('an uncompleted set answers prs: [] without any PR query', async () => {
      const user = await createMockContributorUser(context);
      rawQueries(FIXTURE_BUCKETS);
      prisma.setLog.findFirst.mockResolvedValue(setRow({ completed: false, completedAt: null }));
      prisma.setLog.update.mockImplementation(async ({ data }: any) => setRow({ completed: false, completedAt: null, ...data }));

      const response = await request(server()).patch(patchUrl).set(authHeader(user.accessToken)).send({ reps: 8 }).expect(200);

      expect(response.body.data.prs).toEqual([]);
      expect(prisma.workoutExercise.findFirst).not.toHaveBeenCalled();
      expect(prisma.$queryRaw.mock.calls.some((call: any[]) => sqlText(call[0]).includes('GROUP BY'))).toBe(false);
    });

    it('a completed warm-up earns nothing', async () => {
      const user = await createMockContributorUser(context);
      rawQueries(FIXTURE_BUCKETS);
      const warm = setRow({ weightKg: new Prisma.Decimal('100'), reps: 1, isWarmup: true });
      prisma.setLog.findFirst.mockResolvedValueOnce(setRow({ completed: false, completedAt: null })).mockResolvedValueOnce(null);
      prisma.setLog.update.mockResolvedValue(warm);
      prisma.workoutExercise.findFirst.mockResolvedValue({ exerciseId: EXERCISE });
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id, [warm]));

      const response = await request(server()).patch(patchUrl).set(authHeader(user.accessToken)).send({ completed: true }).expect(200);

      expect(response.body.data.prs).toEqual([]);
    });

    it('POST .../sets with completed: true answers first_time for the first set ever', async () => {
      const user = await createMockContributorUser(context);
      rawQueries([]);
      prisma.workoutExercise.findFirst.mockImplementation(async (args: any) =>
        args.select?.exerciseId ? { exerciseId: EXERCISE } : { id: WE },
      );
      prisma.setLog.count.mockResolvedValue(0);
      prisma.setLog.findFirst.mockResolvedValue(null);
      prisma.setLog.create.mockImplementation(async ({ data }: any) =>
        setRow({ ...data, id: SET, weightKg: new Prisma.Decimal(data.weightKg) }),
      );
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id, [setRow({ weightKg: new Prisma.Decimal('60'), reps: 10 })]));

      const response = await request(server())
        .post(`/api/workouts/${WORKOUT}/exercises/${WE}/sets`)
        .set(authHeader(user.accessToken))
        .send({ weightKg: 60, reps: 10, completed: true })
        .expect(201);

      expect(response.body.data.prs).toEqual([{ type: 'first_time', value: 60, previous: null }]);
    });
  });

  describe('PRs on GET /api/workouts/:id', () => {
    it('carries per-set prs and the best set per type in summary.prs', async () => {
      const user = await createMockContributorUser(context);
      rawQueries(FIXTURE_BUCKETS);
      prisma.workout.findFirst.mockResolvedValue(
        workoutRow(user.id, [
          setRow({ id: SET, setNumber: 1, weightKg: new Prisma.Decimal('65'), reps: 7 }),
          setRow({ id: SET_2, setNumber: 2, weightKg: new Prisma.Decimal('60'), reps: 12 }),
          setRow({ id: '33333333-3333-4333-8333-333333333335', setNumber: 3, weightKg: new Prisma.Decimal('90'), reps: 1, completed: false, completedAt: null }),
        ]),
      );

      const response = await request(server()).get(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).expect(200);

      const sets = response.body.data.exercises[0].sets;
      expect(sets[0].prs).toEqual([
        { type: 'reps', value: 7, previous: 6 },
        { type: 'e1rm', value: 80.2, previous: 80 },
      ]);
      // 60x12 is compared with the fixture plus 65x7 (earlier in this workout).
      expect(sets[1].prs).toEqual([
        { type: 'reps', value: 12, previous: 10 },
        { type: 'e1rm', value: 84, previous: 80.2 },
      ]);
      expect(sets[2].prs).toEqual([]);

      expect(response.body.data.summary.prs).toEqual([
        { exerciseId: EXERCISE, exerciseName: 'Bench press', workoutExerciseId: WE, setId: SET_2, setNumber: 2, type: 'reps', value: 12, previous: 10 },
        { exerciseId: EXERCISE, exerciseName: 'Bench press', workoutExerciseId: WE, setId: SET_2, setNumber: 2, type: 'e1rm', value: 84, previous: 80.2 },
      ]);

      const grouped = prisma.$queryRaw.mock.calls.filter((call: any[]) => sqlText(call[0]).includes('GROUP BY'));
      expect(grouped).toHaveLength(1);
    });

    it('a workout without completed sets makes no PR query', async () => {
      const user = await createMockContributorUser(context);
      rawQueries(FIXTURE_BUCKETS);
      prisma.workout.findFirst.mockResolvedValue(workoutRow(user.id, [setRow({ completed: false, completedAt: null })]));

      const response = await request(server()).get(`/api/workouts/${WORKOUT}`).set(authHeader(user.accessToken)).expect(200);

      expect(response.body.data.summary.prs).toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
