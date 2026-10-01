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
// List, series, update and delete arrived with E2.5 (#60).

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
  /**
   * Whether the file this reading was read from (`sourceRef.healthDocumentId`)
   * was erased (delete after processing, #185); `null` when the reading names
   * no health document.
   */
  fileDeleted: boolean | null;
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

// =============================================================================
// Daily check-ins (`/api/check-ins`), issue #56 (E2.4)
// =============================================================================
//
// Four optional 1-5 self-reported scores and a note, one record per LOCAL day.
// The server decides what "today" is (in the profile time zone), so the web
// app asks `GET /today` and echoes its `date` back on `PUT`; it never derives
// a day from the device clock. The score bounds and end labels ("Drained" to
// "Energised") are read off the measurement catalog's wellness metrics
// (`scale`), not copied here. No combined readiness score is computed.

/** API field -> the catalog's wellness metric key, in display order. */
export const CHECK_IN_FIELDS = [
  { field: 'energy', metricKey: 'energy', fallbackLabel: 'Energy' },
  { field: 'sleepQuality', metricKey: 'sleep_quality', fallbackLabel: 'Sleep quality' },
  { field: 'soreness', metricKey: 'muscle_soreness', fallbackLabel: 'Muscle soreness' },
  { field: 'stress', metricKey: 'stress', fallbackLabel: 'Stress' },
] as const;
export type CheckInField = (typeof CHECK_IN_FIELDS)[number]['field'];

/** The API's limit on `note`, counted after trimming. */
export const CHECK_IN_NOTE_MAX_LENGTH = 500;

/** One day's check-in. `null` = that score was not recorded. */
export interface CheckIn {
  /** `YYYY-MM-DD`, the user's local day; never parse it through local time. */
  date: string;
  energy: number | null;
  sleepQuality: number | null;
  soreness: number | null;
  stress: number | null;
  note: string | null;
  updatedAt: string;
}

/** `GET /api/check-ins/today`. */
export interface TodayCheckIn {
  /** Today in the profile time zone (UTC when unset). Send it back on `PUT`. */
  date: string;
  checkIn: CheckIn | null;
}

/** The body of `PUT /api/check-ins/:date`: a FULL replace of that day. */
export type CheckInInput = Pick<CheckIn, CheckInField | 'note'>;

/** `GET /api/check-ins/today` (`health_data:read`). */
export function getTodayCheckIn(): Promise<TodayCheckIn> {
  return api.get<TodayCheckIn>('/check-ins/today');
}

/** `GET /api/check-ins?days=` (`health_data:read`), newest first. */
export async function listCheckIns(days: number): Promise<CheckIn[]> {
  const data = await api.get<{ items: CheckIn[] }>(`/check-ins?days=${encodeURIComponent(String(days))}`);
  return data.items;
}

/**
 * `PUT /api/check-ins/:date` (`health_data:write`). The API schema is strict,
 * so exactly these five keys are sent; an omitted score is sent as `null`.
 */
export function saveCheckIn(date: string, input: CheckInInput): Promise<CheckIn> {
  const body: CheckInInput = {
    energy: input.energy,
    sleepQuality: input.sleepQuality,
    soreness: input.soreness,
    stress: input.stress,
    note: input.note,
  };
  return api.put<CheckIn>(`/check-ins/${encodeURIComponent(date)}`, body);
}

/** `DELETE /api/check-ins/:date` (`health_data:write`). `404` when there is none. */
export async function deleteCheckIn(date: string): Promise<void> {
  await api.delete<void>(`/check-ins/${encodeURIComponent(date)}`);
}

/** True when a check-in save lost a race with another device (`409`). */
export function isCheckInConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

// =============================================================================
// History and trends, issue #60 (E2.5)
// =============================================================================

