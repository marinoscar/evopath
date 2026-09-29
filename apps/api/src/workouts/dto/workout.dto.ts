import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { isRealDate } from '../../check-ins/local-date';
import { EXERCISE_STATUSES, EXERCISE_TRACKING_MODES } from '../../common/constants/training.constants';
import { optionalText, requiredName } from '../../gyms/dto/fields';
import { PR_TYPES } from '../workout-records';
import {
  MAX_EXERCISES_PER_WORKOUT,
  SET_BOUNDS,
  SET_NOTES_MAX,
  SET_PAIN_NOTE_MAX,
  WORKOUT_DURATION_MAX_SECONDS,
  WORKOUT_LIST_PAGE_SIZE_DEFAULT,
  WORKOUT_LIST_PAGE_SIZE_MAX,
  WORKOUT_NAME_MAX,
  WORKOUT_NOTES_MAX,
  WORKOUT_STATUSES,
} from '../workouts.constants';

// =============================================================================
// /api/workouts — schemas (E4.2)
// =============================================================================
//
// Weights are kilograms (`weightKg`) and distances metres (`distanceMeters`),
// always. Decimals leave the API as JSON numbers.
// =============================================================================

const localDate = z.iso
  .date()
  .refine(isRealDate, { message: 'Must be a real calendar date in YYYY-MM-DD format' })
  .meta({ description: 'A local calendar day, `YYYY-MM-DD`.' });

const instant = z.iso.datetime({ offset: true }).meta({ description: 'An ISO 8601 instant.' });

/** A number in [min, max] with at most `decimals` fractional digits. */
function boundedDecimal(min: number, max: number, decimals: number) {
  const factor = 10 ** decimals;
  return z
    .number()
    .min(min)
    .max(max)
    .refine((value) => Math.abs(value * factor - Math.round(value * factor)) < 1e-6, {
      message: `At most ${decimals} decimal places`,
    });
}

function boundedInt(min: number, max: number) {
  return z.number().int().min(min).max(max);
}

const weightKg = boundedDecimal(SET_BOUNDS.weightKg.min, SET_BOUNDS.weightKg.max, SET_BOUNDS.weightKg.decimals).meta({
  description: 'Kilograms, 0..1000, at most 3 decimals.',
});
const reps = boundedInt(SET_BOUNDS.reps.min, SET_BOUNDS.reps.max);
const setDurationSeconds = boundedInt(SET_BOUNDS.durationSeconds.min, SET_BOUNDS.durationSeconds.max);
const distanceMeters = boundedDecimal(
  SET_BOUNDS.distanceMeters.min,
  SET_BOUNDS.distanceMeters.max,
  SET_BOUNDS.distanceMeters.decimals,
).meta({ description: 'Metres, 0..1,000,000, at most 2 decimals.' });
const rpe = z
  .number()
  .min(SET_BOUNDS.rpe.min)
  .max(SET_BOUNDS.rpe.max)
  .refine((value) => Number.isInteger(value / SET_BOUNDS.rpe.step), { message: 'RPE moves in steps of 0.5' })
  .meta({ description: 'Rate of perceived exertion, 1..10 in steps of 0.5.' });
const rir = boundedInt(SET_BOUNDS.rir.min, SET_BOUNDS.rir.max).meta({ description: 'Reps in reserve, 0..10.' });
const restSeconds = boundedInt(SET_BOUNDS.restSeconds.min, SET_BOUNDS.restSeconds.max);

const atLeastOneField = (body: Record<string, unknown>) => Object.values(body).some((value) => value !== undefined);

// -----------------------------------------------------------------------------
// POST /api/workouts
// -----------------------------------------------------------------------------

export const startWorkoutSchema = z
  .object({
    name: requiredName(WORKOUT_NAME_MAX)
      .optional()
      .meta({ description: 'Default: the weekday of `date` plus "workout", e.g. "Tuesday workout".' }),
    date: localDate
      .optional()
      .meta({
        description:
          'The user\'s local day. Default: today in the Health Profile time zone (UTC when unset). ' +
          'Must be within 2 days of that server date.',
      }),
    gymId: z.uuid().optional().meta({ description: 'One of the caller\'s gyms. Default: the caller\'s default gym, if any.' }),
    startedAt: instant.optional().meta({ description: 'Default: now. At most 5 minutes in the future.' }),
  })
  .strict();

