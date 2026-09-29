import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  EXERCISE_ORIGINS,
  EXERCISE_STATUSES,
  EXERCISE_TRACKING_MODES,
  MOVEMENT_PATTERNS,
  MUSCLES,
} from '../../common/constants/training.constants';
import { optionalText, queryBoolean, requiredName } from '../../gyms/dto/fields';
import {
  EXERCISE_LIST_LIMIT_DEFAULT,
  EXERCISE_LIST_LIMIT_MAX,
  EXERCISE_NAME_MAX,
  EXERCISE_NOTES_MAX,
  EXERCISE_PRIMARY_MUSCLES_MAX,
  EXERCISE_PRIMARY_MUSCLES_MIN,
  EXERCISE_QUERY_MAX,
  EXERCISE_REQUIREMENT_GROUPS_MAX,
  EXERCISE_REQUIREMENT_OPTIONS_MAX,
  EXERCISE_SECONDARY_MUSCLES_MAX,
} from '../exercises.constants';

// =============================================================================
// /api/exercises — schemas (E4.1)
// =============================================================================

const distinct = (values: readonly string[]) => new Set(values).size === values.length;

// -----------------------------------------------------------------------------
// GET /api/exercises
// -----------------------------------------------------------------------------

export const listExercisesQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(EXERCISE_QUERY_MAX)
      .optional()
      .meta({ description: 'Case-insensitive substring of the name or of any alias.' }),
    muscle: z.enum(MUSCLES).optional().meta({ description: 'Exercises that train this muscle (primary or secondary).' }),
    pattern: z.enum(MOVEMENT_PATTERNS).optional(),
    tracking: z.enum(EXERCISE_TRACKING_MODES).optional(),
    custom: queryBoolean
      .optional()
      .meta({ description: '`true`: only the caller\'s custom exercises; `false`: only the library.' }),
    includePending: queryBoolean
      .default(false)
      .meta({ description: '`true` also lists the caller\'s AI-proposed exercises awaiting approval. Default `false`.' }),
    gymId: z.uuid().optional().meta({ description: 'One of the caller\'s gyms; adds `available` and `missing` to each item.' }),
    availableOnly: queryBoolean
      .default(false)
      .meta({ description: '`true` keeps only exercises the gym supports. Requires `gymId`.' }),
    limit: z.coerce.number().int().min(1).max(EXERCISE_LIST_LIMIT_MAX).default(EXERCISE_LIST_LIMIT_DEFAULT),
  })
  .superRefine((query, ctx) => {
    if (query.availableOnly && !query.gymId) {
      ctx.addIssue({ code: 'custom', path: ['gymId'], message: 'availableOnly requires gymId' });
    }
  });

export class ListExercisesQueryDto extends createZodDto(listExercisesQuerySchema) {}
export type ListExercisesQuery = z.output<typeof listExercisesQuerySchema>;

// -----------------------------------------------------------------------------
// POST / PATCH /api/exercises
// -----------------------------------------------------------------------------

/**
 * One requirement group: satisfied by ANY listed equipment type OR any gym
 * equipment providing ANY listed capability. 1..6 options in total.
 */
export const exerciseRequirementGroupInputSchema = z
  .object({
    equipmentTypeIds: z
      .array(z.uuid())
      .max(EXERCISE_REQUIREMENT_OPTIONS_MAX)
      .default([])
      .meta({ description: 'Catalog equipment types or the caller\'s custom types.' }),
    capabilityIds: z.array(z.uuid()).max(EXERCISE_REQUIREMENT_OPTIONS_MAX).default([]),
  })
  .strict()
  .superRefine((group, ctx) => {
    const total = group.equipmentTypeIds.length + group.capabilityIds.length;
    if (total < 1 || total > EXERCISE_REQUIREMENT_OPTIONS_MAX) {
      ctx.addIssue({
        code: 'custom',
        message: `A requirement group needs 1 to ${EXERCISE_REQUIREMENT_OPTIONS_MAX} options`,
      });
    }
    if (!distinct(group.equipmentTypeIds) || !distinct(group.capabilityIds)) {
      ctx.addIssue({ code: 'custom', message: 'Ids in a requirement group must be distinct' });
    }
  });

export type ExerciseRequirementGroupInput = z.output<typeof exerciseRequirementGroupInputSchema>;

const requirementGroups = z
  .array(exerciseRequirementGroupInputSchema)
  .max(EXERCISE_REQUIREMENT_GROUPS_MAX, { message: `At most ${EXERCISE_REQUIREMENT_GROUPS_MAX} requirement groups` })
  .meta({
    description:
      `Up to ${EXERCISE_REQUIREMENT_GROUPS_MAX} groups, all of which a gym must satisfy (AND); ` +
      'inside a group any option satisfies it (OR). Empty or omitted: needs no equipment.',
  });

const primaryMuscles = z
  .array(z.enum(MUSCLES))
  .min(EXERCISE_PRIMARY_MUSCLES_MIN, { message: `At least ${EXERCISE_PRIMARY_MUSCLES_MIN} primary muscle` })
  .max(EXERCISE_PRIMARY_MUSCLES_MAX, { message: `At most ${EXERCISE_PRIMARY_MUSCLES_MAX} primary muscles` })
  .refine(distinct, { message: 'Muscles must be distinct' });

