// =============================================================================
// Health data export (H7, #191): shared constants
// =============================================================================
//
// Plain data with no Nest or Prisma import, so the writers, the handler, the
// service and the tests read one definition.
// =============================================================================

import { APP_NAME } from '@app/shared';

import { EXPORTS_KEY_PREFIX } from '../storage/storage-key-prefixes';

/** The export job. PERMANENT once rows of it exist. */
export const HEALTH_EXPORT_JOB_TYPE = 'health.export';

/** The housekeeping job that erases expired export files. PERMANENT. */
export const HEALTH_EXPORT_PURGE_JOB_TYPE = 'health.export.purge';

/** `Job.subjectType` of an export: the user whose data it reads. `subjectId` is the user id. */
export const HEALTH_EXPORT_SUBJECT_TYPE = 'user';

/** Audit action written when an export file is produced. */
export const HEALTH_EXPORT_AUDIT_ACTION = 'health:export:create';

/** Audit `targetType`; `targetId` is the export (job) id. */
export const HEALTH_EXPORT_AUDIT_TARGET = 'health_export';

/** Notification events (`notifications/notification-events.ts`). */
export const HEALTH_EXPORT_READY_EVENT = 'health.export_ready';
export const HEALTH_EXPORT_FAILED_EVENT = 'health.export_failed';

/** `storage_objects.metadata.source` of an export file. */
export const HEALTH_EXPORT_OBJECT_SOURCE = 'health_export';

export const HEALTH_EXPORT_FORMATS = ['json', 'csv', 'xlsx', 'pdf'] as const;
export type HealthExportFormat = (typeof HEALTH_EXPORT_FORMATS)[number];

/** Datasets in the order every writer emits them. */
export const HEALTH_EXPORT_DATASETS = [
  'profile',
  'body',
  'vitals',
  'labs',
  'wellness',
  'documents',
  'progress_photos',
] as const;
export type HealthExportDataset = (typeof HEALTH_EXPORT_DATASETS)[number];

/** Display titles (sheet names, PDF headings). Wellness is the check-in scores. */
export const HEALTH_EXPORT_DATASET_TITLES: Record<HealthExportDataset, string> = {
  profile: 'Profile',
  body: 'Body',
  vitals: 'Vitals',
  labs: 'Labs',
  wellness: 'Wellness / mood',
  documents: 'Documents',
  progress_photos: 'Progress photos',
};

/** The file's extension and stored MIME type, per format. */
export const HEALTH_EXPORT_FILE_TYPES: Record<HealthExportFormat, { ext: string; mimeType: string }> = {
  json: { ext: 'json', mimeType: 'application/json' },
  csv: { ext: 'zip', mimeType: 'application/zip' },
  xlsx: { ext: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pdf: { ext: 'pdf', mimeType: 'application/pdf' },
};

/** The JSON export's `schemaVersion`. Bump on a breaking shape change. */
export const HEALTH_EXPORT_SCHEMA_VERSION = 1;

/** How long an export file is kept before `health.export.purge` erases it. */
export const HEALTH_EXPORT_RETENTION_DAYS = 7;
export const HEALTH_EXPORT_RETENTION_MS = HEALTH_EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Lifetime of a signed download URL, in seconds (5 minutes). */
export const HEALTH_EXPORT_DOWNLOAD_URL_TTL_SECONDS = 300;

/** Longest range one export may cover, in days (10 years). */
export const HEALTH_EXPORT_MAX_RANGE_DAYS = 3660;

/** Exports one user may have pending or running at once; the next is a 429. */
export const HEALTH_EXPORT_MAX_IN_FLIGHT = 3;

/** How many exports `GET /api/health/exports` lists. */
export const HEALTH_EXPORT_LIST_LIMIT = 20;

/** `exports/<userId>/<exportId>.<ext>`. Server-side values only. */
export function healthExportKey(userId: string, exportId: string, ext: string): string {
  return `${EXPORTS_KEY_PREFIX}${userId}/${exportId}.${ext}`;
}

/** `APP_NAME` as a filename-safe slug (`My App` -> `my-app`), `app` when nothing survives. */
export function appSlug(name: string = APP_NAME): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'app';
}

/**
 * The download name: `<app>-health-<from>-<to>.<ext>`. `from` and `to` are
 * validated `YYYY-MM-DD` dates, so the name never needs quoting or escaping.
 */
export function healthExportFileName(from: string, to: string, format: HealthExportFormat): string {
  return `${appSlug()}-health-${from}-${to}.${HEALTH_EXPORT_FILE_TYPES[format].ext}`;
}
