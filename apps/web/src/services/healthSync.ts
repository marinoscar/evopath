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
import { api } from './api';

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
  details: Record<string, unknown> | null;
  createdAt: string;
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
  healthConnect?: { status?: string; version?: string | null; grantedPermissions?: string[] };
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

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

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

/** True when the phone's zone and the Health Profile zone are both set and differ. */
export function hasTimezoneMismatch(device: Pick<Device, 'timezone' | 'userTimezone'>): boolean {
  return Boolean(device.timezone && device.userTimezone && device.timezone !== device.userTimezone);
}
