import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import type { DraftItem, Prisma } from '@prisma/client';
import { z } from 'zod';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import { badExerciseRequest, normalizeExerciseName } from '../../exercises/exercise-views';
import { EXERCISE_REFUSALS, MAX_CUSTOM_EXERCISES_PER_USER } from '../../exercises/exercises.constants';
import { customSlug } from '../../gyms/equipment-types.service';
import type {
  IntakeApplyArgs,
  IntakeKind,
  IntakeKindPermissions,
  IntakeValueSource,
} from '../../intake/intake-kind.interface';
import { IntakeKindRegistry } from '../../intake/intake-kind.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { WORKOUT_PREFILL_JOB_TYPE } from '../prefill/workout-prefill.handler';
import { WORKOUT_PREFILL_SOURCE_HINTS } from '../prefill/workout-prefill.prompt';
import { workoutNotFound } from '../workout-mapper';
import { lockOwnedWorkout } from '../workout-lock';
import { MAX_EXERCISES_PER_WORKOUT, WORKOUT_STATUSES } from '../workouts.constants';
import {
  WORKOUT_PREFILL_ITEM_KIND,
  inferTrackingMode,
  workoutPrefillValueSchema,
  type WorkoutPrefillValue,
} from './workout-prefill.value';

// =============================================================================
// The `workout_prefill` intake kind (E4.5): "Prefill from photo"
// =============================================================================
//
// Context `{ workoutId, sourceHint? }`: the caller's workout, `in_progress` or
// `completed` (another user's, or a missing one, is a 404). `sourceHint`
// (`machine_placard`, `notebook`, `whiteboard`) is passed to the model as a
// hint, never as a fact; `PATCH /api/intakes/:id` changes it. The analyzer is
// `ai.workout.prefill`; each draft is one exercise with its written sets
// (`workout-prefill.value.ts`). The intake's subject is the workout, so
// `GET /intakes?kind=workout_prefill&subjectId=<workoutId>` finds an
// unfinished prefill.
//
// APPLY (inside the intake module's transaction; every write through `tx`):
//
//   1. the workout row is locked (`lockOwnedWorkout`, the lock every exercise
//      and set write takes); a workout deleted meanwhile is a 404 and the
//      intake stays unapplied for a retry;
//   2. every intake photo becomes a `WorkoutPhoto` of the workout (an object
//      already attached to a workout is skipped);
//   3. each accepted item, in review order, resolves its exercise: the slug's
//      library exercise (or the caller's custom one); else an active library
//      or custom exercise with the same name (case- and punctuation-
//      insensitive, aliases included); else a new custom exercise named
//      `value.name` (`full_body`, `isolation`, tracking mode from the sets),
//      created once per name per apply;
//   4. it is appended as a `WorkoutExercise` (dense positions) with its sets
//      as `SetLog`s numbered 1..n, ALL UNCOMPLETED: a photo of last week's
//      notebook is not today's work, so the user checks each set off as they
//      train. Past the 30-exercise cap the rest are skipped and counted.
//
// Result: `{ workoutId, exercisesAdded, setsAdded, skipped, photosAttached }`.
//
// PERMISSIONS. `requiredPermissions` adds `workouts:read` / `workouts:write`
// and `exercises:write` (apply may create a custom exercise) to the intake
// routes' `intakes:*` (a 403 `MISSING_KIND_PERMISSIONS` otherwise).
//
// Exercises are read with Prisma directly: `ExercisesModule` imports
// `WorkoutsModule`, so nothing here may import `ExercisesService`.
// =============================================================================

export const WORKOUT_PREFILL_INTAKE_KIND = 'workout_prefill';
export const WORKOUT_PREFILL_MAX_PHOTOS = 32;
export const WORKOUT_INTAKE_SUBJECT_TYPE = 'workout';

const contextSchema = z
  .object({
    workoutId: z.uuid(),
    sourceHint: z.enum(WORKOUT_PREFILL_SOURCE_HINTS).optional(),
  })
  .strict();
export type WorkoutPrefillIntakeContext = z.infer<typeof contextSchema>;

export interface WorkoutPrefillApplyResult {
  workoutId: string;
  exercisesAdded: number;
  setsAdded: number;
  /** Accepted items not added because the workout reached its 30-exercise cap. */
  skipped: number;
  photosAttached: number;
}

/** What a custom exercise created by apply gets besides its name and tracking mode. */
export const PREFILL_CUSTOM_EXERCISE_DEFAULTS = {
  primaryMuscles: ['full_body'],
  movementPattern: 'isolation',
} as const;

