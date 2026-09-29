import { z } from 'zod';

import {
  getMetric,
  isMethodAllowed,
  isWithinBounds,
  MetricRegistryError,
  toCanonical,
  unitFor,
} from '../metric-registry';

// =============================================================================
// The `body_metric_reading` draft item value (E2.6, #64)
// =============================================================================
//
// One reading as DISPLAYED ON THE DEVICE: `unit` is the device's unit, and the
// conversion to the metric's canonical unit happens once, at apply. The six
// body/vital metrics a scale, a smart scale or a blood-pressure cuff shows;
// wellness scores are never read from a photo.
//
// Pure data and pure functions (no Nest, no Prisma), shared by the intake
// kind (validation, apply), the job's mapper (bounds flagging) and
// `MeasurementsService.updateEntry` (the `userEdited` recompute).
//
// ⚠ Messages name the field and the rule, NEVER the value: a health value must
// not be echoed into a response or a log.
// =============================================================================

/** PERMANENT once `photo_intakes` rows carry it. */
export const BODY_METRIC_READING_KIND = 'body_metric_reading';

/** PERMANENT once jobs of this type exist. */
export const BODY_METRIC_READING_JOB_TYPE = 'ai.health.body_metric_reading';

/** The one `DraftItem.kind` inside this intake kind. */
export const BODY_METRIC_READING_ITEM_KIND = 'reading';

export const BODY_METRIC_READING_MAX_PHOTOS = 4;

/** The metrics a device display can show, in registry order. */
export const PHOTO_METRIC_KEYS = [
  'weight',
  'body_fat_pct',
  'waist_circumference',
  'bp_systolic',
  'bp_diastolic',
  'resting_hr',
] as const;

export type PhotoMetricKey = (typeof PHOTO_METRIC_KEYS)[number];

export const bodyMetricReadingValueSchema = z
  .object({
    metricKey: z.enum(PHOTO_METRIC_KEYS).meta({ description: 'The metric the reading is for.' }),
    value: z
      .number()
      .refine(Number.isFinite, { message: 'value must be a finite number' })
      .meta({ description: 'The number as displayed, in `unit`.' }),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .meta({ description: "The unit as displayed on the device; one of the metric's `units` to be saved." }),
    method: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .optional()
      .meta({ description: "How it was measured; one of the metric's `methods`. Omitted = `unspecified`." }),
  })
  .strict();

export type BodyMetricReadingValue = z.output<typeof bodyMetricReadingValueSchema>;

/** One broken rule of a reading, at the field of the value it concerns. */
export interface ReadingProblem {
  field: 'metricKey' | 'value' | 'unit' | 'method';
  message: string;
}

/**
 * The metric's own spelling of `unit` when it matches one of the metric's
 * units ignoring case and spaces (`KG` -> `kg`, `mm Hg` -> `mmHg`, `BPM` ->
 * `bpm`); otherwise `unit` unchanged.
 */
export function canonicalUnitSpelling(metricKey: string, unit: string): string {
  const metric = getMetric(metricKey);
  const squash = (text: string) => text.replace(/\s+/g, '').toLowerCase();
  const wanted = squash(unit);

  return metric?.units.find((candidate) => squash(candidate.unit) === wanted)?.unit ?? unit;
}

/** The label a person reads for a metric (`Weight`), or the key. */
export function metricLabel(metricKey: string): string {
  return getMetric(metricKey)?.label ?? metricKey;
}

/** The note a reading outside the metric's hard bounds carries. */
export function outOfRangeNote(metricKey: string): string {
  return `Outside the usual range for ${metricLabel(metricKey).toLowerCase()}`;
}

/**
 * The value in the metric's canonical unit, or null when the unit is not
 * one the metric allows (or the number is not finite).
 */
export function canonicalValueOf(value: Pick<BodyMetricReadingValue, 'metricKey' | 'value' | 'unit'>): number | null {
  try {
    return toCanonical(value.metricKey, value.value, value.unit);
  } catch (error) {
    if (error instanceof MetricRegistryError) return null;
    throw error;
  }
}

/**
 * Every registry rule the reading breaks, in field order: the unit is one the
 * metric allows, the method is one the metric allows, and the value is inside
 * the hard bounds once converted. Empty = the reading can be saved.
 */
export function readingProblems(value: BodyMetricReadingValue): ReadingProblem[] {
  const problems: ReadingProblem[] = [];
  const label = metricLabel(value.metricKey);

  if (!unitFor(value.metricKey, value.unit)) {
    const allowed = getMetric(value.metricKey)?.units.map((unit) => unit.unit).join(', ') ?? '';
    problems.push({ field: 'unit', message: `unit must be one of ${allowed} for ${label.toLowerCase()}` });
  }

  if (value.method !== undefined && !isMethodAllowed(value.metricKey, value.method)) {
    problems.push({ field: 'method', message: `method is not allowed for ${label.toLowerCase()}` });
  }

  const canonical = canonicalValueOf(value);

  if (canonical !== null && !isWithinBounds(value.metricKey, canonical)) {
    const metric = getMetric(value.metricKey)!;
    problems.push({
      field: 'value',
      message: `value is outside the allowed range for ${label.toLowerCase()} (${metric.min} to ${metric.max} ${metric.canonicalUnit})`,
    });
  }

  return problems;
}

/**
 * Whether two readings say the same thing: the same metric and the same
 * canonical value (so `208.4 lb` and its kg equivalent agree). A reading
 * whose unit cannot be converted never equals anything.
 */
export function sameReading(
  a: Pick<BodyMetricReadingValue, 'metricKey' | 'value' | 'unit'>,
  b: Pick<BodyMetricReadingValue, 'metricKey' | 'value' | 'unit'>,
): boolean {
  if (a.metricKey !== b.metricKey) return false;

  const left = canonicalValueOf(a);
  const right = canonicalValueOf(b);

  return left !== null && right !== null && left === right;
}
