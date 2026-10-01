// =============================================================================
// Real-Postgres test: cardio prescriptions end to end (#262, #263)
// =============================================================================
//
// What only a real server can prove: a duration / distance prescription on
// the seeded `outdoor_walk` passes the `program_exercises_shape_chk` CHECK,
// round-trips through the tree, the version snapshots and the decimal
// column; an edit and a revert log readable lines ("20 → 30 min"); a reps
// prescription on it is refused before anything is written; Today exposes the
// targets; starting the planned walk pre-creates it without rep targets and
// snapshots its target; and the signals grade the session by the logged
// distance (and a planned walk with nothing logged as missed).
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated, SEEDED
// database (the `outdoor_walk` library exercise).
// =============================================================================

import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { ExerciseAvailabilityService } from '../../src/exercises/exercise-availability.service';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { GymsService } from '../../src/gyms/gyms.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { PlanExercise, PlanTree } from '../../src/programs/contracts/plan-tree.contract';
import { ProgramsService } from '../../src/programs/programs.service';
import { SignalsLoader } from '../../src/programs/signals/signals.loader';
import { TrainingSignalsService } from '../../src/programs/signals/signals.service';
import { TrainingTodayService } from '../../src/programs/today/training-today.service';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('program-cardio.db.spec');

// Wednesday 2026-09-30, noon UTC (no Health Profile time zone: UTC). The plan starts Monday 2026-09-28.
const NOW = new Date('2026-09-30T12:00:00.000Z');
const TODAY = '2026-09-30';
const MONDAY = '2026-09-28';

