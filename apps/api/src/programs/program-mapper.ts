import type { Prisma, PrismaClient } from '@prisma/client';

import { fromDbDate } from '../check-ins/local-date';
import type { PlanTree } from './contracts/plan-tree.contract';
import type {
  ChangeLogEntryData,
  PlanTreeViewData,
  ProgramListItemData,
  ProgramViewData,
  VersionSummaryData,
  VersionViewData,
} from './dto/program.dto';
import type { ProgramRows } from './plan-diff';
import type {
  ChangeActor,
  ChangeKind,
  ChangeStatus,
  ProgramAutonomy,
  ProgramGoal,
  ProgramSource,
  ProgramStatus,
  VersionOrigin,
} from './programs.constants';

// =============================================================================
// Programs (E5.1): row loading and row-to-view mappers
// =============================================================================

type Db = PrismaClient | Prisma.TransactionClient;

const toNumber = (value: Prisma.Decimal | null): number | null => (value === null ? null : Number(value));

/** Every row of a program's tree, archived ones included, as plain values. Four indexed reads. */
export async function loadProgramRows(db: Db, programId: string): Promise<ProgramRows> {
  const [blocks, weeks, workouts, exercises] = await Promise.all([
    db.programBlock.findMany({
      where: { programId },
      select: { id: true, position: true, name: true, focus: true, rationale: true, archivedAt: true },
    }),
    db.programWeek.findMany({
      where: { programId },
      select: { id: true, blockId: true, weekNumber: true, isDeload: true, archivedAt: true },
    }),
    db.programWorkout.findMany({
      where: { week: { programId } },
      select: {
        id: true,
        weekId: true,
        position: true,
        weekday: true,
        name: true,
        estimatedMinutes: true,
        rationale: true,
        archivedAt: true,
      },
    }),
    db.programExercise.findMany({
      where: { programWorkout: { week: { programId } } },
      select: {
        id: true,
        programWorkoutId: true,
        exerciseId: true,
        position: true,
        isPriority: true,
        targetSets: true,
        repMin: true,
        repMax: true,
        targetLoadKg: true,
        targetRpe: true,
        restSeconds: true,
        loadGuidance: true,
        rationale: true,
        evidenceRefs: true,
        notes: true,
        equipmentTypeId: true,
      },
    }),
  ]);

  return {
    blocks,
    weeks,
    workouts,
    exercises: exercises.map((row) => ({
      ...row,
      targetLoadKg: toNumber(row.targetLoadKg),
      targetRpe: toNumber(row.targetRpe),
    })),
  };
}

