import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { optionalText } from '../../gyms/dto/fields';
import {
  QUICK_CARDIO_BACKDATE_DAYS,
  QUICK_CARDIO_DISTANCE_METERS_MAX,
  QUICK_CARDIO_DURATION_SECONDS,
  QUICK_CARDIO_EXERCISE_KEYS,
  QUICK_CARDIO_NOTE_MAX,
} from '../workouts.constants';
import { workoutViewSchema } from './workout.dto';

// =============================================================================
// POST /api/workouts/quick-cardio — schemas (E8 F4, #264)
// =============================================================================
//
// A gym-free walk, run or hike logged in one call, already finished. Seconds
// and metres, always. The time window of `performedAt` (not in the future,
// not older than 7 days) depends on the clock, so the service checks it and
// answers 400 with a `details.reason`.
// =============================================================================

export const quickCardioSchema = z
  .object({
    exerciseKey: z
      .enum(QUICK_CARDIO_EXERCISE_KEYS)
      .meta({ description: 'The seeded exercise slug: `outdoor_walk`, `outdoor_run` or `hike`.' }),
    durationSeconds: z
      .number()
      .int()
      .min(QUICK_CARDIO_DURATION_SECONDS.min)
      .max(QUICK_CARDIO_DURATION_SECONDS.max)
      .optional()
      .meta({ description: 'Seconds, 60..36000 (1 minute to 10 hours).' }),
    distanceMeters: z
      .number()
      .positive()
      .max(QUICK_CARDIO_DISTANCE_METERS_MAX)
      .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, { message: 'At most 2 decimal places' })
      .optional()
      .meta({ description: 'Metres, greater than 0 and at most 100000, at most 2 decimals.' }),
    performedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .meta({
        description:
          `When the activity ended. Default: now. Not in the future (5 minutes of clock skew tolerated) and ` +
          `not more than ${QUICK_CARDIO_BACKDATE_DAYS} days ago.`,
      }),
    note: optionalText(QUICK_CARDIO_NOTE_MAX).meta({ description: 'Stored as the workout notes, at most 280 characters.' }),
  })
  .strict()
  .refine((body) => body.durationSeconds !== undefined || body.distanceMeters !== undefined, {
    path: ['durationSeconds'],
    message: 'At least one of durationSeconds or distanceMeters is required',
  });

export class QuickCardioDto extends createZodDto(quickCardioSchema) {}
export type QuickCardioInput = z.output<typeof quickCardioSchema>;

export const quickCardioResultSchema = z.object({
  workout: workoutViewSchema.meta({ description: 'The completed workout, as `GET /api/workouts/{id}` returns it.' }),
  linkedProgramWorkoutId: z
    .uuid()
    .nullable()
    .meta({
      description:
        'The planned workout of the active plan this session counts toward (that local day\'s planned session ' +
        'containing the exercise), or null when it is an extra session.',
    }),
});

export class QuickCardioResultView extends createZodDto(quickCardioResultSchema) {}
export type QuickCardioResultData = z.infer<typeof quickCardioResultSchema>;
