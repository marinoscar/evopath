import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { isRealDate } from '../../check-ins/local-date';
import { EXERCISE_HISTORY_LIMIT_DEFAULT, EXERCISE_HISTORY_LIMIT_MAX } from '../workouts.constants';

// =============================================================================
// GET /api/exercises/:id/history — schemas (E4.4)
// =============================================================================
//
// Kilograms and metres, as everywhere in the workouts API. The AI coach reads
// `lastTime` and `records` later: keep this shape stable (add, never rename).
// =============================================================================

const localDate = z.iso
  .date()
  .refine(isRealDate, { message: 'Must be a real calendar date in YYYY-MM-DD format' })
  .meta({ description: 'A local calendar day, `YYYY-MM-DD`.' });

export const exerciseHistoryQuerySchema = z
  .object({
    beforeDate: localDate.optional().meta({
      description:
        'History as of this day: completed workouts dated on or before it. Default: today in the Health ' +
        'Profile time zone (UTC when unset). Ignored with `workoutId`.',
    }),
    workoutId: z.uuid().optional().meta({
      description:
        'History in the context of one of the caller\'s workouts: only completed workouts earlier than it by ' +
        '(date, start time); its gym is preferred for `lastTime` unless `gymId` is given.',
    }),
    gymId: z.uuid().optional().meta({
      description: '`lastTime` prefers this gym when one of the two most recent workouts with the exercise was there.',
    }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(EXERCISE_HISTORY_LIMIT_MAX)
      .default(EXERCISE_HISTORY_LIMIT_DEFAULT)
      .meta({ description: `How many recent workouts \`recent\` lists; default ${EXERCISE_HISTORY_LIMIT_DEFAULT}, max ${EXERCISE_HISTORY_LIMIT_MAX}.` }),
  });

export class ExerciseHistoryQueryDto extends createZodDto(exerciseHistoryQuerySchema) {}
export type ExerciseHistoryQuery = z.output<typeof exerciseHistoryQuerySchema>;

const gymRefSchema = z.object({ id: z.uuid(), name: z.string() });

export const lastTimeSetSchema = z.object({
  setNumber: z.number().int(),
  weightKg: z.number().nullable().meta({ description: 'Kilograms.' }),
  reps: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
  distanceMeters: z.number().nullable().meta({ description: 'Metres.' }),
  rpe: z.number().nullable(),
  isWarmup: z.boolean(),
});

export const lastTimeSchema = z
  .object({
    workoutId: z.uuid(),
    date: z.iso.date(),
    gym: gymRefSchema.nullable(),
    sets: z.array(lastTimeSetSchema).meta({
      description: 'The completed sets of the exercise in that workout, in position then `setNumber` order (warm-ups flagged).',
    }),
  })
  .meta({
    description:
      'The most recent completed workout with a completed set of this exercise; of the two most recent, the ' +
      'one at the preferred gym wins.',
  });

export const recentWorkoutSchema = z.object({
  workoutId: z.uuid(),
  date: z.iso.date(),
  topSet: z
    .object({ weightKg: z.number(), reps: z.number().int() })
    .nullable()
    .meta({ description: 'The heaviest working set (most reps on a tie); null without working sets.' }),
  e1rmKg: z.number().nullable().meta({ description: 'The best estimated 1RM of the workout (Epley, 0.1 kg), or null.' }),
});

export const exerciseRecordsSchema = z
  .object({
    maxWeightKg: z
      .object({ value: z.number(), reps: z.number().int(), date: z.iso.date() })
      .nullable()
      .meta({ description: 'Heaviest working set (most reps on a tie), and the day it was first lifted.' }),
    maxReps: z
      .object({ value: z.number().int(), weightKg: z.number(), date: z.iso.date() })
      .nullable()
      .meta({ description: 'Most reps in one working set (heaviest on a tie), and the day.' }),
    bestE1rmKg: z
      .object({ value: z.number(), weightKg: z.number(), reps: z.number().int(), date: z.iso.date() })
      .nullable()
      .meta({ description: 'Best estimated 1RM (Epley, 1..12 reps, 0.1 kg), the set it came from, and the day.' }),
  })
  .meta({ description: 'All-time records over working sets as of the history\'s cut-off; nulls without any.' });

export const exerciseHistorySchema = z.object({
  exerciseId: z.uuid(),
  lastTime: lastTimeSchema.nullable().meta({ description: 'Null the first time the exercise is logged.' }),
  recent: z.array(recentWorkoutSchema).meta({ description: 'The most recent workouts with the exercise, newest first.' }),
  records: exerciseRecordsSchema,
});

export class ExerciseHistoryView extends createZodDto(exerciseHistorySchema) {}
export type ExerciseHistoryData = z.infer<typeof exerciseHistorySchema>;
export type LastTimeData = z.infer<typeof lastTimeSchema>;
export type RecentWorkoutData = z.infer<typeof recentWorkoutSchema>;
