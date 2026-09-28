// =============================================================================
// Storage failures as AI run outcomes (issue #437, epic #420)
// =============================================================================
//
// Over HTTP a storage failure answers as itself: `StorageNotConfiguredError`
// is already a 503 with a remedy, and the input resolver's 404/403 are the
// same answers `ObjectsService` gives. A BACKGROUND RUN has no HTTP response
// to carry them — its outcome is `ai_runs.errorCode`, which is always an
// `AiErrorCode` — so a job that meets one records it through this mapping:
//
//   StorageNotConfiguredError (503)       -> AI_STORAGE_UNAVAILABLE
//   input 404 / 403 (deleted, or no
//   longer the user's to read)            -> AI_INVALID_REQUEST
//
// Anything else is not a storage outcome this file knows, and is `null`.
// =============================================================================

import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { STORAGE_SETTINGS_PATH, StorageNotConfiguredError } from '../../storage/config/storage-not-configured.error';
import { AiError } from '../core/ai-error';

/** The `AiError` a job records for a storage failure, or `null` when `err` is not one. */
export function aiErrorFromStorage(err: unknown): AiError | null {
  if (err instanceof StorageNotConfiguredError) {
    const body = err.getResponse() as { details?: { reason?: string } };

    return new AiError(
      'AI_STORAGE_UNAVAILABLE',
      `Object storage is not configured for this deployment; an administrator must complete it at ${STORAGE_SETTINGS_PATH}.`,
      { cause: err, details: { storageReason: body.details?.reason ?? 'storage_not_configured' } },
    );
  }

  if (err instanceof NotFoundException || err instanceof ForbiddenException) {
    return new AiError('AI_INVALID_REQUEST', 'An input storage object is missing or no longer accessible.', {
      cause: err,
      details: { status: err.getStatus() },
    });
  }

  return null;
}
