// =============================================================================
// Health documents (H1, #185): the constants every side of the store shares
// =============================================================================
//
// A `HealthDocument` is one file a user handed the system for a health intake
// (a scale photo today, lab reports and PDFs next), with the user's
// keep-or-delete choice. This file is plain data (no Nest, no Prisma) so the
// intake module can name `HealthDocumentKind` without importing a feature.
//
// ⚠ Never log a file name: ids and counts only.
// =============================================================================

/** What a health document is. Open to extension; stored as text. */
export const HEALTH_DOCUMENT_KINDS = ['body_metric', 'lab_report'] as const;
export type HealthDocumentKind = (typeof HEALTH_DOCUMENT_KINDS)[number];

/**
 * The user's choice for the file: `keep` (the default, pre-selected) or
 * `delete_after_processing` (hard-deleted once the intake is applied or
 * discarded, by the `health.document.purge` job).
 */
export const FILE_RETENTIONS = ['keep', 'delete_after_processing'] as const;
export type FileRetention = (typeof FILE_RETENTIONS)[number];

export const DEFAULT_FILE_RETENTION: FileRetention = 'keep';

/** `retainFiles` (the API's boolean) as the stored retention. */
export function retentionOf(retainFiles: boolean | undefined): FileRetention {
  return retainFiles === false ? 'delete_after_processing' : 'keep';
}

/** A stored retention string as the API's boolean; anything unknown reads as `keep`. */
export function retainsFiles(retention: string): boolean {
  return retention !== 'delete_after_processing';
}

/** PERMANENT once jobs of this type exist. */
export const HEALTH_DOCUMENT_PURGE_JOB_TYPE = 'health.document.purge';

/**
 * Why a purge erases a file, carried in the job payload and the audit row:
 * `delete_after_processing` (the user's upload-time choice; the default for a
 * payload without one, which is every job enqueued before H6) or
 * `user_delete` (`DELETE /api/health/documents/:id`, H6 #190), which erases
 * the file whatever its retention.
 */
export const HEALTH_DOCUMENT_PURGE_REASONS = ['delete_after_processing', 'user_delete'] as const;
export type HealthDocumentPurgeReason = (typeof HEALTH_DOCUMENT_PURGE_REASONS)[number];

/** `jobs.subject_type` of a purge job, and the audit target type. */
export const HEALTH_DOCUMENT_SUBJECT_TYPE = 'health_document';

/** Audit action of a purge: ids and counts only, never a file name. */
export const HEALTH_DOCUMENT_DELETE_AUDIT_ACTION = 'health:document:delete';

/** Span attribute naming the retention mode (intake routes and the purge job). */
export const RETENTION_SPAN_ATTRIBUTE = 'health.document.retention';

/** Seconds a `GET /api/health/documents/:id/download` URL stays valid (H6, #190). At most 5 minutes. */
export const HEALTH_DOCUMENT_DOWNLOAD_TTL_SECONDS = 300;

/** `details.reason` values the documents API (H6, #190) refuses with. */
export const HEALTH_DOCUMENT_REASONS = {
  /** PATCH or DELETE without a usable `If-Match` (400). */
  IF_MATCH_REQUIRED: 'IF_MATCH_REQUIRED',
  /** `If-Match` names an older version (412); `details.currentVersion` has the current one. */
  STALE: 'HEALTH_DOCUMENT_STALE',
  /** Download of a document whose file was erased (409). */
  FILE_DELETED: 'HEALTH_DOCUMENT_FILE_DELETED',
  /** Download of a document whose file purge is queued or running (409). */
  FILE_DELETION_PENDING: 'HEALTH_DOCUMENT_FILE_DELETION_PENDING',
  /** Download of a file whose upload is not `ready` (409). */
  FILE_NOT_READY: 'HEALTH_DOCUMENT_FILE_NOT_READY',
} as const;
