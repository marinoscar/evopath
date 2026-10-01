/**
 * The health export API (`/api/health/exports`), as the web app sees it.
 *
 * Issue #191 (H7). Three routes, all `health_data:read`:
 *
 *   POST /api/health/exports        -> 202 HealthExport (`pending`)
 *   GET  /api/health/exports        -> { items }: the 20 most recent, no URLs
 *   GET  /api/health/exports/:id    -> HealthExport, with a FRESH `download`
 *                                      (a 5-minute signed URL) while `ready`
 *
 * The browser presents and collects only. The range rules (real dates, `from`
 * not after `to`, at most 3660 days, `to` not after tomorrow), the dataset rules
 * and the three-in-flight limit are the API's; the dialog's own checks only
 * explain a problem before the round trip. A download URL is never cached:
 * it is fetched from `GET /:id` right before it is opened.
 */

import { api, ApiError } from './api';
import { validationIssues } from './health';

export const HEALTH_EXPORT_FORMATS = ['json', 'csv', 'xlsx', 'pdf'] as const;
export type HealthExportFormat = (typeof HEALTH_EXPORT_FORMATS)[number];

/** In the API's canonical order (the order the file lists them in). */
export const HEALTH_EXPORT_DATASETS = [
  'profile',
  'body',
  'vitals',
  'labs',
  'wellness',
  'documents',
  // E7.9 (#249): the user's progress photos.
  'progress_photos',
] as const;
export type HealthExportDataset = (typeof HEALTH_EXPORT_DATASETS)[number];

export const HEALTH_EXPORT_STATUSES = ['pending', 'running', 'ready', 'failed', 'expired'] as const;
export type HealthExportStatus = (typeof HEALTH_EXPORT_STATUSES)[number];

/** The API's longest range, in days between `from` and `to`. */
export const HEALTH_EXPORT_MAX_RANGE_DAYS = 3660;

/** The API's limit on exports pending or running at once. */
export const HEALTH_EXPORT_MAX_IN_FLIGHT = 3;

export interface HealthExportDownload {
  url: string;
  expiresAt: string;
}

/** One export, as every route answers it. */
export interface HealthExport {
  id: string;
  status: HealthExportStatus;
  format: HealthExportFormat;
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
  datasets: HealthExportDataset[];
  includeHistory: boolean;
  createdAt: string;
  completedAt: string | null;
  /** When the file is deleted (7 days after it was made). */
  expiresAt: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  rowCounts: Record<HealthExportDataset, number> | null;
  /** A fixed message for a `failed` export, else null. */
  error: string | null;
  /** Only on `GET /:id` while `ready`; always null in the list. */
  download: HealthExportDownload | null;
}

export interface CreateHealthExportInput {
  format: HealthExportFormat;
  from: string;
  to: string;
  datasets: HealthExportDataset[];
  includeHistory: boolean;
}

/** `POST /api/health/exports`. */
export function createHealthExport(input: CreateHealthExportInput): Promise<HealthExport> {
  // The API's schema is strict: exactly these five keys, datasets in canonical order.
  const body: CreateHealthExportInput = {
    format: input.format,
    from: input.from,
    to: input.to,
    datasets: HEALTH_EXPORT_DATASETS.filter((d) => input.datasets.includes(d)),
    includeHistory: input.includeHistory,
  };
  return api.post<HealthExport>('/health/exports', body);
}

/** `GET /api/health/exports`, unwrapped to its items (newest first). */
export async function listHealthExports(): Promise<HealthExport[]> {
  const data = await api.get<{ items: HealthExport[] }>('/health/exports');
  return data.items;
}

/** `GET /api/health/exports/:id`: the status, and a fresh download URL while ready. */
export function getHealthExport(id: string): Promise<HealthExport> {
  return api.get<HealthExport>(`/health/exports/${encodeURIComponent(id)}`);
}

/** True while the job has not settled: keep polling. */
export function isHealthExportActive(item: Pick<HealthExport, 'status'>): boolean {
  return item.status === 'pending' || item.status === 'running';
}

// =============================================================================
// Labels
// =============================================================================

