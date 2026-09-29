/**
 * Several photos, picked or captured, shrunk and uploaded — the state behind
 * `components/intake/ImageIntake.tsx`.
 *
 * Each photo is a tile moving through `queued → downscaling → uploading →
 * processing → ready` (or `error`, with Retry). At most
 * {@link IMAGE_INTAKE_CONCURRENCY} photos are in flight at once.
 *
 * The caller decides WHERE a photo goes: `uploadPhoto` uploads it and links it
 * to whatever record it helps create (`uploadAndAttach(intakeId)` from
 * `services/intake.ts` is the usual one), and `removePhoto` undoes that. The
 * optional second argument lets an `uploadPhoto` report the `processing`
 * stage (the upload is done, the server is still post-processing).
 *
 * PROGRESS IS HONEST: the shared transport is `fetch`, which has no upload
 * progress events, so a tile shows its stage and the hook an aggregate
 * count ("3 of 8 ready"), never an invented percentage.
 *
 * `previewUrl` is an object URL of the chosen file, revoked when the tile is
 * removed and when the hook unmounts. A photo that was already on the server
 * (`initialPhotos`, a resumed intake) has `previewUrl: null`; the tile shows
 * it through a signed URL instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downscaleImage, UnsupportedImageError } from '../utils/downscaleImage';

export const IMAGE_INTAKE_DEFAULT_MAX_PHOTOS = 48;
export const IMAGE_INTAKE_CONCURRENCY = 3;

export type IntakePhotoStage = 'queued' | 'downscaling' | 'uploading' | 'processing' | 'ready' | 'error';

export interface IntakePhotoState {
  key: string;
  name: string;
  /** Object URL of the local file, or `null` for a photo already on the server. */
  previewUrl: string | null;
  stage: IntakePhotoStage;
  error?: string;
  storageObjectId?: string;
}

export interface UploadPhotoContext {
  /** Report a stage after `uploading` (the server is post-processing). */
  setStage: (stage: 'uploading' | 'processing') => void;
}

export interface UseImageIntakeOptions {
  /** 48 by default. */
  maxPhotos?: number;
  maxEdgePx?: number;
  quality?: number;
  uploadPhoto: (file: File, context?: UploadPhotoContext) => Promise<{ storageObjectId: string }>;
  removePhoto: (storageObjectId: string) => Promise<void>;
  /** Photos already attached (a resumed intake); shown as `ready` tiles. */
  initialPhotos?: readonly { storageObjectId: string; name: string }[];
}

export interface UseImageIntakeReturn {
  items: IntakePhotoState[];
  addFiles: (files: FileList | File[]) => void;
  remove: (key: string) => Promise<void>;
  retry: (key: string) => void;
  readyCount: number;
  /** True while any photo is queued or in flight. */
  busy: boolean;
  /** Storage object ids of the `ready` photos, in tile order. */
  readyIds: string[];
  maxPhotos: number;
  /** One message about files that were not added (over the limit, not an image), or `null`. */
  notice: string | null;
  clearNotice: () => void;
}

const IN_FLIGHT: ReadonlySet<IntakePhotoStage> = new Set(['downscaling', 'uploading', 'processing']);

let sequence = 0;
function nextKey(): string {
  sequence += 1;
  return `photo-${sequence}`;
}

function createPreview(file: File): string | null {
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
  } catch {
    return null;
  }
}

function revokePreview(url: string | null): void {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Nothing to release.
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof UnsupportedImageError) return 'This file cannot be read. Convert to JPEG or PNG.';
  if (err instanceof Error && err.message) return err.message;
  return 'Upload failed';
}

function isImage(file: File): boolean {
  // Some platforms report no type for a HEIC file; let the decoder decide.
  return !file.type || file.type.startsWith('image/');
}

