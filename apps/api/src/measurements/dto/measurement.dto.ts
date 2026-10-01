import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  BP_DIASTOLIC,
  BP_SYSTOLIC,
  getMetric,
  isLabMetric,
  isMeasurementMetric,
  isMethodAllowed,
  isMetricKey,
  isWithinBounds,
  LAB_PANELS,
  MEASUREMENT_METRIC_KEYS,
  METRIC_CATEGORIES,
  METRICS,
  toCanonical,
  unitFor,
} from '../metric-registry';

// =============================================================================
// /api/measurements — request and response schemas (E2.2, #50)
// =============================================================================
//
// Every registry rule lives in these schemas (`superRefine`), so the global
// `ZodValidationPipe` enforces them on the controller and the unit tests parse
// the very same schema. Each issue carries the field path
// (`readings.1.unit`), which `HttpExceptionFilter` publishes under
// `details.issues`.
//
// Write bodies are `.strict()`: `origin` and `sourceRef` are server-owned and
// a client sending either is refused with a 400, permanently.
//
// ⚠ Messages name the field and the rule, NEVER the submitted value (health
// data and free-text notes must not be echoed into a response or a log).
// =============================================================================

export const MAX_READINGS_PER_ENTRY = 6;
/** A lab entry is one report (a panel or several): at most this many analytes. */
export const MAX_LAB_READINGS_PER_ENTRY = 40;
export const REFERENCE_TEXT_MAX = 100;
/** The lab's own flag on a result (H3, #187). Stored as text; Zod is the guard. */
export const MEASUREMENT_FLAGS = ['low', 'normal', 'high', 'critical', 'unknown'] as const;
export type MeasurementFlag = (typeof MEASUREMENT_FLAGS)[number];
/** The reading fields only a lab analyte may carry. */
const REFERENCE_FIELDS = ['referenceLow', 'referenceHigh', 'referenceText', 'flag'] as const;
export const MEASUREMENT_NOTES_MAX = 500;
/** `measuredAt` may be at most this far ahead of the server clock (clock skew). */
export const MEASURED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const MEASURED_AT_MIN = new Date('1900-01-01T00:00:00.000Z');
export const LIST_PAGE_SIZE_DEFAULT = 20;
export const LIST_PAGE_SIZE_MAX = 100;
export const SERIES_DEFAULT_DAYS = 180;
/** The widest `series` range: five years including leap days. */
export const SERIES_MAX_RANGE_DAYS = 5 * 365 + 2;
export const SERIES_MAX_POINTS = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Readings
// -----------------------------------------------------------------------------

const readingInputSchema = z
  .object({
    metricKey: z
      .string()
      .min(1)
      .max(64)
      .meta({ description: 'A body or vital metric key from `GET /api/measurements/metrics`.' }),
    value: z
      .number()
      .meta({ description: 'The value in `unit`. Converted once to the canonical unit.' }),
    unit: z
      .string()
      .min(1)
      .max(16)
      .optional()
      .meta({ description: "One of the metric's `units`. Omitted = the canonical unit." }),
    method: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .meta({
        description:
          "How it was measured; one of the metric's `methods`. Omitted = `unspecified` on create, unchanged on edit.",
      }),
    referenceLow: z
      .number()
      .nullable()
      .optional()
      .meta({
        description:
          "Lab metrics only. The lab's lower reference limit, in `unit` (converted like `value`). Null or omitted = none on create; omitted = unchanged, null = cleared on edit.",
      }),
    referenceHigh: z
      .number()
      .nullable()
      .optional()
      .meta({
        description:
          "Lab metrics only. The lab's upper reference limit, in `unit`; not below `referenceLow`. Same null/omitted rules as `referenceLow`.",
      }),
    referenceText: z
      .string()
      .trim()
      .max(REFERENCE_TEXT_MAX, {
        message: `referenceText must be at most ${REFERENCE_TEXT_MAX} characters`,
      })
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional()
      .meta({
        description: `Lab metrics only. The range as printed when it is not two numbers (\`<100\`, \`negative\`), at most ${REFERENCE_TEXT_MAX} characters. An empty string is stored as null.`,
      }),
    flag: z
      .enum(MEASUREMENT_FLAGS)
      .nullable()
      .optional()
      .meta({ description: "Lab metrics only. The lab's flag on the result." }),
  })
  .strict();

type ReadingInput = z.output<typeof readingInputSchema>;

