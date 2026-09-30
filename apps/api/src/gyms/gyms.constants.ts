import type { GymType } from '@prisma/client';

// =============================================================================
// Gyms (E3.3) — shared limits and vocabularies
// =============================================================================
//
// One home for every bound the DTOs, the services and the tests agree on.
// Machine-readable refusal reasons go in `details.reason` (the error filter
// derives the top-level `code` from the status).
// =============================================================================

/** Mirrors the Prisma `GymType` enum; the `satisfies` below breaks the build if they drift. */
export const GYM_TYPES = ['home', 'club', 'office', 'hotel', 'apartment', 'outdoor', 'other'] as const satisfies readonly GymType[];

/** Mirrors `EQUIPMENT_CATEGORIES` in `prisma/seed-data.ts` (the column is free text). */
export const EQUIPMENT_CATEGORIES = [
  'free_weights',
  'benches_racks',
  'plate_loaded',
  'selectorized',
  'cable',
  'cardio',
  'bodyweight',
  'accessories',
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export const EQUIPMENT_ORIGINS = ['manual', 'ai'] as const;
export const EQUIPMENT_CONFIDENCES = ['high', 'medium', 'low'] as const;

export const GYM_NAME_MAX = 80;
export const GYM_DESCRIPTION_MAX = 1000;
export const GYM_NOTES_MAX = 4000;
export const MAX_GYMS_PER_USER = 50;

/** Stored coordinates keep 5 decimals (about 1 m); more would only be noise. */
export const GYM_COORDINATE_DECIMALS = 5;
/** Upper bound of the (never stored) `accuracyMeters` a location write may carry. */
export const GYM_LOCATION_ACCURACY_MAX_METERS = 100_000;

export const EQUIPMENT_QUANTITY_MIN = 1;
export const EQUIPMENT_QUANTITY_MAX = 99;
export const EQUIPMENT_BRAND_MAX = 60;
export const EQUIPMENT_MODEL_MAX = 80;
export const EQUIPMENT_NOTES_MAX = 1000;

export const PHOTO_CAPTION_MAX = 500;
export const MAX_PHOTOS_PER_GYM = 100;
/** How many equipment rows one photo may be linked to. */
export const PHOTO_EQUIPMENT_LINKS_MAX = 100;
/** Image types a gym photo may be (what every browser can display). */
export const GYM_PHOTO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const GYM_PHOTO_MAX_BYTES = 20 * 1024 * 1024;

export const EQUIPMENT_TYPE_NAME_MAX = 80;
export const EQUIPMENT_TYPE_CAPABILITIES_MAX = 12;
export const MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER = 100;
export const EQUIPMENT_TYPE_LIST_LIMIT_DEFAULT = 100;
export const EQUIPMENT_TYPE_LIST_LIMIT_MAX = 200;
export const EQUIPMENT_TYPE_QUERY_MAX = 80;
export const CUSTOM_SLUG_PREFIX = 'custom-';

/** `details.reason` values this module answers with. */
export const GYM_REFUSALS = {
  GYM_LIMIT: 'GYM_LIMIT',
  DEFAULT_CONFLICT: 'DEFAULT_CONFLICT',
  EQUIPMENT_TYPE_IN_USE: 'EQUIPMENT_TYPE_IN_USE',
  EQUIPMENT_TYPE_LIMIT: 'EQUIPMENT_TYPE_LIMIT',
  UNKNOWN_CAPABILITY: 'UNKNOWN_CAPABILITY',
  PHOTO_ALREADY_ATTACHED: 'PHOTO_ALREADY_ATTACHED',
  PHOTO_LIMIT: 'PHOTO_LIMIT',
  OBJECT_NOT_READY: 'OBJECT_NOT_READY',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  OBJECT_TOO_LARGE: 'OBJECT_TOO_LARGE',
  EQUIPMENT_NOT_IN_GYM: 'EQUIPMENT_NOT_IN_GYM',
  /** 409: a temporary gym cannot be the default; save it (`isTemporary: false`) first. */
  TEMPORARY_GYM_NOT_DEFAULT: 'TEMPORARY_GYM_NOT_DEFAULT',
} as const;

// -----------------------------------------------------------------------------
// Temporary gyms (E6.2): the hotel flow's lifecycle
// -----------------------------------------------------------------------------

/**
 * Days a temporary gym may sit unchanged (`gyms.updated_at`) before the daily
 * `gyms.temporary.purge` job deletes it, when nothing references it. A code
 * constant on purpose: no env var and no system setting.
 */
export const TEMPORARY_GYM_RETENTION_DAYS = 30;
export const TEMPORARY_GYM_RETENTION_MS = TEMPORARY_GYM_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** The purge's job type. PERMANENT once jobs of this type exist. */
export const TEMPORARY_GYM_PURGE_JOB_TYPE = 'gyms.temporary.purge';
/** Daily at 03:30 (server time). */
export const TEMPORARY_GYM_PURGE_CRON = '30 3 * * *';
/** Candidates read per batch; each is then deleted in its own transaction. */
export const TEMPORARY_GYM_PURGE_BATCH_SIZE = 200;
/** A safety stop per run (200 x 50 = 10,000 gyms); the next run continues. */
export const TEMPORARY_GYM_PURGE_MAX_BATCHES = 50;
/**
 * Adaptation statuses that keep a temporary gym alive: the adaptation is still
 * being made, or is ready to apply (both apply routes re-read the gym).
 */
export const TEMPORARY_GYM_LIVE_ADAPTATION_STATUSES = ['queued', 'running', 'ready'] as const;
/** A `gym_equipment` intake in this status is being analysed right now. */
export const TEMPORARY_GYM_LIVE_INTAKE_STATUSES = ['scanning'] as const;
