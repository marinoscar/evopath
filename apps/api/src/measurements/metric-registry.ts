// =============================================================================
// Metric registry — the vocabulary of the `measurements` table (E2.2, #50)
// =============================================================================
//
// `measurements.metric_key`, `.method` and `.unit` are plain strings on
// purpose: this file (plus the Zod schemas built on it) owns the vocabulary,
// so a new metric or method needs no migration — the same reason `Job.type` is
// a string.
//
// Every value is STORED in the metric's canonical unit. The API converts once
// on write (`toCanonical`), rounds to 4 decimals, and publishes the factors in
// `GET /api/measurements/metrics` (`catalogView`) so the web app never keeps a
// second copy of them.
//
// Deliberately free of Nest and Prisma imports: it is pure data plus pure
// functions, trivially unit-testable, and importable from any later feature
// (check-ins, photo intake) without pulling in a module.
// =============================================================================

export const METRIC_CATEGORIES = ['body', 'vital', 'wellness'] as const;
export type MetricCategory = (typeof METRIC_CATEGORIES)[number];

/**
 * How a value was physically measured (VISION §18). One shared list; each
 * metric allows a subset. Order is display order.
 */
export const MEASUREMENT_METHODS = [
  { key: 'unspecified', label: 'Not specified' },
  { key: 'scale', label: 'Scale' },
  { key: 'smart_scale', label: 'Smart scale' },
  { key: 'bia', label: 'Bioelectrical impedance (BIA)' },
  { key: 'dexa', label: 'DEXA scan' },
  { key: 'air_displacement', label: 'Air displacement' },
  { key: 'skinfold', label: 'Skinfold calipers' },
  { key: 'hydrostatic', label: 'Hydrostatic weighing' },
  { key: 'tape', label: 'Tape measure' },
  { key: 'bp_cuff', label: 'Blood-pressure cuff' },
  { key: 'manual_pulse', label: 'Manual pulse' },
  { key: 'wearable', label: 'Wearable' },
  { key: 'clinical', label: 'Clinical' },
  { key: 'self_report', label: 'Self-report' },
  { key: 'other', label: 'Other' },
] as const;

export type MeasurementMethod = (typeof MEASUREMENT_METHODS)[number]['key'];

/** The method a reading gets when the client names none. */
export const DEFAULT_METHOD: MeasurementMethod = 'unspecified';

/**
 * How a value entered the system — never the same thing as `method`. Only
 * server code sets it: `manual` for everything written through
 * `/api/measurements`; `ai` when an accepted photo-intake draft is applied.
 */
export const MEASUREMENT_ORIGINS = ['manual', 'calculated', 'ai', 'device'] as const;
export type MeasurementOrigin = (typeof MEASUREMENT_ORIGINS)[number];

export interface MetricUnitDef {
  unit: string;
  /** Multiply a value in `unit` by this to get the canonical unit. */
  factor: number;
  label: string;
}

export interface MetricScaleDef {
  min: number;
  max: number;
  lowLabel: string;
  highLabel: string;
}

export interface MetricDef {
  key: string;
  label: string;
  category: MetricCategory;
  canonicalUnit: string;
  units: readonly MetricUnitDef[];
  displayUnit: { metric: string; imperial: string };
  /** Hard bounds, inclusive, in the canonical unit. */
  min: number;
  max: number;
  /** Display precision. */
  decimals: number;
  methods: readonly MeasurementMethod[];
  scale?: MetricScaleDef;
  /** One value per local day (check-in scores); stored with `localDate`. */
  daily: boolean;
}

const BODY_WEIGHT_METHODS = ['unspecified', 'scale', 'smart_scale', 'clinical', 'other'] as const;
const BODY_FAT_METHODS = [
  'unspecified',
  'smart_scale',
  'bia',
  'skinfold',
  'dexa',
  'air_displacement',
  'hydrostatic',
  'other',
] as const;
const WAIST_METHODS = ['unspecified', 'tape', 'other'] as const;
const BP_METHODS = ['unspecified', 'bp_cuff', 'clinical', 'wearable', 'other'] as const;
const RESTING_HR_METHODS = ['unspecified', 'wearable', 'bp_cuff', 'manual_pulse', 'other'] as const;
const WELLNESS_METHODS = ['self_report'] as const;

const SCORE_UNITS = [{ unit: 'score', factor: 1, label: 'score' }] as const;
const SCORE_DISPLAY = { metric: 'score', imperial: 'score' } as const;