describeWithDb('cardio prescriptions (real Postgres)', () => {
  let client: PrismaClient;
  let programs: ProgramsService;
  let today: TrainingTodayService;
  let signals: TrainingSignalsService;
  let walkId: string;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `cardio-${label}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  function walk(position: number, fields: Partial<PlanExercise>): PlanExercise {
    return {
      exerciseId: walkId,
      position,
      isPriority: false,
      targetSets: null,
      repMin: null,
      repMax: null,
      targetDurationSeconds: null,
      targetDistanceMeters: null,
      targetLoadKg: null,
      targetRpe: null,
      restSeconds: 0,
      loadGuidance: 'choose_start',
      rationale: 'Easy aerobic base',
      evidenceRefs: [],
      notes: null,
      equipmentTypeId: null,
      ...fields,
    };
  }

  /** One week: a 20-minute walk on Monday, a 5.25 km walk on Wednesday. */
  function tree(): PlanTree {
    return {
      blocks: [
        {
          position: 0,
          name: 'Base',
          focus: null,
          rationale: null,
          weeks: [
            {
              weekNumber: 1,
              isDeload: false,
              workouts: [
                { position: 0, weekday: 1, name: 'Walk', estimatedMinutes: 25, rationale: null, exercises: [walk(0, { targetDurationSeconds: 1200 })] },
                { position: 1, weekday: 3, name: 'Long walk', estimatedMinutes: 60, rationale: null, exercises: [walk(0, { targetDistanceMeters: 5250.5 })] },
              ],
            },
          ],
        },
      ],
    };
  }

  const create = (userId: string) =>
    programs.createWithTree({
      userId,
      header: { name: 'Walking plan', goal: 'endurance', source: 'manual' },
      tree: tree(),
      origin: 'initial',
      actor: 'user',
      summary: 'Created by you',
    });

  const mondayWalk = (minutes: number) => (plan: PlanTree): PlanTree => {
    plan.blocks[0].weeks[0].workouts.find((w) => w.weekday === 1)!.exercises[0].targetDurationSeconds = minutes * 60;
    return plan;
  };

  const lastLog = (programId: string) =>
    client.programChangeLog.findFirstOrThrow({ where: { programId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });

  const snapshotWalk = async (programId: string, versionNumber: number) => {
    const version = await client.programVersion.findUniqueOrThrow({ where: { programId_versionNumber: { programId, versionNumber } } });
    return (version.snapshot as any).tree.blocks[0].weeks[0].workouts[0].exercises[0];
  };

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
    const gyms = new GymsService(prisma, {} as GymStorageService);
    programs = new ProgramsService(prisma);
    const workouts = new WorkoutsService(prisma, gyms, checkIns, new WorkoutHistoryService(prisma, checkIns));
    today = new TrainingTodayService(prisma, checkIns, new ExerciseAvailabilityService(prisma, gyms), workouts);
    signals = new TrainingSignalsService(prisma, checkIns, new SignalsLoader(prisma, new WorkoutHistoryService(prisma, checkIns)));
    const seeded = await client.exercise.findFirstOrThrow({ where: { slug: 'outdoor_walk', ownerUserId: null }, select: { id: true, trackingMode: true } });
    expect(seeded.trackingMode).toBe('distance_time');
    walkId = seeded.id;
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  it('round-trips duration and distance targets through the rows, the read and the version snapshot', async () => {
    const userId = await makeUser('roundtrip');
    const { programId } = await create(userId);

    const rows = await client.programExercise.findMany({
      where: { programWorkout: { week: { programId } } },
      orderBy: { programWorkout: { weekday: 'asc' } },
      select: { targetSets: true, repMin: true, repMax: true, targetDurationSeconds: true, targetDistanceMeters: true },
    });
    expect(rows.map((row) => ({ ...row, targetDistanceMeters: row.targetDistanceMeters === null ? null : Number(row.targetDistanceMeters) }))).toEqual([
      { targetSets: null, repMin: null, repMax: null, targetDurationSeconds: 1200, targetDistanceMeters: null },
      { targetSets: null, repMin: null, repMax: null, targetDurationSeconds: null, targetDistanceMeters: 5250.5 },
    ]);

    const view = await programs.get(userId, programId);
    const [monday, wednesday] = view.tree.blocks[0].weeks[0].workouts.map((w) => w.exercises[0]);
    expect(monday).toMatchObject({ exercise: { slug: 'outdoor_walk', trackingMode: 'distance_time' }, targetSets: null, repMin: null, repMax: null, targetDurationSeconds: 1200, targetDistanceMeters: null });
    expect(wednesday).toMatchObject({ targetDurationSeconds: null, targetDistanceMeters: 5250.5 });
    expect(await snapshotWalk(programId, 1)).toMatchObject({ id: monday.id, targetDurationSeconds: 1200, repMin: null });
  });

  it('an edit and a revert log the change as "20 → 30 min" and "30 → 20 min", with each version keeping its own target', async () => {
    const userId = await makeUser('diff');
    const { programId } = await create(userId);

    const edited = await programs.applyChange({
      userId,
      programId,
      expectedVersion: 1,
      origin: 'manual_edit',
      actor: 'user',
      kind: 'edited',
      summary: 'Edited by you',
      mutate: mondayWalk(30),
    });
    expect(edited.versionNumber).toBe(2);
    expect(await lastLog(programId)).toMatchObject({
      kind: 'edited',
      summary: 'Edited by you',
      operations: [{ op: 'edit_prescription', description: 'Week 1, Outdoor walk: 20 → 30 min' }],
    });
    expect(await snapshotWalk(programId, 1)).toMatchObject({ targetDurationSeconds: 1200 });
    expect(await snapshotWalk(programId, 2)).toMatchObject({ targetDurationSeconds: 1800 });

    await programs.revert({ userId, programId, expectedVersion: 2, toVersion: 1 });
    expect(await lastLog(programId)).toMatchObject({
      kind: 'reverted',
      operations: [{ op: 'edit_prescription', description: 'Week 1, Outdoor walk: 30 → 20 min' }],
    });
    const view = await programs.get(userId, programId);
    expect(view.tree.blocks[0].weeks[0].workouts[0].exercises[0].targetDurationSeconds).toBe(1200);
  });

  it('refuses a reps prescription on the walk with 400 PRESCRIPTION_SHAPE_MISMATCH and writes nothing', async () => {
    const userId = await makeUser('mismatch');
    const { programId } = await create(userId);

    const error = await programs
      .applyChange({
        userId,
        programId,
        expectedVersion: 1,
        origin: 'manual_edit',
        actor: 'user',
        kind: 'edited',
        summary: 'Edited by you',
        mutate: (plan) => {
          Object.assign(plan.blocks[0].weeks[0].workouts[0].exercises[0], { targetSets: 3, repMin: 10, repMax: 15, targetDurationSeconds: null });
          return plan;
        },
      })
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ details: { reason: 'PRESCRIPTION_SHAPE_MISMATCH' } });
    expect(await client.program.findUniqueOrThrow({ where: { id: programId }, select: { currentVersion: true } })).toEqual({ currentVersion: 1 });
    expect(await client.programVersion.count({ where: { programId } })).toBe(1);
  });

  it('Today shows the targets; starting the walk pre-creates it without rep targets; the signals grade it by distance', async () => {
    const userId = await makeUser('today');
    const { programId } = await create(userId);
    await programs.activate(userId, programId, MONDAY, NOW);

    const plan = await today.today(userId, TODAY, NOW);
    expect(plan.kind).toBe('workout');
    if (plan.kind !== 'workout') return;
    expect(plan.session.exercises).toEqual([
      expect.objectContaining({ sets: null, repMin: null, repMax: null, targetDurationSeconds: null, targetDistanceMeters: 5250.5, suggestedLoadKg: null }),
    ]);

    const started = await today.start(userId, plan.programWorkout.id, { date: TODAY }, NOW);
    const workout = await client.workout.findUniqueOrThrow({
      where: { id: started.workoutId },
      include: { exercises: { include: { sets: true } }, programSession: { select: { plannedSnapshot: true } } },
    });
    expect(workout.exercises).toHaveLength(1);
    expect(workout.exercises[0].exerciseId).toBe(walkId);
    expect(workout.exercises[0].sets.map((set) => [set.setNumber, set.reps, set.weightKg, set.durationSeconds, set.distanceMeters, set.completed])).toEqual([
      [1, null, null, null, null, false],
    ]);
    expect(workout.programSession?.plannedSnapshot).toEqual([
      expect.objectContaining({ exerciseId: walkId, sets: null, repMin: null, repMax: null, targetDurationSeconds: null, targetDistanceMeters: 5250.5 }),
    ]);

    // The person walks 3.7 km (70 percent) and finishes.
    await client.setLog.update({ where: { id: workout.exercises[0].sets[0].id }, data: { distanceMeters: '3700', durationSeconds: 2700, completed: true } });
    await client.workout.update({ where: { id: workout.id }, data: { status: 'completed', endedAt: new Date('2026-09-30T13:00:00.000Z') } });

    const asOf = '2026-10-01';
    const result = await signals.forUser(userId, { programId, from: MONDAY, to: asOf, asOf }, new Date('2026-10-01T12:00:00.000Z'));
    expect(result.sessions.map((s) => [s.plannedFor, s.status, s.completionPct])).toEqual([
      // Monday's planned walk: nothing logged, the day is over.
      ['2026-09-28', 'missed', null],
      ['2026-09-30', 'done', 70.5],
    ]);
  });
});