export function useImageIntake(options: UseImageIntakeOptions): UseImageIntakeReturn {
  const { maxPhotos = IMAGE_INTAKE_DEFAULT_MAX_PHOTOS, maxEdgePx, quality, initialPhotos } = options;
  const [items, setItems] = useState<IntakePhotoState[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // The source of truth for the scheduler, mirrored into state for rendering.
  const itemsRef = useRef<IntakePhotoState[]>([]);
  const filesRef = useRef(new Map<string, File>());
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const settingsRef = useRef({ maxEdgePx, quality });
  settingsRef.current = { maxEdgePx, quality };
  const seenInitialRef = useRef(new Set<string>());

  const commit = useCallback((next: IntakePhotoState[]) => {
    itemsRef.current = next;
    if (mountedRef.current) setItems(next);
  }, []);

  const patch = useCallback(
    (key: string, change: Partial<IntakePhotoState>) => {
      if (!itemsRef.current.some((item) => item.key === key)) return false;
      commit(itemsRef.current.map((item) => (item.key === key ? { ...item, ...change } : item)));
      return true;
    },
    [commit],
  );

  const pumpRef = useRef<() => void>(() => undefined);

  const process = useCallback(
    async (key: string) => {
      const file = filesRef.current.get(key);
      if (!file) return;
      const alive = () => mountedRef.current && itemsRef.current.some((item) => item.key === key);
      try {
        patch(key, { stage: 'downscaling', error: undefined });
        const { maxEdgePx: edge, quality: q } = settingsRef.current;
        const shrunk = await downscaleImage(file, {
          ...(edge !== undefined ? { maxEdgePx: edge } : {}),
          ...(q !== undefined ? { quality: q } : {}),
        });
        if (!alive()) return;
        patch(key, { stage: 'uploading' });
        const result = await optionsRef.current.uploadPhoto(shrunk, {
          setStage: (stage) => {
            if (alive()) patch(key, { stage });
          },
        });
        if (!alive()) {
          // Removed (or unmounted) while uploading: do not leave it attached.
          await optionsRef.current.removePhoto(result.storageObjectId).catch(() => undefined);
          return;
        }
        filesRef.current.delete(key);
        patch(key, { stage: 'ready', storageObjectId: result.storageObjectId });
      } catch (err) {
        if (alive()) patch(key, { stage: 'error', error: errorMessage(err) });
      } finally {
        pumpRef.current();
      }
    },
    [patch],
  );

  const pump = useCallback(() => {
    if (!mountedRef.current) return;
    let active = itemsRef.current.filter((item) => IN_FLIGHT.has(item.stage)).length;
    for (const item of itemsRef.current) {
      if (active >= IMAGE_INTAKE_CONCURRENCY) break;
      if (item.stage !== 'queued') continue;
      active += 1;
      // Mark it before the async body starts so the next pass does not pick it again.
      patch(item.key, { stage: 'downscaling' });
      void process(item.key);
    }
  }, [patch, process]);
  pumpRef.current = pump;

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      const images = list.filter(isImage);
      const notImages = list.length - images.length;
      const room = Math.max(0, maxPhotos - itemsRef.current.length);
      const accepted = images.slice(0, room);
      const overLimit = images.length - accepted.length;

      const messages: string[] = [];
      if (overLimit > 0) {
        messages.push(
          `${overLimit} ${overLimit === 1 ? 'photo was' : 'photos were'} not added: at most ${maxPhotos} photos.`,
        );
      }
      if (notImages > 0) {
        messages.push(`${notImages} ${notImages === 1 ? 'file is' : 'files are'} not an image and ${notImages === 1 ? 'was' : 'were'} skipped.`);
      }
      setNotice(messages.length ? messages.join(' ') : null);
      if (accepted.length === 0) return;

      const added: IntakePhotoState[] = accepted.map((file) => {
        const key = nextKey();
        filesRef.current.set(key, file);
        return { key, name: file.name, previewUrl: createPreview(file), stage: 'queued' };
      });
      commit([...itemsRef.current, ...added]);
      pump();
    },
    [commit, maxPhotos, pump],
  );

  const remove = useCallback(
    async (key: string) => {
      const item = itemsRef.current.find((entry) => entry.key === key);
      if (!item) return;
      revokePreview(item.previewUrl);
      filesRef.current.delete(key);
      commit(itemsRef.current.filter((entry) => entry.key !== key));
      pump();
      if (item.storageObjectId) {
        try {
          await optionsRef.current.removePhoto(item.storageObjectId);
        } catch (err) {
          if (mountedRef.current) setNotice(`Could not remove ${item.name}: ${errorMessage(err)}`);
        }
      }
    },
    [commit, pump],
  );

  const retry = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((entry) => entry.key === key);
      if (!item || item.stage !== 'error' || !filesRef.current.has(key)) return;
      patch(key, { stage: 'queued', error: undefined });
      pump();
    },
    [patch, pump],
  );

  // Seed photos already on the server (a resumed intake), once each.
  useEffect(() => {
    if (!initialPhotos?.length) return;
    const present = new Set(itemsRef.current.map((item) => item.storageObjectId).filter(Boolean));
    const fresh = initialPhotos.filter(
      (photo) => !present.has(photo.storageObjectId) && !seenInitialRef.current.has(photo.storageObjectId),
    );
    if (fresh.length === 0) return;
    for (const photo of fresh) seenInitialRef.current.add(photo.storageObjectId);
    commit([
      ...fresh.map<IntakePhotoState>((photo) => ({
        key: nextKey(),
        name: photo.name,
        previewUrl: null,
        stage: 'ready',
        storageObjectId: photo.storageObjectId,
      })),
      ...itemsRef.current,
    ]);
  }, [initialPhotos, commit]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const item of itemsRef.current) revokePreview(item.previewUrl);
    };
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);

  const derived = useMemo(() => {
    const ready = items.filter((item) => item.stage === 'ready' && item.storageObjectId);
    return {
      readyCount: ready.length,
      readyIds: ready.map((item) => item.storageObjectId as string),
      busy: items.some((item) => item.stage === 'queued' || IN_FLIGHT.has(item.stage)),
    };
  }, [items]);

  return { items, addFiles, remove, retry, ...derived, maxPhotos, notice, clearNotice };
}
