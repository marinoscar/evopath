/**
 * Progress photos (`/api/progress-photos`), E7.9 (#249), as the web app sees them.
 *
 *   GET    /api/progress-photos?pose=&limit=&cursor=  -> { items, nextCursor }  health_data:read
 *   POST   /api/progress-photos                       -> 201 ProgressPhoto      health_data:write
 *   DELETE /api/progress-photos/:id                   -> 204                    health_data:write
 *
 * The bytes never pass through these routes: the browser downscales the image
 * (which drops EXIF, GPS included), uploads it to `POST /api/storage/objects`,
 * waits for `ready`, and then adds the object here by id. A photo is viewed
 * through the owner-checked signed download of
 * `GET /api/storage/objects/:id/download`, as `StoragePhotoThumb` does.
 *
 * PRIVATE TO THE USER: never sent to an AI model, never in a notification.
 * The API decides every rule (ownership, image-by-content, size, the date);
 * the checks here only explain a problem before the round trip.
 */

import { api, ApiError } from './api';
import { uploadStorageObjectAndWait, type WaitForReadyOptions } from './storage';

export const PROGRESS_PHOTO_POSES = ['front', 'side', 'back', 'other'] as const;
export type ProgressPhotoPose = (typeof PROGRESS_PHOTO_POSES)[number];

export const PROGRESS_PHOTO_POSE_LABELS: Record<ProgressPhotoPose, string> = {
  front: 'Front',
  side: 'Side',
  back: 'Back',
  other: 'Other',
};

/** The API's limits (`progress-photos.constants.ts`). */
export const PROGRESS_PHOTO_NOTE_MAX = 200;
export const PROGRESS_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const PROGRESS_PHOTO_PAGE_SIZE = 30;
/** Image types the API accepts (by content); GIF is deliberately not one. */
export const PROGRESS_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const PROGRESS_PHOTOS_PRIVACY_COPY = 'Private to you. Never shared with AI or put in notifications.';

export const PROGRESS_PHOTOS_PATH = '/health/progress-photos';
/** The deep link that opens the add flow directly (the Coach's "Take photo"). */
export const PROGRESS_PHOTOS_ADD_PATH = `${PROGRESS_PHOTOS_PATH}?add=1`;

export interface ProgressPhoto {
  id: string;
  storageObjectId: string;
  /** The user's local calendar day, `YYYY-MM-DD`. */
  localDate: string;
  pose: ProgressPhotoPose;
  note: string | null;
  createdAt: string;
}

export interface ProgressPhotoPage {
  items: ProgressPhoto[];
  /** Pass back as `cursor`; null on the last page. */
  nextCursor: string | null;
}

export interface ListProgressPhotosParams {
  pose?: ProgressPhotoPose | null;
  limit?: number;
  cursor?: string | null;
}

export interface CreateProgressPhotoInput {
  storageObjectId: string;
  localDate: string;
  pose: ProgressPhotoPose;
  note?: string | null;
}

/** `GET /api/progress-photos`: one page, newest `localDate` first. */
export function listProgressPhotos(params: ListProgressPhotosParams = {}): Promise<ProgressPhotoPage> {
  const query = new URLSearchParams();
  if (params.pose) query.set('pose', params.pose);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);
  const qs = query.toString();
  return api.get<ProgressPhotoPage>(`/progress-photos${qs ? `?${qs}` : ''}`);
}

/** The newest photo of `pose`, or `null` (the ghost overlay's source). */
export async function getLatestProgressPhoto(pose: ProgressPhotoPose): Promise<ProgressPhoto | null> {
  const page = await listProgressPhotos({ pose, limit: 1 });
  return page.items[0] ?? null;
}

/** `POST /api/progress-photos`. The body is strict: no keys beyond these four. */
export function createProgressPhoto(input: CreateProgressPhotoInput): Promise<ProgressPhoto> {
  const note = input.note?.trim();
  const body: CreateProgressPhotoInput = {
    storageObjectId: input.storageObjectId,
    localDate: input.localDate,
    pose: input.pose,
    ...(note ? { note } : {}),
  };
  return api.post<ProgressPhoto>('/progress-photos', body);
}

