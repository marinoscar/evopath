import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  ACTIVITY_KINDS,
  ENTRY_BATCH_MAX,
  ENTRY_BOUNDS,
  ENTRY_EXTERNAL_ID_MAX,
  ENTRY_NOTE_MAX,
  ENTRY_PROVIDER_MAX,
} from '../activity.constants';
import { localDate } from './goal.dto';

// =============================================================================
// /api/activity-entries — schemas (#267)
// =============================================================================
//
// Three check-in shapes share one body: "I did it" `{ activityKind: 'walk' }`,
// minutes `{ activityKind: 'walk', durationSeconds: 1800 }` and steps
// `{ activityKind: 'steps', steps: 8000 }`. A `steps` entry must carry `steps`.
// The day window ([today-7, today] local) needs the user's time zone, so the
// service checks it.
// =============================================================================

const steps = z.number().int().min(ENTRY_BOUNDS.steps.min).max(ENTRY_BOUNDS.steps.max);
const durationSeconds = z.number().int().min(ENTRY_BOUNDS.durationSeconds.min).max(ENTRY_BOUNDS.durationSeconds.max);
const distanceMeters = z
  .number()
  .min(ENTRY_BOUNDS.distanceMeters.min)
  .max(ENTRY_BOUNDS.distanceMeters.max)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, { message: 'At most 2 decimal places' });
const note = z.string().trim().max(ENTRY_NOTE_MAX, `At most ${ENTRY_NOTE_MAX} characters`);

const entryShape = {
  occurredOn: localDate.optional().meta({ description: 'Local day; defaults to today. Today or up to 7 days back.' }),
  activityKind: z.enum(ACTIVITY_KINDS),
  completed: z.boolean().optional().meta({ description: 'Defaults to true.' }),
  durationSeconds: durationSeconds.optional().meta({ description: 'Seconds, 0..86400.' }),
  steps: steps.optional().meta({ description: 'A daily total, 0..200000. Required for kind `steps`.' }),
  distanceMeters: distanceMeters.optional().meta({ description: 'Meters, 0..1000000, at most 2 decimals.' }),
  note: note.optional(),
};

const stepsNeedValue = (value: { activityKind?: string; steps?: number | null }) =>
  value.activityKind !== 'steps' || (value.steps !== undefined && value.steps !== null);
const STEPS_MESSAGE = { message: 'A `steps` entry needs a `steps` value', path: ['steps'] };

export const createActivityEntrySchema = z.object(entryShape).strict().refine(stepsNeedValue, STEPS_MESSAGE);
export type CreateActivityEntryInput = z.infer<typeof createActivityEntrySchema>;
export class CreateActivityEntryDto extends createZodDto(createActivityEntrySchema) {}

/** PATCH: any create field; the nullable values may be cleared with `null`. */
export const updateActivityEntrySchema = z
  .object({
    occurredOn: localDate.optional(),
    activityKind: z.enum(ACTIVITY_KINDS).optional(),
    completed: z.boolean().optional(),
    durationSeconds: durationSeconds.nullable().optional(),
    steps: steps.nullable().optional(),
    distanceMeters: distanceMeters.nullable().optional(),
    note: note.nullable().optional(),
  })
  .strict();
export type UpdateActivityEntryInput = z.infer<typeof updateActivityEntrySchema>;
export class UpdateActivityEntryDto extends createZodDto(updateActivityEntrySchema) {}

export const batchEntrySchema = z
  .object({
    ...entryShape,
    provider: z.string().trim().min(1).max(ENTRY_PROVIDER_MAX).optional(),
    externalId: z.string().trim().min(1).max(ENTRY_EXTERNAL_ID_MAX).optional(),
  })
  .strict()
  .refine(stepsNeedValue, STEPS_MESSAGE);
export type BatchEntryInput = z.infer<typeof batchEntrySchema>;

export const batchActivityEntriesSchema = z
  .object({
    entries: z.array(batchEntrySchema).min(1).max(ENTRY_BATCH_MAX).meta({
      description:
        `1..${ENTRY_BATCH_MAX} entries. With both \`provider\` and \`externalId\`, an entry replaces the ` +
        'caller\'s earlier one with the same pair (idempotent re-send); otherwise it is inserted.',
    }),
  })
  .strict();
export type BatchActivityEntriesInput = z.infer<typeof batchActivityEntriesSchema>;
export class BatchActivityEntriesDto extends createZodDto(batchActivityEntriesSchema) {}

export const listActivityEntriesQuerySchema = z
  .object({
    from: localDate,
    to: localDate,
    kind: z.enum(ACTIVITY_KINDS).optional(),
  })
  .refine((value) => value.from <= value.to, { message: '`from` must not be after `to`', path: ['from'] });
export type ListActivityEntriesQuery = z.infer<typeof listActivityEntriesQuerySchema>;
export class ListActivityEntriesQueryDto extends createZodDto(listActivityEntriesQuerySchema) {}

export const batchResultViewSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
});
export type BatchResultData = z.infer<typeof batchResultViewSchema>;
export class BatchResultView extends createZodDto(batchResultViewSchema) {}
