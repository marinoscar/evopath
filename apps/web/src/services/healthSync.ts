/**
 * The Android Health Connect sync API (`/api/health-sync`) and the admin
 * Android app trust endpoint (`/api/admin/android-app`), as the web app sees
 * them. Issue #283, epic #276.
 *
 * The phone is the only writer of devices, runs and diagnostic reports; the
 * web app reads them and can unpair a device. Every `/health-sync` route is
 * owner-scoped on the server (`goals:read` for reads, `goals:write` for the
 * unpair). The admin routes need `system_settings:read` / `:write`.
 *
 * `services/api.ts` stays the transport (bearer token, refresh, the `{ data }`
 * envelope); this module holds the calls next to their types. Nothing here
 * decides anything: statuses, expiry and retention are the API's.
 */
import { api, ApiError } from './api';

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

export type HealthSyncDeviceStatus = 'active' | 'revoked';
export type HealthSyncTrigger = 'periodic' | 'manual' | 'initial' | 'app_open';
export type HealthSyncRunStatus = 'ok' | 'partial' | 'failed' | 'skipped';
export type DiagnosticCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

/** The rolling GitHub release the Android workflow publishes the APK to. */
export const ANDROID_RELEASE_TAG = 'android-latest';
/** The deep link `HealthSyncActivity` answers on the phone. */
export const ANDROID_HEALTH_SYNC_DEEP_LINK = 'evopath-android://health-sync';

/** Mirrors the API's Zod bounds for the trusted apps editor. */
export const MAX_TRUSTED_APPS = 10;
export const SHA256_FINGERPRINT_PATTERN = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
/** An Android application id: two or more dot-separated Java identifiers. */
export const ANDROID_PACKAGE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

// -----------------------------------------------------------------------------
// Shapes
// -----------------------------------------------------------------------------

export interface Device {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  androidVersion: string | null;
  sdkInt: number | null;
  appVersion: string | null;
  healthConnectVersion: string | null;
  packageName: string | null;
  signingSha256: string | null;
  /** The phone's IANA zone at its last sync. */
  timezone: string | null;
  /** The user's Health Profile zone, or `null` when unset. */
  userTimezone: string | null;
  status: HealthSyncDeviceStatus;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: HealthSyncRunStatus | null;
  lastError: string | null;
  /** Expiry of the personal access token the phone paired with. */
  tokenExpiresAt: string | null;
  /** The app build the phone registered with (#287); `null` for an older build. */
  appVersionCode?: number | null;
  /** The current server release's versionCode for this package, or `null` without one. */
  latestVersionCode?: number | null;
  /** The API's answer: the phone runs an older build than the current release. */
  updateAvailable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  deviceId: string;
  trigger: HealthSyncTrigger;
  status: HealthSyncRunStatus;
  startedAt: string;
  finishedAt: string;
  /** `YYYY-MM-DD`. */
  windowFrom: string | null;
  windowTo: string | null;
  recordsRead: number;
  created: number;
  updated: number;
  deleted: number;
  errorCode: string | null;
  errorMessage: string | null;
  details: RunDetails | null;
  createdAt: string;
}

/** One data type's outcome in a run, as the phone reports it in `run.details.perType`. */
export interface RunTypeStat {
  permission?: 'granted' | 'denied' | string;
  read?: number;
  sent?: number;
}

/** A Health Connect writer (an app), as the phone reports it. */
export interface HealthConnectSource {
  packageName: string;
  appLabel?: string | null;
  dataTypes?: string[];
  recordCount?: number;
  latestRecordAt?: string | null;
}

/**
 * `run.details` as the Android app writes it. Free-form on the server (a JSON
 * column), so every field is optional and an older build may send none.
 */
export interface RunDetails {
  syncedTypes?: string[];
  perType?: Record<string, RunTypeStat>;
  sources?: HealthConnectSource[];
  timezone?: string;
  [key: string]: unknown;
}

/** One row of the phone's Health Connect inventory (last 30 days, counts capped at 1000). */
export interface HealthConnectInventoryRow {
  dataType: string;
  permission: 'granted' | 'denied' | string;
  recordCount30d: number;
  capped?: boolean;
  latestRecordAt?: string | null;
  sources?: Array<{ packageName: string; appLabel?: string | null; recordCount?: number; latestRecordAt?: string | null }>;
}

/** A diagnostic report as the list endpoint returns it (no body). */
export interface ReportSummary {
  id: string;
  deviceId: string;
  summary: string | null;
  createdAt: string;
}

