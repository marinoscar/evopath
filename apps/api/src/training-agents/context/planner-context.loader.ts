import { Injectable } from '@nestjs/common';

import { CHECK_IN_FIELDS, CHECK_IN_METRIC_KEYS } from '../../check-ins/dto/check-in.dto';
import { addDays, fromDbDate, localDateInZone, toDbDate } from '../../check-ins/local-date';
import { ACTIVE } from '../../measurements/measurement-active';
import { PrismaService } from '../../prisma/prisma.service';
import { loadProgramRows } from '../../programs/program-mapper';
import { liveTreeOf } from '../../programs/plan-diff';
import {
  createRunRequestSchema,
  reviseRunRequestSchema,
  trainingIntakeSchema,
  type TrainingIntake,
} from '../contracts/training-intake.contract';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { CONTEXT_LIMITS, type PlannerContextSource } from './build-planner-context';
import { implementOf, isCompoundPattern, type ImplementOption } from './implement';
import type { LibraryExercise } from './planner-context.contract';

// =============================================================================
// PlannerContextLoader: the reads behind the context builder
// =============================================================================
//
// EVERY QUERY IS SCOPED BY THE CALLER'S `userId` and SELECTS ONLY THE COLUMNS
// THE BUILDER USES: never a name, email, note, pain note, storage key, gym
// name or location, and no gym other than the one the request names. The
// builder then copies an allow-list of fields again (defence in depth, and
// what the canary test proves).
//
// Reads: the health profile (birth date, sex, height, unit system, time zone,
// bio), weight and body-fat measurements, the named gym's equipment types and
// their capabilities, the exercise library (seeded plus the caller's active
// custom exercises, with requirement groups), the last 6 weeks of workouts
// with their sets, the last 7 local days of check-in scores, and for `revise`
// the program's intake snapshot and live tree.
// =============================================================================

export const TRAINING_CONTEXT_REASONS = {
  GYM_NOT_FOUND: 'TRAINING_GYM_NOT_FOUND',
  PROGRAM_NOT_FOUND: 'TRAINING_PROGRAM_NOT_FOUND',
  REQUEST_INVALID: 'TRAINING_REQUEST_INVALID',
} as const;

