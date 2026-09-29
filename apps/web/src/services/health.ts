/**
 * The health profile API (`/api/health-profile`), as the web app sees it.
 *
 * Issue #47 (E2.1). One row per user, read with `health_data:read` and fully
 * replaced with `health_data:write`. `services/api.ts` stays the transport (the
 * bearer token, the refresh dance, the `{ data }` envelope); this module holds
 * the two calls next to the types they produce.
 *
 * The browser presents and collects only. Every rule that matters (a real
 * calendar date, not in the future, height 500 to 2500 mm, an IANA time zone,
 * the 1000-character bio) is enforced by the API's Zod schema; the form's own
 * checks exist to explain a problem before the round trip, never to decide it.
 */

import { api, ApiError } from './api';

/** Mirrors the API's `sexAtBirth` enum. `null` means "not set". */
export const SEX_AT_BIRTH_VALUES = ['female', 'male', 'prefer_not_to_say'] as const;
export type SexAtBirth = (typeof SEX_AT_BIRTH_VALUES)[number];

export const UNIT_SYSTEMS = ['metric', 'imperial'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

/** The bounds the API enforces on `heightMm` (integer millimetres). */
export const HEIGHT_MM_MIN = 500;
export const HEIGHT_MM_MAX = 2500;

/** The API's limit on `bio`, counted after trimming. */
export const BIO_MAX_LENGTH = 1000;

/** How far back a date of birth may go, in years. */
export const DOB_MAX_AGE_YEARS = 120;

/** What `GET` and `PUT /api/health-profile` return. */
export interface HealthProfile {
  /** `YYYY-MM-DD`, a date-only value; never parse it through local time. */
  dateOfBirth: string | null;
  sexAtBirth: SexAtBirth | null;
  /** Integer millimetres, the only stored unit (5 ft 10 in is exactly 1778). */
  heightMm: number | null;
  unitSystem: UnitSystem;
  /** IANA name, e.g. `Europe/Madrid` or `UTC`. */
  timeZone: string | null;
  bio: string | null;
  /** `0` when no row exists yet. Pass back as `If-Match` on the next `PUT`. */
  version: number;
  updatedAt: string | null;
}

/**
 * The body of `PUT`: a FULL replace. A nullable field sent as `null` clears
 * it, and the API's schema is strict, so nothing but these six keys is sent.
 */
export type HealthProfileInput = Omit<HealthProfile, 'version' | 'updatedAt'>;

/** `GET /api/health-profile` (`health_data:read`). */
export function getHealthProfile(): Promise<HealthProfile> {
  return api.get<HealthProfile>('/health-profile');
}

/**
 * `PUT /api/health-profile` (`health_data:write`).
 *
 * `expectedVersion` becomes `If-Match`. The check is `=== undefined`, never a
 * truthiness test, so the first save of a user with no row still sends
 * `If-Match: 0` and asserts "nothing is stored yet". A mismatch is a `409`.
 */
export function saveHealthProfile(
  input: HealthProfileInput,
  expectedVersion?: number,
): Promise<HealthProfile> {
  const body: HealthProfileInput = {
    dateOfBirth: input.dateOfBirth,
    sexAtBirth: input.sexAtBirth,
    heightMm: input.heightMm,
    unitSystem: input.unitSystem,
    timeZone: input.timeZone,
    bio: input.bio,
  };
  return api.put<HealthProfile>('/health-profile', body, {
    headers:
      expectedVersion === undefined ? undefined : { 'If-Match': String(expectedVersion) },
  });
}

/** True when a save was refused because the profile changed elsewhere. */
export function isHealthProfileConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

// =============================================================================
// Measurements (`/api/measurements`), issue #53 (E2.3)
// =============================================================================
//
// The API owns the vocabulary: `GET /api/measurements/metrics` publishes every
// metric's units with their conversion `factor`, its display unit per unit
// system, its bounds (canonical, inclusive) and its methods. The web app keeps
// NO copy of those numbers; `utils/measurementUnits.ts` reads them off the
// catalog. A reading is sent in the unit the user sees and the API converts it
// once; every value the API returns is canonical.
//
// List, series, update and delete arrive with E2.5.

/** The body and vital metrics the quick-entry form and the tiles show, in display order. */
export const QUICK_ENTRY_METRIC_KEYS = [
  'weight',
  'body_fat_pct',
  'waist_circumference',
  'bp_systolic',
  'bp_diastolic',
  'resting_hr',
] as const;
export type MetricKey = (typeof QUICK_ENTRY_METRIC_KEYS)[number];

export interface MetricUnitDef {
  unit: string;
  /** Multiply a value in `unit` by this to get the canonical unit. */
  factor: number;
  label: string;
}

/** One metric of `GET /api/measurements/metrics`. */
export interface MetricDef {
  key: string;
  label: string;
  category: 'body' | 'vital' | 'wellness';
  canonicalUnit: string;
  units: MetricUnitDef[];
  displayUnit: { metric: string; imperial: string };
  /** Hard bounds, inclusive, in the canonical unit. */
  min: number;
  max: number;
  /** Display precision. */
  decimals: number;
  methods: string[];
  scale: { min: number; max: number; lowLabel: string; highLabel: string } | null;
  daily: boolean;
}

export interface MeasurementMethodDef {
  key: string;
  label: string;
}

/** `GET /api/measurements/metrics`. */
export interface MetricCatalog {
  metrics: MetricDef[];
  methods: MeasurementMethodDef[];
}

/** One stored reading. `value` is canonical, `unit` the canonical unit. */
export interface MeasurementDto {
  id: string;
  entryId: string;
  metricKey: string;
  value: number;
  unit: string;
  measuredAt: string;
  method: string;
  origin: string;
  notes: string | null;
  sourceRef: Record<string, unknown> | null;
  revision: number;
  edited: boolean;
}

/** One item of `GET /api/measurements/latest`. */
export interface LatestItem {
  metricKey: string;
  latest: MeasurementDto | null;
  previous: MeasurementDto | null;
}

export interface MeasurementReadingInput {
  metricKey: string;
  /** In `unit`; the API converts it to the canonical unit. */
  value: number;
  unit: string;
  /** Omitted = `unspecified`. */
  method?: string;
}

/** The body of `POST /api/measurements`. The API schema is strict: nothing else is sent. */
export interface CreateMeasurementEntryInput {
  /** ISO 8601 instant; omitted = the server clock. */
  measuredAt?: string;
  notes?: string;
  readings: MeasurementReadingInput[];
}

export interface MeasurementEntry {
  entryId: string;
  items: MeasurementDto[];
}

/** The method a reading gets when the client names none. */
export const UNSPECIFIED_METHOD = 'unspecified';

/** `GET /api/measurements/metrics` (`health_data:read`). */
export function getMeasurementCatalog(): Promise<MetricCatalog> {
  return api.get<MetricCatalog>('/measurements/metrics');
}

/** `POST /api/measurements` (`health_data:write`). Resolves with the created entry. */
export function createMeasurementEntry(input: CreateMeasurementEntryInput): Promise<MeasurementEntry> {
  const body: CreateMeasurementEntryInput = {
    ...(input.measuredAt !== undefined ? { measuredAt: input.measuredAt } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    readings: input.readings.map((reading) => ({
      metricKey: reading.metricKey,
      value: reading.value,
      unit: reading.unit,
      ...(reading.method !== undefined ? { method: reading.method } : {}),
    })),
  };
  return api.post<MeasurementEntry>('/measurements', body);
}

/** `GET /api/measurements/latest` (`health_data:read`), unwrapped to its items. */
export async function getLatestMeasurements(): Promise<LatestItem[]> {
  const data = await api.get<{ items: LatestItem[] }>('/measurements/latest');
  return data.items;
}

/** A field-level problem from a validation `400` (`details.issues`). */
export interface ValidationIssue {
  /** Dotted path, e.g. `readings.1.value`. */
  path: string;
  message: string;
}

/** The `details.issues` of a `400`, or `[]` for anything else. */
export function validationIssues(err: unknown): ValidationIssue[] {
  if (!(err instanceof ApiError) || err.status !== 400) return [];
  const issues = (err.details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue): issue is ValidationIssue =>
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as ValidationIssue).path === 'string' &&
      typeof (issue as ValidationIssue).message === 'string',
  );
}

/** True for a `403`: the account holds no health-data grant. */
export function isHealthDataForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

/** What every health surface shows instead of data on a `403` or without `health_data:read`. */
export const HEALTH_DATA_UNAVAILABLE = 'Health data is not available for your account';
