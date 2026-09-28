// =============================================================================
// Storage secret access key credential address (issue #373, epic #372)
// =============================================================================
//
// The `(purpose, name)` pair the object-storage SECRET ACCESS KEY is stored
// under in the encrypted credential store (#115, epic #108). Mirrors
// `../email/smtp-credential.constants.ts` and
// `../notifications/push-vapid-credential.constants.ts` exactly, including why
// it lives in a leaf module that imports nothing: several modules need this
// address (the settings write path that stores the key, the provider factory
// that reads it back), and a file with no imports of its own is safe to import
// from either side without inviting a module import cycle under
// `emitDecoratorMetadata` — see the SMTP file's header for the mechanical
// reason that matters at Nest boot.
//
// ONE DEFINITION, EVERY READER. `purpose` is ALSO the cipher's sub-key domain
// (see `CredentialsService`), so a second string literal that differs by a
// character produces a credential that saves without complaint and can never be
// decrypted back. There is deliberately nothing here to keep in sync.
//
// EVERYTHING ELSE ABOUT STORAGE IS **NOT** HERE. The provider, bucket, region,
// endpoint, account id, `forcePathStyle` — and the ACCESS KEY ID — live in the
// `storage` namespace of the `system_settings` document
// (`common/schemas/settings.schema.ts`), in full, returned by the admin GET.
// Only the SECRET access key belongs at this address, exactly as only the SMTP
// password goes to `smtp/default` while `smtpHost`/`smtpUsername` stay in the
// settings blob.
//
// WHY THE ACCESS KEY ID IS ON THE OTHER SIDE OF THAT LINE, since the two arrive
// together and are often pasted from the same screen: the key id is an
// IDENTIFIER, not a credential. It is sent in the clear in the `Authorization`
// header of every SigV4 request, it authorises nothing on its own, and an
// administrator who cannot see which key id is configured cannot tell a rotated
// key from a mistyped one. It is the counterpart of `smtpUsername`; the secret
// access key is the counterpart of the SMTP password. `settings.schema.ts`
// carries a compile-time proof that the settings half never acquires the
// secret.
// =============================================================================

/**
 * Credential store address for the storage secret access key: the sub-key
 * domain.
 *
 * `purpose` is also the AES-GCM sub-key domain (see `CredentialsService`), so
 * changing this string orphans every already-stored secret access key — they
 * remain in the table and become permanently unreadable. It is not a rename.
 */
export const STORAGE_CREDENTIAL_PURPOSE = 'storage';

/**
 * Discriminator within the purpose. 'default' because this app talks to one
 * object store; a future multi-bucket or multi-provider setup keys additional
 * rows by provider id without touching anything above.
 */
export const STORAGE_CREDENTIAL_NAME = 'default';

/**
 * Human label written alongside the stored secret access key.
 *
 * NON-SECRET, and it must stay that way: `CredentialMeta` carries a
 * compile-time proof that it has no secret-bearing field, and this string is
 * shown verbatim in any credential listing. It exists so a row in that listing
 * says what it is for rather than only `storage/default`.
 */
export const STORAGE_CREDENTIAL_LABEL = 'Storage secret access key';
