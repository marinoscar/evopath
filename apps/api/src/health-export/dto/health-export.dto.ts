// =============================================================================
// /api/health/exports (H7, #191): request, job payload and response shapes
// =============================================================================
//
//   POST /api/health/exports        CreateHealthExportDto  -> 202 HealthExportDto
//   GET  /api/health/exports        -> { items: HealthExportDto[] }  (no URLs)
//   GET  /api/health/exports/:id    -> HealthExportDto (+ `download` when ready)
//
// ⚠ Messages name the field and the rule, never a submitted value.
// =============================================================================

import type { Prisma } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { addDays, isRealDate } from '../../check-ins/local-date';
import { DEFAULT_LAB_UNITS, LAB_UNIT_SYSTEMS } from '../../measurements/metric-registry';
import {
  HEALTH_EXPORT_DATASETS,
  HEALTH_EXPORT_DOWNLOAD_URL_TTL_SECONDS,
  HEALTH_EXPORT_FORMATS,
  HEALTH_EXPORT_MAX_RANGE_DAYS,
  HEALTH_EXPORT_RETENTION_DAYS,
} from '../health-export.constants';

const dateSchema = z
  .string()
  .refine(isRealDate, 'Expected a real calendar date in YYYY-MM-DD format')
  .meta({ format: 'date', example: '2026-09-30' });

const formatSchema = z.enum(HEALTH_EXPORT_FORMATS).meta({
  description:
    '`json` (one versioned file), `csv` (a zip with one CSV per dataset), `xlsx` (one sheet per dataset) ' +
    'or `pdf` (a report for a doctor).',
});

const datasetSchema = z.enum(HEALTH_EXPORT_DATASETS);

const labUnitsSchema = z.enum(LAB_UNIT_SYSTEMS);

const datasetsSchema = z
  .array(datasetSchema)
  .min(1, 'Choose at least one dataset')
  .max(HEALTH_EXPORT_DATASETS.length)
  .refine((datasets) => new Set(datasets).size === datasets.length, 'Each dataset may appear once')
  .meta({
    description:
      '`profile` (date of birth, sex at birth, height), `body` (weight, body fat, waist), `vitals` ' +
      '(blood pressure, resting heart rate), `labs` (blood work with reference ranges and flags), ' +
      '`wellness` (the daily check-in scores, "Wellness / mood"), `documents` (an index of kept ' +
      'documents, metadata only) and `progress_photos` (an index of progress photos: day, pose, note, ' +
      'type and size, metadata only).',
  });

