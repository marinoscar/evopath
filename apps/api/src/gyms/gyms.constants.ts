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
} as const;
