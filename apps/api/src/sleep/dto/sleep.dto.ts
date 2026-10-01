import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { localDate } from '../../activity/dto/goal.dto';

// =============================================================================
// /api/sleep — schemas (epic #276, #278)
// =============================================================================

/** `GET /api/sleep?from&to`: at most this many local days, inclusive. */
export const SLEEP_LIST_MAX_RANGE_DAYS = 400;

export const listSleepQuerySchema = z
  .object({
    from: localDate.meta({ description: 'First local day (the day of waking), inclusive.' }),
    to: localDate.meta({ description: 'Last local day, inclusive.' }),
  })
  .refine((query) => query.from <= query.to, { message: '`from` must not be after `to`', path: ['from'] });
export type ListSleepQuery = z.infer<typeof listSleepQuerySchema>;
export class ListSleepQueryDto extends createZodDto(listSleepQuerySchema) {}

export const sleepSessionViewSchema = z.object({
  id: z.uuid(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  localDate: z.iso.date().meta({ description: 'The local day of waking.' }),
  durationMinutes: z.number().int().meta({ description: 'Asleep minutes (total minus awake when stages exist).' }),
  awakeMinutes: z.number().int().nullable(),
  lightMinutes: z.number().int().nullable(),
  deepMinutes: z.number().int().nullable(),
  remMinutes: z.number().int().nullable(),
  unknownMinutes: z.number().int().nullable(),
  origin: z.string().meta({ description: '`manual` or `device` (synced from a phone).' }),
  provider: z.string().nullable().meta({ description: 'Device rows: `health_connect:<deviceId>`; null otherwise.' }),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SleepSessionView = z.infer<typeof sleepSessionViewSchema>;
export class SleepSessionViewDto extends createZodDto(sleepSessionViewSchema) {}
