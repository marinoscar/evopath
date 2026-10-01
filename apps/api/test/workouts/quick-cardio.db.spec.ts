// =============================================================================
// Real-Postgres test: quick cardio log (E8 F4, #264)
// =============================================================================
//
// What only a real server can prove: `POST /api/workouts/quick-cardio`'s
// service persists a COMPLETED, gym-free workout (a default gym never
// applies) with exactly one exercise (the seeded `outdoor_walk`) and one
// completed set; it is created finished, so it coexists with a workout in
// progress (the partial unique index `workouts_user_in_progress_uniq_idx`
// never sees it); and it links to the active plan's planned workout of that
// local day through `workouts.program_workout_id` only when that planned
// workout holds the exercise (a cardio-shaped prescription row).
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated, seeded
// database (the seeded `outdoor_walk` and `outdoor_run` exercises).
// =============================================================================

import { randomUUID } from 'node:crypto';

import { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaClient } from '@prisma/client';

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { GymsService } from '../../src/gyms/gyms.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { quickCardioSchema } from '../../src/workouts/dto/quick-cardio.dto';
import { startWorkoutSchema } from '../../src/workouts/dto/workout.dto';
import { QuickCardioService } from '../../src/workouts/quick-cardio.service';
import { WORKOUT_FINISHED_EVENT } from '../../src/workouts/workout-events';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('quick-cardio.db.spec');

// Wednesday 2026-09-30, noon UTC (no Health Profile time zone: UTC).
const NOW = new Date('2026-09-30T12:00:00.000Z');
const PERFORMED_AT = new Date('2026-09-30T11:00:00.000Z');
const TODAY = '2026-09-30';
const MONDAY = '2026-09-28';

