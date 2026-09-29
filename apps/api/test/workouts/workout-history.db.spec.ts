// =============================================================================
// Real-Postgres test: exercise history, last time and PRs (E4.4)
// =============================================================================
//
// The acceptance fixture inserted into real tables (one library exercise, all
// completed working sets, kg): Sep 1: 60x10, 60x10; Sep 8: 62.5x8, 62.5x8;
// Sep 15: 65x6. Then a Sep 22 workout logged through the real services.
//
// What only a real server can prove: the grouped SQL (`GROUP BY weight`, the
// `FILTER`ed MAX, the `(date, started_at)` row comparison, the records CTE
// with ROUND over numeric) gives the same answers as the pure functions of
// `workout-records.ts` over the raw rows; another user's sets of the same
// library exercise never enter a comparison; another user's custom exercise
// is a 404; and the query plan over 10,000 sets.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { fromDbDate } from '../../src/check-ins/local-date';
import { GymsService } from '../../src/gyms/gyms.service';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createSetSchema, updateSetSchema } from '../../src/workouts/dto/workout.dto';
import { exerciseHistoryQuerySchema } from '../../src/workouts/dto/exercise-history.dto';
import { WorkoutEntriesService } from '../../src/workouts/workout-entries.service';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { classifySequence, recordsOf, toWorkingSet } from '../../src/workouts/workout-records';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('workout-history.db.spec');

const day = (date: string) => new Date(`${date}T00:00:00.000Z`);
const historyQuery = (input: unknown = {}) => exerciseHistoryQuerySchema.parse(input);
const setInput = (input: unknown) => createSetSchema.parse(input);
const setPatch = (input: unknown) => updateSetSchema.parse(input);

type SetSpec = { weightKg: number | null; reps: number | null; completed?: boolean; isWarmup?: boolean; durationSeconds?: number };