/** What `prepare_context` calls (the node reaches it through `NodeContext.ports`). */
export interface PlannerContextPort {
  load(userId: string, request: Record<string, unknown>, now: Date): Promise<PlannerContextSource>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PlannerContextLoader implements PlannerContextPort {
  constructor(private readonly prisma: PrismaService) {}

  async load(userId: string, request: Record<string, unknown>, now: Date): Promise<PlannerContextSource> {
    const kind = request.kind === 'revise' ? 'revise' : 'create';
    let intake: TrainingIntake;
    let gymId: string | null;
    let revise: PlannerContextSource['revise'] = null;

    if (kind === 'create') {
      const parsed = createRunRequestSchema.safeParse(request);
      if (!parsed.success) throw invalidRequest();
      intake = parsed.data.intake;
      gymId = intake.gymId;
    } else {
      const parsed = reviseRunRequestSchema.safeParse(request);
      if (!parsed.success) throw invalidRequest();
      const program = await this.prisma.program.findFirst({
        where: { id: parsed.data.programId, userId },
        select: { id: true, goal: true, gymId: true, intake: true, currentVersion: true },
      });
      if (!program) {
        throw new TrainingRunFailedError(TRAINING_CONTEXT_REASONS.PROGRAM_NOT_FOUND, 'The plan to revise no longer exists.');
      }
      const tree = liveTreeOf(await loadProgramRows(this.prisma, program.id));
      intake = intakeOfProgram(program.intake, program.goal, tree);
      gymId = program.gymId;
      revise = {
        programId: program.id,
        basedOnVersion: parsed.data.basedOnVersion,
        instruction: parsed.data.instruction,
        currentPlan: tree,
      };
    }

    const [profile, weights, latestWeight, bodyFat, gym, library, workouts] = await Promise.all([
      this.prisma.healthProfile.findUnique({
        where: { userId },
        select: { dateOfBirth: true, sexAtBirth: true, heightMm: true, unitSystem: true, timeZone: true, bio: true },
      }),
      this.prisma.measurement.findMany({
        where: {
          userId,
          ...ACTIVE,
          metricKey: 'weight',
          measuredAt: { gte: new Date(now.getTime() - CONTEXT_LIMITS.weightTrendWeeks * 7 * DAY_MS), lte: now },
        },
        select: { measuredAt: true, value: true },
      }),
      this.prisma.measurement.findFirst({
        where: { userId, ...ACTIVE, metricKey: 'weight', measuredAt: { lte: now } },
        orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
        select: { measuredAt: true, value: true },
      }),
      this.prisma.measurement.findFirst({
        where: { userId, ...ACTIVE, metricKey: 'body_fat_pct', measuredAt: { lte: now } },
        orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
        select: { value: true },
      }),
      gymId ? this.loadGym(userId, gymId, kind === 'create') : Promise.resolve(null),
      this.loadLibrary(userId),
      this.prisma.workout.findMany({
        where: { userId, startedAt: { gte: new Date(now.getTime() - CONTEXT_LIMITS.historyWeeks * 7 * DAY_MS), lte: now } },
        select: {
          date: true,
          startedAt: true,
          status: true,
          exercises: {
            select: {
              exerciseId: true,
              sets: { select: { weightKg: true, reps: true, completed: true, isWarmup: true, painFlag: true } },
            },
          },
        },
      }),
    ]);

    const today = localDateInZone(now, profile?.timeZone ?? null);
    const checkInRows = await this.prisma.measurement.findMany({
      where: {
        userId,
        ...ACTIVE,
        metricKey: { in: [...CHECK_IN_METRIC_KEYS] },
        localDate: { gte: toDbDate(addDays(today, -(CONTEXT_LIMITS.readinessDays - 1))), lte: toDbDate(today) },
      },
      select: { localDate: true, metricKey: true, value: true },
    });

    const weightPoints = weights.map((w) => ({ measuredAt: w.measuredAt, valueKg: w.value }));
    if (latestWeight && !weightPoints.some((w) => w.measuredAt.getTime() === latestWeight.measuredAt.getTime())) {
      weightPoints.push({ measuredAt: latestWeight.measuredAt, valueKg: latestWeight.value });
    }

    return {
      now,
      kind,
      intake,
      revise,
      profile: profile
        ? {
            dateOfBirth: profile.dateOfBirth ? fromDbDate(profile.dateOfBirth) : null,
            sexAtBirth: profile.sexAtBirth,
            heightMm: profile.heightMm,
            unitSystem: profile.unitSystem,
            bio: profile.bio,
          }
        : null,
      weights: weightPoints,
      latestBodyFatPercent: bodyFat?.value ?? null,
      gym,
      library,
      workouts: workouts.map((w) => ({
        date: fromDbDate(w.date),
        startedAt: w.startedAt,
        completed: w.status === 'completed',
        exercises: w.exercises.map((e) => ({
          exerciseId: e.exerciseId,
          sets: e.sets.map((s) => ({
            weightKg: s.weightKg === null ? null : Number(s.weightKg),
            reps: s.reps,
            completed: s.completed,
            isWarmup: s.isWarmup,
            painFlag: s.painFlag,
          })),
        })),
      })),
      checkIns: groupCheckIns(checkInRows),
    };
  }

  private async loadGym(userId: string, gymId: string, required: boolean): Promise<PlannerContextSource['gym']> {
    const owned = await this.prisma.gym.findFirst({ where: { id: gymId, userId }, select: { id: true } });
    if (!owned) {
      if (!required) return null;
      throw new TrainingRunFailedError(TRAINING_CONTEXT_REASONS.GYM_NOT_FOUND, 'The gym chosen for this plan no longer exists.');
    }

    const equipment = await this.prisma.gymEquipment.findMany({
      where: { gymId, gym: { userId } },
      select: { equipmentTypeId: true, equipmentType: { select: { slug: true, category: true } } },
    });
    const typeIds = [...new Set(equipment.map((e) => e.equipmentTypeId))];
    const capabilities = typeIds.length
      ? await this.prisma.equipmentTypeCapability.findMany({
          where: { equipmentTypeId: { in: typeIds } },
          select: { capability: { select: { id: true, slug: true } } },
        })
      : [];

    return {
      equipment: equipment.map((e) => ({ equipmentTypeId: e.equipmentTypeId, slug: e.equipmentType.slug, category: e.equipmentType.category })),
      capabilities: capabilities.map((c) => ({ id: c.capability.id, slug: c.capability.slug })),
    };
  }

  /**
   * The exercises `userId` may be prescribed (seeded plus their active custom
   * ones), with requirement groups, sorted by key. Also read by the quick
   * adaptation context builder (`training-adaptation/`).
   */
  async loadLibrary(userId: string): Promise<LibraryExercise[]> {
    const rows = await this.prisma.exercise.findMany({
      where: { status: 'active', OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
      select: {
        id: true,
        slug: true,
        name: true,
        primaryMuscles: true,
        secondaryMuscles: true,
        movementPattern: true,
        trackingMode: true,
        isUnilateral: true,
        isBodyweight: true,
        requirements: {
          select: {
            groupIndex: true,
            equipmentTypeId: true,
            capabilityId: true,
            equipmentType: { select: { slug: true, category: true } },
            capability: {
              select: { slug: true, equipmentTypes: { select: { equipmentType: { select: { slug: true, category: true } } } } },
            },
          },
        },
      },
    });

    return rows
      .map((row) => {
        const groups = [...new Set(row.requirements.map((r) => r.groupIndex))].sort((a, b) => a - b);
        const firstGroup: ImplementOption[] = row.requirements
          .filter((r) => r.groupIndex === groups[0])
          .map((r): ImplementOption =>
            r.equipmentType
              ? { kind: 'equipment', slug: r.equipmentType.slug, category: r.equipmentType.category }
              : {
                  kind: 'capability',
                  slug: r.capability?.slug ?? '',
                  providers: (r.capability?.equipmentTypes ?? []).map((p) => ({ slug: p.equipmentType.slug, category: p.equipmentType.category })),
                },
          );

        return {
          id: row.id,
          key: row.slug,
          name: row.name,
          primaryMuscles: [...row.primaryMuscles],
          secondaryMuscles: [...row.secondaryMuscles],
          movementPattern: row.movementPattern,
          trackingMode: row.trackingMode,
          isCompound: isCompoundPattern(row.movementPattern),
          isUnilateral: row.isUnilateral,
          isBodyweight: row.isBodyweight,
          implement: implementOf({ slug: row.slug, isBodyweight: row.isBodyweight, firstGroup }),
          requirements: row.requirements.map((r) => ({
            groupIndex: r.groupIndex,
            equipmentTypeId: r.equipmentTypeId,
            capabilityId: r.capabilityId,
          })),
        } satisfies LibraryExercise;
      })
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

function invalidRequest(): TrainingRunFailedError {
  return new TrainingRunFailedError(TRAINING_CONTEXT_REASONS.REQUEST_INVALID, 'The training run request is not valid.');
}

/** The program's intake snapshot, or a minimal one derived from the plan when it has none. */
export function intakeOfProgram(snapshot: unknown, goal: string, tree: { blocks: Array<{ weeks: Array<{ workouts: unknown[] }> }> }): TrainingIntake {
  const parsed = trainingIntakeSchema.safeParse(snapshot);
  if (parsed.success) return parsed.data;

  const weeks = tree.blocks.flatMap((b) => b.weeks);
  const days = Math.min(7, Math.max(1, ...weeks.map((w) => w.workouts.length)));
  const goalType = trainingIntakeSchema.shape.goal.shape.type.safeParse(goal);

  return trainingIntakeSchema.parse({
    goal: { type: goalType.success ? goalType.data : 'general' },
    experience: 'beginner',
    daysPerWeek: days,
    minutesPerSession: 60,
    durationWeeks: Math.min(24, Math.max(4, weeks.length)),
  });
}

function groupCheckIns(rows: Array<{ localDate: Date | null; metricKey: string; value: number }>): PlannerContextSource['checkIns'] {
  const byDate = new Map<string, Record<string, number | null>>();
  for (const row of rows) {
    if (!row.localDate) continue;
    const date = fromDbDate(row.localDate);
    const entry = byDate.get(date) ?? {};
    const field = CHECK_IN_FIELDS.find((f) => f.metricKey === row.metricKey)?.field;
    if (field) entry[field] = row.value;
    byDate.set(date, entry);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, scores]) => ({
      date,
      energy: scores.energy ?? null,
      sleepQuality: scores.sleepQuality ?? null,
      soreness: scores.soreness ?? null,
      stress: scores.stress ?? null,
    }));
}
