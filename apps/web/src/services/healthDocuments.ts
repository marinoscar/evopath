/**
 * The health documents API (`/api/health/documents`), as the web app sees it.
 *
 * Issue #190 (H6). Every route is owner-scoped: the list holds the caller's
 * documents only, and another user's id is a `404`. Reads (`list`, `get`,
 * `download`) need `health_data:read`; rename and delete need
 * `health_data:write` and an `If-Match` with the document's `version`. The
 * browser presents and collects only; name sanitising, the signed URL, its
 * `Content-Disposition` and the delete itself are the API's.
 *
 * A signed URL is a bearer credential for its 300 seconds: callers keep it in
 * component state only and never log or persist it.
 */

import { api, ApiError } from './api';

/** Mirrors `HEALTH_DOCUMENT_KINDS` on the API (open to extension). */
export const HEALTH_DOCUMENT_KINDS = ['body_metric', 'lab_report'] as const;
export type HealthDocumentKind = (typeof HEALTH_DOCUMENT_KINDS)[number];

/** Display labels per kind; an unknown kind shows its raw value. */
export const HEALTH_DOCUMENT_KIND_LABELS: Record<HealthDocumentKind, string> = {
  body_metric: 'Body metrics',
  lab_report: 'Lab report',
};

export type HealthDocumentRetention = 'keep' | 'delete_after_processing';

export type HealthDocumentSortField = 'createdAt' | 'documentDate';
export type HealthDocumentSortOrder = 'asc' | 'desc';

/** One item of `GET /api/health/documents`, and the body of `GET`/`PATCH :id`. */
export interface HealthDocument {
  id: string;
  /** `body_metric` or `lab_report` today; typed as `string` because the API is open to more. */
  kind: string;
  originalName: string;
  mimeType: string;
  /** A decimal string (a `BigInt` on the API). */
  sizeBytes: string;
  /** `YYYY-MM-DD`, a date-only value, or `null` when not set. */
  documentDate: string | null;
  /** Upload time (ISO instant). */
  createdAt: string;
  updatedAt: string;
  retention: HealthDocumentRetention;
  /** Active measurements extracted from this document. */
  valueCount: number;
  fileAvailable: boolean;
  fileDeletedAt: string | null;
  fileDeletionPending: boolean;
  intakeId: string | null;
  /** Send back as `If-Match` on `PATCH` and `DELETE`. */
  version: number;
}

export interface HealthDocumentList {
  items: HealthDocument[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ListHealthDocumentsParams {
  kind?: HealthDocumentKind;
  sort?: HealthDocumentSortField;
  order?: HealthDocumentSortOrder;
  /** One-based. */
  page?: number;
  pageSize?: number;
}

export type HealthDocumentDisposition = 'inline' | 'attachment';

/** `GET /api/health/documents/:id/download`. */
export interface HealthDocumentDownload {
  url: string;
  expiresIn: number;
  expiresAt: string;
  disposition: HealthDocumentDisposition;
  fileName: string;
  mimeType: string;
}

/** The body of `PATCH /api/health/documents/:id`; `documentDate: null` clears it. */
export interface HealthDocumentUpdate {
  originalName?: string;
  documentDate?: string | null;
}

/** `DELETE /api/health/documents/:id`. */
export interface HealthDocumentDeleteResult {
  id: string;
  /** `file`: the file is being erased and the row stays; `record`: the row is gone. */
  scope: 'file' | 'record';
  jobId: string | null;
  valuesDeleted: number;
}

/** `GET /api/health/documents` (`health_data:read`). */
export function listHealthDocuments(params: ListHealthDocumentsParams = {}): Promise<HealthDocumentList> {
  const search = new URLSearchParams();
  if (params.kind) search.set('kind', params.kind);
  if (params.sort) search.set('sort', params.sort);
  if (params.order) search.set('order', params.order);
  if (params.page !== undefined) search.set('page', String(params.page));
  if (params.pageSize !== undefined) search.set('pageSize', String(params.pageSize));
  const query = search.toString();
  return api.get<HealthDocumentList>(`/health/documents${query ? `?${query}` : ''}`);
}

/** `GET /api/health/documents/:id/download` (`health_data:read`): a URL valid 300 seconds. */
export function getHealthDocumentDownload(
  id: string,
  disposition: HealthDocumentDisposition,
): Promise<HealthDocumentDownload> {
  return api.get<HealthDocumentDownload>(
    `/health/documents/${encodeURIComponent(id)}/download?disposition=${disposition}`,
  );
}

/** `PATCH /api/health/documents/:id` (`health_data:write`), `If-Match: <version>`. */
export function updateHealthDocument(
  id: string,
  input: HealthDocumentUpdate,
  expectedVersion: number,
): Promise<HealthDocument> {
  return api.patch<HealthDocument>(`/health/documents/${encodeURIComponent(id)}`, input, {
    headers: { 'If-Match': String(expectedVersion) },
  });
}

/** `DELETE /api/health/documents/:id?deleteValues=` (`health_data:write`), `If-Match: <version>`. */
export function deleteHealthDocument(
  id: string,
  options: { deleteValues: boolean; expectedVersion: number },
): Promise<HealthDocumentDeleteResult> {
  return api.delete<HealthDocumentDeleteResult>(
    `/health/documents/${encodeURIComponent(id)}?deleteValues=${options.deleteValues ? 'true' : 'false'}`,
    { headers: { 'If-Match': String(options.expectedVersion) } },
  );
}

/**
 * A `412`: the document changed since it was loaded (`details.reason` is
 * `HEALTH_DOCUMENT_STALE`). Every `412` on these routes is a version mismatch,
 * so the status alone decides.
 */
export function isHealthDocumentStale(error: unknown): boolean {
  return error instanceof ApiError && error.status === 412;
}

/** The `409` reasons `download` refuses with, as user-facing text. */
export function downloadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const reason = (error.details as { reason?: unknown } | undefined)?.reason;
    if (reason === 'HEALTH_DOCUMENT_FILE_DELETED') return 'This file has been deleted.';
    if (reason === 'HEALTH_DOCUMENT_FILE_DELETION_PENDING') return 'This file is being deleted.';
    if (reason === 'HEALTH_DOCUMENT_FILE_NOT_READY') return 'This file is not available yet. Try again later.';
    if (error.status === 404) return 'This document no longer exists.';
  }
  return 'Could not open the file. Try again later.';
}
