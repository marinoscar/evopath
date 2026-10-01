// =============================================================================
// Health sync (Android Health Connect, epic #276, #278): vocabulary, bounds,
// refusal reasons and the reconciliation scope of each synced data type.
// =============================================================================
//
// Pure data, no Nest or Prisma imports.
// =============================================================================

/** Every imported row's provider is `health_connect:<deviceId>`: one per phone. */
export const HEALTH_CONNECT_PROVIDER_PREFIX = 'health_connect:';

export function providerForDevice(deviceId: string): string {
  return `${HEALTH_CONNECT_PROVIDER_PREFIX}${deviceId}`;
}

// -----------------------------------------------------------------------------
// Bounds
// -----------------------------------------------------------------------------

export const DEVICE_STRING_MAX = 100;
export const SIGNING_SHA256_PATTERN = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** A sync's local days lie in [today - SYNC_MAX_DAYS_BACK, today + SYNC_MAX_DAYS_AHEAD] (user's zone). */
export const SYNC_MAX_DAYS_BACK = 30;
export const SYNC_MAX_DAYS_AHEAD = 1;
/** `window.from..window.to`, inclusive, at most this many days. */
export const SYNC_WINDOW_MAX_DAYS = 31;
/**
 * A measurement's local day is computed here, in the USER's zone, from its
 * instant, while the phone built the window in ITS zone: a reading this many
 * days outside the window is still accepted (but never reconciled), so a time
 * zone difference cannot fail a whole sync.
 */
export const MEASUREMENT_WINDOW_SLACK_DAYS = 1;

export const SYNC_ENTRIES_MAX = 1000;
export const SYNC_MEASUREMENTS_MAX = 3000;
export const SYNC_SLEEP_MAX = 200;
export const SYNC_EXTERNAL_ID_MAX = 200;
export const SYNC_ENTRY_KEY_MAX = 200;
export const SYNC_ERROR_CODE_MAX = 100;
export const SYNC_ERROR_MESSAGE_MAX = 2000;
export const SYNC_NOTE_MAX = 280;
/** `run.details`, serialized. */
export const SYNC_DETAILS_MAX_BYTES = 32 * 1024;

export const DIAGNOSTIC_SUMMARY_MAX = 500;
/** `report`, serialized. */
export const DIAGNOSTIC_REPORT_MAX_BYTES = 256 * 1024;

/** Retention, enforced on insert in the same transaction. */
export const RUNS_KEPT_PER_DEVICE = 200;
export const REPORTS_KEPT_PER_DEVICE = 20;

export const RUNS_LIMIT_DEFAULT = 50;
export const RUNS_LIMIT_MAX = 200;
export const REPORTS_LIMIT_DEFAULT = 5;
export const REPORTS_LIMIT_MAX = 20;

/** A sync writes up to ~4200 rows one statement at a time. */
export const SYNC_TX_TIMEOUT_MS = 60_000;

/** Kinds a phone may send (no `workout_any` / `custom`). */
export const SYNC_ACTIVITY_KINDS = ['walk', 'run', 'cardio_any', 'steps'] as const;

/** Mirrors the Prisma enums. */
export const HEALTH_SYNC_TRIGGERS = ['periodic', 'manual', 'initial', 'app_open'] as const;
export const HEALTH_SYNC_RUN_STATUSES = ['ok', 'partial', 'failed', 'skipped'] as const;
export const HEALTH_SYNC_DEVICE_STATUSES = ['active', 'revoked'] as const;

/** Metrics a phone may send, each with the method used when the phone names none. */
export const SYNC_METRIC_DEFAULT_METHOD = {
  weight: 'smart_scale',
  body_fat_pct: 'smart_scale',
  resting_hr: 'wearable',
  heart_rate_avg: 'wearable',
  hrv_rmssd: 'wearable',
  bp_systolic: 'bp_cuff',
  bp_diastolic: 'bp_cuff',
} as const;
export type SyncMetricKey = keyof typeof SYNC_METRIC_DEFAULT_METHOD;
export const SYNC_METRIC_KEYS = Object.keys(SYNC_METRIC_DEFAULT_METHOD) as [SyncMetricKey, ...SyncMetricKey[]];

// -----------------------------------------------------------------------------
// Reconciliation scope per synced type
// -----------------------------------------------------------------------------
//
// A sync with a `window` and `run.status === 'ok'` deletes this device's rows
// in the window that the payload no longer carries — but ONLY for the data
// types the phone names in `run.details.syncedTypes`. A type the user switched
// off on the phone, or whose Health Connect permission is missing, is absent
// from that list, so its rows are left alone (an empty read must never be
// mistaken for "the user deleted everything"). No `syncedTypes` at all means
// nothing is reconciled. Unknown names are ignored.
//
//   syncedTypes name     table               rows reconciled
//   ------------------   -----------------   ---------------------------------
//   steps                activity_entries    activityKind `steps`
//   exercise             activity_entries    every other kind (walk, run, cardio_any)
//   weight               measurements        metricKey `weight`
//   body_fat             measurements        metricKey `body_fat_pct`
//   resting_heart_rate   measurements        metricKey `resting_hr`
//   heart_rate           measurements        metricKey `heart_rate_avg`
//   hrv                  measurements        metricKey `hrv_rmssd`
//   blood_pressure       measurements        metricKeys `bp_systolic`, `bp_diastolic`
//   sleep                sleep_sessions      every row
//
// Activity entries and sleep sessions are hard-deleted; measurements are
// soft-deleted (`deletedAt`), like a user's own delete.
// -----------------------------------------------------------------------------

export type SyncedTypeScope =
  | { table: 'activity_entries'; activityKinds: readonly string[] }
  | { table: 'measurements'; metricKeys: readonly SyncMetricKey[] }
  | { table: 'sleep_sessions' };

export const SYNCED_TYPE_SCOPES = {
  steps: { table: 'activity_entries', activityKinds: ['steps'] },
  exercise: { table: 'activity_entries', activityKinds: ['walk', 'run', 'cardio_any'] },
  weight: { table: 'measurements', metricKeys: ['weight'] },
  body_fat: { table: 'measurements', metricKeys: ['body_fat_pct'] },
  resting_heart_rate: { table: 'measurements', metricKeys: ['resting_hr'] },
  heart_rate: { table: 'measurements', metricKeys: ['heart_rate_avg'] },
  hrv: { table: 'measurements', metricKeys: ['hrv_rmssd'] },
  blood_pressure: { table: 'measurements', metricKeys: ['bp_systolic', 'bp_diastolic'] },
  sleep: { table: 'sleep_sessions' },
} as const satisfies Record<string, SyncedTypeScope>;

export type SyncedTypeName = keyof typeof SYNCED_TYPE_SCOPES;
export const SYNCED_TYPE_NAMES = Object.keys(SYNCED_TYPE_SCOPES) as SyncedTypeName[];

// -----------------------------------------------------------------------------
// Refusals (`details.reason`)
// -----------------------------------------------------------------------------

export const HEALTH_SYNC_REASONS = {
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  ENTRY_DATE_OUT_OF_RANGE: 'ENTRY_DATE_OUT_OF_RANGE',
  WINDOW_TOO_LARGE: 'WINDOW_TOO_LARGE',
  INVALID_MEASUREMENT: 'INVALID_MEASUREMENT',
  HEALTH_DATA_SCOPE_REQUIRED: 'HEALTH_DATA_SCOPE_REQUIRED',
} as const;
