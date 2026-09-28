// =============================================================================
// Storage-object inputs to a Responses request (issue #441, epic #420)
// =============================================================================
//
// An `image`/`file` content part may name one of the caller's storage objects
// (`{ type: 'file', storageObjectId }`) instead of a public URL. The RUNTIME
// resolves it before the adapter is called — ownership, readiness, modality
// against the model's capabilities, size — and hands the adapter what its
// declared DELIVERY STRATEGY needs, through `AiCallContext.storageInputs`:
//
//   presigned_url   a short-lived signed GET URL the provider fetches itself
//                   (`AI_STORAGE_INPUT_URL_TTL_SECONDS`); the bytes never pass
//                   through this API.
//   upload          the adapter streams the bytes to the provider's own file
//                   store and deletes the provider-side copy afterwards.
//   inline          the adapter embeds the bytes in the request (base64).
//
// The request itself is never rewritten: it keeps `storageObjectId`, so what
// is logged (the opt-in prompt log), queued (`ai_runs.request`) or recorded
// never carries a URL or bytes. A background run resolves again when it
// executes, under the same checks, with a fresh URL.
//
// ⚠ A presigned URL is a bearer capability for the object: it lives only in
// `AiCallContext.storageInputs`, for one call, and must never be logged,
// persisted, put on a span, or returned — the same rule as `apiKey`.
// =============================================================================

import type { AiBinaryPayload } from './media.types';

/** The largest image a Responses request may reference by storage object (20 MiB). */
export const AI_STORAGE_INPUT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** The largest non-image file a Responses request may reference by storage object (50 MiB). */
export const AI_STORAGE_INPUT_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** The most storage-object parts one request may carry. */
export const AI_STORAGE_INPUTS_MAX = 16;

/** How long a presigned input URL stays valid, in seconds (10 minutes). */
export const AI_STORAGE_INPUT_URL_TTL_SECONDS = 600;

/**
 * Stored objects of these MIME types are IMAGES (they need `vision_input`
 * and are capped at `AI_STORAGE_INPUT_IMAGE_MAX_BYTES`); every other type is
 * a FILE (`file_input`, `AI_STORAGE_INPUT_FILE_MAX_BYTES`).
 */
export const AI_STORAGE_INPUT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** What kind of input a stored object is, decided by its MIME type. */
export type AiStorageInputModality = 'image' | 'file';

/** How an adapter wants a resolved storage input delivered (see the file header). */
export type AiFileInputStrategy = 'presigned_url' | 'upload' | 'inline';

/**
 * An adapter's delivery strategy per modality. Presence on the adapter IS the
 * declaration that it accepts storage-object inputs at all; an adapter
 * without one refuses them with `AI_CAPABILITY_UNSUPPORTED`.
 */
export type AiFileInputStrategies = Readonly<Record<AiStorageInputModality, AiFileInputStrategy>>;

/** The modality of a stored object with `mimeType`. */
export function storageInputModality(mimeType: string): AiStorageInputModality {
  const normalised = mimeType.split(';')[0].trim().toLowerCase();

  return (AI_STORAGE_INPUT_IMAGE_MIME_TYPES as readonly string[]).includes(normalised) ? 'image' : 'file';
}

/** The size cap for a modality. */
export function storageInputMaxBytes(modality: AiStorageInputModality): number {
  return modality === 'image' ? AI_STORAGE_INPUT_IMAGE_MAX_BYTES : AI_STORAGE_INPUT_FILE_MAX_BYTES;
}

/**
 * One storage-object input, resolved and authorised by the runtime for one
 * provider call. Exactly what the adapter's declared strategy needs is set.
 */
export interface AiResolvedStorageInput {
  storageObjectId: string;
  modality: AiStorageInputModality;
  /** Normalised MIME type (lower case, no parameters). */
  mimeType: string;
  /** The object's display name — a provider-facing filename. */
  filename: string;
  /** The strategy this input was prepared for (the adapter's own declaration). */
  strategy: AiFileInputStrategy;
  /**
   * `presigned_url` only: a signed GET URL valid for
   * `AI_STORAGE_INPUT_URL_TTL_SECONDS`. ⚠ Never log, persist or return it.
   */
  url?: string;
  /**
   * `upload`/`inline`: the object's bytes as a stream (a Node `Readable` in
   * practice), failing with `AI_INVALID_REQUEST` once more than the
   * modality's cap has arrived.
   */
  open?(): Promise<AsyncIterable<Uint8Array>>;
  /** `upload`/`inline`: the bytes buffered, with the same cap. */
  read?(): Promise<AiBinaryPayload>;
}

/** Every resolved storage input of one call, keyed by storage object id. */
export type AiResolvedStorageInputs = ReadonlyMap<string, AiResolvedStorageInput>;
