/**
 * Measurement fixtures (issue #53, E2.3), shaped exactly as
 * `GET /api/measurements/metrics`, `GET /api/measurements/latest` and
 * `POST /api/measurements` answer inside the `{ data }` envelope.
 *
 * The catalog mirrors `apps/api/src/measurements/metric-registry.ts`
 * (`catalogView()`): it is what the API would send, not a second source of
 * truth for the app, which only ever reads factors off the response.
 */
import type {
  LatestItem,
  MeasurementDto,
  MeasurementPage,
  MeasurementSeries,
  MetricCatalog,
  MetricDef,
  SeriesPoint,
} from '../../../services/health';

const BODY_WEIGHT_METHODS = ['unspecified', 'scale', 'smart_scale', 'clinical', 'other'];
const BP_METHODS = ['unspecified', 'bp_cuff', 'clinical', 'wearable', 'other'];

function metric(def: Omit<MetricDef, 'scale' | 'daily'> & Partial<Pick<MetricDef, 'scale' | 'daily'>>): MetricDef {
  return { scale: null, daily: false, ...def };
}

/** A daily 1-5 self-report score, as the registry's `wellness()` helper builds it. */
function wellness(key: string, label: string, lowLabel: string, highLabel: string): MetricDef {
  return metric({
    key,
    label,
    category: 'wellness',
    canonicalUnit: 'score',
    units: [{ unit: 'score', factor: 1, label: 'score' }],
    displayUnit: { metric: 'score', imperial: 'score' },
    min: 1,
    max: 5,
    decimals: 0,
    methods: ['self_report'],
    scale: { min: 1, max: 5, lowLabel, highLabel },
    daily: true,
  });
}

export const mockMetricCatalog: MetricCatalog = {
  metrics: [
    metric({
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
    }),
    metric({
      key: 'body_fat_pct',
      label: 'Body fat',
      category: 'body',
      canonicalUnit: '%',
      units: [{ unit: '%', factor: 1, label: '%' }],
      displayUnit: { metric: '%', imperial: '%' },
      min: 2,
      max: 70,
      decimals: 1,
      methods: ['unspecified', 'smart_scale', 'bia', 'skinfold', 'dexa', 'air_displacement', 'hydrostatic', 'other'],
    }),
    metric({
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
      methods: ['unspecified', 'tape', 'other'],
    }),
    metric({
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
    }),
    metric({
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
    }),
    metric({
      key: 'resting_hr',
      label: 'Resting heart rate',
      category: 'vital',
      canonicalUnit: 'bpm',
      units: [{ unit: 'bpm', factor: 1, label: 'bpm' }],
      displayUnit: { metric: 'bpm', imperial: 'bpm' },
      min: 25,
      max: 220,
      decimals: 0,
      methods: ['unspecified', 'wearable', 'bp_cuff', 'manual_pulse', 'other'],
    }),
    metric({
      key: 'energy',
      label: 'Energy',
      category: 'wellness',
      canonicalUnit: 'score',
      units: [{ unit: 'score', factor: 1, label: 'score' }],
      displayUnit: { metric: 'score', imperial: 'score' },
      min: 1,
      max: 5,
      decimals: 0,
      methods: ['self_report'],
      scale: { min: 1, max: 5, lowLabel: 'Drained', highLabel: 'Energised' },
      daily: true,
    }),
    wellness('sleep_quality', 'Sleep quality', 'Poor', 'Great'),
    wellness('muscle_soreness', 'Muscle soreness', 'None', 'Severe'),
    wellness('stress', 'Stress', 'Calm', 'Overwhelmed'),
  ],
  methods: [
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
  ],
};

export const catalogMetric = (key: string): MetricDef => {
  const found = mockMetricCatalog.metrics.find((m) => m.key === key);
  if (!found) throw new Error(`No fixture metric ${key}`);
  return found;
};

/** The body and vital metrics `latest` answers for, in registry order. */
export const LATEST_METRIC_KEYS = [
  'weight',
  'body_fat_pct',
  'waist_circumference',
  'bp_systolic',
  'bp_diastolic',
  'resting_hr',
];

const CANONICAL_UNIT: Record<string, string> = {
  weight: 'kg',
  body_fat_pct: '%',
  waist_circumference: 'cm',
  bp_systolic: 'mmHg',
  bp_diastolic: 'mmHg',
  resting_hr: 'bpm',
};

let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

/** One stored reading; `value` is canonical. */
export function mockMeasurement(
  metricKey: string,
  value: number,
  overrides: Partial<MeasurementDto> = {},
): MeasurementDto {
  return {
    id: uuid(),
    entryId: uuid(),
    metricKey,
    value,
    unit: CANONICAL_UNIT[metricKey] ?? 'kg',
    measuredAt: '2026-09-29T08:00:00.000Z',
    method: 'unspecified',
    origin: 'manual',
    notes: null,
    sourceRef: null,
    revision: 1,
    edited: false,
    ...overrides,
  };
}

/** A `latest` answer: every metric null except those given. */
export function mockLatest(
  entries: Partial<Record<string, { latest?: MeasurementDto | null; previous?: MeasurementDto | null }>> = {},
): LatestItem[] {
  return LATEST_METRIC_KEYS.map((metricKey) => ({
    metricKey,
    latest: entries[metricKey]?.latest ?? null,
    previous: entries[metricKey]?.previous ?? null,
  }));
}

/** A user with nothing logged yet. */
export const mockLatestEmpty: LatestItem[] = mockLatest();

// -----------------------------------------------------------------------------
// History and trends (#60, E2.5)
// -----------------------------------------------------------------------------

/** One `GET /api/measurements/series` point; `value` is canonical. */
export function mockSeriesPoint(
  measuredAt: string,
  value: number,
  method = 'unspecified',
): SeriesPoint {
  return { id: uuid(), measuredAt, value, method, origin: 'manual' };
}

/** A `GET /api/measurements/series` answer. */
export function mockSeries(
  metricKey: string,
  points: SeriesPoint[],
  options: { truncated?: boolean } = {},
): MeasurementSeries {
  return {
    metricKey,
    unit: CANONICAL_UNIT[metricKey] ?? 'score',
    points,
    truncated: options.truncated ?? false,
  };
}

/** A `GET /api/measurements` page (flat pagination). */
export function mockListPage(
  items: MeasurementDto[],
  options: { page?: number; pageSize?: number; total?: number; totalPages?: number } = {},
): MeasurementPage {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 100;
  const total = options.total ?? items.length;
  return { items, total, page, pageSize, totalPages: options.totalPages ?? Math.ceil(total / pageSize) };
}