function invalidSlug(slug: string): BadRequestException {
  return new BadRequestException({
    message: 'Validation failed',
    details: { issues: [{ path: 'value.exerciseSlug', message: `Unknown exercise "${slug}"` }] },
  });
}

@Injectable()
export class WorkoutPrefillIntakeKind implements IntakeKind<WorkoutPrefillIntakeContext, WorkoutPrefillValue>, OnModuleInit {
  // PERMANENT once photo_intakes rows carry it.
  readonly kind = WORKOUT_PREFILL_INTAKE_KIND;
  readonly contextSchema = contextSchema;
  readonly valueSchema = workoutPrefillValueSchema;
  readonly analyzeJobType = WORKOUT_PREFILL_JOB_TYPE;
  readonly maxPhotos = WORKOUT_PREFILL_MAX_PHOTOS;
  readonly itemKinds = [WORKOUT_PREFILL_ITEM_KIND] as const;
  /**
   * `apply` writes the workout's exercises, sets and photos (the workout
   * routes' `workouts:*`) and may create a custom exercise (`exercises:write`);
   * an intake must not be a side door around them.
   */
  readonly requiredPermissions: IntakeKindPermissions = {
    read: [PERMISSIONS.WORKOUTS_READ],
    write: [PERMISSIONS.WORKOUTS_WRITE, PERMISSIONS.EXERCISES_WRITE],
  };