function wellness(
  key: string,
  label: string,
  lowLabel: string,
  highLabel: string,
): MetricDef {
  return {
    key,
    label,
    category: 'wellness',
    canonicalUnit: 'score',
    units: SCORE_UNITS,
    displayUnit: SCORE_DISPLAY,
    min: 1,
    max: 5,
    decimals: 0,
    methods: WELLNESS_METHODS,
    scale: { min: 1, max: 5, lowLabel, highLabel },
    daily: true,
  };
}

/**
 * The ten metrics of the epic's catalog, in display order. Appending a metric
 * here is the whole of "add a metric"; renaming a `key` is not allowed once
 * rows carry it (it is stored).
 */
export const METRICS = [
  {
    key: 'weight',
    label: 'Weight',
    category: 'body',
    canonicalUnit: 'kg',
    units: [
      { unit: 'kg', factor: 1, label: 'kg' },
      { unit: 'lb', factor: 0.45359237, label: 'lb' },
    ],
    displayUnit: { metric: 'kg', imperial: 'lb' },
    min: 20,
    max: 500,
    decimals: 1,
    methods: BODY_WEIGHT_METHODS,
    daily: false,
  },
  {
    key: 'body_fat_pct',
    label: 'Body fat',
    category: 'body',
    canonicalUnit: '%',
    units: [{ unit: '%', factor: 1, label: '%' }],
    displayUnit: { metric: '%', imperial: '%' },
    min: 2,
    max: 70,
    decimals: 1,
    methods: BODY_FAT_METHODS,
    daily: false,
  },
  {
    key: 'waist_circumference',
    label: 'Waist',
    category: 'body',
    canonicalUnit: 'cm',
    units: [
      { unit: 'cm', factor: 1, label: 'cm' },
      { unit: 'in', factor: 2.54, label: 'in' },
    ],
    displayUnit: { metric: 'cm', imperial: 'in' },
    min: 30,
    max: 250,
    decimals: 1,
    methods: WAIST_METHODS,
    daily: false,
  },
  {
    key: 'bp_systolic',
    label: 'Systolic pressure',
    category: 'vital',
    canonicalUnit: 'mmHg',
    units: [{ unit: 'mmHg', factor: 1, label: 'mmHg' }],
    displayUnit: { metric: 'mmHg', imperial: 'mmHg' },
    min: 60,
    max: 260,
    decimals: 0,
    methods: BP_METHODS,
    daily: false,
  },
  {
    key: 'bp_diastolic',
    label: 'Diastolic pressure',
    category: 'vital',
    canonicalUnit: 'mmHg',
    units: [{ unit: 'mmHg', factor: 1, label: 'mmHg' }],
    displayUnit: { metric: 'mmHg', imperial: 'mmHg' },
    min: 30,
    max: 160,
    decimals: 0,
    methods: BP_METHODS,
    daily: false,
  },
  {
    key: 'resting_hr',
    label: 'Resting heart rate',
    category: 'vital',
    canonicalUnit: 'bpm',
    units: [{ unit: 'bpm', factor: 1, label: 'bpm' }],
    displayUnit: { metric: 'bpm', imperial: 'bpm' },
    min: 25,
    max: 220,
    decimals: 0,
    methods: RESTING_HR_METHODS,
    daily: false,
  },
  wellness('energy', 'Energy', 'Drained', 'Energised'),
  wellness('sleep_quality', 'Sleep quality', 'Poor', 'Great'),
  wellness('muscle_soreness', 'Muscle soreness', 'None', 'Severe'),
  wellness('stress', 'Stress', 'Calm', 'Overwhelmed'),
] as const satisfies readonly MetricDef[];

export type MetricKey = (typeof METRICS)[number]['key'];

/** The blood-pressure pair: submitted together, systolic above diastolic. */
export const BP_SYSTOLIC = 'bp_systolic';
export const BP_DIASTOLIC = 'bp_diastolic';

/** Metrics written through `/api/measurements` (body and vital), registry order. */
export const MEASUREMENT_METRIC_KEYS: readonly string[] = METRICS.filter(
  (metric) => metric.category !== 'wellness',
).map((metric) => metric.key);

const BY_KEY: ReadonlyMap<string, MetricDef> = new Map(
  (METRICS as readonly MetricDef[]).map((metric) => [metric.key, metric]),
);

const METHOD_LABELS: ReadonlyMap<string, string> = new Map(
  MEASUREMENT_METHODS.map((method) => [method.key, method.label]),
);

