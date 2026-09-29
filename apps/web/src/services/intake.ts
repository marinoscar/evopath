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
import { api } from './api';
import { deleteStorageObject, uploadStorageObject, waitForStorageObjectReady } from './storage';

export type PhotoIntakeStatus = 'draft' | 'scanning' | 'ready' | 'applied' | 'failed';
export type DraftItemOrigin = 'ai' | 'user';
export type DraftItemStatus = 'pending' | 'accepted' | 'rejected';
export type DraftItemConfidence = 'high' | 'medium' | 'low';

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

/** Discard an intake (allowed unless `applied`). */
export async function discardIntake(id: string): Promise<void> {
  await api.delete<void>(base(id));
}

export async function attachIntakePhoto(id: string, storageObjectId: string): Promise<PhotoIntakePhotoView> {
  return api.post<PhotoIntakePhotoView>(`${base(id)}/photos`, { storageObjectId });
}

export async function removeIntakePhoto(id: string, storageObjectId: string): Promise<void> {
  await api.delete<void>(`${base(id)}/photos/${encodeURIComponent(storageObjectId)}`);
}

export async function analyzeIntake(
  id: string,
  model: { provider: string; modelId: string },
): Promise<IntakeAnalyzeStarted> {
  return api.post<IntakeAnalyzeStarted>(`${base(id)}/analyze`, {
    provider: model.provider,
    modelId: model.modelId,
  });
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
 * The default `uploadPhoto` for `useImageIntake`: upload the file (the same
 * two steps as `uploadStorageObjectAndWait`, split so the tile can show
 * `processing`), wait for it to be `ready`, then attach it to the intake.
 * When processing or the attach fails, the fresh storage object is deleted
 * (best effort) so no orphan is left, and the error is rethrown for the tile
 * to show Retry.
 */
export function uploadAndAttach(
  intakeId: string,
): (file: File, context?: { setStage: (stage: 'uploading' | 'processing') => void }) => Promise<{ storageObjectId: string }> {
  return async (file, context) => {
    const uploaded = await uploadStorageObject(file);
    try {
      context?.setStage('processing');
      const ready = await waitForStorageObjectReady(uploaded);
      await attachIntakePhoto(intakeId, ready.id);
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