/** A validated reading, value (and reference limits) already in the canonical unit. */
export interface NormalizedReading {
  metricKey: string;
  value: number;
  unit: string;
  /** Undefined = default (create) or keep the existing method (edit). */
  method?: string;
  /**
   * Lab context. Undefined = none (create) or keep the stored one (edit);
   * null = none / clear.
   */
  referenceLow?: number | null;
  referenceHigh?: number | null;
  referenceText?: string | null;
  flag?: MeasurementFlag | null;
}

/**
 * Adds one issue per broken registry rule, each at the field it concerns.
 * Defensive about shapes: Zod may run a refinement over a value that already
 * has element-level issues.
 */
function checkReadings(
  readings: unknown,
  ctx: z.RefinementCtx,
  options: { requireBloodPressurePair: boolean },
): void {
  if (!Array.isArray(readings)) return;

  const seen = new Set<string>();
  const canonical = new Map<string, number>();
  const keys = readings
    .map((reading: Partial<ReadingInput> | undefined) => reading?.metricKey)
    .filter((key): key is string => typeof key === 'string' && isMeasurementMetric(key));
  const labCount = keys.filter(isLabMetric).length;

  if (labCount > 0 && labCount < keys.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['readings'],
      message: 'Lab metrics and body or vital metrics cannot be saved in one entry',
    });
  } else if (labCount === 0 && readings.length > MAX_READINGS_PER_ENTRY) {
    ctx.addIssue({
      code: 'custom',
      path: ['readings'],
      message: `readings must contain at most ${MAX_READINGS_PER_ENTRY} readings`,
    });
  }

  readings.forEach((raw: Partial<ReadingInput> | undefined, index) => {
    if (!raw || typeof raw.metricKey !== 'string') return;

    const at = (field: string) => ['readings', index, field];
    const { metricKey } = raw;

    if (!isMetricKey(metricKey)) {
      ctx.addIssue({ code: 'custom', path: at('metricKey'), message: 'Unknown metricKey' });
      return;
    }

    if (!isMeasurementMetric(metricKey)) {
      ctx.addIssue({
        code: 'custom',
        path: at('metricKey'),
        message: 'Wellness metrics are recorded through /api/check-ins, not /api/measurements',
      });
      return;
    }

    if (seen.has(metricKey)) {
      ctx.addIssue({
        code: 'custom',
        path: at('metricKey'),
        message: `Duplicate metricKey ${metricKey} in one request`,
      });
      return;
    }
    seen.add(metricKey);

    if (typeof raw.method === 'string' && !isMethodAllowed(metricKey, raw.method)) {
      ctx.addIssue({
        code: 'custom',
        path: at('method'),
        message: `method is not allowed for ${metricKey}`,
      });
    }

    const lab = isLabMetric(metricKey);

    if (!lab) {
      for (const field of REFERENCE_FIELDS) {
        if (raw[field] !== undefined && raw[field] !== null) {
          ctx.addIssue({
            code: 'custom',
            path: at(field),
            message: `${field} is only accepted for lab metrics`,
          });
        }
      }
    }

    const unit = raw.unit ?? getMetric(metricKey)!.canonicalUnit;

    if (!unitFor(metricKey, unit)) {
      ctx.addIssue({
        code: 'custom',
        path: at('unit'),
        message: `unit is not allowed for ${metricKey}`,
      });
      return;
    }

    if (lab) {
      const low = typeof raw.referenceLow === 'number' ? raw.referenceLow : undefined;
      const high = typeof raw.referenceHigh === 'number' ? raw.referenceHigh : undefined;
      const problem = referenceRangeProblem(
        low === undefined ? undefined : toCanonical(metricKey, low, unit),
        high === undefined ? undefined : toCanonical(metricKey, high, unit),
      );

      if (problem) {
        ctx.addIssue({ code: 'custom', path: at('referenceLow'), message: problem });
      }
    }

    if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) return;

    const value = toCanonical(metricKey, raw.value, unit);

    if (!isWithinBounds(metricKey, value)) {
      const metric = getMetric(metricKey)!;
      ctx.addIssue({
        code: 'custom',
        path: at('value'),
        message: `value is outside the allowed range for ${metricKey} (${metric.min} to ${metric.max} ${metric.canonicalUnit})`,
      });
      return;
    }

    canonical.set(metricKey, value);
  });

  if (options.requireBloodPressurePair) {
    const problem = bloodPressureProblem(
      readings.map((reading: Partial<ReadingInput> | undefined) => reading?.metricKey),
      canonical.get(BP_SYSTOLIC),
      canonical.get(BP_DIASTOLIC),
    );

    if (problem) {
      ctx.addIssue({ code: 'custom', path: ['readings'], message: problem });
    }
  }
}

