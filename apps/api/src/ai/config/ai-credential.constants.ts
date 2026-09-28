// =============================================================================
// Credential-store address for the admin (org) AI provider key (#428, epic #419)
// =============================================================================
//
// One `credentials` row per provider: `(purpose 'ai', name '<providerId>')`.
// The same shape `storage-credential.constants.ts` uses for the storage secret,
// and for the same reason — see `docs/specs/ai-platform.md` §2.1 for why the key
// can never live in the `ai` system-settings namespace.
//
// ⚠ `purpose` IS ALSO THE AES-GCM SUB-KEY DOMAIN (see `CredentialsService`), so
// renaming this string orphans every stored admin key: the rows stay, and become
// permanently unreadable. It is not a rename. It is also deliberately NOT the
// `'ai_user_key'` purpose the per-user BYOK keys are encrypted under — the two
// secret spaces cannot decrypt each other's ciphertext by construction.
//
// ONE DEFINITION, EVERY READER: the admin config API (#428) that stores the key
// and the catalog sync (#427) that reads it back both import THIS file. It is a
// leaf — it imports nothing — so either module can depend on it without a
// module import cycle. A second copy of the purpose string that differed by a
// character would store keys that can never be decrypted back.
// =============================================================================

/** `CredentialsService` purpose for every admin/org AI provider key. */
export const AI_CREDENTIAL_PURPOSE = 'ai';

/**
 * The credential `name` for provider `providerId` — the provider id itself.
 * A function rather than a bare use of the id so every call site states which
 * half of the address it is building.
 */
export function aiCredentialName(providerId: string): string {
  return providerId;
}

/**
 * Human label stored beside the key. NON-SECRET: it is shown verbatim in any
 * credential listing, and exists so a row there says what it is for.
 */
export function aiCredentialLabel(providerDisplayName: string): string {
  return `AI provider key (${providerDisplayName})`;
}
