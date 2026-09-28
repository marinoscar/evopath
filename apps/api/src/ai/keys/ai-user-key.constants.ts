// =============================================================================
// Per-user (BYOK) AI key constants (issue #431, epic #419)
// =============================================================================
//
// ⚠ `AI_USER_KEY_PURPOSE` IS THE AES-GCM SUB-KEY DOMAIN for `user_ai_keys.secret`
// (`encryptSecret(plaintext, purpose)` derives a per-purpose key). Renaming it
// makes every stored user key permanently undecryptable — it is not a rename.
// It is deliberately NOT the admin key's `'ai'` purpose
// (`config/ai-credential.constants.ts`): the two secret spaces cannot decrypt
// each other's ciphertext by construction (docs/specs/ai-platform.md §2.1).
// =============================================================================

/** `encryptSecret`/`decryptSecret` purpose for every `user_ai_keys.secret`. */
export const AI_USER_KEY_PURPOSE = 'ai_user_key';

/** Audit `targetType` for a user's own key lifecycle (`ai_key:set`, `ai_key:delete`). */
export const AI_USER_KEY_AUDIT_TARGET = 'user_ai_key';

/** The weekly reachability recheck job type. PERMANENT once jobs of it exist. */
export const AI_KEYS_RECHECK_TYPE = 'ai.keys.recheck';

/** A key's reachable-model list is re-verified once it is older than this. */
export const AI_KEY_RECHECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Keys read per page by the recheck sweep. */
export const AI_KEY_RECHECK_BATCH_SIZE = 50;
