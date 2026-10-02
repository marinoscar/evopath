import { z } from 'zod';

import { MEASUREMENT_FLAGS, REFERENCE_TEXT_MAX } from '../dto/measurement.dto';
import {
  getMetric,
  isLabMetric,
  isWithinBounds,
  LAB_PANELS,
  MetricRegistryError,
  resolveLabAnalyte,
  toCanonical,
  unitFor,
} from '../metric-registry';

// =============================================================================
// The `lab_report` draft item value and intake context (H4, #188)
// =============================================================================
//
// One lab result as read off a report, after the SERVER matched it to the lab
// catalog and converted it:
//
//   - `analyteKey` is the catalog key the server resolved from the printed
//     name (`resolveLabAnalyte`), or null = UNMATCHED. An unmatched result is
//     never dropped: it stays in the review, and `apply` refuses the intake
//     (409 `UNRESOLVED_ANALYTES`) until the user maps it to a catalog key
//     (an edit) or rejects it.
//   - `value`, `unit` and the reference limits are in the analyte's
//     CANONICAL unit once matched and convertible; `originalValue` and
//     `originalUnit` keep what the report printed.
//   - `match` says how the key was found: `matched` (the printed name is a
//     catalog key, label or alias), `suggested` (the printed name matched
//     nothing and the model's own key suggestion is a valid catalog key; shown
//     uncertain for the user to confirm), `user_mapped` (a user edit set a key
//     the printed name does not resolve to) or `unmatched`.
//   - `collectionDate` is the result's OWN specimen date (#305): a trend or
//     cumulative report prints one column per collection date, so one intake
//     carries the same analyte on several dates. Null = the result uses the
//     report date (the context's `collectionDate`), else the time of apply.
//     Validated like the context date; a draft stored before the field
//     existed parses with it null.
//
// The document-level fields (report date, lab name) live on the intake's
// CONTEXT, so the user can correct them with `PATCH /api/intakes/:id`; the
// analyzer job fills them from the report. `effectiveCollectionDate` is the
// one rule that combines the two.
//
// Pure data and pure functions (no Nest, no Prisma).
//
// ⚠ Messages name the field and the rule, NEVER the value: a health value must
// not be echoed into a response or a log.
// =============================================================================

/** PERMANENT once `photo_intakes` rows carry it. */
export const LAB_REPORT_KIND = 'lab_report';

/** PERMANENT once jobs of this type exist. */
export const LAB_REPORT_JOB_TYPE = 'ai.health.lab_report';

/** The one `DraftItem.kind` inside this intake kind. */
export const LAB_REPORT_ITEM_KIND = 'result';

/** Multi-page paper reports are photographed page by page; a PDF counts as one. */
export const LAB_REPORT_MAX_PHOTOS = 10;

export const LAB_NAME_MAX = 120;
export const LAB_UNIT_MAX = 24;
export const LAB_VALUE_TEXT_MAX = 40;

export const LAB_MATCH_STATUSES = ['matched', 'suggested', 'user_mapped', 'unmatched'] as const;
export type LabMatchStatus = (typeof LAB_MATCH_STATUSES)[number];

const finiteNumber = z.number().refine(Number.isFinite, { message: 'must be a finite number' });

