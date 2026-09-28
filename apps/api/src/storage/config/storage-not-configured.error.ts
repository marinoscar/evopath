import { ServiceUnavailableException } from '@nestjs/common';

import type { MissingStorageConfigField } from './storage-config';
import type { StorageProviderKind } from '../../common/schemas/settings.schema';

// =============================================================================
// StorageNotConfiguredError — what a call gets when there is no storage (#373)
// =============================================================================
//
// Making storage runtime-configurable creates a state that could not exist when
// it came from the environment: a RUNNING, HEALTHY API with nowhere to put a
// file. A fresh deployment is in that state from its first boot until an
// administrator fills in the form, and every deployment returns to it the
// moment somebody clears the bucket field. This is the answer every storage
// call gives in it.
//
// WHY 503 AND NOT 500. The request is not broken and neither is the server: the
// work is genuinely unavailable right now, and an administrator filling in one
// form makes the identical request succeed with nothing about the caller having
// changed. That is the same distinction `NodeSecretBrokerService.assertUsable`
// draws for an unusable credential broker, and this type deliberately copies
// its body shape — `{ message, details: { reason, remedy } }` — so the two
// "this deployment has not been set up for that yet" refusals read alike to
// whoever is on the receiving end.
//
// WHY 503 AND NOT 501/409/422. 501 says the server does not implement this,
// which is false and is not retryable. 409 says the request conflicts with
// state, which invites a client to change the request. 422 says the input can
// never work — a worker node that believed it would burn its whole attempt
// budget in the minute before somebody saved the settings page. 503 says "not
// now", which is the truth, and is the one status a queue, a browser and a
// health check all already know how to wait on.
//
// WHY IT EXTENDS AN HTTP EXCEPTION AT ALL, in a file under `storage/config`.
// The alternative — a plain `Error` subclass mapped to a status by each caller
// — puts the mapping in nine consumer modules, none of which asked to know
// about storage configuration, and every one of which would otherwise let it
// surface as a 500. `HttpExceptionFilter` already renders this correctly with
// no consumer change at all, which is precisely the constraint #373 part 2
// works under: NO CONSUMER OF `STORAGE_PROVIDER` CHANGES.
//
// ⚠ NOTHING HERE MAY CARRY A VALUE. The details name FIELDS ('bucket',
// 'secretAccessKey') and never their contents — this body reaches an
// unauthenticated caller on some paths (the public avatar route), and a
// diagnostic that quoted the configuration would be an information leak in the
// one place nobody thinks to check.
// =============================================================================

/**
 * Where an administrator fixes this.
 *
 * Named in the `remedy` of every instance, because "storage is not configured"
 * without a destination is a support ticket. Kept as a constant so the settings
 * page can move without leaving a wrong path in an error body that is the only
 * instruction some operators will ever see.
 */
export const STORAGE_SETTINGS_PATH = '/admin/settings/storage';

/** Why storage could not be used. Reported verbatim; never inferred. */
export type StorageNotConfiguredReason =
  /** The configuration is incomplete — `details.missing` says which fields. */
  | 'storage_not_configured'
  /**
   * A SYNCHRONOUS question (`getBucket()`) has no answer: no settings read has
   * succeeded in this process yet, or the one that did named no bucket.
   * Distinct from the above because it cannot list missing fields — the caller
   * never got far enough to check any — and because one of its two causes (an
   * unreadable settings row at startup) clears itself.
   */
  | 'storage_bucket_unknown';

/**
 * Thrown by `ResolvingStorageProvider` when this deployment has no usable
 * object storage.
 *
 * Constructed through the two named factories rather than directly, so the
 * `reason` and the `remedy` cannot be paired up wrongly at a call site.
 */
export class StorageNotConfiguredError extends ServiceUnavailableException {
  constructor(
    message: string,
    details: {
      reason: StorageNotConfiguredReason;
      remedy: string;
      provider?: StorageProviderKind;
      missing?: MissingStorageConfigField[];
    },
  ) {
    super({ message, details });
  }

  /**
   * The ordinary case: the settings row (and/or the credential store) is not
   * filled in.
   *
   * The missing FIELD NAMES are in the body on purpose. An administrator who is
   * told only "storage is not configured" reloads a form that looks complete —
   * because the one empty field is the secret access key, which by design
   * cannot be displayed. Naming the fields is what makes that state
   * diagnosable, and a field name carries nothing an attacker did not already
   * know from the public settings schema.
   */
  static missing(
    provider: StorageProviderKind,
    missing: MissingStorageConfigField[],
  ): StorageNotConfiguredError {
    return new StorageNotConfiguredError(
      `Object storage is not configured for this deployment: the ${provider} ` +
        `configuration is missing ${missing.join(', ')}. Files cannot be stored ` +
        `or served until it is complete.`,
      {
        reason: 'storage_not_configured',
        remedy:
          `An administrator must complete the storage configuration at ` +
          `${STORAGE_SETTINGS_PATH} (the secret access key is saved there too, ` +
          `and is never displayed once stored).`,
        provider,
        missing,
      },
    );
  }

  /**
   * The narrow case: something asked, synchronously, which bucket is in use,
   * and this process does not know.
   *
   * Only `getBucket()` can raise this — see the long comment on that method in
   * `ResolvingStorageProvider`. It is deliberately NOT reported as the same
   * thing as an incomplete configuration, because it has two causes with
   * different remedies (no bucket saved, or a settings row that was unreadable
   * when this process started) and it cannot tell them apart. Naming both in
   * the remedy is more use than picking one and being wrong half the time.
   */
  static unresolved(): StorageNotConfiguredError {
    return new StorageNotConfiguredError(
      'The active object storage bucket is unknown to this process: either no ' +
        'bucket is configured, or the storage settings could not be read at ' +
        'startup.',
      {
        reason: 'storage_bucket_unknown',
        remedy:
          `Check that storage is configured at ${STORAGE_SETTINGS_PATH}. If it ` +
          `is, the settings row was unreadable at startup — confirm the database ` +
          `is reachable; the settings are re-read on the next storage operation.`,
      },
    );
  }
}