export class StartWorkoutDto extends createZodDto(startWorkoutSchema) {}
export type StartWorkoutInput = z.output<typeof startWorkoutSchema>;

// -----------------------------------------------------------------------------
// GET /api/workouts
// -----------------------------------------------------------------------------

export const listWorkoutsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(WORKOUT_LIST_PAGE_SIZE_MAX).default(WORKOUT_LIST_PAGE_SIZE_DEFAULT),
    status: z.enum(WORKOUT_STATUSES).optional(),
    gymId: z.uuid().optional(),
    from: localDate.optional().meta({ description: 'Earliest `date`, inclusive.' }),
    to: localDate.optional().meta({ description: 'Latest `date`, inclusive.' }),
    exerciseId: z.uuid().optional().meta({ description: 'Only workouts that include this exercise.' }),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ['from'],
    message: 'from must not be after to',
  });

export class ListWorkoutsQueryDto extends createZodDto(listWorkoutsQuerySchema) {}
export type ListWorkoutsQuery = z.output<typeof listWorkoutsQuerySchema>;

// -----------------------------------------------------------------------------
// PATCH /api/workouts/:id
// -----------------------------------------------------------------------------

export const updateWorkoutSchema = z
  .object({
    name: requiredName(WORKOUT_NAME_MAX).optional(),
    notes: optionalText(WORKOUT_NOTES_MAX),
    gymId: z.uuid().nullable().optional().meta({ description: 'One of the caller\'s gyms; null clears it.' }),
    date: localDate.optional().meta({ description: 'At most 2 days after the server\'s today.' }),
    startedAt: instant.optional(),
    endedAt: instant.optional().meta({ description: 'Completed workouts only.' }),
    durationSeconds: boundedInt(0, WORKOUT_DURATION_MAX_SECONDS)
      .optional()
      .meta({
        description:
          'Completed workouts only. When omitted and `startedAt` or `endedAt` changes, it is recomputed.',
      }),
  })
  .strict()
  .refine(atLeastOneField, { message: 'At least one field is required' });

export class UpdateWorkoutDto extends createZodDto(updateWorkoutSchema) {}
export type UpdateWorkoutInput = z.output<typeof updateWorkoutSchema>;

// -----------------------------------------------------------------------------
// POST /api/workouts/:id/finish
// -----------------------------------------------------------------------------

export const finishWorkoutSchema = z
  .object({
    notes: optionalText(WORKOUT_NOTES_MAX),
    endedAt: instant.optional().meta({ description: 'Default: now. Not before `startedAt`, at most 5 minutes ahead.' }),
  })
  .strict();

export class FinishWorkoutDto extends createZodDto(finishWorkoutSchema) {}
export type FinishWorkoutInput = z.output<typeof finishWorkoutSchema>;

// -----------------------------------------------------------------------------
// Workout exercises
// -----------------------------------------------------------------------------

export const addWorkoutExerciseSchema = z
  .object({
    exerciseId: z.uuid().meta({ description: 'A library exercise or one of the caller\'s active custom exercises.' }),
    position: boundedInt(0, MAX_EXERCISES_PER_WORKOUT - 1)
      .optional()
      .meta({ description: '0-based; inserts there and shifts the rest. Default: appended.' }),
    equipmentTypeId: z.uuid().nullable().optional().meta({ description: 'Equipment actually used (catalog or custom type).' }),
    notes: optionalText(WORKOUT_NOTES_MAX),
  })
  .strict();

export class AddWorkoutExerciseDto extends createZodDto(addWorkoutExerciseSchema) {}
export type AddWorkoutExerciseInput = z.output<typeof addWorkoutExerciseSchema>;