export const labReportValueSchema = z
  .object({
    analyteKey: z
      .string()
      .min(1)
      .max(64)
      .refine(isLabMetric, { message: 'analyteKey must be a lab analyte key from GET /api/measurements/metrics' })
      .nullable()
      .default(null)
      .meta({ description: 'The catalog analyte (category `lab`), or null while the result is unmatched.' }),
    nameAsPrinted: z
      .string()
      .trim()
      .min(1)
      .max(LAB_NAME_MAX)
      .nullable()
      .default(null)
      .meta({ description: 'The analyte name as printed on the report. Null on a user-added result = the analyte label.' }),
    value: finiteNumber
      .nullable()
      .default(null)
      .meta({ description: 'The numeric result, in `unit` (canonical once matched). Null when the report printed no number.' }),
    valueText: z
      .string()
      .trim()
      .max(LAB_VALUE_TEXT_MAX)
      .nullable()
      .default(null)
      .meta({ description: 'A non-numeric result as printed (`negative`, `<0.5`); informative only, never saved.' }),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(LAB_UNIT_MAX)
      .nullable()
      .default(null)
      .meta({ description: "The unit of `value`: the analyte's canonical unit once matched and convertible." }),
    originalValue: finiteNumber.nullable().default(null).meta({ description: 'The value as printed.' }),
    originalUnit: z.string().trim().min(1).max(LAB_UNIT_MAX).nullable().default(null).meta({ description: 'The unit as printed.' }),
    referenceLow: finiteNumber.nullable().default(null).meta({ description: 'Lower reference limit, in `unit`.' }),
    referenceHigh: finiteNumber.nullable().default(null).meta({ description: 'Upper reference limit, in `unit`.' }),
    referenceText: z
      .string()
      .trim()
      .max(REFERENCE_TEXT_MAX)
      .nullable()
      .default(null)
      .meta({ description: `The reference range as printed, at most ${REFERENCE_TEXT_MAX} characters.` }),
    flag: z.enum(MEASUREMENT_FLAGS).nullable().default(null).meta({ description: "The lab's own flag on the result." }),
    panel: z
      .enum(LAB_PANELS)
      .nullable()
      .default(null)
      .meta({ description: "The panel the result is grouped under: the analyte's panel once matched, else a hint." }),
    match: z
      .enum(LAB_MATCH_STATUSES)
      .default('unmatched')
      .meta({ description: 'How `analyteKey` was found. Recomputed by the server on every user write.' }),
    collectionDate: z
      .string()
      .refine((text) => isCollectionDate(text), {
        message: 'collectionDate must be a date YYYY-MM-DD, not before 1900-01-01 and not in the future',
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "The result's own specimen collection date (`YYYY-MM-DD`), e.g. one column of a trend report. " +
          "Null = the intake context's `collectionDate` applies, else the time of apply.",
      }),
  })
  .strict();

export type LabReportValue = z.output<typeof labReportValueSchema>;

// -----------------------------------------------------------------------------
// Context: the document-level fields
// -----------------------------------------------------------------------------

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const EARLIEST_DATE = '1900-01-01';

/**
 * Whether `text` is a real calendar date `YYYY-MM-DD`, not before 1900 and
 * not after tomorrow (UTC; a user east of UTC may already be a day ahead).
 */
export function isCollectionDate(text: string, now: Date = new Date()): boolean {
  const match = DATE_PATTERN.exec(text);
  if (!match) return false;

  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  if (text < EARLIEST_DATE) return false;

  return date.getTime() <= now.getTime() + DAY_MS;
}

export const labReportContextSchema = z
  .object({
    collectionDate: z
      .string()
      .refine((text) => isCollectionDate(text), {
        message: 'collectionDate must be a date YYYY-MM-DD, not before 1900-01-01 and not in the future',
      })
      .nullable()
      .optional()
      .meta({
        description:
          'The report date (specimen collection date): results without their own `collectionDate` are dated with it. ' +
          'Filled by the analyzer.',
      }),
    labName: z
      .string()
      .trim()
      .max(LAB_NAME_MAX)
      .transform((text) => (text === '' ? null : text))
      .nullable()
      .optional()
      .meta({ description: 'The laboratory or provider that issued the report. Filled by the analyzer.' }),
  })
  .strict()
  .optional();

export type LabReportContext = z.output<typeof labReportContextSchema>;

/**
 * The `measuredAt` of results collected on `date`: noon UTC that day (so the
 * date reads the same in most time zones), never later than `now`.
 */
export function measuredAtFor(date: string, now: Date = new Date()): Date {
  const [y, m, d] = date.split('-').map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  return noon.getTime() > now.getTime() ? now : noon;
}