/** Days from `from` to `to`, inclusive of neither end. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export const createHealthExportSchema = z
  .object({
    format: formatSchema,
    from: dateSchema.meta({ description: 'First day of the range (inclusive, UTC calendar date).' }),
    to: dateSchema.meta({ description: 'Last day of the range (inclusive, UTC calendar date).' }),
    datasets: datasetsSchema,
    includeHistory: z
      .boolean()
      .default(false)
      .meta({ description: 'Also export superseded revisions of edited readings. Deleted readings are never exported.' }),
    labUnits: labUnitsSchema.optional().meta({
      description:
        'Units for lab results: `conventional` (US conventional, e.g. mg/dL) or `si` (e.g. mmol/L). ' +
        "Omitted = the caller's health-profile `labUnits` (`conventional` without a profile). Only the " +
        'labs dataset and the PDF lab values change; other datasets stay in canonical units.',
    }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isRealDate(value.from) || !isRealDate(value.to)) return;
    if (value.from > value.to) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: '`from` must not be after `to`' });
      return;
    }
    if (daysBetween(value.from, value.to) > HEALTH_EXPORT_MAX_RANGE_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `The range may not exceed ${HEALTH_EXPORT_MAX_RANGE_DAYS} days`,
      });
    }
    const tomorrow = addDays(new Date().toISOString().slice(0, 10), 1);
    if (value.to > tomorrow) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` may not be in the future' });
    }
  });

export class CreateHealthExportDto extends createZodDto(createHealthExportSchema) {}
export type CreateHealthExportInput = z.output<typeof createHealthExportSchema>;

export const healthExportIdParamSchema = z.object({ id: z.uuid() });

// `progress_photos` (E7.9, #249) came later: a result written before it has
// no such key, and reads as 0 rather than failing the whole result.
const rowCountsSchema = z
  .object({
    ...(Object.fromEntries(HEALTH_EXPORT_DATASETS.map((d) => [d, z.number().int().nonnegative()])) as Record<
      (typeof HEALTH_EXPORT_DATASETS)[number],
      z.ZodNumber
    >),
    progress_photos: z.number().int().nonnegative().default(0),
  })
  .meta({ description: 'Rows written per dataset (0 for one not selected; `profile` is 0 or 1).' });

/** What the job writes on `payload.result` when the file is committed. */
export const healthExportResultSchema = z.object({
  storageObjectId: z.uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  rowCounts: rowCountsSchema,
  completedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type HealthExportResult = z.infer<typeof healthExportResultSchema>;

/** Reads `payload.result` off an export job, or undefined when absent or malformed. */
export function readHealthExportResult(payload: Prisma.JsonValue | null): HealthExportResult | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const parsed = healthExportResultSchema.safeParse((payload as Prisma.JsonObject).result);
  return parsed.success ? parsed.data : undefined;
}

/** The `health.export` job payload: the request, the owner and, once done, `result`. */
export const healthExportJobPayloadSchema = z.object({
  userId: z.uuid(),
  format: z.enum(HEALTH_EXPORT_FORMATS),
  from: dateSchema,
  to: dateSchema,
  datasets: z.array(datasetSchema).min(1),
  includeHistory: z.boolean(),
  /** Resolved at request time; jobs queued before #234 carry none and read as conventional. */
  labUnits: labUnitsSchema.default(DEFAULT_LAB_UNITS),
  /** Validated on read by {@link readHealthExportResult}; opaque here so a bad one never wedges the job. */
  result: z.unknown().optional(),
});
export type HealthExportJobPayload = z.infer<typeof healthExportJobPayloadSchema>;

export const HEALTH_EXPORT_STATUSES = ['pending', 'running', 'ready', 'failed', 'expired'] as const;
export type HealthExportStatus = (typeof HEALTH_EXPORT_STATUSES)[number];

export const healthExportSchema = z.object({
  id: z.uuid().meta({ description: 'The export id (the id of its `health.export` job).' }),
  status: z.enum(HEALTH_EXPORT_STATUSES).meta({
    description:
      '`pending` (queued), `running`, `ready` (the file can be downloaded), `failed`, or `expired` ' +
      `(the file was removed: exports are kept ${HEALTH_EXPORT_RETENTION_DAYS} days).`,
  }),
  format: z.enum(HEALTH_EXPORT_FORMATS),
  from: z.string().meta({ format: 'date' }),
  to: z.string().meta({ format: 'date' }),
  datasets: z.array(datasetSchema),
  includeHistory: z.boolean(),
  labUnits: labUnitsSchema.meta({ description: 'The units lab results were (or will be) exported in.' }),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable().meta({ description: 'When the file is removed; null until ready.' }),
  fileName: z.string().nullable().meta({ description: 'The download name, e.g. `<app>-health-2026-01-01-2026-09-30.pdf`, where `<app>` is the product name as a slug.' }),
  sizeBytes: z.number().int().nullable(),
  rowCounts: rowCountsSchema.nullable(),
  error: z.string().nullable().meta({ description: 'Why it failed, in general terms; null unless `failed`.' }),
  download: z
    .object({
      url: z.string().meta({
        description:
          `A signed URL valid for ${HEALTH_EXPORT_DOWNLOAD_URL_TTL_SECONDS / 60} minutes that downloads the ` +
          'file as an attachment. Ask again for a fresh one; never store or share it.',
      }),
      expiresAt: z.iso.datetime(),
    })
    .nullable()
    .meta({ description: 'Only on `GET /api/health/exports/{id}` while `ready`; null otherwise.' }),
});
export class HealthExportDto extends createZodDto(healthExportSchema) {}
export type HealthExport = z.infer<typeof healthExportSchema>;

export const healthExportListSchema = z.object({ items: z.array(healthExportSchema) });
export class HealthExportListDto extends createZodDto(healthExportListSchema) {}
export type HealthExportList = z.infer<typeof healthExportListSchema>;
