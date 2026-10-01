// =============================================================================
// Progress photos (E7.9, #249): shared constants
// =============================================================================
//
// Plain data with no Nest or Prisma import, so the DTOs, the service, the
// export and the tests read one definition.
// =============================================================================

/** The poses a progress photo can show. Drives the ghost-overlay pairing. */
export const PROGRESS_PHOTO_POSES = ['front', 'side', 'back', 'other'] as const;
export type ProgressPhotoPose = (typeof PROGRESS_PHOTO_POSES)[number];

/** `note` is free text, never read by any model. */
export const PROGRESS_PHOTO_NOTE_MAX = 200;

/**
 * The largest object accepted. The browser downscales before upload
 * (`ImageIntake`), so a real photo is far below this; it bounds what a client
 * that skips the downscale can make the gallery serve.
 */
export const PROGRESS_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Declared types accepted. The STORED bytes must also be one of these by their
 * magic bytes (GIF is deliberately not a progress photo).
 */
export const PROGRESS_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Leading bytes read back for the magic-byte check (a WebP header needs 12). */
export const PROGRESS_PHOTO_SNIFF_BYTES = 64;

export const PROGRESS_PHOTO_PAGE_SIZE_DEFAULT = 30;
export const PROGRESS_PHOTO_PAGE_SIZE_MAX = 100;

/** `details.reason` of each refusal (the envelope's `code` is status-derived). */
export const PROGRESS_PHOTO_REASONS = {
  NOT_IMAGE: 'PROGRESS_PHOTO_NOT_IMAGE',
  OBJECT_NOT_OWNED: 'PROGRESS_PHOTO_OBJECT_NOT_OWNED',
  OBJECT_NOT_READY: 'PROGRESS_PHOTO_OBJECT_NOT_READY',
  NOT_FOUND: 'PROGRESS_PHOTO_NOT_FOUND',
  TOO_LARGE: 'PROGRESS_PHOTO_TOO_LARGE',
  ALREADY_ADDED: 'PROGRESS_PHOTO_ALREADY_ADDED',
} as const;

/** The `StorageObjectReferences` checker name. */
export const PROGRESS_PHOTOS_REFERENCE = 'progress_photos';