export const PROGRAM_HEADER_SELECT = {
  id: true,
  name: true,
  goal: true,
  status: true,
  source: true,
  autonomy: true,
  startDate: true,
  gymId: true,
  currentVersion: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProgramSelect;

type ProgramHeaderRow = Prisma.ProgramGetPayload<{ select: typeof PROGRAM_HEADER_SELECT }>;

function toHeader(program: ProgramHeaderRow) {
  return {
    id: program.id,
    name: program.name,
    goal: program.goal as ProgramGoal,
    status: program.status as ProgramStatus,
    source: program.source as ProgramSource,
    autonomy: program.autonomy as ProgramAutonomy,
    startDate: program.startDate ? fromDbDate(program.startDate) : null,
    gymId: program.gymId,
    currentVersion: program.currentVersion,
    createdAt: program.createdAt.toISOString(),
    updatedAt: program.updatedAt.toISOString(),
  };
}

export function toProgramListItem(program: ProgramHeaderRow, unseenChangeCount: number): ProgramListItemData {
  return { ...toHeader(program), unseenChangeCount };
}

export interface ExerciseRef {
  id: string;
  name: string;
  slug: string;
  trackingMode: string;
  status: string;
  ownerUserId: string | null;
}

/**
 * The tree for a read, each prescription with its exercise. An exercise that
 * is not (or no longer) usable by the owner reads as `exercise: null` with
 * `exerciseUnavailable: true`, never an error.
 */
export function toTreeView(tree: PlanTree, exercises: ReadonlyMap<string, ExerciseRef>, userId: string): PlanTreeViewData {
  return {
    blocks: tree.blocks.map((block) => ({
      id: block.id!,
      position: block.position,
      name: block.name,
      focus: block.focus,
      rationale: block.rationale,
      weeks: block.weeks.map((week) => ({
        id: week.id!,
        weekNumber: week.weekNumber,
        isDeload: week.isDeload,
        workouts: week.workouts.map((workout) => ({
          id: workout.id!,
          position: workout.position,
          weekday: workout.weekday,
          name: workout.name,
          estimatedMinutes: workout.estimatedMinutes,
          rationale: workout.rationale,
          exercises: workout.exercises.map((exercise) => {
            const ref = exercises.get(exercise.exerciseId);
            const usable =
              ref !== undefined && ref.status === 'active' && (ref.ownerUserId === null || ref.ownerUserId === userId);
            return {
              id: exercise.id!,
              exerciseId: exercise.exerciseId,
              exercise: usable ? { id: ref.id, name: ref.name, slug: ref.slug, trackingMode: ref.trackingMode } : null,
              exerciseUnavailable: !usable,
              position: exercise.position,
              isPriority: exercise.isPriority,
              targetSets: exercise.targetSets,
              repMin: exercise.repMin,
              repMax: exercise.repMax,
              targetLoadKg: exercise.targetLoadKg,
              targetRpe: exercise.targetRpe,
              restSeconds: exercise.restSeconds,
              loadGuidance: exercise.loadGuidance,
              rationale: exercise.rationale,
              evidenceRefs: exercise.evidenceRefs,
              notes: exercise.notes,
              equipmentTypeId: exercise.equipmentTypeId,
            };
          }),
        })),
      })),
    })),
  };
}

const asObjectArray = (value: Prisma.JsonValue): Record<string, unknown>[] =>
  Array.isArray(value) ? (value.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[]) : [];

const asObject = (value: Prisma.JsonValue): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

type ProgramDetailRow = ProgramHeaderRow & {
  notes: string | null;
  rationale: string | null;
  intake: Prisma.JsonValue | null;
  gym: { id: string; name: string } | null;
};

type VersionRow = {
  versionNumber: number;
  origin: string;
  rationale: string | null;
  evidence: Prisma.JsonValue;
  meta: Prisma.JsonValue;
  createdAt: Date;
};

export function toProgramView(program: ProgramDetailRow, version: VersionRow | null, tree: PlanTreeViewData): ProgramViewData {
  return {
    ...toHeader(program),
    notes: program.notes,
    rationale: program.rationale,
    intake: program.intake ?? null,
    gym: program.gym,
    version: {
      versionNumber: version?.versionNumber ?? program.currentVersion,
      origin: (version?.origin ?? 'initial') as VersionOrigin,
      rationale: version?.rationale ?? null,
      evidence: version ? asObjectArray(version.evidence) : [],
      meta: version ? asObject(version.meta) : {},
      createdAt: (version?.createdAt ?? program.createdAt).toISOString(),
    },
    tree,
  };
}

type VersionSummaryRow = { versionNumber: number; origin: string; createdAt: Date; runId: string | null };

export function toVersionSummary(
  version: VersionSummaryRow,
  log: { id: string; summary: string } | undefined,
): VersionSummaryData {
  return {
    versionNumber: version.versionNumber,
    origin: version.origin as VersionOrigin,
    createdAt: version.createdAt.toISOString(),
    runId: version.runId,
    changeLogId: log?.id ?? null,
    summary: log?.summary ?? null,
  };
}

export function toVersionView(
  version: VersionSummaryRow & { rationale: string | null; evidence: Prisma.JsonValue; meta: Prisma.JsonValue; snapshot: Prisma.JsonValue },
  log: { id: string; summary: string } | undefined,
): VersionViewData {
  return {
    ...toVersionSummary(version, log),
    rationale: version.rationale,
    evidence: asObjectArray(version.evidence),
    meta: asObject(version.meta),
    snapshot: asObject(version.snapshot),
  };
}

type ChangeLogRow = Prisma.ProgramChangeLogGetPayload<object>;

export function toChangeLogEntry(row: ChangeLogRow): ChangeLogEntryData {
  return {
    id: row.id,
    kind: row.kind as ChangeKind,
    actor: row.actor as ChangeActor,
    status: row.status as ChangeStatus,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    runId: row.runId,
    summary: row.summary,
    rationale: row.rationale,
    operations: asObjectArray(row.operations),
    citations: asObjectArray(row.citations),
    revertsLogId: row.revertsLogId,
    seenAt: row.seenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}
