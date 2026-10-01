/**
 * Photo intake (`/api/intakes`) — the reusable "share a picture instead of
 * typing" foundation.
 *
 * An intake is a server-side staging record: the photos a user shared, the
 * AI's DRAFT items read from them, and the user's edits, until the user
 * applies the accepted items to real data. Every flow (gym equipment,
 * workout prefill, …) is one registered `kind` on the server; this module is
 * kind-agnostic, and `TValue` is the kind's item value.
 *
 * The browser never decides anything here: the API validates every value
 * against the kind's schema, enforces ownership and permissions, and keeps
 * the provenance (`originalAiValue`, `userVerified`). This file only types
 * the routes.
 */
import { api, ApiError } from './api';
import { deleteStorageObject, uploadStorageObject, waitForStorageObjectReady } from './storage';

export type PhotoIntakeStatus = 'draft' | 'scanning' | 'ready' | 'applied' | 'failed';
export type DraftItemOrigin = 'ai' | 'user';
export type DraftItemStatus = 'pending' | 'accepted' | 'rejected';
export type DraftItemConfidence = 'high' | 'medium' | 'low';

/**
 * What happens to a health intake's files once it is applied or discarded
 * (H1, #185): `keep` (the default) or `delete_after_processing` (erased once
 * the values are saved; the values and their provenance stay).
 */
export type FileRetention = 'keep' | 'delete_after_processing';

/**
 * The intake kinds whose files are health documents, so the keep-or-delete
 * choice applies. Presentation only: the server decides per kind
 * (`healthDocumentKind`) and ignores the choice for any other kind.
 */
export const HEALTH_INTAKE_KINDS: readonly string[] = ['body_metric_reading'];

/** The keep-or-delete choice a health upload starts with: keep (pre-selected). */
export const DEFAULT_RETAIN_FILES = true;

export function isHealthIntakeKind(kind: string | null | undefined): boolean {
  return typeof kind === 'string' && HEALTH_INTAKE_KINDS.includes(kind);
}

/** One draft item — the public contract (OpenAPI `DraftItemView`). */
export interface DraftItemView<TValue = unknown> {
  id: string;
  kind: string;
  origin: DraftItemOrigin;
  status: DraftItemStatus;
  /** `null` for a user-added item. */
  confidence: DraftItemConfidence | null;
  /** The AI flagged that it is not sure about something in this item. */
  uncertain: boolean;
  uncertaintyNote: string | null;
  /** Storage object ids of the photos this item was read from. */
  sourcePhotoIds: string[];
  userVerified: boolean;
  value: TValue;
  /** Non-null once an AI item was edited: the value the AI proposed. */
  originalAiValue: TValue | null;
  sortOrder: number;
}

/** A photo attached to an intake. */
export interface PhotoIntakePhotoView {
  id: string;
  storageObjectId: string;
  name: string;
  sortOrder: number;
  /** The health document this file is, for a health intake kind; `null` otherwise. */
  healthDocumentId: string | null;
  /** That document's keep-or-delete choice; `null` when the file is not a health document. */
  retention: FileRetention | null;
}

/** `GET /intakes/:id`. */
export interface PhotoIntakeView<TValue = unknown, TContext = unknown> {
  id: string;
  kind: string;
  status: PhotoIntakeStatus;
  subjectType: string | null;
  subjectId: string | null;
  context: TContext | null;
  provider: string | null;
  modelId: string | null;
  jobId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** The keep-or-delete choice for the intake's files (`keep` by default). */
  retention: FileRetention;
  /** `retention === 'keep'`. */
  retainFiles: boolean;
  /** What the analyzer recorded (prompt version, batches, items it could not validate). */
  resultMeta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  photos: PhotoIntakePhotoView[];
  items: DraftItemView<TValue>[];
}

/** A row of `GET /intakes`: no photos or items, their counts instead. */
export type PhotoIntakeSummary<TContext = unknown> = Omit<PhotoIntakeView<unknown, TContext>, 'photos' | 'items'> & {
  photoCount: number;
  itemCount: number;
};

export interface CreateIntakeRequest<TContext = unknown> {
  kind: string;
  context?: TContext;
  subjectType?: string;
  subjectId?: string;
  /** Keep the uploaded files after processing; the server defaults to `true`. Health kinds only. */
  retainFiles?: boolean;
}

export interface ListIntakesFilter {
  kind?: string;
  subjectId?: string;
  /** One status or several (sent as a comma list). */
  status?: PhotoIntakeStatus | PhotoIntakeStatus[];
  /** At most 50; the server defaults to 20. */
  limit?: number;
}

