// =============================================================================
// Integration: GET /api/training/today and POST /api/program-workouts/:id/start (E5.7)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter, over a mocked Prisma: 401 without a token and 403 without each
// required permission (start needs BOTH `programs:read` and
// `workouts:write`); all three seeded roles are admitted (AI is not needed);
// `date` is required, real and within 2 days of the server's today; another
// user's planned workout is a 404; the 409 reasons and the idempotent 200.
// Transactions, races and the snapshot are proven in
// `program-sessions.db.spec.ts`.
// =============================================================================

import { Prisma } from '@prisma/client';
import request from 'supertest';

import { addDays, localDateInZone } from '../../src/check-ins/local-date';
import { isoWeekday } from '../../src/programs/today/resolve-today';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

const PROGRAM = '11111111-1111-4111-8111-111111111111';
const BLOCK = '22222222-2222-4222-8222-222222222222';
const WEEK = '33333333-3333-4333-8333-333333333333';
const PW = '44444444-4444-4444-8444-444444444444';
const PE = '55555555-5555-4555-8555-555555555555';
const EXERCISE = '66666666-6666-4666-8666-666666666666';
const WORKOUT = '77777777-7777-4777-8777-777777777777';
const OTHER_WORKOUT = '88888888-8888-4888-8888-888888888888';

const TODAY = localDateInZone(new Date(), 'UTC');

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
}

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

