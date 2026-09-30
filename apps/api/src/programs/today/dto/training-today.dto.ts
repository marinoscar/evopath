import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { isRealDate } from '../../../check-ins/local-date';
import { CHANGE_ACTORS } from '../../programs.constants';
import { LOAD_GUIDANCE } from '../../contracts/plan-tree.contract';
import { TODAY_DATE_WINDOW_DAYS } from '../training-today.constants';

// =============================================================================
// Today's planned workout (E5.7): schemas
// =============================================================================
//
// `GET /api/training/today?date=` and `POST /api/program-workouts/:id/start`.
// Weights are kilograms. `date` is always the client's local calendar day;
// the server validates it against its own view of today (Health Profile time
// zone, else UTC) and never derives it.
// =============================================================================

const localDate = z.iso
  .date()
  .refine(isRealDate, { message: 'Must be a real calendar date in YYYY-MM-DD format' })
  .meta({
    description:
      'The client\'s local calendar day, `YYYY-MM-DD` (the Health Profile time zone when set). Must be within ' +
      `${TODAY_DATE_WINDOW_DAYS} days of the server's today in that zone.`,
  });

export const trainingTodayQuerySchema = z.object({ date: localDate });
export class TrainingTodayQueryDto extends createZodDto(trainingTodayQuerySchema) {}
export type TrainingTodayQuery = z.output<typeof trainingTodayQuerySchema>;

export const startProgramWorkoutSchema = z
  .object({
    date: localDate,
    gymId: z
      .uuid()
      .optional()
      .meta({ description: 'The caller\'s gym for this session. Default: the plan\'s gym (none when the plan has none).' }),
  })
  .strict();
export class StartProgramWorkoutDto extends createZodDto(startProgramWorkoutSchema) {}
export type StartProgramWorkoutInput = z.output<typeof startProgramWorkoutSchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

const programRefSchema = z.object({ id: z.uuid(), name: z.string() }).meta({ description: 'The active program.' });

const programWorkoutRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  weekday: z.number().int().min(1).max(7).meta({ description: 'ISO weekday 1 (Monday) .. 7 (Sunday).' }),
  estimatedMinutes: z.number().int().nullable(),
});

const lastTimeSchema = z
  .object({
    performedOn: z.iso.date().meta({ description: 'The local day of the most recent completed workout with this exercise.' }),
    topSet: z
      .object({ weightKg: z.number(), reps: z.number().int() })
      .nullable()
      .meta({ description: 'Heaviest completed working set (then most reps); null when none recorded reps.' }),
  })
  .nullable()
  .meta({ description: 'The last time the caller did this exercise on or before `date`; null when never.' });

const sessionExerciseSchema = z.object({
  programExerciseId: z.uuid(),
  exercise: z.object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    trackingMode: z.string(),
    isBodyweight: z.boolean(),
    primaryMuscles: z.array(z.string()),
  }),
  isPriority: z.boolean(),
  sets: z.number().int(),
  repMin: z.number().int(),
  repMax: z.number().int(),
  targetRpe: z.number().nullable(),
  restSeconds: z.number().int(),
  loadGuidance: z.enum(LOAD_GUIDANCE),
  targetLoadKg: z.number().nullable().meta({ description: 'The plan\'s load; meaningful for `loadGuidance: fixed`.' }),
  suggestedLoadKg: z.number().nullable().meta({
    description:
      'The load to show and prefill: `fixed` uses `targetLoadKg` (else the last top set), `from_history` the ' +
      'last top set, `choose_start` none ("Choose a starting load").',
  }),
  rationale: z.string().nullable().meta({ description: 'The one-line reason for this prescription.' }),
  lastTime: lastTimeSchema,
  availableAtGym: z
    .boolean()
    .nullable()
    .meta({ description: 'Whether the plan\'s gym has what the exercise needs; null when the plan has no gym.' }),
});