/** `POST /intakes/:id/analyze` answers 202 with this. */
export interface IntakeAnalyzeStarted {
  intakeId: string;
  jobId: string;
}

export interface UpdateDraftItemRequest<TValue = unknown> {
  value?: TValue;
  status?: DraftItemStatus;
}

const base = (id: string) => `/intakes/${encodeURIComponent(id)}`;

export async function createIntake<TContext = unknown>(
  req: CreateIntakeRequest<TContext>,
): Promise<PhotoIntakeView<unknown, TContext>> {
  return api.post<PhotoIntakeView<unknown, TContext>>('/intakes', req);
}

export async function listIntakes(filter: ListIntakesFilter = {}): Promise<PhotoIntakeSummary[]> {
  const params = new URLSearchParams();
  if (filter.kind) params.set('kind', filter.kind);
  if (filter.subjectId) params.set('subjectId', filter.subjectId);
  if (filter.status) {
    params.set('status', Array.isArray(filter.status) ? filter.status.join(',') : filter.status);
  }
  if (filter.limit !== undefined) params.set('limit', String(filter.limit));
  const query = params.toString();
  return api.get<PhotoIntakeSummary[]>(`/intakes${query ? `?${query}` : ''}`);
}

export async function getIntake<TValue = unknown, TContext = unknown>(
  id: string,
): Promise<PhotoIntakeView<TValue, TContext>> {
  return api.get<PhotoIntakeView<TValue, TContext>>(base(id));
}

/**
 * `PATCH /intakes/:id`: replace the intake's context (the whole object; the
 * kind's schema validates it). Allowed while the intake is not scanning or
 * applied.
 */
export async function updateIntakeContext<TValue = unknown, TContext = unknown>(
  id: string,
  context: TContext,
): Promise<PhotoIntakeView<TValue, TContext>> {
  return api.patch<PhotoIntakeView<TValue, TContext>>(base(id), { context });
}

/**
 * `PATCH /intakes/:id { retainFiles }`: change the keep-or-delete choice for
 * the intake and every file already attached. Refused once the intake is
 * applied.
 */
export async function updateIntakeRetainFiles<TValue = unknown, TContext = unknown>(
  id: string,
  retainFiles: boolean,
): Promise<PhotoIntakeView<TValue, TContext>> {
  return api.patch<PhotoIntakeView<TValue, TContext>>(base(id), { retainFiles });
}

/** Discard an intake (allowed unless `applied`). */
export async function discardIntake(id: string): Promise<void> {
  await api.delete<void>(base(id));
}

/**
 * Attach a ready storage object. `retainFiles`, when given, is this file's
 * own keep-or-delete choice; omitted, the file takes the intake's.
 */
export async function attachIntakePhoto(
  id: string,
  storageObjectId: string,
  options: { retainFiles?: boolean } = {},
): Promise<PhotoIntakePhotoView> {
  const body: { storageObjectId: string; retainFiles?: boolean } = { storageObjectId };
  if (options.retainFiles !== undefined) body.retainFiles = options.retainFiles;
  return api.post<PhotoIntakePhotoView>(`${base(id)}/photos`, body);
}

export async function removeIntakePhoto(id: string, storageObjectId: string): Promise<void> {
  await api.delete<void>(`${base(id)}/photos/${encodeURIComponent(storageObjectId)}`);
}

/**
 * Start the AI read. The body is an empty object, always: the server resolves
 * the model from the administrator's assignments (#173) and refuses a body
 * naming another one (409 `AI_MODEL_ASSIGNMENT_LOCKED`). A request with no
 * body at all is a 400, so `{}` is sent explicitly.
 */
export async function analyzeIntake(id: string): Promise<IntakeAnalyzeStarted> {
  return api.post<IntakeAnalyzeStarted>(`${base(id)}/analyze`, {});
}

export async function addDraftItem<TValue = unknown>(
  id: string,
  item: { kind: string; value: TValue },
): Promise<DraftItemView<TValue>> {
  return api.post<DraftItemView<TValue>>(`${base(id)}/items`, item);
}

export async function updateDraftItem<TValue = unknown>(
  id: string,
  itemId: string,
  patch: UpdateDraftItemRequest<TValue>,
): Promise<DraftItemView<TValue>> {
  return api.patch<DraftItemView<TValue>>(`${base(id)}/items/${encodeURIComponent(itemId)}`, patch);
}

/** Hard-delete a USER item. An AI item answers 409 `USE_REJECT`: reject it instead. */
export async function deleteDraftItem(id: string, itemId: string): Promise<void> {
  await api.delete<void>(`${base(id)}/items/${encodeURIComponent(itemId)}`);
}

