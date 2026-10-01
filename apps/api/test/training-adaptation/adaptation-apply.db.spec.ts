// =============================================================================
// Quick workout adaptation: build the context and apply, on the real database
// =============================================================================
//
//   - `AdaptationContextBuilder` resolves today's planned workout (E5.7) and
//     builds the context from real rows.
//   - `apply/workout` writes one prefilled in-progress workout linked to the
//     planned workout with a `program_sessions` row, leaves the plan
//     untouched, is idempotent, and the other mode afterwards is 409.
//   - `apply/plan` writes a new plan version and an `adapted` AI change-log
//     entry; the one-off mode afterwards is 409.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { HttpException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { ExerciseAvailabilityService } from '../../src/exercises/exercise-availability.service';
import type { GymStorageService } from '../../src/gyms/gym-storage.service';
import { GymsService } from '../../src/gyms/gyms.service';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { PlanTree } from '../../src/programs/contracts/plan-tree.contract';
import { ProgramsService } from '../../src/programs/programs.service';
import { TrainingTodayService } from '../../src/programs/today/training-today.service';
import { PlannerContextLoader } from '../../src/training-agents/context/planner-context.loader';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';
import { ADAPTATION_TTL_MS } from '../../src/training-adaptation/adaptation.constants';
import { AdaptationService } from '../../src/training-adaptation/adaptation.service';
import { AdaptationContextBuilder } from '../../src/training-adaptation/context/adaptation-context.builder';
import { snapshotOf } from '../../src/training-adaptation/context/adaptation-context.contract';
import { adaptationRequestSchema } from '../../src/training-adaptation/dto/adaptation-request.dto';
import { applyAdaptationRules } from '../../src/training-adaptation/rules/adaptation-rules';
import { modelExercise, proposalAnswer } from '../../src/training-adaptation/testing/adaptation-fixtures';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('adaptation-apply.db.spec');

// Wednesday 2026-09-30, noon UTC (no Health Profile time zone: UTC).
const NOW = new Date('2026-09-30T12:00:00.000Z');
const MONDAY = '2026-09-28';