describe('Training today (integration)', () => {
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
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.healthProfile.findUnique.mockResolvedValue(null);
    prisma.program.findFirst.mockResolvedValue(null);
    prisma.programWorkout.findFirst.mockResolvedValue(null);
    prisma.workout.findFirst.mockResolvedValue(null);
    prisma.workout.findMany.mockResolvedValue([]);
  });

  /** The caller has an ACTIVE program starting today with one workout on today's weekday. */
  function activePlan(userId: string, status = 'active') {
    const program = { id: PROGRAM, name: 'Plan', status, startDate: new Date(`${TODAY}T00:00:00.000Z`), gymId: null, currentVersion: 4 };
    prisma.program.findFirst.mockImplementation(async ({ where }: any) =>
      where.userId === userId && (where.status === undefined || where.status === status) ? program : null,
    );
    prisma.programBlock.findMany.mockResolvedValue([{ id: BLOCK, position: 0, name: 'B', focus: null, rationale: null, archivedAt: null }]);
    prisma.programWeek.findMany.mockResolvedValue([{ id: WEEK, blockId: BLOCK, weekNumber: 1, isDeload: false, archivedAt: null }]);
    prisma.programWorkout.findMany.mockResolvedValue([
      { id: PW, weekId: WEEK, position: 0, weekday: isoWeekday(TODAY), name: 'Upper', estimatedMinutes: 45, rationale: null, archivedAt: null },
    ]);
    const exerciseRow = {
      id: PE,
      programWorkoutId: PW,
      exerciseId: EXERCISE,
      position: 0,
      isPriority: true,
      targetSets: 3,
      repMin: 8,
      repMax: 10,
      targetLoadKg: new Prisma.Decimal('60'),
      targetRpe: new Prisma.Decimal('8'),
      restSeconds: 90,
      loadGuidance: 'fixed',
      rationale: 'Main lift',
      evidenceRefs: [],
      notes: null,
      equipmentTypeId: null,
    };
    prisma.programExercise.findMany.mockImplementation(async (args: any) =>
      args?.select?.exercise ? [{ ...exerciseRow, exercise: { slug: 'bench', trackingMode: 'weight_reps' } }] : [exerciseRow],
    );
    prisma.exercise.findMany.mockResolvedValue([
      { id: EXERCISE, slug: 'bench', name: 'Bench press', trackingMode: 'weight_reps', isBodyweight: false, primaryMuscles: ['chest'] },
    ]);
    prisma.programChangeLog.count.mockResolvedValue(2);
    prisma.programChangeLog.findFirst.mockResolvedValue({ summary: 'Added a set', actor: 'ai', createdAt: new Date('2026-09-29T08:00:00Z') });
    prisma.programWorkout.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === PW && where.week?.program?.userId === userId ? { id: PW, name: 'Upper', week: { programId: PROGRAM } } : null,
    );
    prisma.workout.create.mockResolvedValue({ id: WORKOUT });
    prisma.programSession.create.mockResolvedValue({ id: 'session' });
  }

  // ---------------------------------------------------------------------------
  // Access control
  // ---------------------------------------------------------------------------

  const ROUTES = [
    { method: 'get' as const, path: `/api/training/today?date=${TODAY}`, permissions: ['programs:read'] },
    {
      method: 'post' as const,
      path: `/api/program-workouts/${PW}/start`,
      permissions: ['programs:read', 'workouts:write'],
      body: { date: TODAY },
    },
  ];

  describe.each(ROUTES)('$method $path', ({ method, path, permissions, body }) => {
    it('returns 401 without a token', async () => {
      await request(server())[method](path).send(body).expect(401);
    });

    it.each(permissions)('returns 403 without %s, touching no program data', async (permission) => {
      const user = await createMockContributorUser(context);
      stripPermission(prisma, user.id, permission);

      const response = await request(server())[method](path).set(authHeader(user.accessToken)).send(body).expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prisma.program.findFirst).not.toHaveBeenCalled();
      expect(prisma.programWorkout.findFirst).not.toHaveBeenCalled();
    });

    it.each([
      ['admin', createMockAdminUser],
      ['contributor', createMockContributorUser],
      ['viewer', createMockViewerUser],
    ])('admits the seeded %s role', async (_role, create) => {
      const user = await create(context);
      activePlan(user.id);
      const response = await request(server())[method](path).set(authHeader(user.accessToken)).send(body);
      expect([200, 201]).toContain(response.status);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/training/today
  // ---------------------------------------------------------------------------

  it('answers no_program without an active plan', async () => {
    const user = await createMockContributorUser(context);
    const response = await request(server()).get(`/api/training/today?date=${TODAY}`).set(authHeader(user.accessToken)).expect(200);
    expect(response.body.data).toEqual({ kind: 'no_program', date: TODAY });
  });

  it('returns the hydrated planned workout for today', async () => {
    const user = await createMockContributorUser(context);
    activePlan(user.id);

    const response = await request(server()).get(`/api/training/today?date=${TODAY}`).set(authHeader(user.accessToken)).expect(200);

    expect(response.body.data).toMatchObject({
      kind: 'workout',
      date: TODAY,
      program: { id: PROGRAM, name: 'Plan' },
      programWorkout: { id: PW, name: 'Upper', weekday: isoWeekday(TODAY), estimatedMinutes: 45 },
      weekNumber: 1,
      totalWeeks: 1,
      isDeload: false,
      done: false,
      completedWorkoutId: null,
      inProgressWorkoutId: null,
      session: {
        programId: PROGRAM,
        programWorkoutId: PW,
        planVersion: 4,
        unseenChangeCount: 2,
        lastChange: { summary: 'Added a set', actor: 'ai', at: '2026-09-29T08:00:00.000Z' },
        exercises: [
          {
            programExerciseId: PE,
            exercise: { id: EXERCISE, slug: 'bench', name: 'Bench press' },
            sets: 3,
            repMin: 8,
            repMax: 10,
            targetRpe: 8,
            loadGuidance: 'fixed',
            targetLoadKg: 60,
            suggestedLoadKg: 60,
            rationale: 'Main lift',
            lastTime: null,
            availableAtGym: null,
          },
        ],
      },
    });
  });

  it('marks the planned workout done when a completed linked workout exists', async () => {
    const user = await createMockContributorUser(context);
    activePlan(user.id);
    prisma.workout.findMany.mockResolvedValue([
      { id: WORKOUT, status: 'completed', programWorkoutId: null, startedAt: new Date(), programSession: { programWorkoutId: PW } },
    ]);

    const response = await request(server()).get(`/api/training/today?date=${TODAY}`).set(authHeader(user.accessToken)).expect(200);
    expect(response.body.data).toMatchObject({ kind: 'workout', done: true, completedWorkoutId: WORKOUT });
  });

  it.each([
    ['missing', ''],
    ['malformed', '?date=30-09-2026'],
    ['not a real day', '?date=2026-02-30'],
    ['out of range', `?date=${addDays(TODAY, 3)}`],
  ])('answers 400 for a %s date', async (_label, query) => {
    const user = await createMockContributorUser(context);
    await request(server()).get(`/api/training/today${query}`).set(authHeader(user.accessToken)).expect(400);
  });

  it('names TODAY_OUT_OF_RANGE for a date 3 days ahead', async () => {
    const user = await createMockContributorUser(context);
    const response = await request(server())
      .get(`/api/training/today?date=${addDays(TODAY, 3)}`)
      .set(authHeader(user.accessToken))
      .expect(400);
    expect(response.body.details).toMatchObject({ reason: 'TODAY_OUT_OF_RANGE', today: TODAY });
  });

  // ---------------------------------------------------------------------------
  // POST /api/program-workouts/:id/start
  // ---------------------------------------------------------------------------

  const start = (token: string, body: unknown = { date: TODAY }, id = PW) =>
    request(server()).post(`/api/program-workouts/${id}/start`).set(authHeader(token)).send(body as object);

  it('creates the workout (201) with prefilled uncompleted sets and a session row', async () => {
    const user = await createMockContributorUser(context);
    activePlan(user.id);

    const response = await start(user.accessToken).expect(201);

    expect(response.body.data).toEqual({ workoutId: WORKOUT, existing: false, planVersion: 4 });
    const data = prisma.workout.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: user.id, programWorkoutId: PW, status: 'in_progress', gymId: null });
    expect(data.exercises.create[0].sets.create).toEqual([
      { setNumber: 1, weightKg: 60, reps: 8, completed: false },
      { setNumber: 2, weightKg: 60, reps: 8, completed: false },
      { setNumber: 3, weightKg: 60, reps: 8, completed: false },
    ]);
    expect(prisma.programSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: user.id, programId: PROGRAM, programWorkoutId: PW, workoutId: WORKOUT, versionNumber: 4 }),
    });
  });

  it('returns the in-progress workout for the same session with 200 and existing: true', async () => {
    const user = await createMockContributorUser(context);
    activePlan(user.id);
    prisma.workout.create.mockRejectedValue(uniqueViolation());
    prisma.workout.findFirst.mockImplementation(async ({ where }: any) =>
      where.status === 'in_progress' ? { id: WORKOUT, programWorkoutId: PW, programSession: { programWorkoutId: PW, versionNumber: 3 } } : null,
    );

    const response = await start(user.accessToken).expect(200);
    expect(response.body.data).toEqual({ workoutId: WORKOUT, existing: true, planVersion: 3 });
  });

  it('answers 409 WORKOUT_IN_PROGRESS with the other workout\'s id', async () => {
    const user = await createMockContributorUser(context);
    activePlan(user.id);
    prisma.workout.create.mockRejectedValue(uniqueViolation());
    prisma.workout.findFirst.mockImplementation(async ({ where }: any) =>
      where.status === 'in_progress' ? { id: OTHER_WORKOUT, programWorkoutId: null, programSession: null } : null,
    );

    const response = await start(user.accessToken).expect(409);
    expect(response.body.details).toMatchObject({ reason: 'WORKOUT_IN_PROGRESS', workoutId: OTHER_WORKOUT });
  });

  it('answers 409 PROGRAM_NOT_ACTIVE for a paused plan', async () => {
    const user = await createMockContributorUser(context);
    activePlan(user.id, 'paused');

    const response = await start(user.accessToken).expect(409);
    expect(response.body.details).toMatchObject({ reason: 'PROGRAM_NOT_ACTIVE', status: 'paused' });
    expect(prisma.workout.create).not.toHaveBeenCalled();
  });

  it('answers 404 for another user\'s planned workout', async () => {
    const owner = await createMockContributorUser(context);
    const other = await createMockContributorUser(context);
    activePlan(owner.id);

    await start(other.accessToken).expect(404);
    expect(prisma.workout.create).not.toHaveBeenCalled();
  });

  it('answers 404 for a gym the caller does not own', async () => {
    const user = await createMockContributorUser(context);
    activePlan(user.id);
    prisma.gym.findFirst.mockResolvedValue(null);

    await start(user.accessToken, { date: TODAY, gymId: '99999999-9999-4999-8999-999999999999' }).expect(404);
    expect(prisma.workout.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-uuid id', { date: TODAY }, 'not-a-uuid'],
    ['a missing date', {}, PW],
    ['an out-of-range date', { date: addDays(TODAY, -3) }, PW],
    ['a non-uuid gymId', { date: TODAY, gymId: 'x' }, PW],
    ['an unknown field', { date: TODAY, exercises: [] }, PW],
  ])('answers 400 for %s', async (_label, body, id) => {
    const user = await createMockContributorUser(context);
    activePlan(user.id);
    await start(user.accessToken, body, id).expect(400);
    expect(prisma.workout.create).not.toHaveBeenCalled();
  });
});
