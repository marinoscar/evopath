import { BadRequestException } from '@nestjs/common';

import { isCanonicalUuid } from '@marinoscar/platform-api/core';

// =============================================================================
// Credential store internals — shared by BOTH encrypted stores (issue #387)
// =============================================================================
//
// `CredentialsService` (the deployment's store, addressed by (purpose, name))
// and `UserCredentialsService` (a user's own store, addressed by
// (userId, purpose, name)) must agree on three things, and agreeing by copy is
// how two stores start to disagree:
//
//   1. what a hint looks like      (`deriveHint`)
//   2. what "blank" means on write (`isBlankSecret`)
//   3. what a valid address is     (`assertCredential*`)
//
// So they live here, once, and both services import them. `deriveHint` is
// also consumed by `ai/keys/user-ai-keys.service.ts` and stays re-exported
// from `credentials.service.ts` for existing importers.
//
// Every error thrown here names the FIELD, never the value — the value is a
// code-level constant at best and a caller's mistake at worst, and neither
// belongs in a response body.
// =============================================================================

/** The mask shown for the unreadable part of a secret. */
const HINT_MASK = '••••';

/**
 * Number of trailing characters revealed in a hint.
 *
 * Four is enough to tell two API keys apart in a list, which is the entire job
 * of a hint. More is not a better hint, it is a worse secret.
 */
const HINT_REVEALED_CHARS = 4;

/**
 * Below this length, reveal nothing.
 *
 * At 4 characters "the last 4" is the whole secret; at 5 it is all but one. The
 * floor keeps the hint from being a substantial fraction of a short PIN-like
 * value. Anything at or above 8 loses at most half.
 */
const HINT_MIN_LENGTH_TO_REVEAL = 8;

/**
 * Derive the non-secret display hint from the plaintext.
 *
 * Called only from write paths, where the service already holds the plaintext
 * for encryption, so this adds no new exposure — and it is why neither store's
 * write metadata has a `hint` field for a caller to fill in wrongly.
 *
 * Iterates code points rather than UTF-16 units: `'…'.slice(-4)` can cut a
 * surrogate pair in half and leave a lone surrogate, which is not valid UTF-8
 * and blows up on the way into a Postgres `text` column — a passphrase with an
 * emoji in it would make saving fail with a completely unrelated error.
 */
export function deriveHint(plaintext: string): string {
  const codePoints = Array.from(plaintext);

  if (codePoints.length < HINT_MIN_LENGTH_TO_REVEAL) {
    return HINT_MASK;
  }

  return `${HINT_MASK}${codePoints.slice(-HINT_REVEALED_CHARS).join('')}`;
}

/**
 * Is this write a "preserve what is stored" write?
 *
 * `undefined` and `null` are both here because a JSON body deserialises an
 * omitted field to `undefined` and an explicitly-null one to `null`, and a
 * form means the same thing by both: "I did not type a new password."
 *
 * NOTE THE ABSENCE OF `.trim()`. A whitespace-only submission counts as a real
 * value, and a secret is stored byte-for-byte. Normalising a secret's bytes is
 * not a store's call: the caller may legitimately hold a token whose
 * surrounding whitespace is significant, and silently altering it produces an
 * authentication failure with no visible cause. Trimming user input is a
 * presentation-layer decision, made where the form is.
 */
export function isBlankSecret(
  secret: string | null | undefined,
): secret is null | undefined | '' {
  return secret === undefined || secret === null || secret === '';
}

/**
 * Reject an unusable address component.
 *
 * Runtime checks despite the `string` types because a config value, a JSON
 * round-trip, or a plain-JS caller can all deliver something else.
 *
 * WHITESPACE IS REJECTED RATHER THAN TRIMMED, and `purpose` is the reason:
 * it is also (part of) the cipher's sub-key domain, so `'smtp '` and `'smtp'`
 * derive two different keys. Silently trimming would let a row written under
 * one spelling become permanently unreadable under the other, with both
 * looking identical in a log. `name` is held to the same rule so the two
 * halves of the address behave the same way.
 */
export function assertCredentialIdentifier(
  value: string,
  field: 'purpose' | 'name',
): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestException(
      `Credential ${field} must be a non-empty string.`,
    );
  }

  if (value !== value.trim()) {
    throw new BadRequestException(
      `Credential ${field} must not have leading or trailing whitespace.`,
    );
  }
}

/**
 * A credential purpose — in EITHER store.
 *
 * On top of {@link assertCredentialIdentifier}: NO `:`. A user credential's
 * sub-key domain is `user:<userId>:<purpose>` (`userCredentialPurpose` in
 * `@marinoscar/platform-api/core`), so:
 *
 *   - in the user store, a `:` in `purpose` would make the domain decompose
 *     two ways;
 *   - in the system store, a purpose containing `:` is the only way to spell
 *     one that begins with `user:` — i.e. one whose sub-key IS some user's
 *     sub-key, readable with that user's ciphertext.
 *
 * Forbidding the character in both stores closes both with one rule. No
 * existing system purpose ('smtp', 'storage', 'push_vapid', 'ai') uses it.
 */
export function assertCredentialPurpose(purpose: string): void {
  assertCredentialIdentifier(purpose, 'purpose');

  if (purpose.includes(':')) {
    throw new BadRequestException('Credential purpose must not contain ":".');
  }
}

/** A `(purpose, name)` address, as both stores use it. */
export function assertCredentialAddress(purpose: string, name: string): void {
  assertCredentialPurpose(purpose);
  assertCredentialIdentifier(name, 'name');
}

/**
 * The owner of a user credential: a canonical (lowercase) UUID.
 *
 * Canonical and not merely "a UUID", because the id is part of the cipher's
 * sub-key domain: `ABC…` and `abc…` name the same Postgres row but would
 * derive two different keys, stranding every secret written under the other.
 */
export function assertCredentialOwner(userId: string): void {
  if (!isCanonicalUuid(userId)) {
    throw new BadRequestException(
      'Credential owner must be a canonical (lowercase, hyphenated) UUID.',
    );
  }
}