export async function acceptAllDraftItems<TValue = unknown>(id: string): Promise<DraftItemView<TValue>[]> {
  return api.post<DraftItemView<TValue>[]>(`${base(id)}/items/accept-all`);
}

/** Apply the accepted items; resolves with the kind's own result. */
export async function applyIntake<TResult = unknown>(id: string): Promise<TResult> {
  return api.post<TResult>(`${base(id)}/apply`);
}

/**
 * The attach refusals a file can meet (H2, #186), in words the user can act
 * on. The API puts the reason in `details.reason` (the top-level `code` is the
 * generic HTTP one); the server decides, this only phrases it.
 *
 * - `TOO_MANY_PAGES` → "This PDF has N pages; the limit is 20."
 * - `PDF_UNREADABLE` → damaged or password-protected.
 * - `UNSUPPORTED_MEDIA_TYPE` with `details.contentMismatch` → the bytes are not
 *   what the name says (a renamed file); without it → a type this kind refuses.
 * - `OBJECT_TOO_LARGE` → the cap from `details.maxBytes`.
 *
 * Anything else keeps the server's (or the browser's) own message.
 */
export function intakeFileErrorMessage(err: unknown, kind: 'image' | 'pdf' = 'image'): string {
  if (err instanceof ApiError) {
    const details = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
    const reason = typeof details.reason === 'string' ? details.reason : err.code;
    switch (reason) {
      case 'TOO_MANY_PAGES': {
        const pages = typeof details.pages === 'number' ? details.pages : null;
        const maxPages = typeof details.maxPages === 'number' ? details.maxPages : null;
        if (pages !== null && maxPages !== null) return `This PDF has ${pages} pages; the limit is ${maxPages}.`;
        return maxPages !== null ? `This PDF has too many pages; the limit is ${maxPages}.` : 'This PDF has too many pages.';
      }
      case 'PDF_UNREADABLE':
        return "This PDF can't be read. It may be damaged or password-protected; export it again or upload a photo instead.";
      case 'UNSUPPORTED_MEDIA_TYPE':
        if (details.contentMismatch === true) {
          return kind === 'pdf'
            ? "This file isn't a real PDF. Export the report as a PDF again, or upload a photo."
            : "This file isn't a real image. Use a JPEG, PNG, GIF or WebP photo.";
        }
        return kind === 'pdf'
          ? "PDFs can't be read here. Upload a photo instead."
          : "This file type can't be read here. Use a JPEG, PNG, GIF or WebP photo.";
      case 'OBJECT_TOO_LARGE': {
        const maxBytes = typeof details.maxBytes === 'number' ? details.maxBytes : null;
        const limit = maxBytes !== null ? ` of ${Math.round(maxBytes / (1024 * 1024))} MiB` : '';
        return `This ${kind === 'pdf' ? 'PDF' : 'photo'} is over the size limit${limit}.`;
      }
      default:
        break;
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Upload failed';
}

/**
 * The default `uploadPhoto` for `useImageIntake`: upload the file (the same
 * two steps as `uploadStorageObjectAndWait`, split so the tile can show
 * `processing`), wait for it to be `ready`, then attach it to the intake.
 * When processing or the attach fails, the fresh storage object is deleted
 * (best effort) so no orphan is left, and the error is rethrown for the tile
 * to show Retry.
 *
 * `options.retainFiles`, when given, is read at attach time so each file
 * carries the keep-or-delete choice showing when it was attached (health
 * kinds; see `RetainFilesControl`).
 */
export function uploadAndAttach(
  intakeId: string,
  options: { retainFiles?: () => boolean | undefined } = {},
): (file: File, context?: { setStage: (stage: 'uploading' | 'processing') => void }) => Promise<{ storageObjectId: string }> {
  return async (file, context) => {
    const uploaded = await uploadStorageObject(file);
    try {
      context?.setStage('processing');
      const ready = await waitForStorageObjectReady(uploaded);
      await attachIntakePhoto(intakeId, ready.id, { retainFiles: options.retainFiles?.() });
    } catch (err) {
      await deleteStorageObject(uploaded.id).catch(() => undefined);
      throw err;
    }
    return { storageObjectId: uploaded.id };
  };
}

/** The matching default `removePhoto`: detach (the server deletes the unreferenced object). */
export function detachFrom(intakeId: string): (storageObjectId: string) => Promise<void> {
  return (storageObjectId: string) => removeIntakePhoto(intakeId, storageObjectId);
}