  constructor(
    private readonly registry: IntakeKindRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertContext(userId: string, context: WorkoutPrefillIntakeContext): Promise<void> {
    const workout = await this.prisma.workout.findFirst({
      where: { id: context.workoutId, userId },
      select: { status: true },
    });

    if (!workout || !(WORKOUT_STATUSES as readonly string[]).includes(workout.status)) {
      throw workoutNotFound();
    }
  }

  subjectOf(context: WorkoutPrefillIntakeContext): { subjectType: string; subjectId: string } {
    return { subjectType: WORKOUT_INTAKE_SUBJECT_TYPE, subjectId: context.workoutId };
  }

  /**
   * A slug takes its exercise's name. An unknown slug is a 400 for a user's
   * add or edit; for an analyzer item (a library row removed mid-scan) it
   * never throws: the item keeps its name with a `null` slug, so the review
   * still shows it and apply resolves it by name.
   */
  async normalizeValue(
    value: WorkoutPrefillValue,
    context: WorkoutPrefillIntakeContext,
    source: IntakeValueSource,
  ): Promise<WorkoutPrefillValue> {
    const slug = value.exerciseSlug;

    if (slug === null) {
      return value;
    }

    const owner = await this.prisma.workout.findUnique({ where: { id: context.workoutId }, select: { userId: true } });
    const exercise = await this.prisma.exercise.findFirst({
      where: {
        slug,
        status: 'active',
        OR: [{ ownerUserId: null }, ...(owner ? [{ ownerUserId: owner.userId }] : [])],
      },
      select: { name: true },
    });

    if (exercise) {
      return { ...value, name: exercise.name };
    }

    if (source === 'user') {
      throw invalidSlug(slug);
    }

    return { ...value, exerciseSlug: null };
  }

  async apply({ tx, userId, intake, context, accepted }: IntakeApplyArgs<WorkoutPrefillIntakeContext>): Promise<WorkoutPrefillApplyResult> {
    const workout = await lockOwnedWorkout(tx, userId, context.workoutId);
    const workoutId = workout.id;

    const photosAttached = await this.attachPhotos(tx, workoutId, intake.id);

    let position = await tx.workoutExercise.count({ where: { workoutId } });
    const exercises = new ExerciseResolver(tx, userId);
    let exercisesAdded = 0;
    let setsAdded = 0;
    let skipped = 0;

    for (const item of accepted) {
      const value = this.parseStored(item);

      if (position >= MAX_EXERCISES_PER_WORKOUT) {
        skipped += 1;
        continue;
      }

      const exerciseId = await exercises.resolve(value);
      const entry = await tx.workoutExercise.create({
        data: { workoutId, exerciseId, position },
        select: { id: true },
      });
      position += 1;
      exercisesAdded += 1;

      if (value.sets.length > 0) {
        await tx.setLog.createMany({
          data: value.sets.map((set, index) => ({
            workoutExerciseId: entry.id,
            setNumber: index + 1,
            weightKg: set.weightKg,
            reps: set.reps,
            durationSeconds: set.durationSeconds,
            distanceMeters: set.distanceMeters,
            completed: false,
            completedAt: null,
          })),
        });
        setsAdded += value.sets.length;
      }
    }

    return { workoutId, exercisesAdded, setsAdded, skipped, photosAttached };
  }

  // ---------------------------------------------------------------------------

  /** A stored value, re-read with the schema (it was validated when stored). */
  private parseStored(item: DraftItem): WorkoutPrefillValue {
    const parsed = workoutPrefillValueSchema.safeParse(item.value);

    if (!parsed.success) {
      throw new BadRequestException({
        message: 'An accepted item has an invalid value; edit it before applying',
        details: { itemId: item.id },
      });
    }

    return parsed.data;
  }

  /**
   * Every intake photo as a workout photo. `skipDuplicates` (ON CONFLICT DO
   * NOTHING on the unique storage object) skips an object already attached to
   * a workout and keeps a concurrent attach from aborting the transaction.
   */
  private async attachPhotos(tx: Prisma.TransactionClient, workoutId: string, intakeId: string): Promise<number> {
    const photos = await tx.photoIntakePhoto.findMany({
      where: { intakeId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { storageObjectId: true },
    });

    if (photos.length === 0) {
      return 0;
    }

    const result = await tx.workoutPhoto.createMany({
      data: photos.map((photo) => ({ workoutId, storageObjectId: photo.storageObjectId })),
      skipDuplicates: true,
    });

    return result.count;
  }
}

/**
 * Resolves item values to exercise ids inside one apply, creating at most one
 * custom exercise per (normalized) name.
 */
class ExerciseResolver {
  private candidates: Array<{ id: string; name: string; aliases: string[]; ownerUserId: string | null }> | null = null;
  private readonly bySlug = new Map<string, string | null>();
  private readonly created = new Map<string, string>();

  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly userId: string,
  ) {}

  async resolve(value: WorkoutPrefillValue): Promise<string> {
    if (value.exerciseSlug) {
      const bySlug = await this.slugId(value.exerciseSlug);
      if (bySlug) return bySlug;
    }

    return (await this.byName(value.name)) ?? this.createCustom(value);
  }

  private async slugId(slug: string): Promise<string | null> {
    if (!this.bySlug.has(slug)) {
      const row = await this.tx.exercise.findFirst({
        where: { slug, status: 'active', OR: [{ ownerUserId: null }, { ownerUserId: this.userId }] },
        select: { id: true },
      });
      this.bySlug.set(slug, row?.id ?? null);
    }

    return this.bySlug.get(slug) ?? null;
  }

  /** An active library exercise first, then the caller's own, whose name or alias normalizes the same. */
  private async byName(name: string): Promise<string | null> {
    const target = normalizeExerciseName(name);
    if (target === '') return null;

    const created = this.created.get(target);
    if (created) return created;

    this.candidates ??= await this.tx.exercise.findMany({
      where: { status: 'active', OR: [{ ownerUserId: null }, { ownerUserId: this.userId }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, aliases: true, ownerUserId: true },
    });

    const matches = this.candidates.filter(
      (row) =>
        normalizeExerciseName(row.name) === target ||
        row.aliases.some((alias) => normalizeExerciseName(alias) === target),
    );

    return (matches.find((row) => row.ownerUserId === null) ?? matches[0])?.id ?? null;
  }

  private async createCustom(value: WorkoutPrefillValue): Promise<string> {
    const owned = await this.tx.exercise.count({ where: { ownerUserId: this.userId } });

    if (owned >= MAX_CUSTOM_EXERCISES_PER_USER) {
      throw badExerciseRequest(
        EXERCISE_REFUSALS.EXERCISE_LIMIT,
        `You can have at most ${MAX_CUSTOM_EXERCISES_PER_USER} custom exercises`,
        { max: MAX_CUSTOM_EXERCISES_PER_USER },
      );
    }

    const name = value.name.trim();
    const row = await this.tx.exercise.create({
      data: {
        slug: customSlug(),
        name,
        ownerUserId: this.userId,
        primaryMuscles: [...PREFILL_CUSTOM_EXERCISE_DEFAULTS.primaryMuscles],
        movementPattern: PREFILL_CUSTOM_EXERCISE_DEFAULTS.movementPattern,
        trackingMode: inferTrackingMode(value.sets),
        origin: 'user',
        status: 'active',
      },
      select: { id: true },
    });

    this.created.set(normalizeExerciseName(name), row.id);

    return row.id;
  }
}
