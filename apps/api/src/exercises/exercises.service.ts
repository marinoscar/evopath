import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import type { ExerciseOrigin, ExerciseStatus } from '../common/constants/training.constants';
import { customSlug } from '../gyms/equipment-types.service';
import { isForeignKeyViolation, isUniqueViolation } from '../gyms/gym-views';
import { PrismaService } from '../prisma/prisma.service';
import {
  createExerciseSchema,
  type CreateExerciseInput,
  type ExerciseRequirementGroupInput,
  type ExerciseViewData,
  type ListExercisesQuery,
  type UpdateExerciseInput,
} from './dto/exercise.dto';
import { ExerciseAvailabilityService, evaluateAvailability } from './exercise-availability.service';
import { ExerciseUsageRepository } from './exercise-usage.repository';
import {
  EXERCISE_INCLUDE,
  type ExerciseWithRequirements,
  badExerciseRequest,
  exerciseInUse,
  exerciseNotFound,
  libraryReadOnly,
  matchesExerciseQuery,
  namedRequirements,
  normalizeExerciseName,
  toExerciseView,
} from './exercise-views';
import { EXERCISE_REFUSALS, MAX_CUSTOM_EXERCISES_PER_USER } from './exercises.constants';

// =============================================================================
// ExercisesService — the exercise library and custom exercises (E4.1)
// =============================================================================
//
// A caller sees the seeded library (`owner_user_id` null) plus their own custom
// exercises; another user's exercise answers 404 everywhere. Library exercises
// are read-only (403 `LIBRARY_EXERCISE_READ_ONLY` on a write).
//
// PENDING REVIEW. An AI proposal (`origin: ai`, `status: pending_review`) is a
// draft: it is left out of the list (the picker) unless `includePending=true`,
// and ALWAYS left out of `availableOnly`, until the owner approves it
// (`approve`) or deletes it. `GET /:id` returns it regardless.
//
// SEARCH. `q` matches as a substring of the name or any alias. The visible set
// is small and bounded (the library plus at most 200 custom exercises), so the
// text match and the availability evaluation run in memory.
// =============================================================================

/** What `proposeFromAi` answers: the stored draft, or the existing match it was mapped to. */
export interface ExerciseProposalResult {
  exercise: ExerciseViewData;
  /** False when the proposal matched an existing exercise and nothing was stored. */
  created: boolean;
}

interface NewExerciseMeta {
  origin: ExerciseOrigin;
  status: ExerciseStatus;
  proposedByRunId: string | null;
}

const proposedByRunIdSchema = z.uuid().nullable();

