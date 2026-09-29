// =============================================================================
// Real-Postgres test: workout logging (E4.2)
// =============================================================================
//
// What only a real server can prove: the partial unique index
// `workouts_user_in_progress_uniq_idx` (two concurrent starts leave exactly one
// in-progress row; both callers get the same id, one with `existing: true`),
// the CHECK constraints (status, name length, duration, set number, and every
// range of `set_logs_ranges_chk`), the foreign-key behaviour (workout ->
// entries -> sets cascade, user delete cascade, exercise Restrict, gym SetNull),
// the 409 EXERCISE_IN_USE refusal through the real ExercisesService, dense
// renumbering under concurrency (the workout row lock), finish semantics,
// the readiness snapshot copied by value, the volume totals over real rows, and
// the kg round trip (lb -> kg -> lb within the display precision).
//
// Two independent clients (own connection pools) stand in for two requests
// arriving at once.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { putCheckInSchema } from '../../src/check-ins/dto/check-in.dto';
import { addDays, localDateInZone } from '../../src/check-ins/local-date';
import { ExerciseAvailabilityService } from '../../src/exercises/exercise-availability.service';
import { ExerciseUsageRepository } from '../../src/exercises/exercise-usage.repository';
import { ExercisesService } from '../../src/exercises/exercises.service';
import { GymsService } from '../../src/gyms/gyms.service';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createSetSchema, startWorkoutSchema, updateSetSchema } from '../../src/workouts/dto/workout.dto';
import { WorkoutEntriesService } from '../../src/workouts/workout-entries.service';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('workouts.db.spec');

const LB = 0.45359237;

interface Stack {
  client: PrismaClient;
  workouts: WorkoutsService;
  entries: WorkoutEntriesService;
  exercises: ExercisesService;
}

function buildStack(): Stack {
  const client = createDbClient();
  const prisma = client as unknown as PrismaService;
  const gyms = new GymsService(prisma, {} as GymStorageService);
  const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
  const history = new WorkoutHistoryService(prisma, checkIns);
  return {
    client,
    workouts: new WorkoutsService(prisma, gyms, checkIns, history),
    entries: new WorkoutEntriesService(prisma, history),
    exercises: new ExercisesService(prisma, new ExerciseAvailabilityService(prisma, gyms), new ExerciseUsageRepository(prisma)),
  };
}

const start = (input: unknown = {}) => startWorkoutSchema.parse(input);
const setInput = (input: unknown = {}) => createSetSchema.parse(input);
const setPatch = (input: unknown) => updateSetSchema.parse(input);