describeWithDb('exercise history and PRs (real Postgres)', () => {
  let client: PrismaClient;
  let history: WorkoutHistoryService;
  let workouts: WorkoutsService;
  let entries: WorkoutEntriesService;

  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const exerciseIds: string[] = [];

  let userA: string;
  let userB: string;
  let bench: string;
  let pullUp: string;
  let plank: string;
  let homeGym: string;
  let hotelGym: string;
  const fixture: Record<string, string> = {};

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `history-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  async function makeExercise(label: string, trackingMode: string, ownerUserId: string | null = null): Promise<string> {
    const exercise = await client.exercise.create({
      data: {
        slug: `hist-${run}-${label}`,
        name: `History test ${label}`,
        primaryMuscles: ['chest'],
        movementPattern: 'horizontal_push',
        trackingMode,
        ownerUserId,
      },
      select: { id: true },
    });
    exerciseIds.push(exercise.id);
    return exercise.id;
  }

  /** A workout inserted directly (any date, any status) with one exercise and its sets. */
  async function insertWorkout(
    userId: string,
    date: string,
    exerciseId: string,
    sets: SetSpec[],
    options: { status?: 'completed' | 'in_progress'; gymId?: string | null; hour?: number } = {},
  ): Promise<{ workoutId: string; weId: string; setIds: string[] }> {
    const startedAt = new Date(`${date}T${String(options.hour ?? 17).padStart(2, '0')}:00:00.000Z`);
    const status = options.status ?? 'completed';
    const workout = await client.workout.create({
      data: {
        userId,
        name: `W ${date}`,
        date: day(date),
        status,
        startedAt,
        endedAt: status === 'completed' ? new Date(startedAt.getTime() + 3_600_000) : null,
        gymId: options.gymId ?? null,
        exercises: {
          create: {
            exerciseId,
            position: 0,
            sets: {
              create: sets.map((set, index) => ({
                setNumber: index + 1,
                weightKg: set.weightKg,
                reps: set.reps,
                durationSeconds: set.durationSeconds ?? null,
                isWarmup: set.isWarmup ?? false,
                completed: set.completed ?? true,
                completedAt: (set.completed ?? true) ? startedAt : null,
              })),
            },
          },
        },
      },
      select: { id: true, exercises: { select: { id: true, sets: { orderBy: { setNumber: 'asc' }, select: { id: true } } } } },
    });
    return {
      workoutId: workout.id,
      weId: workout.exercises[0].id,
      setIds: workout.exercises[0].sets.map((set) => set.id),
    };
  }

  /** Raw prior working sets of `exerciseId` for `userId`, read without any SQL aggregate. */
  async function rawPrior(userId: string, exerciseId: string, before: { date: string; startedAt: Date }) {
    const rows = await client.setLog.findMany({
      where: { workoutExercise: { exerciseId, workout: { userId, status: 'completed' } } },
      select: {
        weightKg: true,
        reps: true,
        completed: true,
        isWarmup: true,
        workoutExercise: { select: { workout: { select: { date: true, startedAt: true } } } },
      },
    });
    return rows.filter((row) => {
      const date = fromDbDate(row.workoutExercise.workout.date);
      return date < before.date || (date === before.date && row.workoutExercise.workout.startedAt < before.startedAt);
    });
  }

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const gyms = new GymsService(prisma, {} as GymStorageService);
    const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
    history = new WorkoutHistoryService(prisma, checkIns);
    workouts = new WorkoutsService(prisma, gyms, checkIns, history);
    entries = new WorkoutEntriesService(prisma, history);

    userA = await makeUser('a');
    userB = await makeUser('b');
    bench = await makeExercise('bench', 'weight_reps');
    pullUp = await makeExercise('pullup', 'bodyweight_reps');
    plank = await makeExercise('plank', 'time');
    homeGym = (await client.gym.create({ data: { userId: userA, name: 'Home Gym' }, select: { id: true } })).id;
    hotelGym = (await client.gym.create({ data: { userId: userA, name: 'Hotel gym' }, select: { id: true } })).id;

    // The acceptance fixture (user A), with a warm-up and an uncompleted set that must never count.
    fixture.sep1 = (
      await insertWorkout(userA, '2026-09-01', bench, [
        { weightKg: 100, reps: 1, isWarmup: true },
        { weightKg: 60, reps: 10 },
        { weightKg: 60, reps: 10 },
        { weightKg: 90, reps: 5, completed: false },
      ], { gymId: homeGym })
    ).workoutId;
    fixture.sep8 = (await insertWorkout(userA, '2026-09-08', bench, [{ weightKg: 62.5, reps: 8 }, { weightKg: 62.5, reps: 8 }], { gymId: homeGym })).workoutId;
    fixture.sep15 = (await insertWorkout(userA, '2026-09-15', bench, [{ weightKg: 65, reps: 6 }], { gymId: hotelGym })).workoutId;

    // User B logs the same library exercise far heavier, earlier: it must never reach A.
    await insertWorkout(userB, '2026-08-01', bench, [{ weightKg: 200, reps: 12 }]);
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.gym.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    await client.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  describe('GET history', () => {
    it('lastTime is the Sep 15 sets for a Sep 22 cut-off; records are the fixture\'s, never user B\'s', async () => {
      const result = await history.history(userA, bench, historyQuery({ beforeDate: '2026-09-22' }));

      expect(result.lastTime).toMatchObject({
        workoutId: fixture.sep15,
        date: '2026-09-15',
        gym: { id: hotelGym, name: 'Hotel gym' },
        sets: [{ setNumber: 1, weightKg: 65, reps: 6, isWarmup: false }],
      });
      expect(result.recent.map((r) => [r.date, r.topSet, r.e1rmKg])).toEqual([
        ['2026-09-15', { weightKg: 65, reps: 6 }, 78],
        ['2026-09-08', { weightKg: 62.5, reps: 8 }, 79.2],
        ['2026-09-01', { weightKg: 60, reps: 10 }, 80],
      ]);
      expect(result.records).toEqual({
        maxWeightKg: { value: 65, reps: 6, date: '2026-09-15' },
        maxReps: { value: 10, weightKg: 60, date: '2026-09-01' },
        bestE1rmKg: { value: 80, weightKg: 60, reps: 10, date: '2026-09-01' },
      });
    });

    it('the SQL records equal recordsOf over the raw rows', async () => {
      const raw = await rawPrior(userA, bench, { date: '2026-09-23', startedAt: new Date(0) });
      const dated = raw.flatMap((row) => {
        const working = toWorkingSet({ ...row, weightKg: row.weightKg === null ? null : row.weightKg.toNumber() }, 'weight_reps');
        return working
          ? [{ ...working, date: fromDbDate(row.workoutExercise.workout.date), startedAt: row.workoutExercise.workout.startedAt }]
          : [];
      });

      const result = await history.history(userA, bench, historyQuery({ beforeDate: '2026-09-22' }));
      expect(result.records).toEqual(recordsOf(dated));
    });

    it('prefers the gym when one of the two most recent workouts was there', async () => {
      const result = await history.history(userA, bench, historyQuery({ beforeDate: '2026-09-22', gymId: homeGym }));
      expect(result.lastTime).toMatchObject({ workoutId: fixture.sep8, gym: { id: homeGym, name: 'Home Gym' } });
    });

    it('as of Sep 10 sees only Sep 1 and Sep 8; as of the Sep 8 workout only Sep 1', async () => {
      const asOf = await history.history(userA, bench, historyQuery({ beforeDate: '2026-09-10' }));
      expect(asOf.lastTime?.workoutId).toBe(fixture.sep8);
      expect(asOf.records.maxWeightKg).toEqual({ value: 62.5, reps: 8, date: '2026-09-08' });

      const before = await history.history(userA, bench, historyQuery({ workoutId: fixture.sep8 }));
      expect(before.lastTime?.workoutId).toBe(fixture.sep1);
      // The warm-up 100x1 and the uncompleted 90x5 never count; the warm-up is listed as such.
      expect(before.records.maxWeightKg).toEqual({ value: 60, reps: 10, date: '2026-09-01' });
      expect(before.lastTime?.sets.map((s) => [s.weightKg, s.reps, s.isWarmup])).toEqual([
        [100, 1, true],
        [60, 10, false],
        [60, 10, false],
      ]);
    });

    it('user B sees only their own sets of the same library exercise', async () => {
      const result = await history.history(userB, bench, historyQuery({ beforeDate: '2026-09-22' }));
      expect(result.recent).toHaveLength(1);
      expect(result.records.maxWeightKg).toEqual({ value: 200, reps: 12, date: '2026-08-01' });
    });

    it('another user\'s custom exercise is a 404; an own one is readable', async () => {
      const custom = await makeExercise('custom-b', 'weight_reps', userB);
      await expect(history.history(userA, custom, historyQuery())).rejects.toBeInstanceOf(NotFoundException);
      await expect(history.history(userB, custom, historyQuery())).resolves.toMatchObject({ lastTime: null, recent: [] });
    });

    it('another user\'s workoutId is a 404', async () => {
      await expect(history.history(userB, bench, historyQuery({ workoutId: fixture.sep8 }))).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // PRs
  // ---------------------------------------------------------------------------

  describe('PRs on a Sep 22 workout logged through the services', () => {
    let workoutId: string;
    let weId: string;

    beforeAll(async () => {
      const created = await insertWorkout(userA, '2026-09-22', bench, [], { status: 'in_progress' });
      workoutId = created.workoutId;
      weId = created.weId;
    });

    afterAll(async () => {
      await client.workout.update({ where: { id: workoutId }, data: { status: 'completed' } });
    });

    it('65x7 is a rep PR and an e1RM PR (80.2 > 80.0)', async () => {
      const set = await entries.addSet(userA, workoutId, weId, setInput({ weightKg: 65, reps: 7, completed: true }));
      expect(set.prs).toEqual([
        { type: 'reps', value: 7, previous: 6 },
        { type: 'e1rm', value: 80.2, previous: 80 },
      ]);
    });

    it('67.5x5 is a weight PR only', async () => {
      const set = await entries.addSet(userA, workoutId, weId, setInput({ weightKg: 67.5, reps: 5, completed: true }));
      expect(set.prs).toEqual([{ type: 'weight', value: 67.5, previous: 65 }]);
    });

    it('60x12 is a rep PR and an e1RM PR (84.0), not a weight PR', async () => {
      const set = await entries.addSet(userA, workoutId, weId, setInput({ weightKg: 60, reps: 12, completed: true }));
      expect(set.prs).toEqual([
        { type: 'reps', value: 12, previous: 10 },
        { type: 'e1rm', value: 84, previous: 80.2 },
      ]);
    });

    it('a warm-up 100x1 and an uncompleted set earn nothing; completing it later computes then', async () => {
      const warm = await entries.addSet(userA, workoutId, weId, setInput({ weightKg: 100, reps: 1, isWarmup: true, completed: true }));
      expect(warm.prs).toEqual([]);

      const open = await entries.addSet(userA, workoutId, weId, setInput({ weightKg: 70, reps: 3, completed: false }));
      expect(open.prs).toEqual([]);

      const done = await entries.updateSet(userA, workoutId, open.id, setPatch({ completed: true }));
      expect(done.prs).toEqual([{ type: 'weight', value: 70, previous: 67.5 }]);
    });

    it('the detail view carries the same prs and summary.prs lists the best per type; the grouped SQL equals the pure functions', async () => {
      const view = await workouts.get(userA, workoutId);
      const sets = view.exercises[0].sets;
      expect(sets.map((s) => s.prs.map((pr) => pr.type))).toEqual([['reps', 'e1rm'], ['weight'], ['reps', 'e1rm'], [], ['weight']]);
      expect(view.summary.prs.map((pr) => [pr.type, pr.value, pr.setNumber])).toEqual([
        ['weight', 70, 5],
        ['reps', 12, 3],
        ['e1rm', 84, 3],
      ]);

      // Same answers from raw rows and the pure functions, with no SQL aggregate.
      const context = await client.workout.findUniqueOrThrow({ where: { id: workoutId }, select: { startedAt: true } });
      const prior = await rawPrior(userA, bench, { date: '2026-09-22', startedAt: context.startedAt });
      const priorWorking = prior.flatMap((row) => {
        const working = toWorkingSet({ ...row, weightKg: row.weightKg === null ? null : row.weightKg.toNumber() }, 'weight_reps');
        return working ? [working] : [];
      });
      const buckets = new Map<number, { weightKg: number; maxReps: number; maxRepsForE1rm: number | null }>();
      for (const w of priorWorking) {
        const b = buckets.get(w.weightKg) ?? { weightKg: w.weightKg, maxReps: 0, maxRepsForE1rm: null };
        b.maxReps = Math.max(b.maxReps, w.reps);
        if (w.reps <= 12) b.maxRepsForE1rm = Math.max(b.maxRepsForE1rm ?? 0, w.reps);
        buckets.set(w.weightKg, b);
      }
      const expected = classifySequence(
        sets.map((s) => ({ key: s.id, set: { weightKg: s.weightKg, reps: s.reps, completed: s.completed, isWarmup: s.isWarmup } })),
        'weight_reps',
        [...buckets.values()],
      );
      for (const s of sets) {
        expect(s.prs).toEqual(expected.get(s.id));
      }

      const sqlBuckets = await history.priorBuckets(userA, [bench], {
        kind: 'beforeWorkout',
        workoutId,
        date: day('2026-09-22'),
        startedAt: context.startedAt,
      });
      expect([...(sqlBuckets.get(bench) ?? [])].sort((a, b) => a.weightKg - b.weightKg)).toEqual(
        [...buckets.values()].sort((a, b) => a.weightKg - b.weightKg),
      );
    });

    it('the Sep 8 workout compares only with Sep 1: 62.5x8 is a weight PR, the tie that follows is nothing', async () => {
      const view = await workouts.get(userA, fixture.sep8);
      expect(view.exercises[0].sets.map((s) => s.prs)).toEqual([[{ type: 'weight', value: 62.5, previous: 60 }], []]);
    });

    it('the first ever set is first_time; the warm-up before it is nothing', async () => {
      const view = await workouts.get(userA, fixture.sep1);
      expect(view.exercises[0].sets.map((s) => s.prs)).toEqual([[], [{ type: 'first_time', value: 60, previous: null }], [], []]);
    });

    it('user B\'s 200x12 never reaches A, and A\'s history never reaches B', async () => {
      const b = await insertWorkout(userB, '2026-09-20', bench, [{ weightKg: 150, reps: 5 }], { status: 'in_progress' });
      const view = await workouts.get(userB, b.workoutId);
      // Against B's own 200x12 only: 150x5 is nothing (lighter; e1RM 175.0 < 200*1.4 = 280.0).
      expect(view.exercises[0].sets[0].prs).toEqual([]);
      await client.workout.delete({ where: { id: b.workoutId } });
    });
  });

  describe('bodyweight and time exercises', () => {
    it('an unweighted bodyweight set can earn a rep PR only', async () => {
      await insertWorkout(userA, '2026-09-01', pullUp, [{ weightKg: null, reps: 8 }, { weightKg: null, reps: 10 }]);
      const { workoutId, weId } = await insertWorkout(userA, '2026-09-10', pullUp, [], { status: 'in_progress', hour: 6 });

      const set = await entries.addSet(userA, workoutId, weId, setInput({ weightKg: null, reps: 12, completed: true }));
      expect(set.prs).toEqual([{ type: 'reps', value: 12, previous: 10 }]);

      const history10 = await history.history(userA, pullUp, historyQuery({ beforeDate: '2026-09-10' }));
      expect(history10.records).toEqual({
        maxWeightKg: { value: 0, reps: 10, date: '2026-09-01' },
        maxReps: { value: 10, weightKg: 0, date: '2026-09-01' },
        bestE1rmKg: null,
      });
      await client.workout.delete({ where: { id: workoutId } });
    });

    it('time exercises produce no PRs and no records; last time shows durations', async () => {
      await insertWorkout(userA, '2026-09-02', plank, [{ weightKg: null, reps: null, durationSeconds: 60 }]);
      const { workoutId, weId } = await insertWorkout(userA, '2026-09-09', plank, [], { status: 'in_progress', hour: 6 });

      const set = await entries.addSet(userA, workoutId, weId, setInput({ durationSeconds: 90, completed: true }));
      expect(set.prs).toEqual([]);

      const result = await history.history(userA, plank, historyQuery({ beforeDate: '2026-09-09' }));
      expect(result.lastTime?.sets[0]).toMatchObject({ durationSeconds: 60 });
      expect(result.records).toEqual({ maxWeightKg: null, maxReps: null, bestE1rmKg: null });
      await client.workout.delete({ where: { id: workoutId } });
    });
  });

  // ---------------------------------------------------------------------------
  // Query plan over 10,000 sets
  // ---------------------------------------------------------------------------

  describe('query plan', () => {
    it('the grouped PR query over 10,000 sets of one user stays index-driven and fast', async () => {
      const heavy = await makeUser('heavy');
      // 250 completed workouts x 40 sets = 10,000 sets, generated server-side.
      await client.$executeRaw(Prisma.sql`
        WITH w AS (
          INSERT INTO "workouts" ("id", "user_id", "name", "date", "status", "started_at", "updated_at")
          SELECT gen_random_uuid(), ${heavy}::uuid, 'Bulk', DATE '2025-01-01' + g, 'completed',
                 TIMESTAMPTZ '2025-01-01 17:00+00' + g * INTERVAL '1 day', now()
            FROM generate_series(0, 249) AS g
          RETURNING "id"
        ), we AS (
          INSERT INTO "workout_exercises" ("id", "workout_id", "exercise_id", "position")
          SELECT gen_random_uuid(), w."id", ${bench}::uuid, 0 FROM w
          RETURNING "id"
        )
        INSERT INTO "set_logs" ("id", "workout_exercise_id", "set_number", "weight_kg", "reps", "completed")
        SELECT gen_random_uuid(), we."id", s, 40 + (s % 20) * 2.5, 1 + (s % 12), true
          FROM we, generate_series(1, 40) AS s`);
      await client.$executeRawUnsafe('ANALYZE "workouts"');
      await client.$executeRawUnsafe('ANALYZE "workout_exercises"');
      await client.$executeRawUnsafe('ANALYZE "set_logs"');

      expect(await client.setLog.count({ where: { workoutExercise: { workout: { userId: heavy } } } })).toBe(10_000);

      const plan = await client.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN ANALYZE
         SELECT we."exercise_id", COALESCE(s."weight_kg", 0), MAX(s."reps"), MAX(s."reps") FILTER (WHERE s."reps" <= 12)
           FROM "set_logs" s
           JOIN "workout_exercises" we ON we."id" = s."workout_exercise_id"
           JOIN "workouts" w ON w."id" = we."workout_id"
           JOIN "exercises" e ON e."id" = we."exercise_id"
          WHERE w."user_id" = $1::uuid AND w."status" = 'completed'
            AND w."id" <> gen_random_uuid() AND (w."date", w."started_at") < (DATE '2026-01-01', now())
            AND we."exercise_id" IN ($2::uuid)
            AND s."completed" AND NOT s."is_warmup" AND s."reps" >= 1
            AND e."tracking_mode" IN ('weight_reps', 'bodyweight_reps')
            AND (s."weight_kg" IS NOT NULL OR e."tracking_mode" = 'bodyweight_reps')
          GROUP BY we."exercise_id", COALESCE(s."weight_kg", 0)`,
        heavy,
        bench,
      );
      const text = plan.map((row) => row['QUERY PLAN']).join('\n');
      // Printed so the plan can be noted in the PR.
      // eslint-disable-next-line no-console
      console.log(`Grouped PR query plan over 10,000 sets:\n${text}`);

      const executionMs = Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? 'NaN');
      expect(executionMs).toBeLessThan(500);

      const started = Date.now();
      const buckets = await history.priorBuckets(heavy, [bench], { kind: 'asOfDate', date: '2026-01-01' });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(buckets.get(bench)).toHaveLength(20);

      await client.workout.deleteMany({ where: { userId: heavy } });
    });
  });
});