/** `DELETE /api/progress-photos/:id`: removes the row and its stored image. */
export async function deleteProgressPhoto(id: string): Promise<void> {
  await api.delete<void>(`/progress-photos/${encodeURIComponent(id)}`);
}

/** Upload a prepared (downscaled) image, wait for `ready`, then add it as a progress photo. */
export async function uploadProgressPhoto(
  file: File,
  input: Omit<CreateProgressPhotoInput, 'storageObjectId'>,
  options?: WaitForReadyOptions,
): Promise<ProgressPhoto> {
  const object = await uploadStorageObjectAndWait(file, options);
  return createProgressPhoto({ ...input, storageObjectId: object.id });
}

// =============================================================================
// Client-side checks (explanations only; the API decides)
// =============================================================================

/** Why a picked file cannot be a progress photo before preparing it, or `null`. */
export function progressPhotoRejection(file: File): string | null {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') {
    return `${file.name} is not a photo. Choose a JPEG, PNG or WebP image.`;
  }
  return null;
}

/** Why a prepared (downscaled) file cannot be uploaded, or `null`. */
export function progressPhotoPreparedRejection(file: File): string | null {
  if (!(PROGRESS_PHOTO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name} cannot be used here. Convert it to JPEG or PNG.`;
  }
  if (file.size > PROGRESS_PHOTO_MAX_BYTES) return `${file.name} is larger than 10 MiB.`;
  return null;
}

// =============================================================================
// Errors
// =============================================================================

export const PROGRESS_PHOTO_ERROR_MESSAGES: Record<string, string> = {
  PROGRESS_PHOTO_NOT_IMAGE: 'That file is not a JPEG, PNG or WebP image.',
  PROGRESS_PHOTO_OBJECT_NOT_READY: 'The upload is still being processed. Try again in a moment.',
  PROGRESS_PHOTO_OBJECT_NOT_OWNED: 'That upload does not belong to your account.',
  PROGRESS_PHOTO_ALREADY_ADDED: 'That photo has already been added.',
  PROGRESS_PHOTO_TOO_LARGE: 'The image is larger than 10 MiB.',
  PROGRESS_PHOTO_NOT_FOUND: 'That photo no longer exists.',
};

/** The `details.reason` of a failed call, or `null`. */
export function progressPhotoErrorReason(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : null;
}

/** A sentence for a failed progress-photo call. */
export function progressPhotoErrorMessage(error: unknown, fallback: string): string {
  const reason = progressPhotoErrorReason(error);
  if (reason && PROGRESS_PHOTO_ERROR_MESSAGES[reason]) return PROGRESS_PHOTO_ERROR_MESSAGES[reason];
  if (error instanceof ApiError && error.status === 413) return PROGRESS_PHOTO_ERROR_MESSAGES.PROGRESS_PHOTO_TOO_LARGE;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// =============================================================================
// Presentation helpers
// =============================================================================

export interface ProgressPhotoMonth {
  /** `YYYY-MM`. */
  key: string;
  /** "September 2026". */
  label: string;
  photos: ProgressPhoto[];
}

/** "September 2026" for a `YYYY-MM` key (UTC, so no time zone moves it). */
export function formatPhotoMonth(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}

/** "Sep 15, 2026" for a `YYYY-MM-DD` day. */
export function formatPhotoDate(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number);
  if (!y || !m || !d) return localDate;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** The accessible name of a photo: its date and pose, never a description of a body. */
export function progressPhotoAlt(photo: Pick<ProgressPhoto, 'localDate' | 'pose'>): string {
  return `Progress photo, ${PROGRESS_PHOTO_POSE_LABELS[photo.pose].toLowerCase()} pose, ${formatPhotoDate(photo.localDate)}`;
}

/** Group photos by `localDate` month, newest month first, keeping each month's order. */
export function groupProgressPhotosByMonth(photos: readonly ProgressPhoto[]): ProgressPhotoMonth[] {
  const byKey = new Map<string, ProgressPhoto[]>();
  for (const photo of photos) {
    const key = photo.localDate.slice(0, 7);
    const list = byKey.get(key);
    if (list) list.push(photo);
    else byKey.set(key, [photo]);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, list]) => ({ key, label: formatPhotoMonth(key), photos: list }));
}
