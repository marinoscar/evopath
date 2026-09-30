import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { isRealDate } from '../../check-ins/local-date';
import { WORKOUT_DATE_WINDOW_DAYS } from '../workouts.constants';

// =============================================================================
// GET /api/workouts/summary — schemas (E4.6)
// =============================================================================
//
// The Today page's training card: the workout in progress, the last completed
// workout and this week's count. Weights are kilograms, as everywhere in the
// workouts API. No PR data here: it keeps the endpoint cheap.
// =============================================================================

/** At most this many `last.topLifts`. */
export const WORKOUT_SUMMARY_TOP_LIFTS = 3;

const localDate = z.iso
  .date()
  .refine(isRealDate, { message: 'Must be a real calendar date in YYYY-MM-DD format' });

export const workoutSummaryQuerySchema = z
  .object({
    today: localDate.optional().meta({
      description:
        'The client\'s local day, `YYYY-MM-DD` (the Health Profile time zone when set). Must be within ' +
        `${WORKOUT_DATE_WINDOW_DAYS} days of the server's today. Default: today in the Health Profile ` +
        'time zone (UTC when unset).',
    }),
  });

export class WorkoutSummaryQueryDto extends createZodDto(workoutSummaryQuerySchema) {}
export type WorkoutSummaryQuery = z.output<typeof workoutSummaryQuerySchema>;

const gymRefSchema = z
  .object({ id: z.uuid(), name: z.string() })
  .meta({ description: 'The workout\'s gym; null when none was set or the gym was deleted.' });

export const workoutSummaryInProgressSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  startedAt: z.iso.datetime(),
  gym: gymRefSchema.nullable(),
  exerciseCount: z.number().int(),
  completedSetCount: z.number().int().meta({ description: 'Sets marked completed so far, warm-ups included.' }),
});

export const workoutSummaryTopLiftSchema = z.object({
  exerciseName: z.string(),
  weightKg: z.number().meta({ description: 'Kilograms.' }),
  reps: z.number().int(),
});

export const workoutSummaryLastSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  date: z.iso.date().meta({ description: 'The workout\'s local calendar day.' }),
  durationSeconds: z.number().int().nullable(),
  gym: gymRefSchema.nullable(),
  exerciseCount: z.number().int().meta({ description: 'Exercises in the workout, with or without sets.' }),
  setCount: z.number().int().meta({ description: 'Completed working (non-warm-up) sets.' }),
  volumeKg: z.number().meta({ description: 'Sum of weightKg x reps over completed working sets.' }),
  topLifts: z.array(workoutSummaryTopLiftSchema).max(WORKOUT_SUMMARY_TOP_LIFTS).meta({
    description:
      `Up to ${WORKOUT_SUMMARY_TOP_LIFTS}: per exercise, the heaviest completed working set with a weight ` +
      'above 0 and at least one rep (more reps, then the earlier set, on a tie); heaviest first.',
  }),
});

export const workoutSummarySchema = z.object({
  inProgress: workoutSummaryInProgressSchema.nullable().meta({ description: 'The caller\'s workout in progress, if any.' }),
  last: workoutSummaryLastSchema
    .nullable()
    .meta({ description: 'The most recent completed workout (latest `date`, then latest `startedAt`), if any.' }),
  thisWeek: z.object({
    workoutCount: z.number().int().meta({
      description: 'Completed workouts whose `date` falls Monday to Sunday (inclusive) of the week containing today.',
    }),
    weekStart: z.iso.date().meta({ description: 'The Monday of that ISO week.' }),
  }),
  daysSinceLast: z
    .number()
    .int()
    .nullable()
    .meta({ description: 'Calendar days from `last.date` to today (never negative); null without a last workout.' }),
});

export class WorkoutSummaryView extends createZodDto(workoutSummarySchema) {}
export type WorkoutSummaryData = z.infer<typeof workoutSummarySchema>;
export type WorkoutSummaryTopLiftData = z.infer<typeof workoutSummaryTopLiftSchema>;