const sessionSchema = z.object({
  programId: z.uuid(),
  programName: z.string(),
  programWorkoutId: z.uuid(),
  name: z.string(),
  weekNumber: z.number().int(),
  totalWeeks: z.number().int(),
  isDeload: z.boolean(),
  estimatedMinutes: z.number().int().nullable(),
  planVersion: z.number().int().meta({ description: 'The program\'s `currentVersion`.' }),
  unseenChangeCount: z.number().int().meta({ description: 'AI changes not yet marked seen.' }),
  lastChange: z
    .object({ summary: z.string(), actor: z.enum(CHANGE_ACTORS), at: z.iso.datetime() })
    .nullable()
    .meta({ description: 'The latest applied change after the plan was created; null when none.' }),
  exercises: z.array(sessionExerciseSchema),
});

const nextSessionSchema = z
  .object({ date: z.iso.date(), weekNumber: z.number().int(), programWorkout: programWorkoutRefSchema })
  .nullable()
  .meta({ description: 'The next scheduled occurrence within 14 days; null when there is none.' });

const todayNoProgramSchema = z.object({ kind: z.literal('no_program'), date: z.iso.date() });

const todayNotStartedSchema = z.object({
  kind: z.literal('not_started'),
  date: z.iso.date(),
  program: programRefSchema,
  startsOn: z.iso.date().meta({ description: 'The plan\'s start date.' }),
});

const todayProgramCompleteSchema = z.object({
  kind: z.literal('program_complete'),
  date: z.iso.date(),
  program: programRefSchema,
});

const todayRestDaySchema = z.object({
  kind: z.literal('rest_day'),
  date: z.iso.date(),
  program: programRefSchema,
  weekNumber: z.number().int(),
  totalWeeks: z.number().int(),
  next: nextSessionSchema,
});

const todayWorkoutSchema = z.object({
  kind: z.literal('workout'),
  date: z.iso.date(),
  program: programRefSchema,
  programWorkout: programWorkoutRefSchema,
  weekNumber: z.number().int(),
  totalWeeks: z.number().int(),
  isDeload: z.boolean(),
  done: z.boolean().meta({ description: 'A completed workout is linked to this planned workout.' }),
  completedWorkoutId: z.uuid().nullable().meta({ description: 'The most recent completed linked workout.' }),
  inProgressWorkoutId: z.uuid().nullable().meta({ description: 'The caller\'s in-progress workout linked to it.' }),
  session: sessionSchema,
});

/**
 * The five variants as one discriminated union (the runtime contract and the
 * type). `createZodDto` is applied to each variant, never to the union: a
 * class cannot have a union instance type. The controller publishes the
 * variant classes with `oneOf`.
 */
export const trainingTodaySchema = z.discriminatedUnion('kind', [
  todayNoProgramSchema,
  todayNotStartedSchema,
  todayProgramCompleteSchema,
  todayRestDaySchema,
  todayWorkoutSchema,
]);

export class TodayNoProgramView extends createZodDto(todayNoProgramSchema) {}
export class TodayNotStartedView extends createZodDto(todayNotStartedSchema) {}
export class TodayProgramCompleteView extends createZodDto(todayProgramCompleteSchema) {}
export class TodayRestDayView extends createZodDto(todayRestDaySchema) {}
export class TodayWorkoutView extends createZodDto(todayWorkoutSchema) {}

/** The variants, in the order the controller publishes them. */
export const TRAINING_TODAY_VIEWS = [
  TodayNoProgramView,
  TodayNotStartedView,
  TodayProgramCompleteView,
  TodayRestDayView,
  TodayWorkoutView,
] as const;

export type TrainingTodayData = z.infer<typeof trainingTodaySchema>;
export type TodaySessionData = z.infer<typeof sessionSchema>;
export type TodaySessionExerciseData = z.infer<typeof sessionExerciseSchema>;
export type ProgramWorkoutRefData = z.infer<typeof programWorkoutRefSchema>;

export const startProgramWorkoutResultSchema = z.object({
  workoutId: z.uuid().meta({ description: 'The E4 workout to open in the logger.' }),
  existing: z.boolean().meta({ description: 'True when the caller\'s in-progress workout for this session was returned.' }),
  planVersion: z.number().int().meta({ description: 'The plan version the session was started from.' }),
});
export class StartProgramWorkoutResultView extends createZodDto(startProgramWorkoutResultSchema) {}
export type StartProgramWorkoutResultData = z.infer<typeof startProgramWorkoutResultSchema>;
