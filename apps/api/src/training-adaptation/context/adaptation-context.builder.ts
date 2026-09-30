import { Injectable } from '@nestjs/common';

import { CheckInsService } from '../../check-ins/check-ins.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TrainingTodayService } from '../../programs/today/training-today.service';
import { PlannerContextLoader } from '../../training-agents/context/planner-context.loader';
import { ADAPTATION_CONTEXT_LIMITS } from '../adaptation.constants';
import type { AdaptationRequest } from '../dto/adaptation-request.dto';
import { type AdaptationContext, AdaptationContextError } from './adaptation-context.contract';
import { type AdaptationContextSource, buildAdaptationContext } from './build-adaptation-context';

// =============================================================================
// AdaptationContextBuilder: the reads behind the adaptation context
// =============================================================================
//
// `build(userId, request)` is the ONE door: the preview route, the create
// route and the graph's `context` node all call it, so "what will be sent" is
// what is sent. Every query is scoped by the caller's `userId` and selects
// only the columns the pure builder uses (never a gym's name, notes or
// coordinates, a check-in note, a pain note or any profile field). Today is
// the SERVER's today in the Health Profile time zone, never the client's.
//
// Reads: today's planned workout through E5.7 (`TrainingTodayService.today`,
// the same resolution, prescription and last-time values the Today card
// shows), the active plan's goal and intake snapshot, the chosen gym's
// equipment and capabilities, the exercise library (E5's loader), the
// exercises pain-flagged in the last 28 days, and today's check-in scores.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** What `context` reaches through the node context (a fake in graph tests). */
export interface AdaptationContextPort {
  build(userId: string, request: AdaptationRequest, now?: Date): Promise<AdaptationContext>;
}

@Injectable()
export class AdaptationContextBuilder implements AdaptationContextPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkIns: CheckInsService,
    private readonly todayService: TrainingTodayService,
    private readonly library: PlannerContextLoader,
  ) {}

  async build(userId: string, request: AdaptationRequest, now: Date = new Date()): Promise<AdaptationContext> {
    const today = await this.checkIns.today(userId, now);

    const program = await this.prisma.program.findFirst({
      where: { userId, status: 'active' },
      select: { id: true, goal: true, intake: true, gymId: true, currentVersion: true },
    });

    const planned = request.baseWorkout === 'planned' && program ? await this.plannedToday(userId, today, now) : null;

    // The gym named, else the plan's, else (in `loadGym`) the default gym.
    const gymId = request.gymId ?? program?.gymId ?? null;
    const [gym, library, painRows, checkIn] = await Promise.all([
      this.loadGym(userId, gymId, request.gymId !== undefined),
      this.library.loadLibrary(userId),
      this.prisma.setLog.findMany({
        where: {
          painFlag: true,
          workoutExercise: {
            workout: { userId, startedAt: { gte: new Date(now.getTime() - ADAPTATION_CONTEXT_LIMITS.painFlagDays * DAY_MS) } },
          },
        },
        select: { workoutExercise: { select: { exerciseId: true } } },
      }),
      request.useReadiness ? this.checkIns.getForDate(userId, today) : Promise.resolve(null),
    ]);

    const source: AdaptationContextSource = {
      now,
      today,
      request,
      program: program ? { id: program.id, goal: program.goal, intake: program.intake, gymId: program.gymId } : null,
      planned,
      gym,
      library,
      painFlagExerciseIds: [...new Set(painRows.map((row) => row.workoutExercise.exerciseId))],
      checkIn: checkIn
        ? { energy: checkIn.energy, sleepQuality: checkIn.sleepQuality, soreness: checkIn.soreness, stress: checkIn.stress }
        : null,
    };

    return buildAdaptationContext(source);
  }

  /** Today's planned workout (E5.7), with its version id; `null` on a rest day or when the plan has not started. */
  private async plannedToday(userId: string, today: string, now: Date): Promise<AdaptationContextSource['planned']> {
    const resolved = await this.todayService.today(userId, today, now);
    if (resolved.kind !== 'workout') return null;

    const session = resolved.session;
    const version = await this.prisma.programVersion.findUnique({
      where: { programId_versionNumber: { programId: session.programId, versionNumber: session.planVersion } },
      select: { id: true },
    });

    return {
      programId: session.programId,
      planVersion: session.planVersion,
      planVersionId: version?.id ?? null,
      programWorkoutId: session.programWorkoutId,
      name: session.name,
      date: today,
      weekNumber: session.weekNumber,
      totalWeeks: session.totalWeeks,
      isDeload: session.isDeload,
      estimatedMinutes: session.estimatedMinutes,
      exercises: session.exercises.map((e) => ({
        exerciseId: e.exercise.id,
        key: e.exercise.slug,
        name: e.exercise.name,
        primaryMuscles: [...e.exercise.primaryMuscles],
        trackingMode: e.exercise.trackingMode,
        isPriority: e.isPriority,
        sets: e.sets,
        repMin: e.repMin,
        repMax: e.repMax,
        targetRpe: e.targetRpe,
        restSeconds: e.restSeconds,
        targetLoadKg: e.targetLoadKg,
        loadGuidance: e.loadGuidance,
        lastTime: e.lastTime ? { performedOn: e.lastTime.performedOn, topSet: e.lastTime.topSet ? { ...e.lastTime.topSet } : null } : null,
      })),
    };
  }

  /**
   * The chosen gym's equipment and capabilities (never its name, notes,
   * photos or location). A gym the caller named that is not theirs is an
   * error; a plan gym that no longer exists falls back to the default gym.
   */
  private async loadGym(userId: string, gymId: string | null, named: boolean): Promise<AdaptationContextSource['gym']> {
    let gym = gymId
      ? await this.prisma.gym.findFirst({ where: { id: gymId, userId }, select: { id: true, type: true, isTemporary: true } })
      : null;

    if (!gym && named) {
      throw new AdaptationContextError('ADAPTATION_GYM_NOT_FOUND', 'Gym not found');
    }
    if (!gym) {
      gym = await this.prisma.gym.findFirst({
        where: { userId, isDefault: true },
        select: { id: true, type: true, isTemporary: true },
      });
    }
    if (!gym) return null;

    const equipment = await this.prisma.gymEquipment.findMany({
      where: { gymId: gym.id, gym: { userId } },
      select: { equipmentTypeId: true, quantity: true, equipmentType: { select: { name: true } } },
    });
    const typeIds = [...new Set(equipment.map((e) => e.equipmentTypeId))];
    const capabilities = typeIds.length
      ? await this.prisma.equipmentTypeCapability.findMany({
          where: { equipmentTypeId: { in: typeIds } },
          select: { equipmentTypeId: true, capability: { select: { id: true, slug: true } } },
        })
      : [];

    return {
      id: gym.id,
      type: gym.type ?? null,
      isTemporary: gym.isTemporary,
      equipment: equipment.map((e) => ({ equipmentTypeId: e.equipmentTypeId, name: e.equipmentType.name, quantity: e.quantity })),
      capabilities: capabilities.map((c) => ({ equipmentTypeId: c.equipmentTypeId, id: c.capability.id, slug: c.capability.slug })),
    };
  }
}