export interface DiagnosticCheck {
  id: string;
  status: DiagnosticCheckStatus;
  detail?: string | null;
  remedy?: string | null;
}

/**
 * The report JSON the phone uploads. Typed as the app writes it, every field
 * optional: it is the phone's own document, and an older app build may send
 * less. The viewer renders what is there.
 */
export interface DiagnosticReportBody {
  generatedAt?: string;
  app?: { versionName?: string; versionCode?: number; packageName?: string; signingSha256?: string };
  device?: {
    manufacturer?: string;
    model?: string;
    androidVersion?: string;
    sdkInt?: number;
    timezone?: string;
  };
  server?: { url?: string };
  pairing?: { deviceId?: string; tokenExpiresAt?: string | null };
  healthConnect?: {
    status?: string;
    version?: string | null;
    grantedPermissions?: string[];
    inventory?: HealthConnectInventoryRow[];
    sources?: HealthConnectSource[];
  };
  work?: { state?: string; nextRunAt?: string | null };
  checks?: DiagnosticCheck[];
  recentRuns?: unknown[];
  log?: string[];
  [key: string]: unknown;
}

export interface Report extends ReportSummary {
  report: DiagnosticReportBody;
}

export interface TrustedApp {
  packageName: string;
  sha256: string;
}

export interface ReportedApp extends TrustedApp {
  deviceCount: number;
  lastSeenAt: string | null;
}

export interface AndroidAppConfig {
  trustedApps: TrustedApp[];
  reportedApps: ReportedApp[];
  /** The Digital Asset Links statements `/.well-known/assetlinks.json` serves. */
  assetLinks: unknown;
}

/**
 * A published Android APK (#287), as `GET /api/android-app/releases/latest`
 * answers any signed-in user. The admin list adds the fields in
 * `AdminRelease`.
 */
export interface Release {
  id: string;
  packageName: string;
  versionName: string;
  versionCode: number;
  /** Lower-case hex SHA-256 of the APK file. */
  fileSha256: string;
  sizeBytes: number;
  notes: string | null;
  createdAt: string;
}

export interface AdminRelease extends Release {
  signingSha256: string;
  isCurrent: boolean;
  uploadedById: string | null;
}

/** `POST /api/android-app/releases/:id/download-link` */
export interface DownloadLink {
  /** A navigable, short-lived `/api/android-app/download/<token>` URL. */
  url: string;
  expiresAt: string;
}

export interface UploadReleaseInput {
  apk: File;
  versionName: string;
  versionCode: number;
  packageName: string;
  signingSha256: string;
  notes?: string;
  makeCurrent: boolean;
  force?: boolean;
}

/** API error codes the release endpoints answer with. */
export const RELEASE_ERROR = {
  NO_RELEASE: 'NO_RELEASE',
  VERSION_EXISTS: 'RELEASE_VERSION_EXISTS',
  VERSION_NOT_NEWER: 'RELEASE_VERSION_NOT_NEWER',
  IS_CURRENT: 'RELEASE_IS_CURRENT',
} as const;

// -----------------------------------------------------------------------------
// Calls
// -----------------------------------------------------------------------------

const devicePath = (id: string) => `/health-sync/devices/${encodeURIComponent(id)}`;

/** `GET /api/health-sync/devices` — newest first. */
export function listDevices(options: { signal?: AbortSignal } = {}) {
  return api.get<Device[]>('/health-sync/devices', { signal: options.signal });
}

/** `GET /api/health-sync/devices/:id` */
export function getDevice(id: string) {
  return api.get<Device>(devicePath(id));
}

/** `GET /api/health-sync/devices/:id/runs?limit=` (1..200, default 50) — newest first. */
export function listRuns(id: string, limit = 50) {
  return api.get<Run[]>(`${devicePath(id)}/runs?limit=${limit}`);
}

/** `GET /api/health-sync/devices/:id/diagnostics?limit=` (1..20, default 5). */
export function listDiagnostics(id: string, limit = 5) {
  return api.get<ReportSummary[]>(`${devicePath(id)}/diagnostics?limit=${limit}`);
}

/** `GET /api/health-sync/devices/:id/diagnostics/:reportId` */
export function getDiagnostic(id: string, reportId: string) {
  return api.get<Report>(`${devicePath(id)}/diagnostics/${encodeURIComponent(reportId)}`);
}

/**
 * `DELETE /api/health-sync/devices/:id?deleteEntries=` — revokes the device
 * and its token; with `deleteEntries`, also deletes the activity it imported.
 */