describeWithDb('quick cardio log (real Postgres)', () => {
  let client: PrismaClient;
  let workouts: WorkoutsService;
  let quickCardio: QuickCardioService;
  let events: EventEmitter2;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `qcardio-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  async function exerciseId(slug: string): Promise<string> {
    return (await client.exercise.findFirstOrThrow({ where: { slug, ownerUserId: null }, select: { id: true } })).id;
  }

  /** An active plan started Monday 2026-09-28 whose Wednesday workout holds `slug` (30 min, cardio shape). */
  async function activePlanWith(userId: string, slug: string): Promise<string> {
    const program = await client.program.create({
      data: { userId, name: 'Walk plan', goal: 'general', status: 'active', startDate: new Date(`${MONDAY}T00:00:00.000Z`) },
    });
    const block = await client.programBlock.create({ data: { programId: program.id, position: 0, name: 'Base' } });
    const week = await client.programWeek.create({ data: { programId: program.id, blockId: block.id, weekNumber: 1 } });
    const wednesday = await client.programWorkout.create({
      data: { weekId: week.id, position: 0, weekday: 3, name: 'Walk day', estimatedMinutes: 30 },
    });
    await client.programExercise.create({
      data: {
        programWorkoutId: wednesday.id,
        exerciseId: await exerciseId(slug),
        position: 0,
        targetDurationSeconds: 1800,
        restSeconds: 0,
      },
    });
    return wednesday.id;
  }

  const body = (input: unknown) => quickCardioSchema.parse(input);

  beforeAll(() => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
    const history = new WorkoutHistoryService(prisma, checkIns);
    events = new EventEmitter2();
    workouts = new WorkoutsService(prisma, new GymsService(prisma, {} as GymStorageService), checkIns, history, undefined, events);
    quickCardio = new QuickCardioService(prisma, checkIns, workouts);
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.program.deleteMany({ where: { userId: { in: userIds } } });
    await client.gym.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  it('persists a finished, gym-free workout with one exercise and one set, alongside a workout in progress', async () => {
    const userId = await makeUser('persist');
    await client.gym.create({ data: { userId, name: 'Default', type: 'home', isDefault: true } });
    const inProgress = await workouts.start(userId, startWorkoutSchema.parse({}), NOW);
    expect(inProgress.status).toBe('in_progress');

    const finished: unknown[] = [];
    const listener = (event: unknown) => finished.push(event);
    events.on(WORKOUT_FINISHED_EVENT, listener);
    try {
      const result = await quickCardio.log(
        userId,
        body({ exerciseKey: 'outdoor_walk', durationSeconds: 1800, distanceMeters: 2400.25, performedAt: PERFORMED_AT.toISOString(), note: 'Park loop' }),
        NOW,
      );

      expect(result.linkedProgramWorkoutId).toBeNull();
      expect(result.workout).toMatchObject({ status: 'completed', gymId: null, date: TODAY, durationSeconds: 1800, notes: 'Park loop' });
      expect(finished).toEqual([{ userId, workoutId: result.workout.id }]);

      const row = await client.workout.findUniqueOrThrow({
        where: { id: result.workout.id },
        include: { exercises: { include: { sets: true, exercise: { select: { slug: true } } } } },
      });
      expect(row).toMatchObject({ status: 'completed', gymId: null, durationSeconds: 1800, programWorkoutId: null });
      expect(row.startedAt).toEqual(new Date(PERFORMED_AT.getTime() - 1800 * 1000));
      expect(row.endedAt).toEqual(PERFORMED_AT);
      expect(row.exercises).toHaveLength(1);
      expect(row.exercises[0].exercise.slug).toBe('outdoor_walk');
      expect(row.exercises[0].sets).toHaveLength(1);
      expect(row.exercises[0].sets[0]).toMatchObject({ setNumber: 1, durationSeconds: 1800, completed: true });
      expect(Number(row.exercises[0].sets[0].distanceMeters)).toBe(2400.25);
    } finally {
      events.off(WORKOUT_FINISHED_EVENT, listener);
    }

    // The workout in progress is untouched and still the only one in progress.
    const statuses = await client.workout.findMany({ where: { userId }, select: { id: true, status: true } });
    expect(statuses.filter((row) => row.status === 'in_progress')).toEqual([{ id: inProgress.id, status: 'in_progress' }]);
    expect(statuses.filter((row) => row.status === 'completed')).toHaveLength(1);
  });

  it('links to the planned workout of that local day when it holds the exercise; otherwise it is an extra session', async () => {
    const userId = await makeUser('link');
    const wednesdayId = await activePlanWith(userId, 'outdoor_walk');

    const walk = await quickCardio.log(
      userId,
      body({ exerciseKey: 'outdoor_walk', durationSeconds: 1500, performedAt: PERFORMED_AT.toISOString() }),
      NOW,
    );
    expect(walk.linkedProgramWorkoutId).toBe(wednesdayId);
    expect(walk.workout.programWorkoutId).toBe(wednesdayId);
    expect((await client.workout.findUniqueOrThrow({ where: { id: walk.workout.id } })).programWorkoutId).toBe(wednesdayId);
    // Read-only over the plan: no program_sessions row.
    expect(await client.programSession.count({ where: { userId } })).toBe(0);

    const run5k = await quickCardio.log(
      userId,
      body({ exerciseKey: 'outdoor_run', distanceMeters: 5000, performedAt: PERFORMED_AT.toISOString() }),
      NOW,
    );
    expect(run5k.linkedProgramWorkoutId).toBeNull();
    expect(run5k.workout.durationSeconds).toBeNull();

    // A walk on Tuesday (a rest day) is an extra session too.
    const tuesday = await quickCardio.log(
      userId,
      body({ exerciseKey: 'outdoor_walk', durationSeconds: 900, performedAt: '2026-09-29T18:00:00.000Z' }),
      NOW,
    );
    expect(tuesday.linkedProgramWorkoutId).toBeNull();
    expect(tuesday.workout.date).toBe('2026-09-29');
  });
});
