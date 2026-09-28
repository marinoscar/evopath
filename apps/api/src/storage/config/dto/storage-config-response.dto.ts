// =============================================================================
// GET / PUT /api/admin/storage-config — response body (issue #375, epic #372)
// =============================================================================
//
// ⚠ THE INVARIANT THIS FILE EXISTS TO HOLD: THERE IS NO FIELD HERE CAPABLE OF
// CARRYING THE SECRET ACCESS KEY, AND THERE MUST NEVER BE ONE.
//
// The secret lives at `(purpose 'storage', name 'default')` in the encrypted
// credential store and is readable only through `CredentialsService.getSecret`,
// which no controller may call. What an administrator gets instead is
// {@link storageSecretStatusSchema} — `configured`, a mask, and who wrote it
// last — which is exactly the information needed to tell "a key is stored" from
// "a key is stored and it is the one I just rotated to", and carries none of
// the material. `PrivateKeyStatus` in `notifications/push-config.service.ts` and
// `SmtpPasswordStatus` in `email/email-settings.service.ts` are the same shape
// for the same reason; this is the third and it does not invent a fourth.
//
// Everything else in the `storage` namespace IS returned in full, including
// `accessKeyId`. That is not an oversight: a key id is an identifier, it travels
// in the clear in every SigV4 `Authorization` header, and an administrator who
// cannot see which key id is configured cannot tell a rotated key from a
// mistyped one. `common/schemas/settings.schema.ts` carries a compile-time proof
// that the settings half never acquires the secret.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { STORAGE_PROVIDER_KINDS } from '../../../common/schemas/settings.schema';
import { MISSING_STORAGE_CONFIG_FIELDS } from '../storage-config';

/**
 * The masked view of the stored secret access key.
 *
 * Deliberately the same four fields as `PrivateKeyStatus` and
 * `SmtpPasswordStatus`, in the same order, with the same meanings — a fourth
 * shape for the same job is a fourth thing to reason about when a credential
 * page misbehaves.
 */
export const storageSecretStatusSchema = z.object({
  /** Is a secret stored at `(purpose 'storage', name 'default')`? */
  configured: z.boolean(),

  /**
   * The credential store's own mask, e.g. `••••x9fQ`. Null when nothing is
   * stored.
   *
   * Derived by `CredentialsService` from the plaintext at write time and held
   * in a non-secret column; this endpoint never sees the value it masks.
   */
  hint: z.string().nullable(),

  /**
   * When the stored secret was last written, as an ISO 8601 string. Null when
   * nothing is stored.
   *
   * ⚠ A STRING, NOT `z.date()`. A `Date` has no JSON Schema representation, and
   * `nestjs-zod` throws while building the OpenAPI document rather than
   * degrading — which takes `/api/docs` down for the whole API, not just this
   * route. Every dated field in this repository's response DTOs is
   * `z.iso.datetime()` for that reason; see `push-config-response.dto.ts`.
   */
  updatedAt: z.iso.datetime().nullable(),

  /** Who last wrote it. Null when nothing is stored, or that user was deleted. */
  updatedByUserId: z.string().nullable(),
});

export const storageConfigResponseSchema = z.object({
  // ---------------------------------------------------------------------------
  // The `storage` settings namespace, verbatim
  // ---------------------------------------------------------------------------

  provider: z.enum(STORAGE_PROVIDER_KINDS),
  bucket: z.string(),
  region: z.string(),
  endpoint: z.string(),
  accountId: z.string(),
  /** An identifier, not a credential. See this file's header. */
  accessKeyId: z.string(),
  /** Tri-state: `true`/`false`, or `null` for "use this vendor's convention". */
  forcePathStyle: z.boolean().nullable(),

  // ---------------------------------------------------------------------------
  // Derived, read-only
  // ---------------------------------------------------------------------------

  /**
   * The origin an S3 client would actually be pointed at, or `null` for "the
   * SDK's own regional AWS host".
   *
   * EXISTS SO THE UI CAN SHOW R2's ENDPOINT WITHOUT DERIVING IT. An R2
   * deployment stores an `accountId` and an empty `endpoint`; the host is
   * `<accountId>.r2.cloudflarestorage.com`, built by `deriveR2Endpoint`. A
   * settings page that computed that itself would be a second copy of the rule
   * in a language that cannot be unit-tested against the server's — and the
   * failure mode of the second copy is a page that displays one host while the
   * client talks to another. It is READ-ONLY: `endpoint` above is the field a
   * `PUT` writes, and typing one there always wins.
   */
  effectiveEndpoint: z.string().nullable(),

  /**
   * Whether this configuration is complete enough to use, RIGHT NOW.
   *
   * Answered by `resolveStorageConfig` — the single definition of "configured"
   * — and never re-derived here. A page that decides for itself that six
   * non-empty fields means "ready" is a page that reports ready about a
   * configuration the upload path refuses.
   */
  configured: z.boolean(),

  /**
   * Every field the configuration needs and does not have. Empty when
   * `configured` is true.
   *
   * INCLUDES `secretAccessKey`, which is not a settings field: from the point
   * of view of "can this deployment store a file?", a missing credential row and
   * an empty bucket are the same kind of problem. It names the field, never its
   * value.
   */
  missing: z.array(z.enum(MISSING_STORAGE_CONFIG_FIELDS)),

  /** The masked status of the stored secret. See the header. */
  secretStatus: storageSecretStatusSchema,

  // ---------------------------------------------------------------------------
  // Provenance of the settings row
  // ---------------------------------------------------------------------------

  /**
   * The `system_settings` row version, bumped on every write.
   *
   * The optimistic-concurrency token: send it back as `If-Match` on `PUT`.
   * It is the version of the WHOLE `global` row, not of the `storage` namespace
   * alone — see `StorageConfigAdminService` for why that is the honest token
   * and not an over-broad one.
   */
  version: z.number().int(),

  /** ISO 8601. See the note on `secretStatus.updatedAt` for why not `z.date()`. */
  updatedAt: z.iso.datetime().nullable(),

  updatedBy: z
    .object({ id: z.string(), email: z.string() })
    .nullable(),
});

export class StorageConfigResponseDto extends createZodDto(storageConfigResponseSchema) {}

export type StorageConfigResponse = z.infer<typeof storageConfigResponseSchema>;
