// =============================================================================
// Real-Postgres test: GET /api/workouts/summary (E4.6)
// =============================================================================
//
// What only real rows prove: the ISO week boundary over `@db.Date` values
// (Monday and Sunday inclusive; a Sunday-dated workout belongs to the week
// that began the previous Monday; the Sundays around it do not), the last
// completed workout chosen by `date` then `startedAt`, the filtered set count
// of the workout in progress, totals over real decimals, a deleted gym read as
// null, and another user's rows never appearing. Also that the two indexes
// the reads rely on (`user_id, status` and `user_id, date desc`) exist.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { addDays, localDateInZone } from '../../src/check-ins/local-date';
import { GymsService } from '../../src/gyms/gyms.service';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('workout-summary.db.spec');

// A fixed "now" whose UTC day is a Sunday; the client-supplied today is
// checked against the server's today, so every call passes this instant.
const NOW = new Date('2026-10-04T12:00:00.000Z'); // Sunday
const SUNDAY = '2026-10-04';
const MONDAY = '2026-09-28';

describeWithDb('workouts summary (real Postgres)', () => {
  let client: PrismaClient;
  let workouts: WorkoutsService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const exerciseIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `summary-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  async function makeExercise(label: string): Promise<string> {
    const exercise = await client.exercise.create({
      data: {
        slug: `sum-${run}-${label}`,
        name: `Summary ${label}`,
        primaryMuscles: ['chest'],
        movementPattern: 'horizontal_push',
      },
      select: { id: true },
    });
    exerciseIds.push(exercise.id);
    return exercise.id;
  }

  interface SetSpec {
    weightKg?: string | null;
    reps?: number | null;
    completed?: boolean;
    isWarmup?: boolean;
  }

  /** A workout row with exercises and sets, written directly so any date is allowed. */
  async function makeWorkout(
    userId: string,
    date: string,
    options: {
      status?: 'in_progress' | 'completed';
      startedAt?: Date;
      gymId?: string | null;
      name?: string;
      exercises?: Array<{ exerciseId: string; sets: SetSpec[] }>;
    } = {},
  ): Promise<string> {
    const status = options.status ?? 'completed';
    const startedAt = options.startedAt ?? new Date(`${date}T08:00:00.000Z`);
    const workout = await client.workout.create({
      data: {
        userId,
        name: options.name ?? `W ${date}`,
        date: new Date(`${date}T00:00:00.000Z`),
        status,
        startedAt,
        endedAt: status === 'completed' ? new Date(startedAt.getTime() + 3_600_000) : null,
        durationSeconds: status === 'completed' ? 3600 : null,
        gymId: options.gymId ?? null,
        exercises: {
          create: (options.exercises ?? []).map((entry, position) => ({
            exerciseId: entry.exerciseId,
            position,
            sets: {
              create: entry.sets.map((set, index) => ({
                setNumber: index + 1,
                weightKg: set.weightKg === undefined ? '100' : set.weightKg,
                reps: set.reps === undefined ? 5 : set.reps,
                completed: set.completed ?? true,
                completedAt: set.completed === false ? null : startedAt,
                isWarmup: set.isWarmup ?? false,
              })),
            },
          })),
        },
      },
      select: { id: true },
    });
    return workout.id;
  }

  beforeAll(() => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
    workouts = new WorkoutsService(prisma, new GymsService(prisma, {} as GymStorageService), checkIns, new WorkoutHistoryService(prisma, checkIns));
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.gym.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    await client.$disconnect();
  });

  it('a new user gets the empty shape', async () => {
    const userId = await makeUser('empty');

    await expect(workouts.summary(userId, { today: SUNDAY }, NOW)).resolves.toEqual({
      inProgress: null,
      last: null,
      thisWeek: { workoutCount: 0, weekStart: MONDAY },
      daysSinceLast: null,
    });
  });

  it('counts completed workouts Monday to Sunday inclusive; a Sunday belongs to the week that began the previous Monday', async () => {
    const userId = await makeUser('week');
    await makeWorkout(userId, addDays(MONDAY, -1)); // the previous Sunday: last week
    await makeWorkout(userId, MONDAY); // Monday: in
    await makeWorkout(userId, '2026-10-01'); // Thursday: in, and a workout without exercises still counts
    await makeWorkout(userId, SUNDAY); // Sunday: in
    await makeWorkout(userId, addDays(SUNDAY, 1)); // next Monday: next week (a +1 day client date is allowed)

    const onSunday = await workouts.summary(userId, { today: SUNDAY }, NOW);
    expect(onSunday.thisWeek).toEqual({ workoutCount: 3, weekStart: MONDAY });

    const onMonday = await workouts.summary(userId, { today: addDays(SUNDAY, 1) }, NOW);
    expect(onMonday.thisWeek).toEqual({ workoutCount: 1, weekStart: addDays(SUNDAY, 1) });

    // Another user's workouts this week never count.
    const other = await makeUser('week-other');
    await makeWorkout(other, '2026-10-01');
    expect((await workouts.summary(userId, { today: SUNDAY }, NOW)).thisWeek.workoutCount).toBe(3);
  });

  it('does not count the workout in progress in the week, and fills inProgress with its completed sets', async () => {
    const userId = await makeUser('progress');
    const bench = await makeExercise('progress-bench');
    const row = await makeExercise('progress-row');
    const gym = await client.gym.create({ data: { userId, name: 'Garage' }, select: { id: true } });
    const startedAt = new Date('2026-10-04T11:30:00.000Z');
    const id = await makeWorkout(userId, SUNDAY, {
      status: 'in_progress',
      startedAt,
      gymId: gym.id,
      name: 'Sunday workout',
      exercises: [
        { exerciseId: bench, sets: [{ isWarmup: true }, {}, { completed: false }] },
        { exerciseId: row, sets: [] },
      ],
    });

    const summary = await workouts.summary(userId, { today: SUNDAY }, NOW);

    expect(summary.inProgress).toEqual({
      id,
      name: 'Sunday workout',
      startedAt: startedAt.toISOString(),
      gym: { id: gym.id, name: 'Garage' },
      exerciseCount: 2,
      completedSetCount: 2,
    });
    expect(summary.last).toBeNull();
    expect(summary.thisWeek.workoutCount).toBe(0);
  });

  it('fills last from the latest completed workout: 3 days ago, totals over working sets, top lifts, deleted gym as null', async () => {
    const userId = await makeUser('last');
    const other = await makeUser('last-other');
    const [bench, squat, curl, deadlift] = await Promise.all(
      ['bench', 'squat', 'curl', 'deadlift'].map((label) => makeExercise(`last-${label}`)),
    );
    const gym = await client.gym.create({ data: { userId, name: 'Old gym' }, select: { id: true } });
    const threeDaysAgo = addDays(SUNDAY, -3);

    await makeWorkout(userId, addDays(SUNDAY, -10), { name: 'Older' });
    // Same date, earlier start: not the last one.
    await makeWorkout(userId, threeDaysAgo, { name: 'Morning', startedAt: new Date(`${threeDaysAgo}T06:00:00.000Z`) });
    const lastId = await makeWorkout(userId, threeDaysAgo, {
      name: 'Evening',
      startedAt: new Date(`${threeDaysAgo}T18:00:00.000Z`),
      gymId: gym.id,
      exercises: [
        {
          exerciseId: bench,
          sets: [
            { weightKg: '60', reps: 10, isWarmup: true },
            { weightKg: '82.5', reps: 5 },
            { weightKg: '90', reps: 5, completed: false },
          ],
        },
        { exerciseId: squat, sets: [{ weightKg: '140', reps: 3 }] },
        { exerciseId: curl, sets: [{ weightKg: '12.5', reps: 12 }] },
        { exerciseId: deadlift, sets: [{ weightKg: '180', reps: 1 }] },
      ],
    });
    // Another user's newer workout never appears.
    await makeWorkout(other, SUNDAY, { name: 'Not mine' });
    await client.gym.delete({ where: { id: gym.id } });

    const summary = await workouts.summary(userId, { today: SUNDAY }, NOW);

    expect(summary.last).toEqual({
      id: lastId,
      name: 'Evening',
      date: threeDaysAgo,
      durationSeconds: 3600,
      gym: null,
      exerciseCount: 4,
      setCount: 4,
      volumeKg: 82.5 * 5 + 140 * 3 + 12.5 * 12 + 180,
      topLifts: [
        { exerciseName: `Summary last-deadlift`, weightKg: 180, reps: 1 },
        { exerciseName: `Summary last-squat`, weightKg: 140, reps: 3 },
        { exerciseName: `Summary last-bench`, weightKg: 82.5, reps: 5 },
      ],
    });
    expect(summary.daysSinceLast).toBe(3);
    expect(summary.inProgress).toBeNull();
  });

  it('defaults today to the Health Profile time zone', async () => {
    const userId = await makeUser('zone');
    await client.healthProfile.create({ data: { userId, timeZone: 'Pacific/Kiritimati' } }); // UTC+14
    const instant = new Date('2026-10-04T12:00:00.000Z'); // already Monday 2026-10-05 in Kiritimati
    expect(localDateInZone(instant, 'Pacific/Kiritimati')).toBe('2026-10-05');

    const summary = await workouts.summary(userId, {}, instant);

    expect(summary.thisWeek.weekStart).toBe('2026-10-05');
    await client.healthProfile.deleteMany({ where: { userId } });
  });

  it('has the two indexes the reads rely on', async () => {
    const indexes = await client.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'workouts'`;
    const defs = indexes.map((row) => row.indexdef);

    expect(defs.some((def) => /\(user_id, status\)/.test(def))).toBe(true);
    expect(defs.some((def) => /\(user_id, date DESC\)/.test(def))).toBe(true);
  });
});
