// =============================================================================
// Real-Postgres test: starting a planned workout and today's plan (E5.7)
// =============================================================================
//
// What only a real server can prove: `start` writes exactly one E4 workout
// (with `program_workout_id`, uncompleted prefilled sets) and one
// `program_sessions` row (current version, snapshot) in one transaction, and
// a failure after the workout insert leaves nothing; calling it twice, or
// twice concurrently, yields one workout (E4's partial unique index
// `workouts_user_in_progress_uniq_idx` decides, never a pre-check); another
// workout in progress answers 409 WORKOUT_IN_PROGRESS; the snapshot survives
// a later plan change; finishing flips Today to done; the `active ->
// completed` flip happens once; the cascades behave.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { ExerciseAvailabilityService } from '../../src/exercises/exercise-availability.service';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { GymsService } from '../../src/gyms/gyms.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { LoadGuidance, PlanTree } from '../../src/programs/contracts/plan-tree.contract';
import { ProgramsService } from '../../src/programs/programs.service';
import { TrainingTodayService } from '../../src/programs/today/training-today.service';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('program-sessions.db.spec');

// Wednesday 2026-09-30, noon UTC (no Health Profile time zone: UTC).
const NOW = new Date('2026-09-30T12:00:00.000Z');
const TODAY = '2026-09-30';
const MONDAY = '2026-09-28';

