// =============================================================================
// Integration: GET /api/training/signals (E5.9)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter, over a mocked Prisma: 401 without a token, 403 without
// `programs:read`, all three seeded roles admitted (AI is not needed); the
// range and `asOf` bounds are 400s; another user's program is a 404; a caller
// without a program gets zeroed structures in `{ data }`. The loader's
// queries are proven against real Postgres in `training-signals.db.spec.ts`;
// the definitions in `aggregate-signals.spec.ts`.
// =============================================================================

import request from 'supertest';

import { addDays, localDateInZone } from '../../src/check-ins/local-date';
import { weekStartOf } from '../../src/programs/signals/aggregate-signals';
import { planSignalsSchema } from '../../src/programs/signals/plan-signals.contract';
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
const EXERCISE = '66666666-6666-4666-8666-666666666666';
const WORKOUT = '77777777-7777-4777-8777-777777777777';

const TODAY = localDateInZone(new Date(), 'UTC');

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

describe('Training signals (integration)', () => {
  let context: TestContext;
  let prisma: any;
  const server = () => context.app.getHttpServer();
  const path = '/api/training/signals';

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
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.healthProfile.findUnique.mockResolvedValue(null);
    prisma.program.findFirst.mockResolvedValue(null);
    prisma.programBlock.findMany.mockResolvedValue([]);
    prisma.programWeek.findMany.mockResolvedValue([]);
    prisma.programWorkout.findMany.mockResolvedValue([]);
    prisma.programExercise.findMany.mockResolvedValue([]);
    prisma.programChangeLog.findFirst.mockResolvedValue(null);
    prisma.workout.findMany.mockResolvedValue([]);
    prisma.measurement.findMany.mockResolvedValue([]);
    prisma.exercise.findMany.mockResolvedValue([]);
  });

  /** The caller owns an active program that started 14 days ago with one workout on today's weekday. */
  function ownPlan(userId: string) {
    const start = addDays(TODAY, -14);
    prisma.program.findFirst.mockImplementation(async ({ where }: any) =>
      where.userId === userId && (where.id === undefined || where.id === PROGRAM)
        ? { id: PROGRAM, startDate: new Date(`${start}T00:00:00.000Z`), currentVersion: 2 }
        : null,
    );
    prisma.programBlock.findMany.mockResolvedValue([{ id: BLOCK, position: 0, name: 'B', focus: null, rationale: null, archivedAt: null }]);
    prisma.programWeek.findMany.mockResolvedValue(
      [1, 2, 3].map((weekNumber) => ({ id: `${WEEK.slice(0, -1)}${weekNumber}`, blockId: BLOCK, weekNumber, isDeload: false, archivedAt: null })),
    );
    const weekday = ((new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    prisma.programWorkout.findMany.mockResolvedValue(
      [1, 2, 3].map((weekNumber) => ({
        id: `${PW.slice(0, -1)}${weekNumber}`,
        weekId: `${WEEK.slice(0, -1)}${weekNumber}`,
        position: 0,
        weekday,
        name: `Day ${weekNumber}`,
        estimatedMinutes: 45,
        rationale: null,
        archivedAt: null,
      })),
    );
    prisma.programExercise.findMany.mockResolvedValue(
      [1, 2, 3].map((weekNumber) => ({
        id: `55555555-5555-4555-8555-55555555555${weekNumber}`,
        programWorkoutId: `${PW.slice(0, -1)}${weekNumber}`,
        exerciseId: EXERCISE,
        position: 0,
        isPriority: false,
        targetSets: 3,
        repMin: 5,
        repMax: 8,
        targetLoadKg: null,
        targetRpe: null,
        restSeconds: 120,
        loadGuidance: 'choose_start',
        rationale: null,
        evidenceRefs: [],
        notes: null,
        equipmentTypeId: null,
      })),
    );
    prisma.exercise.findMany.mockResolvedValue([
      { id: EXERCISE, slug: 'bench', name: 'Bench press', primaryMuscles: ['chest'], trackingMode: 'weight_reps' },
    ]);
    // Week 1 done (linked), week 2 missed, week 3 is today (upcoming).
    prisma.workout.findMany.mockImplementation(async (args: any) =>
      args?.select?.programSession
        ? [
            {
              id: WORKOUT,
              date: new Date(`${start}T00:00:00.000Z`),
              startedAt: new Date(`${start}T17:00:00.000Z`),
              status: 'completed',
              programWorkoutId: `${PW.slice(0, -1)}1`,
              programSession: { programWorkoutId: `${PW.slice(0, -1)}1`, plannedSnapshot: [{ sets: 3 }] },
              exercises: [
                {
                  exerciseId: EXERCISE,
                  sets: [1, 2, 3].map(() => ({
                    weightKg: '60',
                    reps: 5,
                    durationSeconds: null,
                    distanceMeters: null,
                    rpe: '8',
                    isWarmup: false,
                    completed: true,
                  })),
                },
              ],
            },
          ]
        : [],
    );
  }

  // ---------------------------------------------------------------------------
  // Access control
  // ---------------------------------------------------------------------------

  it('returns 401 without a token', async () => {
    await request(server()).get(path).expect(401);
  });

  it('returns 403 without programs:read, touching no program data', async () => {
    const user = await createMockContributorUser(context);
    stripPermission(prisma, user.id, 'programs:read');
    const response = await request(server()).get(path).set(authHeader(user.accessToken)).expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
    expect(prisma.program.findFirst).not.toHaveBeenCalled();
    expect(prisma.workout.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['admin', createMockAdminUser],
    ['contributor', createMockContributorUser],
    ['viewer', createMockViewerUser],
  ])('admits the seeded %s role', async (_role, create) => {
    const user = await create(context);
    await request(server()).get(path).set(authHeader(user.accessToken)).expect(200);
  });

  // ---------------------------------------------------------------------------
  // Responses
  // ---------------------------------------------------------------------------

  it('answers zeroed structures for a caller without a program', async () => {
    const user = await createMockContributorUser(context);
    const response = await request(server()).get(path).set(authHeader(user.accessToken)).expect(200);

    const data = planSignalsSchema.parse(response.body.data);
    expect(data).toMatchObject({
      programId: null,
      planVersion: null,
      asOf: TODAY,
      range: { from: addDays(weekStartOf(TODAY), -49), to: TODAY },
      weeksInRange: 8,
      truncated: false,
      sessions: [],
      volume: [],
      performance: [],
      pain: [],
      readiness: { days: 0, avg: null, lowDays: 0, lowStreak: 0 },
      body: { weightKg: { latest: null, changePerWeek: null, points: 0 }, bodyFatPct: null },
    });
    expect(data.adherence.totals).toEqual({ planned: 0, completed: 0, partialSessions: 0, missed: 0, extra: 0, adherencePct: null });
  });

  it('computes the caller\'s active program by default', async () => {
    const user = await createMockContributorUser(context);
    ownPlan(user.id);
    const response = await request(server()).get(path).set(authHeader(user.accessToken)).expect(200);

    const data = planSignalsSchema.parse(response.body.data);
    expect(data.programId).toBe(PROGRAM);
    expect(data.planVersion).toBe(2);
    expect(data.sessions.map((session) => session.status)).toEqual(['done', 'missed', 'upcoming']);
    expect(data.adherence.totals).toMatchObject({ planned: 2, completed: 1, missed: 1, adherencePct: 50 });
    expect(data.performance[0]).toMatchObject({ slug: 'bench', sessions: 1, best: { weightKg: 60, reps: 5 } });
    // Every query the loader ran was scoped to the caller.
    for (const call of prisma.workout.findMany.mock.calls) expect(call[0].where.userId).toBe(user.id);
    for (const call of prisma.measurement.findMany.mock.calls) expect(call[0].where.userId).toBe(user.id);
  });

  it('computes an explicit program of the caller', async () => {
    const user = await createMockContributorUser(context);
    ownPlan(user.id);
    const response = await request(server())
      .get(`${path}?programId=${PROGRAM}&from=${addDays(TODAY, -20)}&to=${TODAY}&asOf=${TODAY}`)
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(response.body.data.range).toEqual({ from: addDays(TODAY, -20), to: TODAY });
  });

  it('answers 404 for another user\'s program', async () => {
    const owner = await createMockContributorUser(context);
    const other = await createMockContributorUser(context);
    ownPlan(owner.id);
    const response = await request(server()).get(`${path}?programId=${PROGRAM}`).set(authHeader(other.accessToken)).expect(404);
    expect(response.body.message).toBe('Program not found');
    expect(prisma.workout.findMany).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  it.each([
    ['a malformed from', `?from=30-09-2026`],
    ['an impossible to', `?to=2026-02-30`],
    ['a malformed programId', `?programId=nope`],
    ['an unknown parameter', `?weeks=4`],
    ['from after to', `?from=${TODAY}&to=${addDays(TODAY, -1)}`],
    ['a range over 26 weeks', `?from=${addDays(TODAY, -182)}&to=${TODAY}`],
    ['a defaulted to with a from over 26 weeks back', `?from=${addDays(TODAY, -200)}`],
    ['asOf 3 days ahead', `?asOf=${addDays(TODAY, 3)}`],
    ['asOf 3 days back', `?asOf=${addDays(TODAY, -3)}`],
  ])('answers 400 for %s', async (_label, query) => {
    const user = await createMockContributorUser(context);
    await request(server()).get(`${path}${query}`).set(authHeader(user.accessToken)).expect(400);
    expect(prisma.workout.findMany).not.toHaveBeenCalled();
  });

  it('accepts exactly 26 weeks and asOf 2 days either side', async () => {
    const user = await createMockContributorUser(context);
    await request(server()).get(`${path}?from=${addDays(TODAY, -181)}&to=${TODAY}`).set(authHeader(user.accessToken)).expect(200);
    await request(server()).get(`${path}?asOf=${addDays(TODAY, 2)}`).set(authHeader(user.accessToken)).expect(200);
    await request(server()).get(`${path}?asOf=${addDays(TODAY, -2)}`).set(authHeader(user.accessToken)).expect(200);
  });

  it('names SIGNALS_AS_OF_OUT_OF_RANGE', async () => {
    const user = await createMockContributorUser(context);
    const response = await request(server()).get(`${path}?asOf=${addDays(TODAY, 3)}`).set(authHeader(user.accessToken)).expect(400);
    expect(response.body.details).toMatchObject({ reason: 'SIGNALS_AS_OF_OUT_OF_RANGE', today: TODAY });
  });
});
