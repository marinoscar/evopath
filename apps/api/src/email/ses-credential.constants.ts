// =============================================================================
// SES credential address (issue #585, epic #109)
// =============================================================================
//
// The `(purpose, name)` pair the SES secret access key is stored under in the
// encrypted credential store (#115, epic #108).
//
// WHY THESE MOVED OUT OF `providers/ses-email.provider.ts`:
//
// #585 adds the WRITE side of the SES secret access key to
// `EmailSettingsService`, and `SesEmailProvider` already injects
// `EmailSettingsService`. Had the service imported these constants from the
// provider, the two modules would import each other, and with
// `emitDecoratorMetadata` a cycle is not a style problem: `design:paramtypes`
// is evaluated at class-decoration time, so whichever module CommonJS begins
// loading second sees `undefined` where a constructor parameter type should
// be, and Nest fails to resolve the dependency at boot.
//
// So the shared value lives in a leaf module that imports nothing. The
// provider re-exports both names, so `SES_CREDENTIAL_PURPOSE` and
// `SES_CREDENTIAL_NAME` remain importable from exactly where #585 put them
// and the `../email` barrel is unchanged.
//
// ONE DEFINITION, TWO SIDES. The write path (#585's settings PUT) and the read
// path (`SesEmailProvider.buildClient`) must address the same row; `purpose`
// is ALSO the cipher's sub-key domain, so a second string literal that differs
// by a character produces a credential that saves without complaint and can
// never be decrypted back. There is deliberately nothing to keep in sync.
// =============================================================================

/**
 * Credential store address for the SES secret access key: the sub-key domain.
 *
 * `purpose` is also the AES-GCM sub-key domain (see `CredentialsService`), so
 * changing this string orphans every already-stored SES secret access key —
 * they remain in the table and become permanently unreadable. It is not a
 * rename.
 */
export const SES_CREDENTIAL_PURPOSE = 'email_ses';

/**
 * Discriminator within the purpose. 'default' because this app has one SES
 * sending identity; a future multi-account setup keys additional rows by
 * account id without touching anything above.
 */
export const SES_CREDENTIAL_NAME = 'default';

/**
 * Human label written alongside the stored secret.
 *
 * NON-SECRET, and it must stay that way: `CredentialMeta` carries a
 * compile-time proof that it has no secret-bearing field, and this string is
 * shown verbatim in any credential listing. It exists so a row in that listing
 * says what it is for rather than only `email_ses/default`.
 */
export const SES_CREDENTIAL_LABEL = 'SES secret access key';