export const HEALTH_EXPORT_FORMAT_LABELS: Record<HealthExportFormat, string> = {
  json: 'JSON',
  csv: 'CSV (zip)',
  xlsx: 'Excel',
  pdf: 'PDF',
};

export const HEALTH_EXPORT_FORMAT_DESCRIPTIONS: Record<HealthExportFormat, string> = {
  json: 'One file for your own records or analysis',
  csv: 'A zip with one spreadsheet-friendly file per dataset',
  xlsx: 'One workbook, one sheet per dataset',
  pdf: 'PDF report for your doctor',
};

export const HEALTH_EXPORT_DATASET_LABELS: Record<HealthExportDataset, string> = {
  profile: 'Profile',
  body: 'Body (weight, body fat, waist)',
  vitals: 'Vitals (blood pressure, resting heart rate)',
  labs: 'Blood work',
  wellness: 'Wellness / mood (check-in scores)',
  documents: 'Documents index',
  progress_photos: 'Progress photos',
};

export const HEALTH_EXPORT_STATUS_LABELS: Record<HealthExportStatus, string> = {
  pending: 'Queued',
  running: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

// =============================================================================
// Date ranges
// =============================================================================

export const HEALTH_EXPORT_RANGE_PRESETS = ['3m', '6m', '12m', 'all', 'custom'] as const;
export type HealthExportRangePreset = (typeof HEALTH_EXPORT_RANGE_PRESETS)[number];

export const HEALTH_EXPORT_RANGE_LABELS: Record<HealthExportRangePreset, string> = {
  '3m': 'Last 3 months',
  '6m': 'Last 6 months',
  '12m': 'Last 12 months',
  all: 'All (up to 10 years)',
  custom: 'Custom',
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The user's local calendar date, `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** True for a real calendar date in `YYYY-MM-DD` form. */
export function isRealDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `date` (`YYYY-MM-DD`) plus `days`, as a calendar date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateString(d);
}

/** `date` minus `months`, clamped to the last day of a shorter month. */
function subtractMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return toDateString(first);
}

/** Days from `from` to `to` (0 for the same day). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The `{ from, to }` a preset stands for, ending `today`. */
export function rangeForPreset(
  preset: Exclude<HealthExportRangePreset, 'custom'>,
  today: string,
): { from: string; to: string } {
  switch (preset) {
    case '3m':
      return { from: subtractMonths(today, 3), to: today };
    case '6m':
      return { from: subtractMonths(today, 6), to: today };
    case '12m':
      return { from: subtractMonths(today, 12), to: today };
    case 'all':
      return { from: addDays(today, -HEALTH_EXPORT_MAX_RANGE_DAYS), to: today };
  }
}

/**
 * Why a custom range would be refused, or null. Mirrors the API's rules so the
 * problem is explained before the round trip; the API still decides.
 */
export function customRangeProblem(from: string, to: string, today: string): string | null {
  if (!isRealDate(from) || !isRealDate(to)) return 'Enter both dates';
  if (from > to) return 'The start date must not be after the end date';
  if (to > today) return 'The end date cannot be in the future';
  if (daysBetween(from, to) > HEALTH_EXPORT_MAX_RANGE_DAYS) return 'The range may be at most 10 years';
  return null;
}

// =============================================================================
// Formatting and errors
// =============================================================================

export function formatExportSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const HEALTH_EXPORT_TOO_MANY_MESSAGE = `You already have ${HEALTH_EXPORT_MAX_IN_FLIGHT} exports in progress. Wait for one to finish, then try again.`;

/** A message a person can act on, for a failed request. */
export function describeHealthExportError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return HEALTH_EXPORT_TOO_MANY_MESSAGE;
    if (err.status === 403) return 'Health data is not available for your account.';
    if (err.status === 404) return 'This export no longer exists.';
    if (err.status === 400) {
      const issues = validationIssues(err);
      return issues.length > 0
        ? `Check the export settings: ${issues.map((i) => i.message).join('; ')}.`
        : 'Check the export settings and try again.';
    }
  }
  return fallback;
}