export function unpairDevice(id: string, deleteEntries: boolean) {
  return api.delete<void>(`${devicePath(id)}?deleteEntries=${deleteEntries ? 'true' : 'false'}`);
}

/** `GET /api/admin/android-app` */
export function getAndroidAppConfig() {
  return api.get<AndroidAppConfig>('/admin/android-app');
}

/** `PUT /api/admin/android-app` — replaces the trusted apps list. */
export function putAndroidAppConfig(trustedApps: TrustedApp[]) {
  return api.put<AndroidAppConfig>('/admin/android-app', { trustedApps });
}

const releasePath = (id: string) => `/admin/android-app/releases/${encodeURIComponent(id)}`;

/** `GET /api/android-app/releases/latest` — the current release, or `null` (404 `NO_RELEASE`). */
export async function getLatestRelease(options: { signal?: AbortSignal } = {}): Promise<Release | null> {
  try {
    return await api.get<Release>('/android-app/releases/latest', { signal: options.signal });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** `POST /api/android-app/releases/:id/download-link` — a 10-minute navigable URL. */
export function createDownloadLink(id: string) {
  return api.post<DownloadLink>(`/android-app/releases/${encodeURIComponent(id)}/download-link`);
}

/** `GET /api/admin/android-app/releases` — newest first. */
export function listReleases() {
  return api.get<AdminRelease[]>('/admin/android-app/releases');
}

/** The multipart body `POST /api/admin/android-app/releases` reads. */
export function buildReleaseFormData(input: UploadReleaseInput): FormData {
  const form = new FormData();
  form.append('versionName', input.versionName);
  form.append('versionCode', String(input.versionCode));
  form.append('packageName', input.packageName);
  form.append('signingSha256', input.signingSha256);
  if (input.notes && input.notes.trim()) form.append('notes', input.notes.trim());
  form.append('makeCurrent', input.makeCurrent ? 'true' : 'false');
  if (input.force) form.append('force', 'true');
  // The file last: a streaming multipart parser has every field by the time it reaches the bytes.
  form.append('apk', input.apk, input.apk.name);
  return form;
}

/** `POST /api/admin/android-app/releases` (multipart). */
export function uploadRelease(input: UploadReleaseInput) {
  return api.postFormData<AdminRelease>('/admin/android-app/releases', buildReleaseFormData(input));
}

/** `POST /api/admin/android-app/releases/:id/make-current` — rollback allowed. */
export function makeReleaseCurrent(id: string) {
  return api.post<AdminRelease>(`${releasePath(id)}/make-current`);
}

/** `DELETE /api/admin/android-app/releases/:id` — 409 `RELEASE_IS_CURRENT` for the current one. */
export function deleteRelease(id: string) {
  return api.delete<void>(releasePath(id));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** `12.3 MB` (one decimal, decimal megabytes, as Android's file manager shows them). */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Hand the browser a navigable download URL. A plain navigation (not a blob)
 * is what lets Chrome and the TWA on Android download the APK natively and
 * offer the system installer. Wrapped so tests can replace it.
 */
export const downloadNavigator = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/** `https://github.com/<repoSlug>/releases/tag/android-latest` */
export function androidReleaseUrl(repoSlug: string): string {
  return `https://github.com/${repoSlug}/releases/tag/${ANDROID_RELEASE_TAG}`;
}

/** Whole days until `iso` (negative once past), or `null` without a date. */
export function daysUntil(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now.getTime()) / 86_400_000);
}

/** `run.details.perType` as rows, or `[]` when the run carries none. */
export function runTypeStats(run: Pick<Run, 'details'>): Array<{ dataType: string } & RunTypeStat> {
  const perType = run.details?.perType;
  if (!perType || typeof perType !== 'object') return [];
  return Object.entries(perType).map(([dataType, stat]) => ({ dataType, ...(stat ?? {}) }));
}

/** Granted but nothing in 30 days: the source app is probably not sharing into Health Connect. */
export function isGrantedButEmpty(row: Pick<HealthConnectInventoryRow, 'permission' | 'recordCount30d'>): boolean {
  return row.permission === 'granted' && row.recordCount30d === 0;
}

/** True when the phone's zone and the Health Profile zone are both set and differ. */
export function hasTimezoneMismatch(device: Pick<Device, 'timezone' | 'userTimezone'>): boolean {
  return Boolean(device.timezone && device.userTimezone && device.timezone !== device.userTimezone);
}
