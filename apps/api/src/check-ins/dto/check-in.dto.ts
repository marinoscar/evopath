import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { getMetric } from '../../measurements/metric-registry';
import { isRealDate } from '../local-date';

// =============================================================================
// /api/check-ins — request and response schemas (E2.4, #56)
// =============================================================================
//
// A check-in is four optional 1-5 self-reported scores and a note for one
// local calendar day, stored as `measurements` rows under the registry's
// wellness keys. `CHECK_IN_FIELDS` is the ONE mapping between the API's
// camelCase fields and those keys.
//
// ⚠ Messages name the field and the rule, NEVER the submitted value.
// =============================================================================

export const CHECK_IN_NOTE_MAX = 500;
/** How far back a check-in may be written: today and the seven days before. */
export const CHECK_IN_MAX_BACK_DAYS = 7;
export const CHECK_IN_LIST_DAYS_DEFAULT = 30;
export const CHECK_IN_LIST_DAYS_MAX = 365;
export const CHECK_IN_EMPTY_MESSAGE = 'Enter at least one score';

/** API field -> registry metric key. Order is display order. */
export const CHECK_IN_FIELDS = [
  { field: 'energy', metricKey: 'energy' },
  { field: 'sleepQuality', metricKey: 'sleep_quality' },
  { field: 'soreness', metricKey: 'muscle_soreness' },
  { field: 'stress', metricKey: 'stress' },
] as const;

export type CheckInField = (typeof CHECK_IN_FIELDS)[number]['field'];

export const CHECK_IN_METRIC_KEYS: readonly string[] = CHECK_IN_FIELDS.map((f) => f.metricKey);

/** The registry must define every key as a daily wellness score; fail at load otherwise. */
function scaleOf(metricKey: string) {
  const metric = getMetric(metricKey);
  if (!metric || metric.category !== 'wellness' || !metric.daily || !metric.scale) {
    throw new Error(`Check-in metric ${metricKey} is not a daily wellness score in the registry`);
  }
  return { ...metric.scale, unit: metric.canonicalUnit, label: metric.label };
}

export const CHECK_IN_SCALES: Readonly<
  Record<CheckInField, { min: number; max: number; unit: string; label: string; lowLabel: string; highLabel: string }>
> = Object.fromEntries(CHECK_IN_FIELDS.map(({ field, metricKey }) => [field, scaleOf(metricKey)])) as never;

// -----------------------------------------------------------------------------
// Date parameter
// -----------------------------------------------------------------------------

export const checkInDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be in YYYY-MM-DD format' })
  .refine(isRealDate, { message: 'date must be a real calendar date' });

/** Wrapped in an object so a failure is reported at path `date`. */
export const checkInDateParamSchema = z.object({ date: checkInDateSchema });

// -----------------------------------------------------------------------------
// PUT body
// -----------------------------------------------------------------------------

function scoreSchema(field: CheckInField) {
  const scale = CHECK_IN_SCALES[field];
  return z
    .number({ message: `${field} must be a whole number from ${scale.min} to ${scale.max}` })
    .int({ message: `${field} must be a whole number from ${scale.min} to ${scale.max}` })
    .min(scale.min, { message: `${field} must be a whole number from ${scale.min} to ${scale.max}` })
    .max(scale.max, { message: `${field} must be a whole number from ${scale.min} to ${scale.max}` })
    .nullable()
    .optional()
    .meta({
      description:
        `${scale.label}, ${scale.min} "${scale.lowLabel}" to ${scale.max} "${scale.highLabel}". ` +
        'Omitted or null = not recorded (an existing score for the day is removed).',
    });
}

export const putCheckInSchema = z
  .object({
    energy: scoreSchema('energy'),
    sleepQuality: scoreSchema('sleepQuality'),
    soreness: scoreSchema('soreness'),
    stress: scoreSchema('stress'),
    note: z
      .string()
      .trim()
      .max(CHECK_IN_NOTE_MAX, { message: `note must be at most ${CHECK_IN_NOTE_MAX} characters` })
      .nullable()
      .optional()
      .transform((note) => (note ? note : null))
      .meta({ description: `Free text, trimmed, at most ${CHECK_IN_NOTE_MAX} characters. Blank = null.` }),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (CHECK_IN_FIELDS.every(({ field }) => body[field] == null)) {
      ctx.addIssue({ code: 'custom', path: [], message: CHECK_IN_EMPTY_MESSAGE });
    }
  });

export class PutCheckInDto extends createZodDto(putCheckInSchema) {}
export type PutCheckInInput = z.output<typeof putCheckInSchema>;

// -----------------------------------------------------------------------------
// GET /api/check-ins query
// -----------------------------------------------------------------------------

export const listCheckInsQuerySchema = z
  .object({
    days: z.coerce
      .number({ message: `days must be a whole number from 1 to ${CHECK_IN_LIST_DAYS_MAX}` })
      .int({ message: `days must be a whole number from 1 to ${CHECK_IN_LIST_DAYS_MAX}` })
      .min(1, { message: `days must be a whole number from 1 to ${CHECK_IN_LIST_DAYS_MAX}` })
      .max(CHECK_IN_LIST_DAYS_MAX, {
        message: `days must be a whole number from 1 to ${CHECK_IN_LIST_DAYS_MAX}`,
      })
      .default(CHECK_IN_LIST_DAYS_DEFAULT),
  })
  .strict();

export class ListCheckInsQueryDto extends createZodDto(listCheckInsQuerySchema) {}
export type ListCheckInsQuery = z.output<typeof listCheckInsQuerySchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

const storedScore = z.number().int().nullable().meta({ description: 'null = not recorded that day.' });

export const checkInSchema = z.object({
  date: z.iso.date().meta({ description: 'The local calendar day (`YYYY-MM-DD`) in the user\'s time zone.' }),
  energy: storedScore,
  sleepQuality: storedScore,
  soreness: storedScore,
  stress: storedScore,
  note: z.string().nullable(),
  updatedAt: z.iso.datetime().meta({ description: 'When the check-in was last saved.' }),
});

export class CheckInDto extends createZodDto(checkInSchema) {}
export type CheckIn = z.infer<typeof checkInSchema>;

export const todayCheckInSchema = z.object({
  date: z.iso
    .date()
    .meta({ description: 'Today in the profile time zone (UTC when unset). Send it back to `PUT /api/check-ins/:date`.' }),
  checkIn: checkInSchema.nullable(),
});

export class TodayCheckInDto extends createZodDto(todayCheckInSchema) {}
export type TodayCheckIn = z.infer<typeof todayCheckInSchema>;

export const checkInListSchema = z.object({
  items: z.array(checkInSchema).meta({ description: 'Newest day first; days without a check-in are absent.' }),
});

export class CheckInListDto extends createZodDto(checkInListSchema) {}
export type CheckInList = z.infer<typeof checkInListSchema>;