export const updateWorkoutExerciseSchema = z
  .object({
    position: boundedInt(0, MAX_EXERCISES_PER_WORKOUT - 1)
      .optional()
      .meta({ description: 'Moves the exercise; positions are renumbered densely (0..n-1).' }),
    notes: optionalText(WORKOUT_NOTES_MAX),
    equipmentTypeId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine(atLeastOneField, { message: 'At least one field is required' });

export class UpdateWorkoutExerciseDto extends createZodDto(updateWorkoutExerciseSchema) {}
export type UpdateWorkoutExerciseInput = z.output<typeof updateWorkoutExerciseSchema>;

// -----------------------------------------------------------------------------
// Sets
// -----------------------------------------------------------------------------

const setFields = {
  weightKg: weightKg.nullable().optional(),
  reps: reps.nullable().optional(),
  durationSeconds: setDurationSeconds.nullable().optional(),
  distanceMeters: distanceMeters.nullable().optional(),
  rpe: rpe.nullable().optional(),
  rir: rir.nullable().optional(),
  restSeconds: restSeconds.nullable().optional(),
  isWarmup: z.boolean().optional(),
  completed: z.boolean().optional(),
  painFlag: z.boolean().optional(),
  painNote: optionalText(SET_PAIN_NOTE_MAX),
  notes: optionalText(SET_NOTES_MAX),
};

export const createSetSchema = z
  .object(setFields)
  .strict()
  .meta({
    description:
      'Every field optional. An omitted `weightKg`, `reps`, `durationSeconds` or `distanceMeters` is copied ' +
      'from the exercise\'s previous set; send null to leave it empty.',
  });

export class CreateSetDto extends createZodDto(createSetSchema) {}
export type CreateSetInput = z.output<typeof createSetSchema>;

export const updateSetSchema = z
  .object(setFields)
  .strict()
  .refine(atLeastOneField, { message: 'At least one field is required' });

export class UpdateSetDto extends createZodDto(updateSetSchema) {}
export type UpdateSetInput = z.output<typeof updateSetSchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const setPrSchema = z
  .object({
    type: z.enum(PR_TYPES).meta({
      description:
        '`weight`: heaviest working set so far; `reps`: most reps at this weight or heavier; `e1rm`: best ' +
        'estimated 1RM (Epley, 1..12 reps); `first_time`: the first working set of this exercise ever.',
    }),
    value: z.number().meta({
      description: 'Kilograms for `weight` and `e1rm` (e1RM rounded to 0.1), reps for `reps`, the set\'s kg for `first_time`.',
    }),
    previous: z.number().nullable().meta({ description: 'The prior best it beats, in the same unit; null for `first_time`.' }),
  })
  .meta({ description: 'A personal record a completed working set earns, computed on read.' });

export type SetPrData = z.infer<typeof setPrSchema>;

export const setLogViewSchema = z.object({
  id: z.uuid(),
  workoutExerciseId: z.uuid(),
  setNumber: z.number().int().meta({ description: '1-based, dense within the exercise.' }),
  weightKg: z.number().nullable().meta({ description: 'Kilograms.' }),
  reps: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
  distanceMeters: z.number().nullable().meta({ description: 'Metres.' }),
  rpe: z.number().nullable(),
  rir: z.number().int().nullable(),
  restSeconds: z.number().int().nullable(),
  isWarmup: z.boolean(),
  completed: z.boolean(),
  completedAt: z.iso.datetime().nullable(),
  painFlag: z.boolean(),
  painNote: z.string().nullable(),
  notes: z.string().nullable(),
  prs: z.array(setPrSchema).meta({
    description:
      'The PRs this set earns against the caller\'s earlier completed workouts and the earlier sets of this ' +
      'workout. Empty for an uncompleted or warm-up set and for time/distance exercises.',
  }),
});

export class SetLogView extends createZodDto(setLogViewSchema) {}
export type SetLogViewData = z.infer<typeof setLogViewSchema>;

export const workoutExerciseRefSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  trackingMode: z.enum(EXERCISE_TRACKING_MODES),
  isBodyweight: z.boolean(),
  isUnilateral: z.boolean(),
  primaryMuscles: z.array(z.string()),
  isCustom: z.boolean(),
  status: z.enum(EXERCISE_STATUSES),
});

const equipmentTypeRefSchema = z.object({ id: z.uuid(), slug: z.string(), name: z.string() });

export const workoutExerciseViewSchema = z.object({
  id: z.uuid(),
  workoutId: z.uuid(),
  exerciseId: z.uuid(),
  position: z.number().int().meta({ description: '0-based, dense within the workout.' }),
  equipmentTypeId: z.uuid().nullable(),
  equipmentType: equipmentTypeRefSchema.nullable(),
  notes: z.string().nullable(),
  exercise: workoutExerciseRefSchema,
  sets: z.array(setLogViewSchema).meta({ description: 'In `setNumber` order.' }),
  createdAt: z.iso.datetime(),
});