/**
 * The cross-field blood-pressure rule, shared by the create schema and the
 * service's merged-entry check on edit. Returns the message, or null.
 * Systolic/diastolic are canonical values, or undefined when unknown.
 */
export function bloodPressureProblem(
  metricKeys: ReadonlyArray<string | undefined>,
  systolic: number | undefined,
  diastolic: number | undefined,
): string | null {
  const hasSystolic = metricKeys.includes(BP_SYSTOLIC);
  const hasDiastolic = metricKeys.includes(BP_DIASTOLIC);

  if (hasSystolic !== hasDiastolic) {
    return 'bp_systolic and bp_diastolic must be submitted together';
  }

  if (systolic !== undefined && diastolic !== undefined && systolic <= diastolic) {
    return 'bp_systolic must be higher than bp_diastolic';
  }

  return null;
}

/**
 * The range rule, shared by the schemas and the service's merged-reading
 * check on edit. Limits are canonical; undefined or null = not set.
 */
export function referenceRangeProblem(
  low: number | null | undefined,
  high: number | null | undefined,
): string | null {
  if (typeof low === 'number' && typeof high === 'number' && low > high) {
    return 'referenceLow must not be higher than referenceHigh';
  }

  return null;
}

function normalize(reading: ReadingInput): NormalizedReading {
  const metric = getMetric(reading.metricKey)!;
  const unit = reading.unit ?? metric.canonicalUnit;
  const limit = (value: number | null | undefined) =>
    value === undefined || value === null ? value : toCanonical(reading.metricKey, value, unit);

  return {
    metricKey: reading.metricKey,
    value: toCanonical(reading.metricKey, reading.value, unit),
    unit: metric.canonicalUnit,
    ...(reading.method !== undefined ? { method: reading.method } : {}),
    ...(reading.referenceLow !== undefined ? { referenceLow: limit(reading.referenceLow) } : {}),
    ...(reading.referenceHigh !== undefined ? { referenceHigh: limit(reading.referenceHigh) } : {}),
    ...(reading.referenceText !== undefined ? { referenceText: reading.referenceText } : {}),
    ...(reading.flag !== undefined ? { flag: reading.flag } : {}),
  };
}

// -----------------------------------------------------------------------------
// Shared fields
// -----------------------------------------------------------------------------

const measuredAtSchema = z
  .iso.datetime({ offset: true, message: 'measuredAt must be an ISO 8601 date-time' })
  .transform((value) => new Date(value))
  .refine((date) => date.getTime() <= Date.now() + MEASURED_AT_FUTURE_TOLERANCE_MS, {
    message: 'measuredAt must not be in the future',
  })
  .refine((date) => date.getTime() >= MEASURED_AT_MIN.getTime(), {
    message: 'measuredAt must not be before 1900-01-01',
  })
  .meta({
    description:
      'When the readings were taken, ISO 8601 with an offset. At most 5 minutes ahead of the server clock, not before 1900-01-01.',
  });

const notesSchema = z
  .string()
  .trim()
  .max(MEASUREMENT_NOTES_MAX, {
    message: `notes must be at most ${MEASUREMENT_NOTES_MAX} characters`,
  })
  .transform((value) => (value === '' ? null : value))
  .meta({
    description: `Free text, at most ${MEASUREMENT_NOTES_MAX} characters after trimming. An empty string is stored as null.`,
  });

const readingsSchema = z
  .array(readingInputSchema)
  .min(1, { message: 'readings must contain at least one reading' })
  // Six for body and vital entries (checked in `checkReadings`); a lab report
  // may carry up to MAX_LAB_READINGS_PER_ENTRY analytes.
  .max(MAX_LAB_READINGS_PER_ENTRY, {
    message: `readings must contain at most ${MAX_LAB_READINGS_PER_ENTRY} readings`,
  });

// -----------------------------------------------------------------------------
// POST /api/measurements
// -----------------------------------------------------------------------------

export const createMeasurementEntrySchema = z
  .object({
    measuredAt: measuredAtSchema.optional(),
    notes: notesSchema.optional(),
    readings: readingsSchema,
  })
  .strict()
  .superRefine((body, ctx) =>
    checkReadings(body.readings, ctx, { requireBloodPressurePair: true }),
  )
  .transform((body) => ({
    measuredAt: body.measuredAt,
    notes: body.notes ?? null,
    readings: body.readings.map(normalize),
  }))
  .meta({
    description:
      `One entry: readings saved together (for example a blood-pressure pair, or weight + body fat + waist): 1 to ${MAX_READINGS_PER_ENTRY} body/vital readings, or 1 to ${MAX_LAB_READINGS_PER_ENTRY} lab analytes from one report (lab and body/vital metrics never share an entry). Lab readings may carry a reference range and flag. \`origin\` and \`sourceRef\` are server-owned and refused.`,
  });

