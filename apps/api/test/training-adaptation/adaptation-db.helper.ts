// =============================================================================
// Shared setup for the real-Postgres adaptation suites
// =============================================================================
//
// The REAL `AdaptationService`, `AdaptationContextBuilder`, `ProgramsService`,
// `WorkoutsService` and `TrainingTodayService` over a real Prisma client, with
// three throw-away library exercises, a user per test with an active plan whose
// Wednesday workout is today (`NOW`), and a `readyAdaptation` whose proposal is
// what `applyAdaptationRules` makes of a scripted planner answer.
//
// Only the model, the queue and object storage are absent: apply calls none.
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
import { ADAPTATION_TTL_MS } from '../../src/training-adaptation/adaptation.constants';
import { AdaptationService } from '../../src/training-adaptation/adaptation.service';
import { AdaptationContextBuilder } from '../../src/training-adaptation/context/adaptation-context.builder';
import { snapshotOf } from '../../src/training-adaptation/context/adaptation-context.contract';
import type { AdaptationProposalModel } from '../../src/training-adaptation/contracts/adapted-workout.contract';
import { adaptationRequestSchema } from '../../src/training-adaptation/dto/adaptation-request.dto';
import { applyAdaptationRules } from '../../src/training-adaptation/rules/adaptation-rules';
import { modelExercise, proposalAnswer } from '../../src/training-adaptation/testing/adaptation-fixtures';
import { WorkoutHistoryService } from '../../src/workouts/workout-history.service';
import { WorkoutsService } from '../../src/workouts/workouts.service';

/** Wednesday 2026-09-30, noon UTC (no Health Profile time zone: UTC). */
export const DB_NOW = new Date('2026-09-30T12:00:00.000Z');
export const DB_MONDAY = '2026-09-28';

export const reasonOf = (error: unknown) => ((error as HttpException).getResponse() as { details?: { reason?: string } }).details?.reason;
export const detailsOf = (error: unknown) => ((error as HttpException).getResponse() as { details?: Record<string, unknown> }).details;

export async function failure(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('Expected the call to be refused');
}

export async function createAdaptationDbRig(client: PrismaClient) {
  const prisma = client as unknown as PrismaService;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const exerciseIds: string[] = [];
  const slugs: string[] = [];

  const checkIns = new CheckInsService(prisma, new HealthProfileService(prisma));
  const gyms = new GymsService(prisma, {} as GymStorageService);
  const workouts = new WorkoutsService(prisma, gyms, checkIns, new WorkoutHistoryService(prisma, checkIns));
  const today = new TrainingTodayService(prisma, checkIns, new ExerciseAvailabilityService(prisma, gyms), workouts);
  const programs = new ProgramsService(prisma);
  const library = new PlannerContextLoader(prisma);
  const builder = new AdaptationContextBuilder(prisma, checkIns, today, library);
  const service = new AdaptationService(prisma, {} as never, {} as never, {} as never, {} as never, builder, library, workouts, programs);

  for (const [label, muscle] of [['press', 'chest'], ['row', 'upper_back'], ['curl', 'biceps']] as const) {
    const slug = `adapt-${tag}-${label}`;
    const row = await client.exercise.create({
      data: { slug, name: `Adapt ${label}`, primaryMuscles: [muscle], movementPattern: 'horizontal_push' },
      select: { id: true },
    });
    exerciseIds.push(row.id);
    slugs.push(slug);
  }

  /** Three exercises, four sets each, the first a priority lift with a 60 kg "fixed" load; Wednesday. */
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

  /** A user, optionally with an active plan whose Wednesday workout is today. */
  async function user(withPlan = true): Promise<{ id: string; email: string; programId: string | null }> {
    const email = `adapt-db-${randomUUID().slice(0, 8)}-${tag}@example.com`;
    const row = await client.user.create({ data: { email } });
    userIds.push(row.id);
    if (!withPlan) return { id: row.id, email, programId: null };

    const { programId } = await programs.createWithTree({
      userId: row.id,
      header: { name: 'Plan', goal: 'strength', source: 'manual' },
      tree: tree(),
      origin: 'initial',
      actor: 'user',
      summary: 'Created by you',
    });
    await programs.activate(row.id, programId, DB_MONDAY, DB_NOW);
    return { id: row.id, email, programId };
  }

  /** A completed workout `daysAgo` days back with completed sets on `slugIndex`, optionally pain-flagged. */
  async function loggedWorkout(userId: string, slugIndex: number, opts: { daysAgo?: number; weightKg?: number; reps?: number; painFlag?: boolean } = {}) {
    const startedAt = new Date(DB_NOW.getTime() - (opts.daysAgo ?? 3) * 24 * 60 * 60 * 1000);
    return client.workout.create({
      data: {
        userId,
        name: 'Earlier',
        date: new Date(startedAt.toISOString().slice(0, 10)),
        status: 'completed',
        startedAt,
        endedAt: new Date(startedAt.getTime() + 3_600_000),
        exercises: {
          create: [
            {
              exerciseId: exerciseIds[slugIndex],
              position: 0,
              sets: {
                create: [1, 2, 3].map((setNumber) => ({
                  setNumber,
                  weightKg: opts.weightKg ?? 55,
                  reps: opts.reps ?? 8,
                  completed: true,
                  completedAt: startedAt,
                  painFlag: opts.painFlag ?? false,
                })),
              },
            },
          ],
        },
      },
      select: { id: true },
    });
  }

  /**
   * A `ready` adaptation of today's workout for `userId`, its proposal what the
   * rules make of `answer` (default: the priority lift at 3 sets plus the row at 3, both at the plan's reps).
   */
  async function readyAdaptation(
    userId: string,
    opts: { request?: Record<string, unknown>; answer?: AdaptationProposalModel['exercises'] } = {},
  ): Promise<{ adaptationId: string; programWorkoutId: string | null }> {
    const request = adaptationRequestSchema.parse(opts.request ?? { minutes: 30, lowEnergy: true });
    const context = await builder.build(userId, request, DB_NOW);

    const outcome = applyAdaptationRules(
      proposalAnswer(opts.answer ?? [modelExercise(slugs[0], { isPriority: true, sets: 3, repMin: 6, repMax: 8 }), modelExercise(slugs[1], { sets: 3, repMin: 6, repMax: 10 })]),
      context.facts,
      { minutes: request.minutes ?? null, soreness: request.soreness ?? null },
    );
    if (!outcome.ok) throw new Error(outcome.message);

    const row = await client.workoutAdaptation.create({
      data: {
        userId,
        status: 'ready',
        request: request as never,
        gymId: null,
        baseRef: context.baseRef ? (context.baseRef as never) : undefined,
        contextSnapshot: snapshotOf(context) as never,
        proposal: outcome.proposal as never,
        guardrailReport: { ...outcome.report, promptVersion: 1, warnings: [] } as never,
        safety: context.safety as never,
        expiresAt: new Date(DB_NOW.getTime() + ADAPTATION_TTL_MS),
      },
    });
    return { adaptationId: row.id, programWorkoutId: context.baseRef?.planWorkoutId ?? null };
  }

  async function cleanup() {
    await client.workout.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.exercise.deleteMany({ where: { id: { in: exerciseIds } } });
  }

  return { prisma, tag, programs, builder, service, workouts, exerciseIds, slugs, tree, user, loggedWorkout, readyAdaptation, cleanup };
}

export type AdaptationDbRig = Awaited<ReturnType<typeof createAdaptationDbRig>>;