describeWithDb('quick workout adaptation: context and apply (real Postgres)', () => {
  let client: PrismaClient;
  let prisma: PrismaService;
  let programs: ProgramsService;
  let builder: AdaptationContextBuilder;
  let service: AdaptationService;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const exerciseIds: string[] = [];
  const slugs: string[] = [];

  const reasonOf = (error: unknown) => ((error as HttpException).getResponse() as { details?: { reason?: string } }).details?.reason;

  beforeAll(async () => {
    client = createDbClient();
    prisma = client as unknown as PrismaService;
    const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
    const gyms = new GymsService(prisma, {} as GymStorageService);
    const workouts = new WorkoutsService(prisma, gyms, checkIns, new WorkoutHistoryService(prisma, checkIns));
    const today = new TrainingTodayService(prisma, checkIns, new ExerciseAvailabilityService(prisma, gyms), workouts);
    programs = new ProgramsService(prisma);
    const library = new PlannerContextLoader(prisma);
    builder = new AdaptationContextBuilder(prisma, checkIns, today, library);
    service = new AdaptationService(prisma, {} as never, {} as never, {} as never, {} as never, builder, library, workouts, programs);

    for (const [label, muscle] of [['press', 'chest'], ['row', 'upper_back'], ['curl', 'biceps']] as const) {
      const slug = `adapt-${tag}-${label}`;
      const row = await client.exercise.create({
        data: { slug, name: `Adapt ${label}`, primaryMuscles: [muscle], movementPattern: 'horizontal_push' },
        select: { id: true },
      });
      exerciseIds.push(row.id);
      slugs.push(slug);
    }
  });

  afterAll(async () => {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
    await client.$disconnect();
  });

  function tree(): PlanTree {
    const exercise = (i: number) => ({
      exerciseId: exerciseIds[i],
      position: i,
      isPriority: i === 0,
      targetSets: 4,
      repMin: 6,
      repMax: 10,
      targetDurationSeconds: null,
      targetDistanceMeters: null,
      targetLoadKg: i === 0 ? 60 : null,
      targetRpe: 8,
      restSeconds: 120,
      loadGuidance: i === 0 ? ('fixed' as const) : ('from_history' as const),
      rationale: null,
      evidenceRefs: [],
      notes: null,
      equipmentTypeId: null,
    });
    return {
      blocks: [
        {
          position: 0,
          name: 'Block',
          focus: null,
          rationale: null,
          weeks: [1, 2].map((weekNumber) => ({
            weekNumber,
            isDeload: false,
            workouts: [{ position: 0, weekday: 3, name: `Upper ${weekNumber}`, estimatedMinutes: 60, rationale: null, exercises: [0, 1, 2].map(exercise) }],
          })),
        },
      ],
    };
  }

  /** A user with an active plan whose Wednesday workout is today, and a ready adaptation of it. */
  async function readyAdaptation(): Promise<{ userId: string; programId: string; adaptationId: string; programWorkoutId: string }> {
    const user = await client.user.create({ data: { email: `adapt-apply-${randomUUID().slice(0, 8)}-${tag}@example.com` } });
    userIds.push(user.id);
    const { programId } = await programs.createWithTree({
      userId: user.id,
      header: { name: 'Plan', goal: 'strength', source: 'manual' },
      tree: tree(),
      origin: 'initial',
      actor: 'user',
      summary: 'Created by you',
    });
    await programs.activate(user.id, programId, MONDAY, NOW);

    const request = adaptationRequestSchema.parse({ minutes: 30, lowEnergy: true });
    const context = await builder.build(user.id, request, NOW);
    expect(context.facts.base?.exercises.map((e) => e.key)).toEqual(slugs);
    expect(JSON.stringify(context.sent)).not.toContain(user.email);

    const outcome = applyAdaptationRules(
      proposalAnswer([modelExercise(slugs[0], { isPriority: true, sets: 3, repMin: 6, repMax: 8 }), modelExercise(slugs[1], { sets: 3 })]),
      context.facts,
      { minutes: 30, soreness: null },
    );
    if (!outcome.ok) throw new Error(outcome.message);

    const row = await client.workoutAdaptation.create({
      data: {
        userId: user.id,
        status: 'ready',
        request: request as never,
        baseRef: context.baseRef as never,
        contextSnapshot: snapshotOf(context) as never,
        proposal: outcome.proposal as never,
        guardrailReport: { ...outcome.report, promptVersion: 1, warnings: [] } as never,
        safety: context.safety as never,
        expiresAt: new Date(NOW.getTime() + ADAPTATION_TTL_MS),
      },
    });
    return { userId: user.id, programId, adaptationId: row.id, programWorkoutId: context.baseRef!.planWorkoutId };
  }

  it('apply/workout: one prefilled workout linked to the planned workout; the plan is untouched; idempotent', async () => {
    const { userId, programId, adaptationId, programWorkoutId } = await readyAdaptation();

    const first = await service.applyWorkout(userId, adaptationId, NOW);
    const again = await service.applyWorkout(userId, adaptationId, NOW);

    expect(first).toEqual({ workoutId: expect.any(String), linkedToPlan: true, planChanged: false });
    expect(again).toEqual(first);
    const workout = await client.workout.findUniqueOrThrow({
      where: { id: first.workoutId },
      include: { exercises: { orderBy: { position: 'asc' }, include: { sets: { orderBy: { setNumber: 'asc' } } } } },
    });
    expect(workout).toMatchObject({ status: 'in_progress', programWorkoutId });
    expect(workout.notes).toMatch(/^Adapted: 30 min, low energy/);
    expect(workout.exercises.map((e) => e.exerciseId)).toEqual([exerciseIds[0], exerciseIds[1]]);
    // The kept "fixed" lift keeps its 60 kg plan load; the other has no history: blank.
    expect(workout.exercises[0].sets.map((s) => Number(s.weightKg))).toEqual([60, 60, 60]);
    expect(workout.exercises[1].sets.every((s) => s.weightKg === null)).toBe(true);
    expect(await client.programSession.count({ where: { workoutId: first.workoutId, programWorkoutId } })).toBe(1);
    expect((await client.program.findUniqueOrThrow({ where: { id: programId } })).currentVersion).toBe(1);

    const other = await service.applyPlan(userId, adaptationId, NOW).catch((e: unknown) => e);
    expect(reasonOf(other)).toBe('ADAPTATION_ALREADY_APPLIED');
  });

  it('apply/plan: a new version and an adapted AI change-log entry; idempotent; one-off afterwards is 409', async () => {
    const { userId, programId, adaptationId, programWorkoutId } = await readyAdaptation();

    const result = await service.applyPlan(userId, adaptationId, NOW);
    const again = await service.applyPlan(userId, adaptationId, NOW);

    expect(result).toMatchObject({ programId, versionNumber: 2 });
    expect(again).toEqual(result);
    const log = await client.programChangeLog.findUniqueOrThrow({ where: { id: result.changeLogId } });
    expect(log).toMatchObject({ kind: 'adapted', actor: 'ai', status: 'applied', fromVersion: 1, toVersion: 2 });
    const version = await client.programVersion.findUniqueOrThrow({ where: { id: result.planVersionId } });
    expect(version.meta).toMatchObject({ adaptationId, source: 'workout_adaptation' });
    const exercises = await client.programExercise.findMany({ where: { programWorkoutId }, orderBy: { position: 'asc' } });
    expect(exercises.map((e) => e.exerciseId)).toEqual([exerciseIds[0], exerciseIds[1]]);

    const other = await service.applyWorkout(userId, adaptationId, NOW).catch((e: unknown) => e);
    expect(reasonOf(other)).toBe('ADAPTATION_ALREADY_APPLIED');

    // E5.1's one-tap revert undoes it.
    await programs.revert({ userId, programId, expectedVersion: 2, changeLogId: result.changeLogId });
    const restored = await client.programExercise.findMany({ where: { programWorkoutId }, orderBy: { position: 'asc' } });
    expect(restored.map((e) => e.exerciseId)).toEqual(exerciseIds);
  });
});
