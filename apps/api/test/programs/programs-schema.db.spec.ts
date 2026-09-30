// =============================================================================
// Real-Postgres test: training program schema (E5.1)
// =============================================================================
//
// What only a real server can prove: the partial unique index
// `programs_one_active_per_user_uniq_idx` (one active program per user, under
// concurrency, while any number of non-active programs coexist), the CHECK
// constraints, the `workouts.program_workout_id` foreign key (SET NULL) and the
// cascade / Restrict behaviour of the plan tree.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('programs-schema.db.spec');

describeWithDb('programs schema (real Postgres)', () => {
  let client: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const exerciseIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `programs-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  async function makeExercise(label: string): Promise<string> {
    const exercise = await client.exercise.create({
      data: { slug: `pg-${run}-${label}`, name: `Program test ${label}`, primaryMuscles: ['chest'], movementPattern: 'horizontal_push' },
      select: { id: true },
    });
    exerciseIds.push(exercise.id);
    return exercise.id;
  }

  const program = (userId: string, overrides: Record<string, unknown> = {}) =>
    client.program.create({ data: { userId, name: 'P', goal: 'general', ...overrides } as any });

  /** program -> block -> week -> workout, returning the ids. */
  async function tree(userId: string) {
    const p = await program(userId);
    const block = await client.programBlock.create({ data: { programId: p.id, position: 0, name: 'B' } });
    const week = await client.programWeek.create({ data: { programId: p.id, blockId: block.id, weekNumber: 1 } });
    const workout = await client.programWorkout.create({ data: { weekId: week.id, position: 0, name: 'W' } });
    return { programId: p.id, workoutId: workout.id };
  }

  const exerciseRow = (programWorkoutId: string, exerciseId: string, overrides: Record<string, unknown> = {}) =>
    client.programExercise.create({
      data: { programWorkoutId, exerciseId, position: 0, targetSets: 3, repMin: 8, repMax: 12, restSeconds: 90, ...overrides } as any,
    });

  beforeAll(() => {
    client = createDbClient();
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    await client.$disconnect();
  });

  describe('one active program per user (partial unique index)', () => {
    it('refuses a second active program for one user, not for another user', async () => {
      const userId = await makeUser('active');
      const other = await makeUser('active-other');
      await program(userId, { status: 'active' });

      await expect(program(userId, { status: 'active' })).rejects.toThrow(/programs_one_active_per_user_uniq_idx|unique constraint/i);
      await expect(program(other, { status: 'active' })).resolves.toBeDefined();
    });

    it('allows any number of non-active programs next to the active one', async () => {
      const userId = await makeUser('inactive');
      await program(userId, { status: 'active' });
      for (const status of ['draft', 'draft', 'paused', 'archived', 'completed']) {
        await expect(program(userId, { status })).resolves.toBeDefined();
      }
    });

    it('concurrent activations leave exactly one active row', async () => {
      const userId = await makeUser('race');
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => program(userId, { status: 'active' })));

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await client.program.count({ where: { userId, status: 'active' } })).toBe(1);
    });

    it('a second program can become active once the first is paused', async () => {
      const userId = await makeUser('swap');
      const first = await program(userId, { status: 'active' });
      const second = await program(userId);

      await client.program.update({ where: { id: first.id }, data: { status: 'paused' } });
      await expect(client.program.update({ where: { id: second.id }, data: { status: 'active' } })).resolves.toBeDefined();
    });
  });

  describe('CHECK constraints', () => {
    it('constrains programs.status, goal and autonomy to their value sets', async () => {
      const userId = await makeUser('program-checks');
      await expect(program(userId, { status: 'running' })).rejects.toThrow(/programs_status_chk|check constraint/i);
      await expect(program(userId, { goal: 'bulk' })).rejects.toThrow(/programs_goal_chk|check constraint/i);
      await expect(program(userId, { autonomy: 'always' })).rejects.toThrow(/programs_autonomy_chk|check constraint/i);
      for (const goal of ['strength', 'hypertrophy', 'fat_loss', 'general', 'endurance', 'custom']) {
        await expect(program(userId, { goal })).resolves.toBeDefined();
      }
      await expect(program(userId, { autonomy: 'ask_first' })).resolves.toBeDefined();
    });

    it('constrains program_workouts.weekday to 1..7 or null', async () => {
      const { workoutId } = await tree(await makeUser('weekday'));
      const weekId = (await client.programWorkout.findUniqueOrThrow({ where: { id: workoutId } })).weekId;
      const row = (weekday: number | null) => client.programWorkout.create({ data: { weekId, position: 1, name: 'X', weekday } });

      await expect(row(0)).rejects.toThrow(/program_workouts_weekday_chk|check constraint/i);
      await expect(row(8)).rejects.toThrow(/program_workouts_weekday_chk|check constraint/i);
      await expect(row(1)).resolves.toBeDefined();
      await expect(row(7)).resolves.toBeDefined();
      await expect(row(null)).resolves.toBeDefined();
    });

    it('constrains program_exercises rep, set, RPE and rest ranges', async () => {
      const { workoutId } = await tree(await makeUser('exercise-checks'));
      const exerciseId = await makeExercise('checks');
      const bad = /program_exercises_ranges_chk|check constraint/i;

      await expect(exerciseRow(workoutId, exerciseId, { repMin: 0 })).rejects.toThrow(bad);
      await expect(exerciseRow(workoutId, exerciseId, { repMin: 13, repMax: 12 })).rejects.toThrow(bad);
      await expect(exerciseRow(workoutId, exerciseId, { repMax: 101 })).rejects.toThrow(bad);
      await expect(exerciseRow(workoutId, exerciseId, { targetSets: 0 })).rejects.toThrow(bad);
      await expect(exerciseRow(workoutId, exerciseId, { targetSets: 21 })).rejects.toThrow(bad);
      await expect(exerciseRow(workoutId, exerciseId, { targetRpe: 0.5 })).rejects.toThrow(bad);
      await expect(exerciseRow(workoutId, exerciseId, { targetRpe: 10.5 })).rejects.toThrow(bad);
      await expect(exerciseRow(workoutId, exerciseId, { restSeconds: -1 })).rejects.toThrow(bad);
      await expect(exerciseRow(workoutId, exerciseId, { restSeconds: 901 })).rejects.toThrow(bad);

      await expect(exerciseRow(workoutId, exerciseId, { repMin: 1, repMax: 1, targetSets: 1, targetRpe: 1, restSeconds: 0 })).resolves.toBeDefined();
      await expect(exerciseRow(workoutId, exerciseId, { repMin: 100, repMax: 100, targetSets: 20, targetRpe: 10, restSeconds: 900 })).resolves.toBeDefined();
      await expect(exerciseRow(workoutId, exerciseId, { targetRpe: null })).resolves.toBeDefined();
    });
  });

  describe('relations', () => {
    it('program_versions is unique per (program, versionNumber)', async () => {
      const p = await program(await makeUser('versions'));
      const version = (versionNumber: number) =>
        client.programVersion.create({ data: { programId: p.id, versionNumber, origin: 'initial', snapshot: {} } });

      await version(1);
      await expect(version(1)).rejects.toThrow(/unique constraint/i);
      await expect(version(2)).resolves.toBeDefined();
    });

    it('workouts.program_workout_id is a foreign key that is nulled when the planned workout goes', async () => {
      const userId = await makeUser('fk');
      const { workoutId } = await tree(userId);
      const base = { userId, name: 'W', date: new Date('2026-09-30T00:00:00.000Z'), startedAt: new Date(), status: 'completed' };

      await expect(client.workout.create({ data: { ...base, programWorkoutId: randomUUID() } })).rejects.toThrow(/foreign key/i);

      const logged = await client.workout.create({ data: { ...base, programWorkoutId: workoutId } });
      await client.programWorkout.delete({ where: { id: workoutId } });
      expect((await client.workout.findUniqueOrThrow({ where: { id: logged.id } })).programWorkoutId).toBeNull();
    });

    it('deleting a program cascades its tree, versions and log; the exercise is Restrict', async () => {
      const userId = await makeUser('cascade');
      const { programId, workoutId } = await tree(userId);
      const exerciseId = await makeExercise('cascade');
      await exerciseRow(workoutId, exerciseId);
      await client.programVersion.create({ data: { programId, versionNumber: 1, origin: 'initial', snapshot: {} } });
      await client.programChangeLog.create({ data: { programId, userId, kind: 'created', actor: 'user', summary: 's' } });

      await expect(client.exercise.delete({ where: { id: exerciseId } })).rejects.toThrow(/foreign key/i);

      await client.program.delete({ where: { id: programId } });
      expect(await client.programBlock.count({ where: { programId } })).toBe(0);
      expect(await client.programWeek.count({ where: { programId } })).toBe(0);
      expect(await client.programWorkout.count({ where: { id: workoutId } })).toBe(0);
      expect(await client.programExercise.count({ where: { programWorkoutId: workoutId } })).toBe(0);
      expect(await client.programVersion.count({ where: { programId } })).toBe(0);
      expect(await client.programChangeLog.count({ where: { programId } })).toBe(0);
    });

    it('deleting a gym nulls program.gymId; deleting a user removes their programs', async () => {
      const userId = await makeUser('gym');
      const gym = await client.gym.create({ data: { userId, name: 'G' } });
      const p = await program(userId, { gymId: gym.id });

      await client.gym.delete({ where: { id: gym.id } });
      expect((await client.program.findUniqueOrThrow({ where: { id: p.id } })).gymId).toBeNull();

      await client.user.delete({ where: { id: userId } });
      expect(await client.program.count({ where: { userId } })).toBe(0);
    });
  });
});
