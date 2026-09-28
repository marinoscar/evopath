/**
 * The caller's own storage objects (`/api/storage/objects`) — issue #445.
 *
 * The slice of the storage API the AI Playground needs: upload a file the AI
 * call will read by `storageObjectId` (an image to edit, and — in later
 * stories — audio to transcribe or a file to attach), wait for it to become
 * usable, and get a short-lived signed URL to show or download an object the
 * AI created (a generated image).
 *
 * ⚠ AN UPLOAD IS NOT USABLE AT ONCE. `POST /storage/objects` answers with the
 * object in `processing`; post-processing moves it to `ready` (or `failed`)
 * moments later, and the AI routes refuse an input that is not `ready`
 * (`AI_INVALID_REQUEST`). {@link uploadStorageObjectAndWait} is the one call a
 * feature should make.
 *
 * ⚠ A SIGNED URL IS A BEARER CREDENTIAL for its lifetime: it is fetched when
 * needed, kept in memory only, and never logged or stored.
 */
import { api } from './api';

export type StorageObjectStatus = 'pending' | 'uploading' | 'processing' | 'ready' | 'failed';

/** `GET /storage/objects/:id` and the upload response. */
export interface StorageObject {
  id: string;
  name: string;
  /** Bytes, as a decimal string (64-bit on the server). */
  size: string;
  mimeType: string;
  status: StorageObjectStatus;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /storage/objects/:id/download`. */
export interface StorageDownloadUrl {
  /** Time-limited signed URL; fetched directly, without an Authorization header. */
  url: string;
  /** Seconds until the URL stops working. */
  expiresIn: number;
}

/** `POST /storage/objects` — a simple (single-request) upload. */
export async function uploadStorageObject(file: File): Promise<StorageObject> {
  const formData = new FormData();
  formData.append('file', file);
  return api.postFormData<StorageObject>('/storage/objects', formData);
}

export async function getStorageObject(id: string): Promise<StorageObject> {
  return api.get<StorageObject>(`/storage/objects/${encodeURIComponent(id)}`);
}

export async function getStorageObjectDownloadUrl(id: string): Promise<StorageDownloadUrl> {
  return api.get<StorageDownloadUrl>(`/storage/objects/${encodeURIComponent(id)}/download`);
}

/** Thrown when an uploaded object ends `failed` or never becomes `ready`. */
export class StorageObjectNotReadyError extends Error {
  constructor(
    readonly objectId: string,
    readonly status: StorageObjectStatus | 'timeout',
  ) {
    super(
      status === 'timeout'
        ? 'The uploaded file is still being processed. Try again in a moment.'
        : 'The uploaded file could not be processed.',
    );
    this.name = 'StorageObjectNotReadyError';
  }
}

export interface WaitForReadyOptions {
  /** Between reads; 500 ms by default. */
  intervalMs?: number;
  /** Give up after this long; 30 s by default. */
  timeoutMs?: number;
}

/** Poll an object until it is `ready`; throws {@link StorageObjectNotReadyError} otherwise. */
export async function waitForStorageObjectReady(
  object: StorageObject,
  { intervalMs = 500, timeoutMs = 30_000 }: WaitForReadyOptions = {},
): Promise<StorageObject> {
  const deadline = Date.now() + timeoutMs;
  let current = object;
  while (current.status !== 'ready') {
    if (current.status === 'failed') throw new StorageObjectNotReadyError(current.id, 'failed');
    if (Date.now() >= deadline) throw new StorageObjectNotReadyError(current.id, 'timeout');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    current = await getStorageObject(current.id);
  }
  return current;
}

/** Upload a file and resolve once it is `ready` for an AI call to read. */
export async function uploadStorageObjectAndWait(
  file: File,
  options?: WaitForReadyOptions,
): Promise<StorageObject> {
  return waitForStorageObjectReady(await uploadStorageObject(file), options);
}
