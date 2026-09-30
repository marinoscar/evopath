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
 *
 * PDFs (H2, #186) are accepted only with `acceptPdf` (a kind whose server
 * `acceptedInputs` lists `'pdf'`, e.g. `body_metric_reading`). A PDF skips the
 * downscale (no canvas, no EXIF to strip) and is uploaded as it is, typed
 * `application/pdf`, going `queued → uploading → processing → ready`. It is
 * checked against {@link INTAKE_PDF_MAX_BYTES} before upload; the server
 * re-checks size, magic bytes and pages and is the authority.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downscaleImage, UnsupportedImageError } from '../utils/downscaleImage';
import { intakeFileErrorMessage } from '../services/intake';

export const IMAGE_INTAKE_DEFAULT_MAX_PHOTOS = 48;
export const IMAGE_INTAKE_CONCURRENCY = 3;
/** The server's PDF cap (`AI_STORAGE_INPUT_FILE_MAX_BYTES`), 50 MiB, checked before upload. */
export const INTAKE_PDF_MAX_BYTES = 50 * 1024 * 1024;
export const PDF_MIME_TYPE = 'application/pdf';

/** What a tile holds: a photo, or a PDF document. */
export type IntakeFileKind = 'image' | 'pdf';

export type IntakePhotoStage = 'queued' | 'downscaling' | 'uploading' | 'processing' | 'ready' | 'error';

export interface IntakePhotoState {
  key: string;
  name: string;
  /** `pdf` for a PDF document (no preview; the tile shows a file icon). */
  kind: IntakeFileKind;
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
  /**
   * Also take PDFs (uploaded as they are, up to {@link INTAKE_PDF_MAX_BYTES}).
   * Only for a kind whose server `acceptedInputs` lists `'pdf'`; the server
   * refuses a PDF on any other kind.
   */
  acceptPdf?: boolean;
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
  /** Whether PDFs are taken (the picker's `accept` and copy follow it). */
  acceptPdf: boolean;
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

function errorMessage(err: unknown, kind: IntakeFileKind = 'image'): string {
  if (err instanceof UnsupportedImageError) return 'This file cannot be read. Convert to JPEG or PNG.';
  return intakeFileErrorMessage(err, kind);
}

/** A PDF by its declared type, or by its extension when the platform reports none. */
export function isPdfFile(file: Pick<File, 'type' | 'name'>): boolean {
  if (file.type) return file.type.toLowerCase() === PDF_MIME_TYPE;
  return isPdfName(file.name);
}

/** A stored file's name says PDF (a resumed intake carries no type). */
export function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

function isImage(file: File): boolean {
  // Some platforms report no type for a HEIC file; let the decoder decide.
  if (!file.type) return !isPdfName(file.name);
  return file.type.startsWith('image/');
}

/** The PDF as it is uploaded: its bytes untouched, always typed `application/pdf`. */
function asPdfUpload(file: File): File {
  if (file.type === PDF_MIME_TYPE) return file;
  return new File([file], file.name, { type: PDF_MIME_TYPE, lastModified: file.lastModified });
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

export function useImageIntake(options: UseImageIntakeOptions): UseImageIntakeReturn {
  const { maxPhotos = IMAGE_INTAKE_DEFAULT_MAX_PHOTOS, maxEdgePx, quality, initialPhotos, acceptPdf = false } = options;
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
      const kind = itemsRef.current.find((item) => item.key === key)?.kind ?? 'image';
      const alive = () => mountedRef.current && itemsRef.current.some((item) => item.key === key);
      try {
        let upload: File;
        if (kind === 'pdf') {
          // A PDF is uploaded as it is: no canvas, no EXIF to strip.
          upload = asPdfUpload(file);
        } else {
          patch(key, { stage: 'downscaling', error: undefined });
          const { maxEdgePx: edge, quality: q } = settingsRef.current;
          upload = await downscaleImage(file, {
            ...(edge !== undefined ? { maxEdgePx: edge } : {}),
            ...(q !== undefined ? { quality: q } : {}),
          });
          if (!alive()) return;
        }
        patch(key, { stage: 'uploading', error: undefined });
        const result = await optionsRef.current.uploadPhoto(upload, {
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
        if (alive()) patch(key, { stage: 'error', error: errorMessage(err, kind) });
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
      patch(item.key, { stage: item.kind === 'pdf' ? 'uploading' : 'downscaling' });
      void process(item.key);
    }
  }, [patch, process]);
  pumpRef.current = pump;

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      const usable: File[] = [];
      const tooLarge: File[] = [];
      let unsupported = 0;
      for (const file of list) {
        if (acceptPdf && isPdfFile(file)) {
          if (file.size > INTAKE_PDF_MAX_BYTES) tooLarge.push(file);
          else usable.push(file);
        } else if (isImage(file)) {
          usable.push(file);
        } else {
          unsupported += 1;
        }
      }
      const room = Math.max(0, maxPhotos - itemsRef.current.length);
      const accepted = usable.slice(0, room);
      const overLimit = usable.length - accepted.length;
      const noun = acceptPdf ? 'file' : 'photo';

      const messages: string[] = [];
      if (overLimit > 0) {
        messages.push(
          `${overLimit} ${noun}${overLimit === 1 ? ' was' : 's were'} not added: at most ${maxPhotos} ${noun}s.`,
        );
      }
      if (unsupported > 0) {
        const what = acceptPdf ? 'an image or a PDF' : 'an image';
        messages.push(
          `${unsupported} ${unsupported === 1 ? 'file is' : 'files are'} not ${what} and ${unsupported === 1 ? 'was' : 'were'} skipped.`,
        );
      }
      for (const file of tooLarge) {
        messages.push(`${file.name} is larger than ${formatMiB(INTAKE_PDF_MAX_BYTES)}, the limit for a PDF, and was skipped.`);
      }
      setNotice(messages.length ? messages.join(' ') : null);
      if (accepted.length === 0) return;

      const added: IntakePhotoState[] = accepted.map((file) => {
        const key = nextKey();
        filesRef.current.set(key, file);
        const kind: IntakeFileKind = acceptPdf && isPdfFile(file) ? 'pdf' : 'image';
        return { key, name: file.name, kind, previewUrl: kind === 'pdf' ? null : createPreview(file), stage: 'queued' };
      });
      commit([...itemsRef.current, ...added]);
      pump();
    },
    [acceptPdf, commit, maxPhotos, pump],
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
          if (mountedRef.current) setNotice(`Could not remove ${item.name}: ${errorMessage(err, item.kind)}`);
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
        kind: isPdfName(photo.name) ? 'pdf' : 'image',
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

  return { items, addFiles, remove, retry, ...derived, maxPhotos, acceptPdf, notice, clearNotice };
}