export class WorkoutExerciseView extends createZodDto(workoutExerciseViewSchema) {}
export type WorkoutExerciseViewData = z.infer<typeof workoutExerciseViewSchema>;

export const readinessSnapshotSchema = z
  .object({
    date: z.iso.date(),
    energy: z.number().int().nullable(),
    sleepQuality: z.number().int().nullable(),
    soreness: z.number().int().nullable(),
    stress: z.number().int().nullable(),
    note: z.string().nullable(),
    updatedAt: z.iso.datetime().meta({ description: 'When the check-in was last saved before the workout started.' }),
  })
  .meta({ description: 'A copy of today\'s readiness check-in at start; later check-in edits do not change it.' });

export type ReadinessSnapshotData = z.infer<typeof readinessSnapshotSchema>;

const gymRefSchema = z.object({ id: z.uuid(), name: z.string() });

export const workoutTotalsSchema = z.object({
  durationSeconds: z.number().int().nullable(),
  exerciseCount: z.number().int(),
  setCount: z.number().int().meta({ description: 'Completed working (non-warm-up) sets.' }),
  volumeKg: z.number().meta({ description: 'Sum of weightKg x reps over completed working sets.' }),
  prs: z
    .array(
      z.object({
        exerciseId: z.uuid(),
        exerciseName: z.string(),
        workoutExerciseId: z.uuid(),
        setId: z.uuid(),
        setNumber: z.number().int(),
        type: z.enum(PR_TYPES),
        value: z.number(),
        previous: z.number().nullable(),
      }),
    )
    .meta({
      description:
        'The best set per PR type per exercise in this workout (highest value, earliest on a tie), ' +
        'in exercise order. Each set\'s own `prs` lists everything it earns.',
    }),
});

export type WorkoutPrSummaryData = WorkoutTotalsData['prs'][number];
export type WorkoutTotalsData = z.infer<typeof workoutTotalsSchema>;

export const workoutPhotoViewSchema = z.object({
  id: z.uuid(),
  storageObjectId: z.uuid().meta({ description: 'View it through `GET /api/storage/objects/{id}/download`.' }),
  caption: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type WorkoutPhotoViewData = z.infer<typeof workoutPhotoViewSchema>;

export const workoutViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  date: z.iso.date(),
  status: z.enum(WORKOUT_STATUSES),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  durationSeconds: z.number().int().nullable(),
  gymId: z.uuid().nullable(),
  gym: gymRefSchema.nullable(),
  notes: z.string().nullable(),
  programWorkoutId: z.uuid().nullable().meta({ description: 'Reserved for programs; always null for now.' }),
  readinessSnapshot: readinessSnapshotSchema.nullable(),
  exercises: z.array(workoutExerciseViewSchema).meta({ description: 'In `position` order.' }),
  photos: z
    .array(workoutPhotoViewSchema)
    .meta({ description: 'Photos the workout was prefilled from ("Prefill from photo"), oldest first.' }),
  summary: workoutTotalsSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class WorkoutView extends createZodDto(workoutViewSchema) {}
export type WorkoutViewData = z.infer<typeof workoutViewSchema>;

export const startWorkoutResultSchema = workoutViewSchema.extend({
  existing: z
    .boolean()
    .meta({ description: 'True (with status 200) when the caller already had a workout in progress; that one is returned.' }),
});

export class StartWorkoutResultView extends createZodDto(startWorkoutResultSchema) {}
export type StartWorkoutResultData = z.infer<typeof startWorkoutResultSchema>;

export const workoutListItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  date: z.iso.date(),
  status: z.enum(WORKOUT_STATUSES),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  durationSeconds: z.number().int().nullable(),
  gym: gymRefSchema.nullable(),
  exerciseCount: z.number().int(),
  setCount: z.number().int().meta({ description: 'Completed working (non-warm-up) sets.' }),
  volumeKg: z.number().meta({ description: 'Sum of weightKg x reps over completed working sets.' }),
  exercises: z
    .array(z.object({ id: z.uuid(), name: z.string() }))
    .meta({ description: 'The exercises in `position` order (exercise ids, not workout-exercise ids).' }),
});

export class WorkoutListItemView extends createZodDto(workoutListItemSchema) {}
export type WorkoutListItemData = z.infer<typeof workoutListItemSchema>;

export interface WorkoutListData {
  items: WorkoutListItemData[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
