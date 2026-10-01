// =============================================================================
// Integration: POST /api/workouts/quick-cardio (E8 F4, #264)
// =============================================================================
//
// The HTTP contract through the real guards, pipes, interceptor and exception
// filter, over a mocked Prisma: Zod bounds and the "at least one value" rule
// answer 400; the performedAt window answers 400 with its `details.reason`;
// the created workout is completed, gym-free (a default gym never applies),
// holds one exercise and one completed set; it links to the active plan's
// planned workout of that local day only when that workout holds the
// exercise; and `workout.finished` is emitted once. Access control (401/403)
// is in the per-route table of `workouts.integration.spec.ts`; the real rows
// (and coexisting with a workout in progress) in `quick-cardio.db.spec.ts`.
// =============================================================================

import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { isoWeekday } from '../../src/programs/today/resolve-today';
import { WORKOUT_FINISHED_EVENT } from '../../src/workouts/workout-events';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockContributorUser } from '../helpers/auth-mock.helper';

const WORKOUT = '11111111-1111-4111-8111-111111111111';
const WE = '22222222-2222-4222-8222-222222222222';
const SET = '33333333-3333-4333-8333-333333333333';
const EXERCISE = '44444444-4444-4444-8444-444444444444';
const OTHER_EXERCISE = '77777777-7777-4777-8777-777777777777';
const GYM = '55555555-5555-4555-8555-555555555555';
const PROGRAM = '88888888-8888-4888-8888-888888888888';
const BLOCK = '99999999-9999-4999-8999-999999999999';
const WEEK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROGRAM_WORKOUT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('POST /api/workouts/quick-cardio (integration)', () => {
  let context: TestContext;
  let prisma: any;
  let emit: jest.SpyInstance;

  const server = () => context.app.getHttpServer();

  /** One hour ago; its UTC day is the local day (no Health Profile -> UTC). */
  const performedAt = new Date(Date.now() - HOUR_MS);
  const localDay = performedAt.toISOString().slice(0, 10);

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
    prisma.healthProfile.findUnique.mockResolvedValue(null);
    // A default gym exists: it must never be applied.
    prisma.gym.findFirst.mockResolvedValue({ id: GYM });
    prisma.exercise.findFirst.mockResolvedValue({ id: EXERCISE, name: 'Outdoor walk' });
    prisma.program.findFirst.mockResolvedValue(null);
    prisma.workout.create.mockResolvedValue({ id: WORKOUT });
    prisma.workout.findFirst.mockImplementation(async () => createdView());

    emit?.mockRestore();
    emit = jest.spyOn(context.app.get(EventEmitter2), 'emit').mockReturnValue(true);
  });

  /** What `GET /api/workouts/:id` reads back, built from the create call. */
  function createdView() {
    const data = prisma.workout.create.mock.calls[0]?.[0]?.data ?? {};
    const set = data.exercises?.create?.[0]?.sets?.create?.[0] ?? {};
    return {
      id: WORKOUT,
      userId: data.userId,
      name: data.name,
      date: data.date,
      status: data.status,
      startedAt: data.startedAt,
      endedAt: data.endedAt,
      durationSeconds: data.durationSeconds,
      gymId: data.gymId,
      gym: null,
      notes: data.notes,
      programWorkoutId: data.programWorkoutId,
      readinessSnapshot: null,
      photos: [],
      exercises: [
        {
          id: WE,
          workoutId: WORKOUT,
          exerciseId: EXERCISE,
          position: 0,
          equipmentTypeId: null,
          equipmentType: null,
          notes: null,
          createdAt: new Date(),
          exercise: {
            id: EXERCISE,
            slug: 'outdoor_walk',
            name: 'Outdoor walk',
            trackingMode: 'distance_time',
            isBodyweight: false,
            isUnilateral: false,
            primaryMuscles: ['full_body'],
            ownerUserId: null,
            status: 'active',
          },
          sets: [
            {
              id: SET,
              workoutExerciseId: WE,
              setNumber: 1,
              weightKg: null,
              reps: null,
              durationSeconds: set.durationSeconds ?? null,
              distanceMeters: set.distanceMeters == null ? null : new Prisma.Decimal(set.distanceMeters),
              rpe: null,
              rir: null,
              restSeconds: null,
              isWarmup: false,
              completed: true,
              completedAt: set.completedAt ?? null,
              painFlag: false,
              painNote: null,
              notes: null,
            },
          ],
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /** An active plan that started on `localDay` with one planned workout that day holding `exerciseIds`. */
  function activePlan(exerciseIds: string[], weekday = isoWeekday(localDay)) {
    prisma.program.findFirst.mockResolvedValue({
      id: PROGRAM,
      status: 'active',
      startDate: new Date(`${localDay}T00:00:00.000Z`),
    });
    prisma.programBlock.findMany.mockResolvedValue([
      { id: BLOCK, position: 0, name: 'Base', focus: null, rationale: null, archivedAt: null },
    ]);
    prisma.programWeek.findMany.mockResolvedValue([
      { id: WEEK, blockId: BLOCK, weekNumber: 1, isDeload: false, archivedAt: null },
    ]);
    prisma.programWorkout.findMany.mockResolvedValue([
      {
        id: PROGRAM_WORKOUT,
        weekId: WEEK,
        position: 0,
        weekday,
        name: 'Walk day',
        estimatedMinutes: 30,
        rationale: null,
        archivedAt: null,
      },
    ]);
    prisma.programExercise.findMany.mockResolvedValue(
      exerciseIds.map((exerciseId, position) => ({
        id: `cccccccc-cccc-4ccc-8ccc-${String(position).padStart(12, '0')}`,
        programWorkoutId: PROGRAM_WORKOUT,
        exerciseId,
        position,
        isPriority: false,
        targetSets: null,
        repMin: null,
        repMax: null,
        targetDurationSeconds: 1800,
        targetDistanceMeters: null,
        targetLoadKg: null,
        targetRpe: null,
        restSeconds: 0,
        loadGuidance: 'choose_start',
        rationale: null,
        evidenceRefs: [],
        notes: null,
        equipmentTypeId: null,
      })),
    );
  }

  async function post(body: unknown, expected: number) {
    const user = await createMockContributorUser(context);
    const response = await request(server())
      .post('/api/workouts/quick-cardio')
      .set(authHeader(user.accessToken))
      .send(body as object)
      .expect(expected);
    return { user, response };
  }

  // ---------------------------------------------------------------------------
  // The created workout
  // ---------------------------------------------------------------------------

  it('creates a completed, gym-free workout with one exercise and one completed set (201)', async () => {
    const { user, response } = await post(
      { exerciseKey: 'outdoor_walk', durationSeconds: 1800, distanceMeters: 2500.5, performedAt: performedAt.toISOString(), note: ' Easy loop ' },
      201,
    );

    const data = prisma.workout.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: user.id,
      name: 'Outdoor walk',
      status: 'completed',
      gymId: null,
      programWorkoutId: null,
      durationSeconds: 1800,
      notes: 'Easy loop',
    });
    expect(data.date).toEqual(new Date(`${localDay}T00:00:00.000Z`));
    expect(data.endedAt).toEqual(performedAt);
    expect(data.startedAt).toEqual(new Date(performedAt.getTime() - 1800 * 1000));
    expect(data.exercises.create).toEqual([
      {
        exerciseId: EXERCISE,
        position: 0,
        sets: {
          create: [{ setNumber: 1, durationSeconds: 1800, distanceMeters: 2500.5, completed: true, completedAt: performedAt }],
        },
      },
    ]);

    // The default gym is never consulted, never applied.
    expect(prisma.gym.findFirst).not.toHaveBeenCalled();
    expect(prisma.exercise.findFirst.mock.calls[0][0].where).toEqual({ slug: 'outdoor_walk', ownerUserId: null, status: 'active' });

    expect(response.body.data.linkedProgramWorkoutId).toBeNull();
    expect(response.body.data.workout).toMatchObject({
      id: WORKOUT,
      status: 'completed',
      gymId: null,
      durationSeconds: 1800,
      date: localDay,
      programWorkoutId: null,
    });
    expect(response.body.data.workout.exercises).toHaveLength(1);
    expect(response.body.data.workout.exercises[0].sets).toEqual([
      expect.objectContaining({ setNumber: 1, durationSeconds: 1800, distanceMeters: 2500.5, completed: true }),
    ]);
  });

  it('distance only: starts and ends at performedAt with no duration; defaults performedAt to now', async () => {
    const before = Date.now();
    await post({ exerciseKey: 'outdoor_run', distanceMeters: 5000 }, 201);
    const after = Date.now();

    const data = prisma.workout.create.mock.calls[0][0].data;
    expect(data.durationSeconds).toBeNull();
    expect(data.startedAt).toEqual(data.endedAt);
    expect(data.endedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.endedAt.getTime()).toBeLessThanOrEqual(after);
    expect(data.exercises.create[0].sets.create[0]).toMatchObject({ durationSeconds: null, distanceMeters: 5000 });
    expect(prisma.exercise.findFirst.mock.calls[0][0].where.slug).toBe('outdoor_run');
  });

  it('emits workout.finished once with ids only, after the write', async () => {
    const { user } = await post({ exerciseKey: 'hike', durationSeconds: 7200 }, 201);

    const calls = emit.mock.calls.filter(([event]) => event === WORKOUT_FINISHED_EVENT);
    expect(calls).toEqual([[WORKOUT_FINISHED_EVENT, { userId: user.id, workoutId: WORKOUT }]]);
    expect(emit.mock.invocationCallOrder[0]).toBeGreaterThan(prisma.workout.create.mock.invocationCallOrder[0]);
  });

  it('404s when the exercise is not in the library, creating nothing', async () => {
    prisma.exercise.findFirst.mockResolvedValue(null);
    await post({ exerciseKey: 'outdoor_walk', durationSeconds: 600 }, 404);
    expect(prisma.workout.create).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Linking to the active plan
  // ---------------------------------------------------------------------------

  describe('plan linking', () => {
    it('links to that local day\'s planned workout when it holds the exercise', async () => {
      activePlan([OTHER_EXERCISE, EXERCISE]);

      const { response } = await post(
        { exerciseKey: 'outdoor_walk', durationSeconds: 1800, performedAt: performedAt.toISOString() },
        201,
      );

      expect(prisma.workout.create.mock.calls[0][0].data.programWorkoutId).toBe(PROGRAM_WORKOUT);
      expect(response.body.data.linkedProgramWorkoutId).toBe(PROGRAM_WORKOUT);
      expect(response.body.data.workout.programWorkoutId).toBe(PROGRAM_WORKOUT);
      // Read-only over the plan: no program row is written.
      expect(prisma.program.update).not.toHaveBeenCalled();
      expect(prisma.program.updateMany).not.toHaveBeenCalled();
      expect(prisma.programSession.create).not.toHaveBeenCalled();
    });

    it('is an extra session when the planned workout of the day lacks the exercise', async () => {
      activePlan([OTHER_EXERCISE]);

      const { response } = await post(
        { exerciseKey: 'outdoor_walk', durationSeconds: 1800, performedAt: performedAt.toISOString() },
        201,
      );

      expect(prisma.workout.create.mock.calls[0][0].data.programWorkoutId).toBeNull();
      expect(response.body.data.linkedProgramWorkoutId).toBeNull();
    });

    it('is an extra session on a rest day', async () => {
      activePlan([EXERCISE], (isoWeekday(localDay) % 7) + 1);

      const { response } = await post(
        { exerciseKey: 'outdoor_walk', durationSeconds: 1800, performedAt: performedAt.toISOString() },
        201,
      );

      expect(response.body.data.linkedProgramWorkoutId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  describe('validation', () => {
    it.each([
      ['neither duration nor distance', { exerciseKey: 'outdoor_walk' }],
      ['an unknown exerciseKey', { exerciseKey: 'treadmill_run', durationSeconds: 600 }],
      ['a missing exerciseKey', { durationSeconds: 600 }],
      ['a duration under 60 s', { exerciseKey: 'outdoor_walk', durationSeconds: 59 }],
      ['a duration over 36000 s', { exerciseKey: 'outdoor_walk', durationSeconds: 36_001 }],
      ['a fractional duration', { exerciseKey: 'outdoor_walk', durationSeconds: 600.5 }],
      ['a zero distance', { exerciseKey: 'outdoor_walk', distanceMeters: 0 }],
      ['a distance over 100000 m', { exerciseKey: 'outdoor_walk', distanceMeters: 100_001 }],
      ['a distance with 3 decimals', { exerciseKey: 'outdoor_walk', distanceMeters: 1.234 }],
      ['a note over 280 characters', { exerciseKey: 'outdoor_walk', durationSeconds: 600, note: 'x'.repeat(281) }],
      ['a non-ISO performedAt', { exerciseKey: 'outdoor_walk', durationSeconds: 600, performedAt: 'yesterday' }],
      ['an unknown field', { exerciseKey: 'outdoor_walk', durationSeconds: 600, gymId: GYM }],
    ])('400s %s and creates nothing', async (_label, body) => {
      const { response } = await post(body, 400);
      expect(response.body.code).toBe('BAD_REQUEST');
      expect(prisma.workout.create).not.toHaveBeenCalled();
    });

    it('400s a performedAt in the future with TIME_IN_FUTURE', async () => {
      const { response } = await post(
        { exerciseKey: 'outdoor_walk', durationSeconds: 600, performedAt: new Date(Date.now() + HOUR_MS).toISOString() },
        400,
      );
      expect(response.body.details).toMatchObject({ reason: 'TIME_IN_FUTURE', path: 'performedAt' });
      expect(prisma.workout.create).not.toHaveBeenCalled();
    });

    it('400s a performedAt more than 7 days ago with PERFORMED_AT_OUT_OF_RANGE; 6 days ago is accepted', async () => {
      const { response } = await post(
        { exerciseKey: 'outdoor_walk', durationSeconds: 600, performedAt: new Date(Date.now() - 8 * DAY_MS).toISOString() },
        400,
      );
      expect(response.body.details).toMatchObject({ reason: 'PERFORMED_AT_OUT_OF_RANGE', path: 'performedAt' });
      expect(prisma.workout.create).not.toHaveBeenCalled();

      await post(
        { exerciseKey: 'outdoor_walk', durationSeconds: 600, performedAt: new Date(Date.now() - 6 * DAY_MS).toISOString() },
        201,
      );
    });
  });
});