describeWithDb('workout logging (real Postgres)', () => {
  let a: Stack;
  let b: Stack;
  let client: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const exerciseIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `workouts-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  /** A library-style exercise (no owner). Deleted in `afterAll`. */
  async function makeExercise(label: string, ownerUserId: string | null = null): Promise<string> {
    const exercise = await client.exercise.create({
      data: {
        slug: `wk-${run}-${label}`,
        name: `Workout test ${label}`,
        primaryMuscles: ['chest'],
        movementPattern: 'horizontal_push',
        ownerUserId,
      },
      select: { id: true },
    });
    exerciseIds.push(exercise.id);
    return exercise.id;
  }

  /** A started workout with one exercise: returns ids. */
  async function workoutWithExercise(userId: string, exerciseId: string) {
    const workout = await a.workouts.start(userId, start());
    const entry = await a.entries.addExercise(userId, workout.id, { exerciseId });
    return { workoutId: workout.id, weId: entry.id };
  }

  /** Raw workout row for CHECK tests. */
  const rawWorkout = (userId: string, overrides: Record<string, unknown> = {}) =>
    client.workout.create({
      data: { userId, name: 'W', date: new Date('2026-09-29T00:00:00.000Z'), startedAt: new Date(), status: 'completed', ...overrides } as any,
    });

  beforeAll(() => {
    a = buildStack();
    b = buildStack();
    client = a.client;
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.gym.deleteMany({ where: { userId: { in: userIds } } });
    await client.auditEvent.deleteMany({ where: { targetType: 'check_in', actorUserId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    await a.client.$disconnect();
    await b.client.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // One in-progress workout per user
  // ---------------------------------------------------------------------------

  describe('one in-progress workout per user (partial unique index)', () => {
    it('two concurrent starts create one row; both callers get the same id, one with existing: true', async () => {
      for (let round = 0; round < 5; round += 1) {
        const userId = await makeUser(`race-${round}`);

        const [first, second] = await Promise.all([a.workouts.start(userId, start()), b.workouts.start(userId, start())]);

        expect(first.id).toBe(second.id);
        expect([first.existing, second.existing].sort()).toEqual([false, true]);
        expect(await client.workout.count({ where: { userId, status: 'in_progress' } })).toBe(1);
      }
    });

    it('a burst of parallel starts still leaves exactly one row', async () => {
      const userId = await makeUser('burst');

      const results = await Promise.all(
        Array.from({ length: 8 }, (_v, i) => (i % 2 === 0 ? a : b).workouts.start(userId, start())),
      );

      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => !r.existing)).toHaveLength(1);
      expect(await client.workout.count({ where: { userId } })).toBe(1);
    });

    it('the index itself refuses a second in-progress row for one user, not for another user', async () => {
      const userId = await makeUser('index');
      const other = await makeUser('index-other');
      await rawWorkout(userId, { status: 'in_progress' });

      await expect(rawWorkout(userId, { status: 'in_progress' })).rejects.toThrow(/workouts_user_in_progress_uniq_idx|unique constraint/i);
      await expect(rawWorkout(other, { status: 'in_progress' })).resolves.toBeDefined();
      // Completed rows are unlimited.
      await rawWorkout(userId, { status: 'completed' });
      await rawWorkout(userId, { status: 'completed' });
    });

    it('a new workout can be started after finishing, and finish is idempotent', async () => {
      const userId = await makeUser('restart');
      const first = await a.workouts.start(userId, start());

      const finished = await a.workouts.finish(userId, first.id, {});
      const again = await a.workouts.finish(userId, first.id, { notes: 'ignored' });
      expect(finished.status).toBe('completed');
      expect(again.endedAt).toBe(finished.endedAt);
      expect(again.notes).toBeNull();
      expect(again.durationSeconds).toBe(finished.durationSeconds);

      const next = await a.workouts.start(userId, start());
      expect(next.existing).toBe(false);
      expect(next.id).not.toBe(first.id);
    });
  });

  // ---------------------------------------------------------------------------
  // CHECK constraints
  // ---------------------------------------------------------------------------

  describe('CHECK constraints', () => {
    let userId: string;
    let weId: string;

    beforeAll(async () => {
      userId = await makeUser('checks');
      const exerciseId = await makeExercise('checks');
      const workout = await rawWorkout(userId);
      weId = (await client.workoutExercise.create({ data: { workoutId: workout.id, exerciseId, position: 0 } })).id;
    });

    const setRow = (data: Record<string, unknown>, setNumber = Math.floor(Math.random() * 1_000_000) + 1) =>
      client.setLog.create({ data: { workoutExerciseId: weId, setNumber, ...data } as any });

    it('rejects an unknown status, an empty or 81-character name and a negative duration', async () => {
      await expect(rawWorkout(userId, { status: 'paused' })).rejects.toThrow(/workouts_status_chk|check constraint/i);
      await expect(rawWorkout(userId, { name: '' })).rejects.toThrow(/workouts_name_len_chk|check constraint/i);
      await expect(rawWorkout(userId, { name: 'x'.repeat(81) })).rejects.toThrow(/workouts_name_len_chk|check constraint/i);
      await expect(rawWorkout(userId, { durationSeconds: -1 })).rejects.toThrow(/workouts_duration_chk|check constraint/i);
      await expect(rawWorkout(userId, { name: 'x'.repeat(80), durationSeconds: 0 })).resolves.toBeDefined();
    });

    it.each([
      ['weightKg', 1000.001],
      ['weightKg', -0.001],
      ['reps', 1001],
      ['reps', -1],
      ['rpe', 10.5],
      ['rpe', 0.5],
      ['rir', 11],
      ['rir', -1],
      ['durationSeconds', 86401],
      ['distanceMeters', 1_000_000.01],
      ['restSeconds', 7201],
      ['restSeconds', -1],
    ])('rejects %s = %s written raw', async (field, value) => {
      await expect(setRow({ [field]: value })).rejects.toThrow(/set_logs_ranges_chk|check constraint/i);
    });

    it('accepts every bound inclusive', async () => {
      await expect(
        setRow({ weightKg: 1000, reps: 1000, rpe: 10, rir: 10, durationSeconds: 86400, distanceMeters: 1_000_000, restSeconds: 7200 }),
      ).resolves.toBeDefined();
      await expect(
        setRow({ weightKg: 0, reps: 0, rpe: 1, rir: 0, durationSeconds: 0, distanceMeters: 0, restSeconds: 0 }),
      ).resolves.toBeDefined();
      await expect(setRow({})).resolves.toBeDefined();
    });

    it('rejects set number 0 and a duplicate (exercise, set number)', async () => {
      await expect(setRow({}, 0)).rejects.toThrow(/set_logs_set_number_chk|check constraint/i);
      await setRow({}, 5000001);
      await expect(setRow({}, 5000001)).rejects.toThrow(/unique constraint/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Foreign keys
  // ---------------------------------------------------------------------------

  describe('foreign keys', () => {
    it('cascades workout -> entries -> sets', async () => {
      const userId = await makeUser('cascade-workout');
      const exerciseId = await makeExercise('cascade-workout');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);
      await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: 50, reps: 5 }));

      await a.workouts.remove(userId, workoutId);

      expect(await client.workoutExercise.count({ where: { workoutId } })).toBe(0);
      expect(await client.setLog.count({ where: { workoutExerciseId: weId } })).toBe(0);
      await expect(a.workouts.get(userId, workoutId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cascades everything when the user is deleted', async () => {
      const userId = await makeUser('cascade-user');
      const exerciseId = await makeExercise('cascade-user');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);
      await a.entries.addSet(userId, workoutId, weId, setInput({ reps: 3 }));

      await client.user.delete({ where: { id: userId } });

      expect(await client.workout.count({ where: { id: workoutId } })).toBe(0);
      expect(await client.workoutExercise.count({ where: { id: weId } })).toBe(0);
      expect(await client.setLog.count({ where: { workoutExerciseId: weId } })).toBe(0);
      // The exercise (library row) is untouched.
      expect(await client.exercise.count({ where: { id: exerciseId } })).toBe(1);
    });

    it('restricts deleting an exercise that a workout uses', async () => {
      const userId = await makeUser('restrict');
      const exerciseId = await makeExercise('restrict');
      await workoutWithExercise(userId, exerciseId);

      await expect(client.exercise.delete({ where: { id: exerciseId } })).rejects.toThrow(/foreign key|violat/i);
      expect(await client.exercise.count({ where: { id: exerciseId } })).toBe(1);
    });

    it('DELETE of a custom exercise used by a workout is 409 EXERCISE_IN_USE; after the workout goes it deletes', async () => {
      const userId = await makeUser('in-use');
      const exerciseId = await makeExercise('in-use', userId);
      const { workoutId } = await workoutWithExercise(userId, exerciseId);

      const refusal = await a.exercises.remove(userId, exerciseId).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toMatchObject({ details: { reason: 'EXERCISE_IN_USE', uses: 1 } });
      expect(await client.exercise.count({ where: { id: exerciseId } })).toBe(1);

      await a.workouts.remove(userId, workoutId);
      await a.exercises.remove(userId, exerciseId);
      expect(await client.exercise.count({ where: { id: exerciseId } })).toBe(0);
    });

    it('sets gymId to null on the workouts of a deleted gym', async () => {
      const userId = await makeUser('gym');
      const gym = await client.gym.create({ data: { userId, name: `Gym ${run}`, type: 'home' } });
      const workout = await a.workouts.start(userId, start({ gymId: gym.id }));
      expect(workout.gymId).toBe(gym.id);
      expect(workout.gym).toEqual({ id: gym.id, name: `Gym ${run}` });

      await client.gym.delete({ where: { id: gym.id } });

      const after = await a.workouts.get(userId, workout.id);
      expect(after.gymId).toBeNull();
      expect(after.gym).toBeNull();
    });

    it('defaults to the default gym and refuses another user\'s gym', async () => {
      const userId = await makeUser('gym-default');
      const other = await makeUser('gym-other');
      const mine = await client.gym.create({ data: { userId, name: 'Mine', type: 'home', isDefault: true } });
      const foreign = await client.gym.create({ data: { userId: other, name: 'Theirs', type: 'home' } });

      await expect(a.workouts.start(userId, start({ gymId: foreign.id }))).rejects.toBeInstanceOf(NotFoundException);
      const workout = await a.workouts.start(userId, start());
      expect(workout.gymId).toBe(mine.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Owner scoping over real rows
  // ---------------------------------------------------------------------------

  describe('owner scoping', () => {
    it('another user\'s workout, entry and set are 404 on every service call, and nothing changes', async () => {
      const owner = await makeUser('owner');
      const intruder = await makeUser('intruder');
      const exerciseId = await makeExercise('owner');
      const { workoutId, weId } = await workoutWithExercise(owner, exerciseId);
      const set = await a.entries.addSet(owner, workoutId, weId, setInput({ weightKg: 40, reps: 8 }));

      const calls: Array<() => Promise<unknown>> = [
        () => a.workouts.get(intruder, workoutId),
        () => a.workouts.update(intruder, workoutId, { name: 'Hijack' }),
        () => a.workouts.finish(intruder, workoutId, {}),
        () => a.workouts.remove(intruder, workoutId),
        () => a.entries.addExercise(intruder, workoutId, { exerciseId }),
        () => a.entries.updateExercise(intruder, workoutId, weId, { position: 0 }),
        () => a.entries.removeExercise(intruder, workoutId, weId),
        () => a.entries.addSet(intruder, workoutId, weId, setInput()),
        () => a.entries.updateSet(intruder, workoutId, set.id, setPatch({ reps: 99 })),
        () => a.entries.removeSet(intruder, workoutId, set.id),
      ];
      for (const call of calls) {
        await expect(call()).rejects.toBeInstanceOf(NotFoundException);
      }

      const intact = await a.workouts.get(owner, workoutId);
      expect(intact).toMatchObject({ name: expect.stringMatching(/workout$/), status: 'in_progress' });
      expect(intact.exercises).toHaveLength(1);
      expect(intact.exercises[0].sets).toHaveLength(1);
      expect(intact.exercises[0].sets[0].reps).toBe(8);
    });

    it('a workout entry or set id under a different (own) workout is 404', async () => {
      const userId = await makeUser('cross');
      const exerciseId = await makeExercise('cross');
      const first = await workoutWithExercise(userId, exerciseId);
      await a.workouts.finish(userId, first.workoutId, {});
      const second = await workoutWithExercise(userId, exerciseId);
      const set = await a.entries.addSet(userId, first.workoutId, first.weId, setInput({ reps: 1 }));

      await expect(a.entries.addSet(userId, second.workoutId, first.weId, setInput())).rejects.toBeInstanceOf(NotFoundException);
      await expect(a.entries.updateSet(userId, second.workoutId, set.id, setPatch({ reps: 2 }))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cannot add another user\'s custom exercise, but can add a library one', async () => {
      const owner = await makeUser('custom-owner');
      const other = await makeUser('custom-other');
      const custom = await makeExercise('custom', owner);
      const library = await makeExercise('library');
      const workout = await a.workouts.start(other, start());

      await expect(a.entries.addExercise(other, workout.id, { exerciseId: custom })).rejects.toBeInstanceOf(NotFoundException);
      await expect(a.entries.addExercise(other, workout.id, { exerciseId: library })).resolves.toBeDefined();
    });

    it('lists only the caller\'s workouts', async () => {
      const mine = await makeUser('list-mine');
      const theirs = await makeUser('list-theirs');
      await a.workouts.start(mine, start());
      await a.workouts.start(theirs, start());

      const list = await a.workouts.list(mine, { page: 1, pageSize: 20 });

      expect(list.total).toBe(1);
      expect(list.items).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Sets: copy, numbering, rest, finish
  // ---------------------------------------------------------------------------

  describe('sets', () => {
    it('an empty add copies weight and reps from the previous set; setNumber is dense after deleting the middle set', async () => {
      const userId = await makeUser('sets');
      const exerciseId = await makeExercise('sets');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);

      const one = await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: 31.75, reps: 10 }));
      const two = await a.entries.addSet(userId, workoutId, weId, setInput());
      const three = await a.entries.addSet(userId, workoutId, weId, setInput({ reps: 8 }));

      expect([one.setNumber, two.setNumber, three.setNumber]).toEqual([1, 2, 3]);
      expect(two).toMatchObject({ weightKg: 31.75, reps: 10 });
      expect(three).toMatchObject({ weightKg: 31.75, reps: 8 });

      await a.entries.removeSet(userId, workoutId, two.id);

      const detail = await a.workouts.get(userId, workoutId);
      expect(detail.exercises[0].sets.map((s) => [s.id, s.setNumber])).toEqual([
        [one.id, 1],
        [three.id, 2],
      ]);
    });

    it('concurrent add-set taps get distinct dense numbers (workout row lock)', async () => {
      const userId = await makeUser('sets-race');
      const exerciseId = await makeExercise('sets-race');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_v, i) => (i % 2 === 0 ? a : b).entries.addSet(userId, workoutId, weId, setInput({ reps: i }))),
      );

      expect(results.map((s) => s.setNumber).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('caps an exercise at 40 sets, even under concurrency', async () => {
      const userId = await makeUser('sets-limit');
      const exerciseId = await makeExercise('sets-limit');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);
      for (let i = 0; i < 38; i += 1) await a.entries.addSet(userId, workoutId, weId, setInput());

      const outcomes = await Promise.allSettled([
        a.entries.addSet(userId, workoutId, weId, setInput()),
        b.entries.addSet(userId, workoutId, weId, setInput()),
        a.entries.addSet(userId, workoutId, weId, setInput()),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
      const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason.getResponse()).toMatchObject({ details: { reason: 'WORKOUT_SET_LIMIT' } });
      expect(await client.setLog.count({ where: { workoutExerciseId: weId } })).toBe(40);
    });

    it('completing stamps completedAt and derives rest only under 15 minutes; un-completing clears it', async () => {
      const userId = await makeUser('rest');
      const exerciseId = await makeExercise('rest');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);
      const s1 = await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: 50, reps: 5 }));
      const s2 = await a.entries.addSet(userId, workoutId, weId, setInput());
      const s3 = await a.entries.addSet(userId, workoutId, weId, setInput());
      const t0 = new Date('2026-09-29T10:00:00.000Z');

      const first = await a.entries.updateSet(userId, workoutId, s1.id, setPatch({ completed: true }), t0);
      expect(first.completedAt).toBe(t0.toISOString());
      expect(first.restSeconds).toBeNull();

      const second = await a.entries.updateSet(userId, workoutId, s2.id, setPatch({ completed: true }), new Date(t0.getTime() + 95_000));
      expect(second.restSeconds).toBe(95);

      // 16 minutes after the previous completion: no derivation.
      const third = await a.entries.updateSet(userId, workoutId, s3.id, setPatch({ completed: true }), new Date(t0.getTime() + 95_000 + 16 * 60_000));
      expect(third.restSeconds).toBeNull();

      const undone = await a.entries.updateSet(userId, workoutId, s2.id, setPatch({ completed: false }));
      expect(undone).toMatchObject({ completed: false, completedAt: null });
      expect(undone.restSeconds).toBe(95);
    });

    it('finish deletes empty uncompleted sets, keeps valued uncompleted ones, renumbers densely, and reports the summary', async () => {
      const userId = await makeUser('finish');
      const exerciseId = await makeExercise('finish');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);

      const done = await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: 100, reps: 5, completed: true }));
      await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: null, reps: null })); // empty, uncompleted
      const valued = await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: 90, reps: 5 })); // uncompleted with values
      await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: null, reps: null })); // empty, uncompleted
      const emptyDone = await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: null, reps: null, completed: true }));
      await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: 60, reps: 10, isWarmup: true, completed: true }));

      const finished = await a.workouts.finish(userId, workoutId, { notes: 'Done' });

      const sets = finished.exercises[0].sets;
      expect(sets.map((s) => s.setNumber)).toEqual([1, 2, 3, 4]);
      expect(sets.map((s) => s.id)).toEqual([done.id, valued.id, emptyDone.id, expect.any(String)]);
      expect(sets.find((s) => s.id === valued.id)).toMatchObject({ completed: false, weightKg: 90 });
      expect(finished).toMatchObject({ status: 'completed', notes: 'Done' });
      expect(finished.endedAt).not.toBeNull();
      expect(finished.durationSeconds).not.toBeNull();
      // Completed working sets: `done` and `emptyDone` (no volume); warm-up excluded.
      expect(finished.summary).toMatchObject({ exerciseCount: 1, setCount: 2, volumeKg: 500 });
    });

    it('volumeKg and setCount in the list exclude warm-up and uncompleted sets', async () => {
      const userId = await makeUser('volume');
      const exerciseId = await makeExercise('volume');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);
      await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: 31.75, reps: 10, completed: true }));
      await a.entries.addSet(userId, workoutId, weId, setInput({ completed: true }));
      await a.entries.addSet(userId, workoutId, weId, setInput({ completed: false }));
      await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: 20, reps: 10, isWarmup: true, completed: true }));

      const list = await a.workouts.list(userId, { page: 1, pageSize: 20, exerciseId });

      expect(list.items[0]).toMatchObject({ id: workoutId, exerciseCount: 1, setCount: 2, volumeKg: 635 });
      const filtered = await a.workouts.list(userId, { page: 1, pageSize: 20, exerciseId: randomUUID() });
      expect(filtered.items).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Exercises: order and limits
  // ---------------------------------------------------------------------------

  describe('exercise order', () => {
    async function names(userId: string, workoutId: string) {
      const detail = await a.workouts.get(userId, workoutId);
      return detail.exercises.map((e) => [e.exercise.name.replace('Workout test ', ''), e.position]);
    }

    it('appends, inserts with a shift, reorders and deletes with dense 0-based positions', async () => {
      const userId = await makeUser('order');
      const [x, y, z, w] = await Promise.all(['ox', 'oy', 'oz', 'ow'].map((l) => makeExercise(l)));
      const workout = await a.workouts.start(userId, start());
      await a.entries.addExercise(userId, workout.id, { exerciseId: x });
      await a.entries.addExercise(userId, workout.id, { exerciseId: y });
      await a.entries.addExercise(userId, workout.id, { exerciseId: z });
      expect(await names(userId, workout.id)).toEqual([['ox', 0], ['oy', 1], ['oz', 2]]);

      const inserted = await a.entries.addExercise(userId, workout.id, { exerciseId: w, position: 1 });
      expect(await names(userId, workout.id)).toEqual([['ox', 0], ['ow', 1], ['oy', 2], ['oz', 3]]);

      await a.entries.updateExercise(userId, workout.id, inserted.id, { position: 3 });
      expect(await names(userId, workout.id)).toEqual([['ox', 0], ['oy', 1], ['oz', 2], ['ow', 3]]);

      await a.entries.updateExercise(userId, workout.id, inserted.id, { position: 0, notes: 'first' });
      expect(await names(userId, workout.id)).toEqual([['ow', 0], ['ox', 1], ['oy', 2], ['oz', 3]]);

      await a.entries.removeExercise(userId, workout.id, inserted.id);
      expect(await names(userId, workout.id)).toEqual([['ox', 0], ['oy', 1], ['oz', 2]]);
    });

    it('concurrent appends get distinct dense positions', async () => {
      const userId = await makeUser('order-race');
      const exerciseId = await makeExercise('order-race');
      const workout = await a.workouts.start(userId, start());

      await Promise.all(
        Array.from({ length: 8 }, (_v, i) => (i % 2 === 0 ? a : b).entries.addExercise(userId, workout.id, { exerciseId })),
      );

      const detail = await a.workouts.get(userId, workout.id);
      expect(detail.exercises.map((e) => e.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('refuses the 31st exercise', async () => {
      const userId = await makeUser('order-limit');
      const exerciseId = await makeExercise('order-limit');
      const workout = await a.workouts.start(userId, start());
      for (let i = 0; i < 30; i += 1) await a.entries.addExercise(userId, workout.id, { exerciseId });

      const refusal = await a.entries.addExercise(userId, workout.id, { exerciseId }).catch((error: unknown) => error);

      expect((refusal as any).getResponse()).toMatchObject({ details: { reason: 'WORKOUT_EXERCISE_LIMIT' } });
      expect(await client.workoutExercise.count({ where: { workoutId: workout.id } })).toBe(30);
    });

    it('refuses a pending AI proposal exercise until it is active', async () => {
      const userId = await makeUser('pending');
      const exerciseId = await makeExercise('pending', userId);
      await client.exercise.update({ where: { id: exerciseId }, data: { status: 'pending_review' } });
      const workout = await a.workouts.start(userId, start());

      const refusal = await a.entries.addExercise(userId, workout.id, { exerciseId }).catch((error: unknown) => error);

      expect((refusal as any).getResponse()).toMatchObject({ details: { reason: 'EXERCISE_PENDING_REVIEW' } });
    });
  });

  // ---------------------------------------------------------------------------
  // Dates and readiness
  // ---------------------------------------------------------------------------

  describe('dates and readiness snapshot', () => {
    it('stores the client date, defaults the name to its weekday and refuses a date beyond +-2 days', async () => {
      const userId = await makeUser('date');
      const today = localDateInZone(new Date(), null);

      const workout = await a.workouts.start(userId, start({ date: addDays(today, 1) }));
      expect(workout.date).toBe(addDays(today, 1));
      expect(workout.name).toMatch(/^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day workout$/);
      await a.workouts.finish(userId, workout.id, {});

      await expect(a.workouts.start(userId, start({ date: addDays(today, 3) }))).rejects.toMatchObject({
        response: { details: { reason: 'WORKOUT_DATE_OUT_OF_RANGE' } },
      });
      await expect(a.workouts.start(userId, start({ date: addDays(today, -3) }))).rejects.toMatchObject({
        response: { details: { reason: 'WORKOUT_DATE_OUT_OF_RANGE' } },
      });
    });

    it('uses today in the Health Profile time zone when the date is omitted', async () => {
      const userId = await makeUser('zone');
      await client.healthProfile.create({ data: { userId, timeZone: 'Pacific/Kiritimati' } });

      const workout = await a.workouts.start(userId, start());

      expect(workout.date).toBe(localDateInZone(new Date(), 'Pacific/Kiritimati'));
    });

    it('snapshots today\'s check-in by value, null without one, and later edits do not rewrite it', async () => {
      const checkIns = new CheckInsService(a.client as unknown as PrismaService, new HealthProfileService(a.client as unknown as PrismaService));
      const today = localDateInZone(new Date(), null);

      const without = await makeUser('ready-none');
      const none = await a.workouts.start(without, start());
      expect(none.readinessSnapshot).toBeNull();

      const userId = await makeUser('ready');
      await checkIns.put(userId, today, putCheckInSchema.parse({ energy: 4, sleepQuality: 3, soreness: 2, stress: 5, note: 'Tired' }));

      const workout = await a.workouts.start(userId, start());
      expect(workout.readinessSnapshot).toMatchObject({ date: today, energy: 4, sleepQuality: 3, soreness: 2, stress: 5, note: 'Tired' });

      await checkIns.put(userId, today, putCheckInSchema.parse({ energy: 1 }));
      const reread = await a.workouts.get(userId, workout.id);
      expect(reread.readinessSnapshot).toMatchObject({ energy: 4, stress: 5, note: 'Tired' });
      await a.workouts.finish(userId, workout.id, {});
      expect((await a.workouts.get(userId, workout.id)).readinessSnapshot).toMatchObject({ energy: 4 });
    });
  });

  // ---------------------------------------------------------------------------
  // Units
  // ---------------------------------------------------------------------------

  describe('kilograms round trip', () => {
    it('135 lb -> 61.235 kg -> "135.0" lb; a 3-decimal kg value is stored and served exactly', async () => {
      const userId = await makeUser('units');
      const exerciseId = await makeExercise('units');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);

      const kg = Math.round(135 * LB * 1000) / 1000;
      expect(kg).toBe(61.235);
      const saved = await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: kg, reps: 5 }));
      const reread = (await a.workouts.get(userId, workoutId)).exercises[0].sets[0];

      expect(saved.weightKg).toBe(61.235);
      expect(reread.weightKg).toBe(61.235);
      expect((reread.weightKg! / LB).toFixed(1)).toBe('135.0');
    });

    it('lb values 0.5..1000 in 0.5 steps survive the kg round trip to 0.1 lb', async () => {
      const userId = await makeUser('units-sweep');
      const exerciseId = await makeExercise('units-sweep');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);
      const samples = [0.5, 2.5, 12.5, 45, 95, 135, 187.5, 225, 315, 405, 545.5, 700, 1000].filter((lb) => lb * LB <= 1000);

      for (const lb of samples) {
        const kg = Math.round(lb * LB * 1000) / 1000;
        const set = await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: kg, reps: 1 }));
        expect(Math.abs(Math.round((set.weightKg! / LB) * 10) / 10 - lb)).toBeLessThan(0.05 + 1e-9);
      }
    });

    it('stores decimals as Decimal(7,3): the API returns numbers, distance keeps 2 decimals, rpe 1', async () => {
      const userId = await makeUser('decimals');
      const exerciseId = await makeExercise('decimals');
      const { workoutId, weId } = await workoutWithExercise(userId, exerciseId);

      const set = await a.entries.addSet(userId, workoutId, weId, setInput({ weightKg: 0.005, distanceMeters: 1234.56, rpe: 8.5 }));

      expect(set).toMatchObject({ weightKg: 0.005, distanceMeters: 1234.56, rpe: 8.5 });
      expect(typeof set.weightKg).toBe('number');
    });
  });

  // ---------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------

  describe('editing a completed workout', () => {
    it('allows edits and recomputes the duration when the times change', async () => {
      const userId = await makeUser('edit');
      const workout = await a.workouts.start(userId, start({ startedAt: new Date(Date.now() - 3_600_000).toISOString() }));
      const finished = await a.workouts.finish(userId, workout.id, {});
      const startedAt = new Date(finished.startedAt);

      const edited = await a.workouts.update(userId, workout.id, {
        name: 'Renamed',
        notes: 'later',
        endedAt: new Date(startedAt.getTime() + 1_800_000).toISOString(),
      });

      expect(edited).toMatchObject({ name: 'Renamed', notes: 'later', durationSeconds: 1800 });
      const manual = await a.workouts.update(userId, workout.id, { durationSeconds: 1234 });
      expect(manual.durationSeconds).toBe(1234);
    });
  });
});