/** Decimal places every canonical value is rounded to on write. */
export const CANONICAL_DECIMALS = 4;

/** Thrown by the helpers below; callers map it to a 400 naming the field. */
export class MetricRegistryError extends Error {
  constructor(
    readonly reason: 'unknown_metric' | 'unknown_unit' | 'not_finite',
    message: string,
  ) {
    super(message);
    this.name = 'MetricRegistryError';
  }
}

export function getMetric(key: string): MetricDef | undefined {
  return BY_KEY.get(key);
}

export function isMetricKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** A body or vital metric: one `/api/measurements` accepts. */
export function isMeasurementMetric(key: string): boolean {
  const metric = BY_KEY.get(key);
  return metric !== undefined && metric.category !== 'wellness';
}

export function methodsFor(key: string): readonly string[] {
  return BY_KEY.get(key)?.methods ?? [];
}

export function isMethodAllowed(key: string, method: string): boolean {
  return methodsFor(key).includes(method);
}

export function unitFor(key: string, unit: string): MetricUnitDef | undefined {
  return BY_KEY.get(key)?.units.find((candidate) => candidate.unit === unit);
}

export function roundCanonical(value: number): number {
  const scale = 10 ** CANONICAL_DECIMALS;
  const rounded = Math.round(value * scale) / scale;
  // Normalise -0 so it serialises as 0.
  return rounded === 0 ? 0 : rounded;
}

/**
 * Converts `value` in `unit` (omitted = canonical) to the metric's canonical
 * unit, rounded to {@link CANONICAL_DECIMALS}. Throws
 * {@link MetricRegistryError} for an unknown metric or a unit the metric does
 * not allow. Does NOT check bounds: see {@link isWithinBounds}.
 */
export function toCanonical(key: string, value: number, unit?: string): number {
  const metric = BY_KEY.get(key);

  if (!metric) {
    throw new MetricRegistryError('unknown_metric', `Unknown metric ${key}`);
  }

  if (!Number.isFinite(value)) {
    throw new MetricRegistryError('not_finite', 'value must be a finite number');
  }

  const unitDef = metric.units.find((candidate) => candidate.unit === (unit ?? metric.canonicalUnit));

  if (!unitDef) {
    throw new MetricRegistryError('unknown_unit', `Unit is not allowed for ${key}`);
  }

  return roundCanonical(value * unitDef.factor);
}

/** Canonical value -> `unit`, unrounded (display code rounds to `decimals`). */
export function fromCanonical(key: string, canonicalValue: number, unit: string): number {
  const unitDef = unitFor(key, unit);

  if (!unitDef) {
    throw new MetricRegistryError('unknown_unit', `Unit is not allowed for ${key}`);
  }

  return canonicalValue / unitDef.factor;
}

/** Whether a CANONICAL value lies inside the metric's hard bounds (inclusive). */
export function isWithinBounds(key: string, canonicalValue: number): boolean {
  const metric = BY_KEY.get(key);
  return (
    metric !== undefined &&
    Number.isFinite(canonicalValue) &&
    canonicalValue >= metric.min &&
    canonicalValue <= metric.max
  );
}

export function methodLabel(method: string): string | undefined {
  return METHOD_LABELS.get(method);
}

export interface MetricCatalogView {
  metrics: Array<{
    key: string;
    label: string;
    category: MetricCategory;
    canonicalUnit: string;
    units: MetricUnitDef[];
    displayUnit: { metric: string; imperial: string };
    min: number;
    max: number;
    decimals: number;
    methods: string[];
    scale: MetricScaleDef | null;
    daily: boolean;
  }>;
  methods: Array<{ key: string; label: string }>;
}

/** What `GET /api/measurements/metrics` returns: plain, mutable JSON copies. */
export function catalogView(): MetricCatalogView {
  return {
    metrics: (METRICS as readonly MetricDef[]).map((metric) => ({
      key: metric.key,
      label: metric.label,
      category: metric.category,
      canonicalUnit: metric.canonicalUnit,
      units: metric.units.map((unit) => ({ ...unit })),
      displayUnit: { ...metric.displayUnit },
      min: metric.min,
      max: metric.max,
      decimals: metric.decimals,
      methods: [...metric.methods],
      scale: metric.scale ? { ...metric.scale } : null,
      daily: metric.daily,
    })),
    methods: MEASUREMENT_METHODS.map((method) => ({ key: method.key, label: method.label })),
  };
}
