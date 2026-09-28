// =============================================================================
// PUT /api/admin/storage-config — request body (issue #375, epic #372)
// =============================================================================
//
// The seven `storage` settings fields, plus the two things that are NOT settings
// fields and are the whole reason this DTO exists rather than reusing
// `systemStoragePatchSchema`:
//
//   * `secretAccessKey` — WRITE-ONLY. It is never in a response, it is never in
//     the stored settings document, and blank means "keep the stored one".
//   * `confirmation`    — the typed acknowledgement that switching a configured
//                         deployment's provider/bucket/endpoint does not move
//                         the bytes that are already there.
//
// -----------------------------------------------------------------------------
// THIS IS A FULL REPLACE, AND EVERY SETTINGS FIELD IS REQUIRED
// -----------------------------------------------------------------------------
//
// A PATCH shape was rejected. The page this backs renders all seven fields at
// once and submits all seven, and the one operation an operator most needs from
// it is CLEARING a field — emptying `endpoint` to fall back to the vendor's own
// host, emptying `accountId` after moving off R2. Under a partial body, `''`
// and "absent" both arrive as "the admin left this alone" unless every single
// field is carefully distinguished with `!== undefined`, and the failure mode
// of getting one of them wrong is a deployment that keeps writing to the bucket
// it was told to stop writing to. Requiring the whole object makes "clear this
// field" the ordinary case — send `''` — and makes it impossible to express by
// accident.
//
// `forcePathStyle` is the exception that proves it: it is TRI-STATE
// (`true`/`false`/`null`, where `null` is "use this vendor's convention"), so
// it is required-and-nullable rather than optional. `null` is a value an
// operator can mean, and there has to be a body that says it.
//
// -----------------------------------------------------------------------------
// WHY THE SECRET IS ON THIS BODY AT ALL, RATHER THAN ITS OWN ENDPOINT
// -----------------------------------------------------------------------------
//
// Because the access key id and the secret access key are one credential, and
// they are pasted from one screen at one moment. Splitting them across two
// requests means every rotation has a window in which the saved key id and the
// saved secret are from different key pairs — which is exactly the state that
// breaks every upload in the deployment, reached by following the UI correctly.
// `EmailSettingsController` makes the same call for `smtpPassword`, and this
// file copies its blank-preserves contract verbatim.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { STORAGE_PROVIDER_KINDS } from '../../../common/schemas/settings.schema';

/**
 * The word `PUT /api/admin/storage-config` requires when the save would point
 * a deployment that already holds objects at a different location.
 *
 * ⚠ EXPORTED, AND THE ONLY DEFINITION. The service raising the 409 and the DTO
 * validating the body both read this constant, and #376's UI sends it back.
 * A second string literal that differs by a character is a confirmation dialog
 * whose "yes" the API rejects.
 *
 * Deliberately a different word from `RESTORE`, `ROLLBACK`, `ROTATE` and
 * `REMOVE` for the reason those four differ from each other: a body copied from
 * one confirming route to another must be refused, not silently accepted. The
 * same argument against `{ "confirm": true }` applies here and is set out in
 * full in `db-backup/dto/db-backup-restore.dto.ts` — in short, a boolean is
 * reproduced by a replayed POST, a retried client and a double-clicked button,
 * and this word is reproduced by none of them accidentally.
 */
export const STORAGE_SWITCH_CONFIRMATION = 'SWITCH';

export const updateStorageConfigSchema = z.object({
  /** Which vendor's flavour of the S3 protocol to talk to. */
  provider: z.enum(STORAGE_PROVIDER_KINDS),

  /**
   * The bucket every object is written to and read from.
   *
   * NO `.min(1)`, matching `systemStorageSchema`: `''` is the legal, persisted
   * "not configured" state and is how an operator un-configures storage
   * entirely. Completeness is decided by `resolveStorageConfig`, in one place,
   * and not by this schema — see that file, and the block comment on
   * `systemStorageSchema`.
   */
  bucket: z.string().trim().max(255),

  /** Signing region. `''` is "not stated"; R2 wants the literal `auto`. */
  region: z.string().trim().max(255),

  /** Explicit origin, or `''` to derive it (R2) or use the SDK's host (S3). */
  endpoint: z.string().trim().max(512),

  /** R2 account id, from which its endpoint is derived. `''` for other kinds. */
  accountId: z.string().trim().max(255),

  /**
   * The identifier half of the credential.
   *
   * NOT A SECRET, and it is in both the request and the response on purpose —
   * it travels in the clear in the `Authorization` header of every SigV4
   * request, authorises nothing on its own, and an administrator who cannot see
   * which key id is configured cannot tell a rotated key from a mistyped one.
   * See `storage/storage-credential.constants.ts`.
   */
  accessKeyId: z.string().trim().max(255),

  /**
   * ⚠ WRITE-ONLY, AND BLANK PRESERVES.
   *
   * Omitted, `null` or `''` means "the admin did not retype the secret", and
   * the stored one is left exactly as it is. That is `CredentialsService
   * .setSecret`'s own contract and this endpoint does not reinterpret it: the
   * form always renders this field empty, so getting it backwards would destroy
   * a working configuration the first time somebody corrects a typo in the
   * region.
   *
   * There is deliberately NO way to erase the stored secret through this
   * endpoint. Erasing is `deleteSecret`, which nothing in #375 exposes — an
   * admin who wants storage off empties `bucket`.
   *
   * ⚠ NEVER ECHOED BACK. No response schema in this feature has a field capable
   * of carrying it, and `storage-config.integration.spec.ts` asserts that
   * property against every route.
   */
  secretAccessKey: z.string().max(512).nullish(),

  /**
   * `https://host/bucket/key` (true) over `https://bucket.host/key` (false), or
   * `null` for "use this vendor's convention".
   *
   * REQUIRED AND NULLABLE, not optional — see this file's header. `null` is the
   * shipped default and a real answer an operator can choose, so there has to
   * be a body that expresses it.
   */
  forcePathStyle: z.boolean().nullable(),

  /**
   * The literal string `SWITCH`, required only when this save would repoint a
   * deployment that still has objects at the old location.
   *
   * Optional because the ordinary save — a first configuration, a corrected
   * region, a rotated key — needs no acknowledgement at all. The service
   * decides whether it was needed and answers `409` with the row counts when it
   * was missing; see `StorageConfigAdminService.assertSwitchAcknowledged`.
   *
   * ⚠ IT ACKNOWLEDGES, IT DOES NOT MIGRATE. Saving a new location does not copy
   * a single object. That is the sentence the confirmation exists to make
   * someone read.
   */
  confirmation: z.literal(STORAGE_SWITCH_CONFIRMATION).optional(),
});

export class UpdateStorageConfigDto extends createZodDto(updateStorageConfigSchema) {}

/** The parsed body. */
export type UpdateStorageConfigInput = z.output<typeof updateStorageConfigSchema>;