const secondaryMuscles = z
  .array(z.enum(MUSCLES))
  .max(EXERCISE_SECONDARY_MUSCLES_MAX, { message: `At most ${EXERCISE_SECONDARY_MUSCLES_MAX} secondary muscles` })
  .refine(distinct, { message: 'Muscles must be distinct' });

function noMuscleOverlap(
  body: { primaryMuscles?: readonly string[]; secondaryMuscles?: readonly string[] },
  ctx: z.RefinementCtx,
): void {
  if (!body.primaryMuscles || !body.secondaryMuscles) return;
  const primary = new Set(body.primaryMuscles);
  if (body.secondaryMuscles.some((muscle) => primary.has(muscle))) {
    ctx.addIssue({ code: 'custom', path: ['secondaryMuscles'], message: 'A muscle cannot be both primary and secondary' });
  }
}

/**
 * The shape of a custom exercise. Also the shape an AI proposal (E5.5) must
 * satisfy before `ExercisesService.proposeFromAi` stores it.
 */
export const createExerciseSchema = z
  .object({
    name: requiredName(EXERCISE_NAME_MAX),
    primaryMuscles,
    secondaryMuscles: secondaryMuscles.default([]),
    movementPattern: z.enum(MOVEMENT_PATTERNS),
    trackingMode: z.enum(EXERCISE_TRACKING_MODES).default('weight_reps'),
    isUnilateral: z.boolean().default(false),
    isBodyweight: z.boolean().default(false),
    notes: optionalText(EXERCISE_NOTES_MAX),
    requirements: requirementGroups.default([]),
  })
  .strict()
  .superRefine(noMuscleOverlap);

export class CreateExerciseDto extends createZodDto(createExerciseSchema) {}
export type CreateExerciseInput = z.output<typeof createExerciseSchema>;

export const updateExerciseSchema = z
  .object({
    name: requiredName(EXERCISE_NAME_MAX).optional(),
    primaryMuscles: primaryMuscles.optional(),
    secondaryMuscles: secondaryMuscles.optional(),
    movementPattern: z.enum(MOVEMENT_PATTERNS).optional(),
    trackingMode: z.enum(EXERCISE_TRACKING_MODES).optional(),
    isUnilateral: z.boolean().optional(),
    isBodyweight: z.boolean().optional(),
    notes: optionalText(EXERCISE_NOTES_MAX),
    requirements: requirementGroups.optional().meta({ description: 'Replaces every group when given.' }),
  })
  .strict()
  .superRefine(noMuscleOverlap)
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one field is required',
  });

export class UpdateExerciseDto extends createZodDto(updateExerciseSchema) {}
export type UpdateExerciseInput = z.output<typeof updateExerciseSchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const exerciseRequirementOptionSchema = z.object({
  kind: z.enum(['equipment', 'capability']),
  id: z.uuid().meta({ description: 'The equipment type id or the capability id.' }),
  slug: z.string(),
  name: z.string(),
});

export const exerciseRequirementGroupSchema = z.object({
  groupIndex: z.number().int(),
  options: z.array(exerciseRequirementOptionSchema).meta({ description: 'Any one of these satisfies the group.' }),
});

export class ExerciseRequirementGroupView extends createZodDto(exerciseRequirementGroupSchema) {}
export type ExerciseRequirementGroupData = z.infer<typeof exerciseRequirementGroupSchema>;
export type ExerciseRequirementOptionData = z.infer<typeof exerciseRequirementOptionSchema>;

export const exerciseViewSchema = z.object({
  id: z.uuid(),
  slug: z.string().meta({ description: 'Permanent; `custom-<8 chars>` for a custom exercise.' }),
  name: z.string(),
  isCustom: z.boolean().meta({ description: 'True for the caller\'s own exercise; false for the library.' }),
  origin: z.enum(EXERCISE_ORIGINS),
  status: z.enum(EXERCISE_STATUSES).meta({ description: '`pending_review`: an AI proposal awaiting the caller\'s approval.' }),
  proposedByRunId: z.uuid().nullable().meta({ description: 'The AI run that proposed it; null otherwise.' }),
  primaryMuscles: z.array(z.string()),
  secondaryMuscles: z.array(z.string()),
  movementPattern: z.string(),
  trackingMode: z.enum(EXERCISE_TRACKING_MODES),
  isUnilateral: z.boolean(),
  isBodyweight: z.boolean(),
  aliases: z.array(z.string()),
  notes: z.string().nullable(),
  requirements: z
    .array(exerciseRequirementGroupSchema)
    .meta({ description: 'Groups by `groupIndex`; every group must be satisfied. Empty: needs no equipment.' }),
  available: z
    .boolean()
    .optional()
    .meta({ description: 'Only with `gymId`: whether that gym satisfies every requirement group.' }),
  missing: z
    .array(z.string())
    .optional()
    .meta({ description: 'Only with `gymId`: the names of the first unsatisfied group\'s options (empty when available).' }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class ExerciseView extends createZodDto(exerciseViewSchema) {}
export type ExerciseViewData = z.infer<typeof exerciseViewSchema>;