describeWithDb('program sessions (real Postgres)', () => {
  let client: PrismaClient;
  let programs: ProgramsService;
  let workouts: WorkoutsService;
  let today: TrainingTodayService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const exerciseIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `psess-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  async function makeExercise(label: string): Promise<string> {
    const exercise = await client.exercise.create({
      data: { slug: `psess-${run}-${label}`, name: `Session ${label}`, primaryMuscles: ['chest'], movementPattern: 'horizontal_push' },
      select: { id: true },
    });
    exerciseIds.push(exercise.id);
    return exercise.id;
  }

  function exercise(exerciseId: string, position: number, loadGuidance: LoadGuidance, targetLoadKg: number | null) {
    return {
      exerciseId,
      position,
      isPriority: position === 0,
      targetSets: 3,
      repMin: 6,
      repMax: 10,
      targetLoadKg,
      targetRpe: 8,
      restSeconds: 120,
      loadGuidance,
      rationale: 'Because',
      evidenceRefs: [],
      notes: null,
      equipmentTypeId: null,
    };
  }

  /** Two weeks of Mon/Wed/Fri, every workout: fixed 62.5 kg, from history, choose start. */
  function tree(): PlanTree {
    const weeks = [1, 2].map((weekNumber) => ({
      weekNumber,
      isDeload: false,
      workouts: [1, 3, 5].map((weekday, position) => ({
        position,
        weekday,
        name: `W${weekNumber} day ${weekday}`,
        estimatedMinutes: 50,
        rationale: null,
        exercises: [
          exercise(exerciseIds[0], 0, 'fixed', 62.5),
          exercise(exerciseIds[1], 1, 'from_history', null),
          exercise(exerciseIds[2], 2, 'choose_start', null),
        ],
      })),
    }));
    return { blocks: [{ position: 0, name: 'Block', focus: null, rationale: null, weeks }] };
  }

  /** An active plan started on Monday 2026-09-28; returns today's (Wednesday) planned workout id. */
  async function activePlan(userId: string): Promise<{ programId: string; wednesdayId: string }> {
    const { programId } = await programs.createWithTree({
      userId,
      header: { name: 'Plan', goal: 'strength', source: 'manual' },
      tree: tree(),
      origin: 'initial',
      actor: 'user',
      summary: 'Created by you',
    });
    await programs.activate(userId, programId, MONDAY, NOW);
    const wednesday = await client.programWorkout.findFirstOrThrow({
      where: { weekday: 3, week: { programId, weekNumber: 1 } },
      select: { id: true },
    });
    return { programId, wednesdayId: wednesday.id };
  }

  /** A completed ad-hoc workout with a top set of `weightKg` x `reps` on `exerciseId`. */
  async function history(userId: string, exerciseId: string, date: string, weightKg: string, reps: number) {
    await client.workout.create({
      data: {
        userId,
        name: 'Earlier',
        date: new Date(`${date}T00:00:00.000Z`),
        status: 'completed',
        startedAt: new Date(`${date}T10:00:00.000Z`),
        endedAt: new Date(`${date}T11:00:00.000Z`),
        exercises: {
          create: [
            {
              exerciseId,
              position: 0,
              sets: {
                create: [
                  { setNumber: 1, weightKg: '20', reps: 12, completed: true, isWarmup: true },
                  { setNumber: 2, weightKg, reps, completed: true },
                  { setNumber: 3, weightKg: '40', reps: 10, completed: true },
                ],
              },
            },
          ],
        },
      },
    });
  }

  const reasonOf = (error: unknown) => ((error as HttpException).getResponse() as any).details?.reason;

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
    const gyms = new GymsService(prisma, {} as GymStorageService);
    programs = new ProgramsService(prisma);
    workouts = new WorkoutsService(prisma, gyms, checkIns, new WorkoutHistoryService(prisma, checkIns));
    today = new TrainingTodayService(prisma, checkIns, new ExerciseAvailabilityService(prisma, gyms), workouts);
    await makeExercise('fixed');
    await makeExercise('history');
    await makeExercise('choose');
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    await client.$disconnect();
  });

  it('start writes one prefilled workout and one session with the current version and snapshot', async () => {
    const userId = await makeUser('basic');
    const { programId, wednesdayId } = await activePlan(userId);
    await history(userId, exerciseIds[1], '2026-09-25', '50', 8);

    const result = await today.start(userId, wednesdayId, { date: TODAY }, NOW);

    expect(result).toEqual({ workoutId: expect.any(String), existing: false, planVersion: 1 });
    const workout = await client.workout.findUniqueOrThrow({
      where: { id: result.workoutId },
      include: { exercises: { orderBy: { position: 'asc' }, include: { sets: { orderBy: { setNumber: 'asc' } } } } },
    });
    expect(workout).toMatchObject({ status: 'in_progress', programWorkoutId: wednesdayId, name: 'W1 day 3' });
    const sets = workout.exercises.map((entry) =>
      entry.sets.map((set) => [set.weightKg === null ? null : Number(set.weightKg), set.reps, set.completed]),
    );
    expect(sets).toEqual([
      [[62.5, 6, false], [62.5, 6, false], [62.5, 6, false]],
      [[50, 6, false], [50, 6, false], [50, 6, false]],
      [[null, 6, false], [null, 6, false], [null, 6, false]],
    ]);

    const sessions = await client.programSession.findMany({ where: { programId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ workoutId: result.workoutId, programWorkoutId: wednesdayId, versionNumber: 1 });
    expect(sessions[0].plannedFor.toISOString().slice(0, 10)).toBe(TODAY);
    expect(sessions[0].plannedSnapshot).toEqual([
      expect.objectContaining({ exerciseId: exerciseIds[0], sets: 3, repMin: 6, repMax: 10, targetLoadKg: 62.5, loadGuidance: 'fixed', isPriority: true }),
      expect.objectContaining({ exerciseId: exerciseIds[1], targetLoadKg: null, loadGuidance: 'from_history' }),
      expect.objectContaining({ exerciseId: exerciseIds[2], loadGuidance: 'choose_start', slug: `psess-${run}-choose` }),
    ]);
  });

  it('is idempotent: a second start returns the same workout with existing: true', async () => {
    const userId = await makeUser('twice');
    const { programId, wednesdayId } = await activePlan(userId);

    const first = await today.start(userId, wednesdayId, { date: TODAY }, NOW);
    const second = await today.start(userId, wednesdayId, { date: TODAY }, NOW);

    expect(second).toEqual({ workoutId: first.workoutId, existing: true, planVersion: 1 });
    expect(await client.workout.count({ where: { userId } })).toBe(1);
    expect(await client.programSession.count({ where: { programId } })).toBe(1);
  });

  it('concurrent starts produce one workout and one session', async () => {
    const userId = await makeUser('race');
    const { programId, wednesdayId } = await activePlan(userId);

    const results = await Promise.all([1, 2, 3].map(() => today.start(userId, wednesdayId, { date: TODAY }, NOW)));

    expect(new Set(results.map((r) => r.workoutId)).size).toBe(1);
    expect(results.filter((r) => !r.existing)).toHaveLength(1);
    expect(await client.workout.count({ where: { userId } })).toBe(1);
    expect(await client.programSession.count({ where: { programId } })).toBe(1);
  });

  it('answers 409 WORKOUT_IN_PROGRESS with the other workout id', async () => {
    const userId = await makeUser('other');
    const { wednesdayId } = await activePlan(userId);
    const adHoc = await workouts.start(userId, { name: 'Ad hoc' }, NOW);

    const error = await today.start(userId, wednesdayId, { date: TODAY }, NOW).catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      details: { reason: 'WORKOUT_IN_PROGRESS', workoutId: adHoc.id },
    });
    expect(await client.workout.count({ where: { userId } })).toBe(1);
  });

  it('rolls the workout back when the session insert fails', async () => {
    const userId = await makeUser('atomic');
    const { programId, wednesdayId } = await activePlan(userId);
    const spy = jest.spyOn(workouts, 'startPrefilled').mockImplementationOnce(async (tx, ...rest) => {
      await WorkoutsService.prototype.startPrefilled.call(workouts, tx, ...rest);
      throw new Error('boom after the workout insert');
    });

    await expect(today.start(userId, wednesdayId, { date: TODAY }, NOW)).rejects.toThrow('boom');
    spy.mockRestore();

    expect(await client.workout.count({ where: { userId } })).toBe(0);
    expect(await client.programSession.count({ where: { programId } })).toBe(0);
  });

  it('refuses a paused program (409), another user (404) and a foreign gym (404)', async () => {
    const owner = await makeUser('owner');
    const stranger = await makeUser('stranger');
    const { programId, wednesdayId } = await activePlan(owner);
    const foreignGym = await client.gym.create({ data: { userId: stranger, name: 'Theirs' }, select: { id: true } });

    await expect(today.start(stranger, wednesdayId, { date: TODAY }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(today.start(owner, wednesdayId, { date: TODAY, gymId: foreignGym.id }, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    await programs.pause(owner, programId);
    const paused = await today.start(owner, wednesdayId, { date: TODAY }, NOW).catch((e) => e);
    expect(paused).toBeInstanceOf(ConflictException);
    expect(reasonOf(paused)).toBe('PROGRAM_NOT_ACTIVE');

    expect(await client.workout.count({ where: { userId: owner } })).toBe(0);
  });

  it('keeps the original snapshot after the plan changes', async () => {
    const userId = await makeUser('snapshot');
    const { programId, wednesdayId } = await activePlan(userId);
    const { workoutId } = await today.start(userId, wednesdayId, { date: TODAY }, NOW);

    await programs.applyChange({
      userId,
      programId,
      expectedVersion: 1,
      origin: 'manual_edit',
      actor: 'user',
      kind: 'edited',
      summary: 'Edited by you',
      mutate: (plan) => {
        for (const week of plan.blocks[0].weeks)
          for (const workout of week.workouts) for (const entry of workout.exercises) entry.targetSets = 5;
        return plan;
      },
    });

    const session = await client.programSession.findUniqueOrThrow({ where: { workoutId } });
    expect(session.versionNumber).toBe(1);
    expect((session.plannedSnapshot as any[]).map((entry) => entry.sets)).toEqual([3, 3, 3]);
  });

  it('today: a workout, done after finishing, counted once for several sessions', async () => {
    const userId = await makeUser('today');
    const { wednesdayId } = await activePlan(userId);

    const before = await today.today(userId, TODAY, NOW);
    expect(before).toMatchObject({
      kind: 'workout',
      programWorkout: { id: wednesdayId, weekday: 3 },
      weekNumber: 1,
      totalWeeks: 2,
      done: false,
      session: { planVersion: 1, unseenChangeCount: 0, lastChange: null },
    });
    if (before.kind !== 'workout') throw new Error('expected a workout');
    expect(before.session.exercises.map((entry) => [entry.loadGuidance, entry.suggestedLoadKg, entry.availableAtGym])).toEqual([
      ['fixed', 62.5, null],
      ['from_history', null, null],
      ['choose_start', null, null],
    ]);

    const first = await today.start(userId, wednesdayId, { date: TODAY }, NOW);
    expect(await today.today(userId, TODAY, NOW)).toMatchObject({ done: false, inProgressWorkoutId: first.workoutId });

    await workouts.finish(userId, first.workoutId, {}, NOW);
    const second = await today.start(userId, wednesdayId, { date: TODAY }, NOW);
    await workouts.finish(userId, second.workoutId, {}, NOW);

    const after = await today.today(userId, TODAY, NOW);
    expect(after).toMatchObject({ kind: 'workout', done: true, completedWorkoutId: second.workoutId, inProgressWorkoutId: null });
  });

  it('today: flips an ended plan to completed exactly once', async () => {
    const userId = await makeUser('complete');
    const { programId } = await activePlan(userId);
    await client.program.update({ where: { id: programId }, data: { startDate: new Date('2026-09-01T00:00:00.000Z') } });

    const results = await Promise.all([today.today(userId, TODAY, NOW), today.today(userId, TODAY, NOW)]);

    expect(results.every((r) => r.kind === 'program_complete' || r.kind === 'no_program')).toBe(true);
    expect(results.some((r) => r.kind === 'program_complete')).toBe(true);
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).status).toBe('completed');
    expect(await today.today(userId, TODAY, NOW)).toEqual({ kind: 'no_program', date: TODAY });
  });

  it('cascades: deleting the workout removes the link; deleting the program removes its sessions', async () => {
    const userId = await makeUser('cascade');
    const { programId, wednesdayId } = await activePlan(userId);
    const { workoutId } = await today.start(userId, wednesdayId, { date: TODAY }, NOW);

    await workouts.remove(userId, workoutId);
    expect(await client.programSession.count({ where: { workoutId } })).toBe(0);

    const again = await today.start(userId, wednesdayId, { date: TODAY }, NOW);
    await client.program.delete({ where: { id: programId } });
    expect(await client.programSession.count({ where: { workoutId: again.workoutId } })).toBe(0);
    expect(await client.workout.findUniqueOrThrow({ where: { id: again.workoutId } })).toMatchObject({ programWorkoutId: null });
  });
});