/** The UTC day `[start, end)` a date string names. */
export function utcDay(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * The date a result is saved under: its own `collectionDate`, else the
 * report date from the context, else null (dated at apply time).
 */
export function effectiveCollectionDate(
  value: Pick<LabReportValue, 'collectionDate'>,
  context: LabReportContext | null | undefined,
): string | null {
  return value.collectionDate ?? context?.collectionDate ?? null;
}

/** Today as `YYYY-MM-DD` (UTC). */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Matching and conversion
// -----------------------------------------------------------------------------

/** How `analyteKey` relates to the printed name (the server's rule, never the client's). */
export function matchOf(analyteKey: string | null, nameAsPrinted: string | null): LabMatchStatus {
  if (!analyteKey) return 'unmatched';
  return nameAsPrinted && resolveLabAnalyte(nameAsPrinted)?.key === analyteKey ? 'matched' : 'user_mapped';
}

/**
 * The value in the analyte's canonical unit: `value` and the reference limits
 * converted, `unit` spelled canonically, `panel` the analyte's. The printed
 * value and unit are kept in `originalValue`/`originalUnit` (set here only
 * when they were not yet). Unchanged when unmatched, when `unit` is null or
 * when the analyte does not allow `unit` (the caller flags it).
 */
export function toCanonicalLabValue(value: LabReportValue): LabReportValue {
  if (!value.analyteKey) return value;

  const metric = getMetric(value.analyteKey);
  if (!metric) return value;

  const withPanel: LabReportValue = { ...value, panel: metric.panel ?? value.panel };
  if (value.unit === null) return withPanel;

  const unitDef = unitFor(value.analyteKey, value.unit);
  if (!unitDef) return withPanel;

  if (unitDef.unit === metric.canonicalUnit) return { ...withPanel, unit: metric.canonicalUnit };

  const convert = (n: number | null) => (n === null ? null : toCanonical(value.analyteKey!, n, unitDef.unit));

  return {
    ...withPanel,
    value: convert(value.value),
    unit: metric.canonicalUnit,
    referenceLow: convert(value.referenceLow),
    referenceHigh: convert(value.referenceHigh),
    originalValue: value.originalUnit === null ? value.value : value.originalValue,
    originalUnit: value.originalUnit ?? value.unit,
  };
}

/** One broken rule of a MATCHED result, at the field it concerns. */
export interface LabResultProblem {
  field: 'value' | 'unit' | 'referenceLow';
  message: string;
}

/** The label a person reads for an analyte, or the key. */
export function analyteLabel(analyteKey: string): string {
  return getMetric(analyteKey)?.label ?? analyteKey;
}

/**
 * Every rule a matched result breaks: a unit the analyte allows, a value
 * inside its hard bounds once converted, reference limits in order.
 * `requireValue` adds "no numeric value" (apply); a review edit may map an
 * analyte before entering a number. Empty = the result can be saved.
 */
export function labResultProblems(value: LabReportValue, options: { requireValue: boolean }): LabResultProblem[] {
  if (!value.analyteKey) return [];

  const problems: LabResultProblem[] = [];
  const key = value.analyteKey;
  const label = analyteLabel(key);
  const metric = getMetric(key)!;
  const unitDef = value.unit === null ? undefined : unitFor(key, value.unit);

  if (!unitDef) {
    problems.push({
      field: 'unit',
      message: `unit must be one of ${metric.units.map((unit) => unit.unit).join(', ')} for ${label}`,
    });
  }

  if (value.value === null) {
    if (options.requireValue) problems.push({ field: 'value', message: `${label} has no numeric value; enter one or reject it` });
  } else if (unitDef) {
    const canonical = canonicalOf(key, value.value, unitDef.unit);
    if (canonical === null || !isWithinBounds(key, canonical)) {
      problems.push({
        field: 'value',
        message: `value is outside the allowed range for ${label} (${metric.min} to ${metric.max} ${metric.canonicalUnit})`,
      });
    }
  }

  if (value.referenceLow !== null && value.referenceHigh !== null && value.referenceLow > value.referenceHigh) {
    problems.push({ field: 'referenceLow', message: 'referenceLow must not be higher than referenceHigh' });
  }

  return problems;
}

function canonicalOf(key: string, value: number, unit: string): number | null {
  try {
    return toCanonical(key, value, unit);
  } catch (error) {
    if (error instanceof MetricRegistryError) return null;
    throw error;
  }
}

/** The result's value in the canonical unit, or null (unmatched, no number, or a unit the analyte does not allow). */
export function canonicalLabValueOf(value: Pick<LabReportValue, 'analyteKey' | 'value' | 'unit'>): number | null {
  if (!value.analyteKey || value.value === null || value.unit === null) return null;
  return canonicalOf(value.analyteKey, value.value, value.unit);
}

/**
 * Whether two results say the same thing: same analyte, same collection date,
 * same canonical value, same reference limits, text and flag. Used for
 * `userEdited` (moving a result to another date is an edit).
 */
export function sameLabResult(a: LabReportValue, b: LabReportValue): boolean {
  if (a.analyteKey !== b.analyteKey) return false;
  if ((a.collectionDate ?? null) !== (b.collectionDate ?? null)) return false;

  const left = canonicalLabValueOf(a);
  const right = canonicalLabValueOf(b);
  if (left === null || right === null || left !== right) return false;

  const limit = (v: LabReportValue, n: number | null) =>
    n === null || !v.analyteKey || v.unit === null ? n : canonicalOf(v.analyteKey, n, v.unit);

  return (
    limit(a, a.referenceLow) === limit(b, b.referenceLow) &&
    limit(a, a.referenceHigh) === limit(b, b.referenceHigh) &&
    (a.referenceText ?? null) === (b.referenceText ?? null) &&
    (a.flag ?? null) === (b.flag ?? null)
  );
}