export class CreateMeasurementEntryDto extends createZodDto(createMeasurementEntrySchema) {}
export type CreateMeasurementEntryInput = z.output<typeof createMeasurementEntrySchema>;

// -----------------------------------------------------------------------------
// PATCH /api/measurements/entries/:entryId
// -----------------------------------------------------------------------------

export const updateMeasurementEntrySchema = z
  .object({
    measuredAt: measuredAtSchema.optional(),
    notes: notesSchema.nullable().optional(),
    readings: readingsSchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.measuredAt !== undefined || body.notes !== undefined || body.readings !== undefined,
    { message: 'At least one of measuredAt, notes or readings is required' },
  )
  // The blood-pressure pair rule is checked by the service on the MERGED
  // entry: a PATCH may carry only the systolic of an existing pair.
  .superRefine((body, ctx) =>
    checkReadings(body.readings, ctx, { requireBloodPressurePair: false }),
  )
  .transform((body) => ({
    measuredAt: body.measuredAt,
    notes: body.notes,
    readings: body.readings?.map(normalize),
  }))
  .meta({
    description:
      'Changes to an entry. At least one property. Readings not mentioned are copied unchanged; `readings[].metricKey` must already be in the entry; `notes: null` clears the notes.',
  });

export class UpdateMeasurementEntryDto extends createZodDto(updateMeasurementEntrySchema) {}
export type UpdateMeasurementEntryInput = z.output<typeof updateMeasurementEntrySchema>;

// -----------------------------------------------------------------------------
// Query strings
// -----------------------------------------------------------------------------

/** The categories `GET /api/measurements` can filter by (wellness is served by check-ins). */
export const LIST_CATEGORIES = ['body', 'vital', 'lab'] as const;

const queryDateSchema = (name: string) =>
  z.iso
    .datetime({ offset: true, message: `${name} must be an ISO 8601 date-time` })
    .transform((value) => new Date(value));

export const listMeasurementsQuerySchema = z
  .object({
    metricKey: z
      .string()
      .refine(isMeasurementMetric, { message: 'metricKey must be a body, vital or lab metric' })
      .optional(),
    category: z
      .enum(LIST_CATEGORIES)
      .optional()
      .meta({ description: 'Only this category. Omitted (and no `metricKey`) = body and vital.' }),
    from: queryDateSchema('from').optional(),
    to: queryDateSchema('to').optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIST_PAGE_SIZE_MAX)
      .default(LIST_PAGE_SIZE_DEFAULT),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ['from'],
    message: 'from must not be later than to',
  });

/**
 * The metric keys a list query covers: one `metricKey` (inside `category`
 * when both are given), a whole `category`, or by default body and vital.
 */
export function listMetricKeys(query: Pick<ListMeasurementsQuery, 'metricKey' | 'category'>): string[] {
  const inCategory = query.category
    ? (METRICS as ReadonlyArray<{ key: string; category: string }>)
        .filter((metric) => metric.category === query.category)
        .map((metric) => metric.key)
    : null;

  if (query.metricKey) {
    return !inCategory || inCategory.includes(query.metricKey) ? [query.metricKey] : [];
  }

  return inCategory ?? [...MEASUREMENT_METRIC_KEYS];
}

export class ListMeasurementsQueryDto extends createZodDto(listMeasurementsQuerySchema) {}
export type ListMeasurementsQuery = z.output<typeof listMeasurementsQuerySchema>;

export const seriesQuerySchema = z
  .object({
    metricKey: z.string().refine(isMetricKey, { message: 'Unknown metricKey' }),
    from: queryDateSchema('from').optional(),
    to: queryDateSchema('to').optional(),
  })
  .transform((query) => {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - SERIES_DEFAULT_DAYS * DAY_MS);
    return { metricKey: query.metricKey, from, to };
  })
  .superRefine((query, ctx) => {
    if (query.from > query.to) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'from must not be later than to' });
    } else if (query.to.getTime() - query.from.getTime() > SERIES_MAX_RANGE_DAYS * DAY_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: `The range must not be wider than ${SERIES_MAX_RANGE_DAYS} days (5 years)`,
      });
    }
  });