@Injectable()
export class ExercisesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: ExerciseAvailabilityService,
    private readonly usage: ExerciseUsageRepository,
  ) {}

  async list(userId: string, query: ListExercisesQuery): Promise<ExerciseViewData[]> {
    // Owner-check the gym first: a foreign gym is a 404 whatever else matches.
    const inventory = query.gymId ? await this.availability.forGym(userId, query.gymId) : null;

    const showPending = query.includePending && !query.availableOnly;
    const where: Prisma.ExerciseWhereInput = {
      AND: [
        query.custom === true
          ? { ownerUserId: userId }
          : query.custom === false
            ? { ownerUserId: null }
            : { OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
        showPending ? {} : { status: 'active' },
        query.muscle
          ? { OR: [{ primaryMuscles: { has: query.muscle } }, { secondaryMuscles: { has: query.muscle } }] }
          : {},
        query.pattern ? { movementPattern: query.pattern } : {},
        query.tracking ? { trackingMode: query.tracking } : {},
      ],
    };

    const rows = await this.prisma.exercise.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: EXERCISE_INCLUDE,
    });

    const q = query.q;
    const matching = q ? rows.filter((row) => matchesExerciseQuery(row, q)) : rows;

    if (!inventory) {
      return matching.slice(0, query.limit).map((row) => toExerciseView(row));
    }

    const views: ExerciseViewData[] = [];
    for (const row of matching) {
      const availability = evaluateAvailability(namedRequirements(row), inventory);
      if (query.availableOnly && !availability.available) continue;
      views.push(toExerciseView(row, availability));
      if (views.length >= query.limit) break;
    }
    return views;
  }

  async get(userId: string, exerciseId: string): Promise<ExerciseViewData> {
    return toExerciseView(await this.findVisible(userId, exerciseId));
  }

  async create(userId: string, input: CreateExerciseInput): Promise<ExerciseViewData> {
    return this.insertCustom(userId, input, { origin: 'user', status: 'active', proposedByRunId: null });
  }

  async update(userId: string, exerciseId: string, input: UpdateExerciseInput): Promise<ExerciseViewData> {
    await this.findEditable(userId, exerciseId);

    if (input.requirements) {
      await this.assertRequirementTargets(userId, input.requirements);
    }

    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.ExerciseUpdateManyMutationInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.primaryMuscles !== undefined) data.primaryMuscles = input.primaryMuscles;
      if (input.secondaryMuscles !== undefined) data.secondaryMuscles = input.secondaryMuscles;
      if (input.movementPattern !== undefined) data.movementPattern = input.movementPattern;
      if (input.trackingMode !== undefined) data.trackingMode = input.trackingMode;
      if (input.isUnilateral !== undefined) data.isUnilateral = input.isUnilateral;
      if (input.isBodyweight !== undefined) data.isBodyweight = input.isBodyweight;
      if (input.notes !== undefined) data.notes = input.notes;

      const { count } = await tx.exercise.updateMany({ where: { id: exerciseId, ownerUserId: userId }, data });

      if (count === 0) {
        throw exerciseNotFound();
      }

      if (input.requirements) {
        await tx.exerciseRequirement.deleteMany({ where: { exerciseId } });
        const rows = requirementRows(input.requirements).map((row) => ({ ...row, exerciseId }));
        if (rows.length > 0) {
          await tx.exerciseRequirement.createMany({ data: rows });
        }
      }
    });

    return toExerciseView(await this.findVisible(userId, exerciseId));
  }

  /** 409 `EXERCISE_IN_USE` while any logged workout references it. */
  async remove(userId: string, exerciseId: string): Promise<void> {
    await this.findEditable(userId, exerciseId);

    const uses = await this.usage.countWorkoutReferences(exerciseId);
    if (uses > 0) {
      throw exerciseInUse(uses);
    }

    try {
      const { count } = await this.prisma.exercise.deleteMany({ where: { id: exerciseId, ownerUserId: userId } });

      if (count === 0) {
        throw exerciseNotFound();
      }
    } catch (error) {
      // A workout referencing it was logged concurrently: the foreign key refuses.
      if (isForeignKeyViolation(error)) {
        throw exerciseInUse();
      }
      throw error;
    }
  }

  /** Makes the caller's pending AI proposal active. Idempotent on an active exercise. */
  async approve(userId: string, exerciseId: string): Promise<ExerciseViewData> {
    const exercise = await this.findEditable(userId, exerciseId);

    if (exercise.status === 'active') {
      return toExerciseView(exercise);
    }

    const { count } = await this.prisma.exercise.updateMany({
      where: { id: exerciseId, ownerUserId: userId },
      data: { status: 'active' },
    });

    if (count === 0) {
      throw exerciseNotFound();
    }

    return toExerciseView(await this.findVisible(userId, exerciseId));
  }

  /**
   * Stores an AI-proposed exercise as the caller's draft (`origin: ai`,
   * `status: pending_review`), for the agentic planner (E5.5). No route calls
   * this.
   *
   * `proposal` is validated with `createExerciseSchema`, the same schema as a
   * custom exercise (a `ZodError` is thrown when it does not fit).
   *
   * DUPLICATE GUARD. When the proposal's normalized name matches the
   * normalized name or an alias of an exercise the caller already sees (an
   * active library or custom exercise first, then one of their own pending
   * drafts), that exercise is returned with `created: false` and nothing is
   * stored.
   */
  async proposeFromAi(userId: string, proposal: unknown, runId: string | null): Promise<ExerciseProposalResult> {
    const input = createExerciseSchema.parse(proposal);
    const proposedByRunId = proposedByRunIdSchema.parse(runId);

    const existing = await this.findByNormalizedName(userId, input.name);
    if (existing) {
      return { exercise: toExerciseView(existing), created: false };
    }

    const exercise = await this.insertCustom(userId, input, { origin: 'ai', status: 'pending_review', proposedByRunId });
    return { exercise, created: true };
  }

  /**
   * The exercise the caller sees whose name or alias normalizes to the same
   * string as `name`: active ones before the caller's pending drafts, then by
   * name. `null` when there is none.
   */
  async findByNormalizedName(userId: string, name: string): Promise<ExerciseWithRequirements | null> {
    const target = normalizeExerciseName(name);
    if (target === '') return null;

    const candidates = await this.prisma.exercise.findMany({
      where: { OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
      select: { id: true, name: true, aliases: true, status: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });

    const matches = candidates.filter(
      (row) =>
        normalizeExerciseName(row.name) === target ||
        row.aliases.some((alias) => normalizeExerciseName(alias) === target),
    );
    const match = matches.find((row) => row.status === 'active') ?? matches[0];

    return match ? this.findVisible(userId, match.id) : null;
  }

  // ---------------------------------------------------------------------------

  private async insertCustom(userId: string, input: CreateExerciseInput, meta: NewExerciseMeta): Promise<ExerciseViewData> {
    const owned = await this.prisma.exercise.count({ where: { ownerUserId: userId } });

    if (owned >= MAX_CUSTOM_EXERCISES_PER_USER) {
      throw badExerciseRequest(
        EXERCISE_REFUSALS.EXERCISE_LIMIT,
        `You can have at most ${MAX_CUSTOM_EXERCISES_PER_USER} custom exercises`,
        { max: MAX_CUSTOM_EXERCISES_PER_USER },
      );
    }

    await this.assertRequirementTargets(userId, input.requirements);

    const create = () =>
      this.prisma.exercise.create({
        data: {
          slug: customSlug(),
          name: input.name,
          ownerUserId: userId,
          primaryMuscles: input.primaryMuscles,
          secondaryMuscles: input.secondaryMuscles,
          movementPattern: input.movementPattern,
          trackingMode: input.trackingMode,
          isUnilateral: input.isUnilateral,
          isBodyweight: input.isBodyweight,
          notes: input.notes ?? null,
          origin: meta.origin,
          status: meta.status,
          proposedByRunId: meta.proposedByRunId,
          requirements: { create: requirementRows(input.requirements) },
        },
        include: EXERCISE_INCLUDE,
      });

    try {
      return toExerciseView(await create());
    } catch (error) {
      // A slug collision (36^8 space) gets one fresh slug.
      if (isUniqueViolation(error)) {
        return toExerciseView(await create());
      }
      throw error;
    }
  }

  /** The library exercise or the caller's own, or a 404. */
  private async findVisible(userId: string, exerciseId: string): Promise<ExerciseWithRequirements> {
    const exercise = await this.prisma.exercise.findFirst({
      where: { id: exerciseId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
      include: EXERCISE_INCLUDE,
    });

    if (!exercise) {
      throw exerciseNotFound();
    }

    return exercise;
  }

  /** The caller's own exercise; a library exercise is 403, anything else 404. */
  private async findEditable(userId: string, exerciseId: string): Promise<ExerciseWithRequirements> {
    const exercise = await this.findVisible(userId, exerciseId);

    if (exercise.ownerUserId === null) {
      throw libraryReadOnly();
    }

    return exercise;
  }

  /**
   * Every equipment type must be a catalog type or the caller's custom type,
   * and every capability must exist; otherwise 400 with the unknown ids.
   */
  private async assertRequirementTargets(
    userId: string,
    groups: readonly ExerciseRequirementGroupInput[],
  ): Promise<void> {
    const equipmentTypeIds = [...new Set(groups.flatMap((group) => group.equipmentTypeIds))];
    const capabilityIds = [...new Set(groups.flatMap((group) => group.capabilityIds))];

    if (equipmentTypeIds.length > 0) {
      const found = await this.prisma.equipmentType.findMany({
        where: { id: { in: equipmentTypeIds }, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
        select: { id: true },
      });
      if (found.length !== equipmentTypeIds.length) {
        const known = new Set(found.map((row) => row.id));
        throw badExerciseRequest(EXERCISE_REFUSALS.UNKNOWN_EQUIPMENT_TYPE, 'Unknown equipment type id', {
          equipmentTypeIds: equipmentTypeIds.filter((id) => !known.has(id)),
        });
      }
    }

    if (capabilityIds.length > 0) {
      const found = await this.prisma.capability.findMany({
        where: { id: { in: capabilityIds } },
        select: { id: true },
      });
      if (found.length !== capabilityIds.length) {
        const known = new Set(found.map((row) => row.id));
        throw badExerciseRequest(EXERCISE_REFUSALS.UNKNOWN_CAPABILITY, 'Unknown capability id', {
          capabilityIds: capabilityIds.filter((id) => !known.has(id)),
        });
      }
    }
  }
}

/** Requirement groups as rows: `groupIndex` is the group's position in the input. */
function requirementRows(groups: readonly ExerciseRequirementGroupInput[]) {
  return groups.flatMap((group, groupIndex) => [
    ...group.equipmentTypeIds.map((equipmentTypeId) => ({ groupIndex, equipmentTypeId, capabilityId: null })),
    ...group.capabilityIds.map((capabilityId) => ({ groupIndex, equipmentTypeId: null, capabilityId })),
  ]);
}