/** `GET /api/measurements` answers with the flat pagination shape (docs/API.md). */
export interface MeasurementPage {
  items: MeasurementDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** The API's `pageSize` cap on `GET /api/measurements`. */
export const MEASUREMENTS_PAGE_SIZE_MAX = 100;

export interface ListMeasurementsParams {
  /** A body or vital metric; omitted = all of them. */
  metricKey?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/**
 * `GET /api/measurements` (`health_data:read`): active body and vital
 * readings, newest `measuredAt` first. Rows, not entries: the caller groups
 * them (`utils/measurementSeries.ts` `groupByEntry`).
 */
export function listMeasurements(
  params: ListMeasurementsParams = {},
  options: { signal?: AbortSignal } = {},
): Promise<MeasurementPage> {
  const search = new URLSearchParams();
  if (params.metricKey) search.set('metricKey', params.metricKey);
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  const query = search.toString();
  return api.get<MeasurementPage>(`/measurements${query ? `?${query}` : ''}`, { signal: options.signal });
}

/** One chart point of `GET /api/measurements/series`; `value` is canonical. */
export interface SeriesPoint {
  id: string;
  measuredAt: string;
  value: number;
  method: string;
  origin: string;
}

/** `GET /api/measurements/series`: oldest first, at most 1000 points (the newest kept). */
export interface MeasurementSeries {
  metricKey: string;
  unit: string;
  points: SeriesPoint[];
  truncated: boolean;
}

/** `GET /api/measurements/series` (`health_data:read`). Any registry metric, wellness included. */
export function getMeasurementSeries(
  params: { metricKey: string; from?: string; to?: string },
  options: { signal?: AbortSignal } = {},
): Promise<MeasurementSeries> {
  const search = new URLSearchParams({ metricKey: params.metricKey });
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  return api.get<MeasurementSeries>(`/measurements/series?${search}`, { signal: options.signal });
}

/**
 * The body of `PATCH /api/measurements/entries/:entryId`. At least one
 * property; readings not mentioned are copied unchanged by the API, and every
 * `readings[].metricKey` must already be in the entry. `notes: null` clears.
 */
export interface UpdateMeasurementEntryInput {
  measuredAt?: string;
  notes?: string | null;
  readings?: MeasurementReadingInput[];
}

/**
 * `PATCH /api/measurements/entries/:entryId` (`health_data:write`). The API
 * supersedes the old rows (kept, `revision + 1`) and resolves with the entry
 * as it now stands. `404`: already gone; `409`: changed by another request.
 */
export function updateMeasurementEntry(
  entryId: string,
  input: UpdateMeasurementEntryInput,
): Promise<MeasurementEntry> {
  const body: UpdateMeasurementEntryInput = {
    ...(input.measuredAt !== undefined ? { measuredAt: input.measuredAt } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.readings !== undefined
      ? {
          readings: input.readings.map((reading) => ({
            metricKey: reading.metricKey,
            value: reading.value,
            unit: reading.unit,
            ...(reading.method !== undefined ? { method: reading.method } : {}),
          })),
        }
      : {}),
  };
  return api.patch<MeasurementEntry>(`/measurements/entries/${encodeURIComponent(entryId)}`, body);
}

/** `DELETE /api/measurements/entries/:entryId` (`health_data:write`): a soft delete, `204`. */
export async function deleteMeasurementEntry(entryId: string): Promise<void> {
  await api.delete<void>(`/measurements/entries/${encodeURIComponent(entryId)}`);
}

/** True for a `404`: the entry is no longer active (deleted or edited elsewhere). */
export function isEntryGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** True for a `409`: the entry was changed by another request mid-edit. */
export function isEntryConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

// =============================================================================
// Read from photo, issue #64 (E2.6)
// =============================================================================
//
// A scale, smart scale or blood-pressure cuff display is read by the E3.1
// photo-intake kit (`services/intake.ts`) with the `body_metric_reading` kind.
// Each draft item is ONE reading as displayed on the device (the device's
// unit); the API converts it once, at apply. Provenance (`origin`,
// `sourceRef`) is derived by the API from the intake rows inside apply; the
// browser only reads it back.

/** The intake kind (`POST /api/intakes { kind }`). Permanent on the server. */
export const BODY_METRIC_READING_KIND = 'body_metric_reading';

/** The one draft item kind inside it (`POST /api/intakes/:id/items { kind }`). */
export const BODY_METRIC_READING_ITEM_KIND = 'reading';

/** Photos one reading intake takes (the kind's `maxPhotos`). */
export const BODY_METRIC_READING_MAX_PHOTOS = 4;

/**
 * The kind also reads PDFs (its server `acceptedInputs` is `['image', 'pdf']`,
 * H2 #186): a smart-scale or body-composition report. A PDF counts as one of
 * the four files.
 */
export const BODY_METRIC_READING_ACCEPTS_PDF = true;

/** One draft item value: a reading as displayed on the device. */
export interface BodyMetricReadingValue {
  metricKey: MetricKey;
  /** The number as displayed, in `unit`. */
  value: number;
  /** One of the metric's catalog units, as displayed (`kg`, `lb`, `%`, `mmHg`, `bpm`). */
  unit: string;
  /** One of the metric's catalog methods; omitted = `unspecified`. */
  method?: string;
}

/** `POST /api/intakes/:id/apply` for this kind: the one entry it created (`null` when nothing was accepted). */
export interface BodyMetricReadingApplyResult {
  entryId: string | null;
  items: MeasurementDto[];
}

/** What the analyzer recorded for a reading intake (`PhotoIntakeView.resultMeta`). */
export interface BodyMetricReadingResultMeta {
  promptVersion?: number;
  deviceKind?: string | null;
  /** The model said no digit on the display was legible. */
  unreadable?: boolean;
  readingsFlagged?: number;
}

/** True when the scan finished but could not read any value off the display. */
export function isUnreadableResult(resultMeta: Record<string, unknown> | null | undefined): boolean {
  return (resultMeta as BodyMetricReadingResultMeta | null | undefined)?.unreadable === true;
}

/** The `sourceRef.kind` of a reading saved from a photo. */
export const PHOTO_INTAKE_SOURCE_KIND = 'photo_intake';

/**
 * `MeasurementDto.sourceRef` of a reading saved from a photo. An AI-read row
 * carries every field; a row the user added by hand in the same review
 * carries only `kind` and `intakeId`.
 */
export interface PhotoIntakeSourceRef {
  kind: typeof PHOTO_INTAKE_SOURCE_KIND;
  intakeId: string;
  draftItemId?: string;
  /** The photos the reading was read from (private storage objects of the owner). */
  storageObjectIds?: string[];
  /** What the AI read, as displayed on the device. */
  aiDraft?: BodyMetricReadingValue;
  confidence?: string | null;
  /** The saved value differs from `aiDraft`. */
  userEdited?: boolean;
  /** The health document the reading was read from (#185); its file may since have been erased. */
  healthDocumentId?: string;
}

/** The row's `sourceRef` when it is a photo intake's, else `null`. Never throws on unexpected shapes. */
export function photoSourceRef(row: Pick<MeasurementDto, 'sourceRef'>): PhotoIntakeSourceRef | null {
  const ref = row.sourceRef;
  if (!ref || typeof ref !== 'object') return null;
  if (ref.kind !== PHOTO_INTAKE_SOURCE_KIND || typeof ref.intakeId !== 'string') return null;
  const ids = Array.isArray(ref.storageObjectIds)
    ? ref.storageObjectIds.filter((id): id is string => typeof id === 'string')
    : undefined;
  return {
    ...(ref as unknown as PhotoIntakeSourceRef),
    storageObjectIds: ids,
    userEdited: ref.userEdited === true,
  };
}

/** The measurement origin of a reading the AI read off a photo (a hand-added one is `manual`). */
export const AI_READ_ORIGIN = 'ai';