export class SeriesQueryDto extends createZodDto(seriesQuerySchema) {}
export type SeriesQuery = z.output<typeof seriesQuerySchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const measurementSchema = z.object({
  id: z.uuid(),
  entryId: z.uuid(),
  metricKey: z.string(),
  value: z.number().meta({ description: 'In the canonical unit, rounded to 4 decimals.' }),
  unit: z.string().meta({ description: "The metric's canonical unit." }),
  measuredAt: z.iso.datetime(),
  method: z.string(),
  origin: z
    .string()
    .meta({ description: '`manual` for everything written through this API; set by the server only.' }),
  notes: z.string().nullable(),
  referenceLow: z
    .number()
    .nullable()
    .meta({ description: "Lab metrics: the lab's lower reference limit in the canonical unit; null when not given." }),
  referenceHigh: z
    .number()
    .nullable()
    .meta({ description: "Lab metrics: the lab's upper reference limit in the canonical unit; null when not given." }),
  referenceText: z
    .string()
    .nullable()
    .meta({ description: 'Lab metrics: the range as printed (`<100`, `negative`); null when not given.' }),
  flag: z.enum(MEASUREMENT_FLAGS).nullable().meta({ description: "Lab metrics: the lab's flag; null when not given." }),
  sourceRef: z
    .record(z.string(), z.unknown())
    .nullable()
    .meta({ description: 'Provenance written by server code (photo intake); null otherwise.' }),
  fileDeleted: z
    .boolean()
    .nullable()
    .meta({
      description:
        "Whether the file this reading was read from (`sourceRef.healthDocumentId`) was erased (delete after processing); " +
        'null when the reading names no health document.',
    }),
  revision: z.number().int(),
  edited: z.boolean().meta({ description: '`revision > 1`.' }),
});

export class MeasurementDto extends createZodDto(measurementSchema) {}
export type Measurement = z.infer<typeof measurementSchema>;

export const measurementEntrySchema = z.object({
  entryId: z.uuid(),
  items: z.array(measurementSchema),
});

export class MeasurementEntryDto extends createZodDto(measurementEntrySchema) {}
export type MeasurementEntry = z.infer<typeof measurementEntrySchema>;

export const latestMeasurementsSchema = z.object({
  items: z.array(
    z.object({
      metricKey: z.string(),
      latest: measurementSchema.nullable(),
      previous: measurementSchema.nullable(),
    }),
  ),
});

export class LatestMeasurementsDto extends createZodDto(latestMeasurementsSchema) {}
export type LatestMeasurements = z.infer<typeof latestMeasurementsSchema>;

export const measurementSeriesSchema = z.object({
  metricKey: z.string(),
  unit: z.string(),
  points: z.array(
    z.object({
      id: z.uuid(),
      measuredAt: z.iso.datetime(),
      value: z.number(),
      method: z.string(),
      origin: z.string(),
    }),
  ),
  truncated: z
    .boolean()
    .meta({ description: `True when the range held more than ${SERIES_MAX_POINTS} points; the newest are kept.` }),
});

export class MeasurementSeriesDto extends createZodDto(measurementSeriesSchema) {}
export type MeasurementSeries = z.infer<typeof measurementSeriesSchema>;

const unitDefSchema = z.object({
  unit: z.string(),
  factor: z.number(),
  offset: z.number().meta({ description: 'Added after `factor`; 0 for every unit but HbA1c in mmol/mol.' }),
  label: z.string(),
});

export const metricCatalogSchema = z.object({
  metrics: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      category: z.enum(METRIC_CATEGORIES),
      canonicalUnit: z.string(),
      units: z
        .array(unitDefSchema)
        .meta({
          description:
            'Allowed units; canonical = value in `unit` x `factor` + `offset`. The first unit is the canonical one.',
        }),
      displayUnit: z.object({ metric: z.string(), imperial: z.string() }),
      min: z.number(),
      max: z.number(),
      decimals: z.number().int(),
      methods: z.array(z.string()),
      scale: z
        .object({
          min: z.number(),
          max: z.number(),
          lowLabel: z.string(),
          highLabel: z.string(),
        })
        .nullable(),
      daily: z.boolean(),
      panel: z
        .enum(LAB_PANELS)
        .nullable()
        .meta({ description: 'Lab analytes: the panel it is shown under; null for other categories.' }),
      aliases: z
        .array(z.string())
        .meta({ description: 'Lab analytes: other names labs print for it; empty for other categories.' }),
    }),
  ),
  methods: z.array(z.object({ key: z.string(), label: z.string() })),
});

export class MetricCatalogDto extends createZodDto(metricCatalogSchema) {}
