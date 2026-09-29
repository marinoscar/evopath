import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { ExerciseOrigin, ExerciseStatus, ExerciseTrackingMode } from '../common/constants/training.constants';
import type { ExerciseRequirementGroupData, ExerciseRequirementOptionData, ExerciseViewData } from './dto/exercise.dto';
import { EXERCISE_REFUSALS } from './exercises.constants';
import { groupRequirements, type Availability, type NamedRequirementRow } from './exercise-availability.service';

// =============================================================================
// Exercises (E4.1) — Prisma include, row-to-view mapper and error helpers
// =============================================================================

export const EXERCISE_INCLUDE = {
  requirements: {
    include: {
      equipmentType: { select: { id: true, slug: true, name: true } },
      capability: { select: { id: true, slug: true, name: true } },
    },
    orderBy: [{ groupIndex: 'asc' as const }],
  },
} satisfies Prisma.ExerciseInclude;

export type ExerciseWithRequirements = Prisma.ExerciseGetPayload<{ include: typeof EXERCISE_INCLUDE }>;
type RequirementWithTargets = ExerciseWithRequirements['requirements'][number];

function toOption(row: RequirementWithTargets): ExerciseRequirementOptionData {
  if (row.equipmentType) {
    return { kind: 'equipment', ...row.equipmentType };
  }
  // The CHECK constraint guarantees exactly one target is set.
  const capability = row.capability!;
  return { kind: 'capability', ...capability };
}

/** Requirement rows with the display name `evaluateAvailability` reports as `missing`. */
export function namedRequirements(exercise: ExerciseWithRequirements): NamedRequirementRow[] {
  return exercise.requirements.map((row) => ({
    groupIndex: row.groupIndex,
    equipmentTypeId: row.equipmentTypeId,
    capabilityId: row.capabilityId,
    name: toOption(row).name,
  }));
}

function requirementGroups(exercise: ExerciseWithRequirements): ExerciseRequirementGroupData[] {
  return groupRequirements(exercise.requirements).map((rows) => ({
    groupIndex: rows[0].groupIndex,
    options: rows
      .map(toOption)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  }));
}

export function toExerciseView(exercise: ExerciseWithRequirements, availability?: Availability): ExerciseViewData {
  return {
    id: exercise.id,
    slug: exercise.slug,
    name: exercise.name,
    isCustom: exercise.ownerUserId !== null,
    origin: exercise.origin as ExerciseOrigin,
    status: exercise.status as ExerciseStatus,
    proposedByRunId: exercise.proposedByRunId,
    primaryMuscles: exercise.primaryMuscles,
    secondaryMuscles: exercise.secondaryMuscles,
    movementPattern: exercise.movementPattern,
    trackingMode: exercise.trackingMode as ExerciseTrackingMode,
    isUnilateral: exercise.isUnilateral,
    isBodyweight: exercise.isBodyweight,
    aliases: exercise.aliases,
    notes: exercise.notes,
    requirements: requirementGroups(exercise),
    ...(availability ? { available: availability.available, missing: availability.missing } : {}),
    createdAt: exercise.createdAt.toISOString(),
    updatedAt: exercise.updatedAt.toISOString(),
  };
}

/**
 * A name reduced for duplicate detection: Unicode-folded, lower case, every
 * run of non-alphanumerics a single space. "Farmer's Carry" and "farmers
 * carry" match; "Pull-up" and "pull up" match.
 */
export function normalizeExerciseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('en')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whether an exercise's name or one of its aliases contains `q`, ignoring case. */
export function matchesExerciseQuery(exercise: { name: string; aliases: readonly string[] }, q: string): boolean {
  const needle = q.toLocaleLowerCase();
  return (
    exercise.name.toLocaleLowerCase().includes(needle) ||
    exercise.aliases.some((alias) => alias.toLocaleLowerCase().includes(needle))
  );
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export function exerciseNotFound(): NotFoundException {
  return new NotFoundException('Exercise not found');
}

export function libraryReadOnly(): ForbiddenException {
  return new ForbiddenException({
    message: 'Library exercises are read-only; create a custom exercise instead',
    details: { reason: EXERCISE_REFUSALS.LIBRARY_EXERCISE_READ_ONLY },
  });
}

export function exerciseInUse(uses?: number): ConflictException {
  return new ConflictException({
    message:
      'This exercise is used by logged workouts; keep it, or delete those workouts first',
    details: { reason: EXERCISE_REFUSALS.EXERCISE_IN_USE, ...(uses !== undefined ? { uses } : {}) },
  });
}

export function badExerciseRequest(reason: string, message: string, extra: Record<string, unknown> = {}): BadRequestException {
  return new BadRequestException({ message, details: { reason, ...extra } });
}
