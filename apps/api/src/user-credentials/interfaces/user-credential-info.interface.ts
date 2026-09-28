// =============================================================================
// UserCredentialInfo — the presentation-safe view of a user's own credential
// (issue #387)
// =============================================================================
//
// The per-user mirror of `credentials/interfaces/credential-info.interface.ts`,
// and for the same reason: "no plaintext egress" is a property of the TYPE
// SYSTEM, not of everyone's good intentions.
//
//   UserCredentialsService.getSecret()  -> string | null       (plaintext, server-side)
//   UserCredentialsService.describe()   -> UserCredentialInfo  (safe for a response)
//
// There is deliberately NO `{ includeSecret?: boolean }` on the reads. Two
// methods, two types, no flag.
// =============================================================================

/**
 * Everything about a user's credential that is safe to serialise.
 *
 * WHAT IS ABSENT AND WHY:
 *
 * - `secret` / any plaintext, and the ciphertext. See the header, and
 *   `CredentialInfo` for the full argument.
 * - `id`. The address is `(userId, purpose, name)` and that is the ONLY way to
 *   reach a row. An id-addressed lookup would drop the owner scoping that both
 *   the unique constraint and the cipher's owner-bound sub-key are built on.
 * - `userId`. Every read is already scoped by the caller's own id; echoing it
 *   back adds nothing and makes the type look like something a cross-user
 *   listing could return.
 * - `updatedByUserId`. The owner is the only writer of their own credential,
 *   so provenance is the owner — unlike the system store, where an admin
 *   writes infrastructure that outlives them.
 */
export interface UserCredentialInfo {
  /** The BYO key type (a `USER_CREDENTIAL_PURPOSES` entry's `purpose`). */
  readonly purpose: string;

  /** Discriminator within a purpose: 'default', a provider id, … */
  readonly name: string;

  /**
   * Non-secret display aid, derived from the plaintext on write — never
   * supplied by a caller. Null only for a row written outside this service.
   */
  readonly hint: string | null;

  /** Human description. User-entered, non-secret. */
  readonly label: string | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Metadata accepted alongside a write.
 *
 * `hint` is NOT here: the service derives it from the plaintext it already
 * holds (see `deriveHint` in `credentials/credential-internals.ts`). Omitting
 * `label` leaves it alone; `null` clears it.
 */
export interface UserCredentialMeta {
  readonly label?: string | null;
}

// -----------------------------------------------------------------------------
// Compile-time proofs — the same shape as `CredentialInfo`'s. A violation is a
// build failure.
// -----------------------------------------------------------------------------

/** Fails to compile unless `T` is exactly `true`. */
type AssertTrue<_T extends true> = void;

/** Field names that would, or plausibly could, carry secret material. */
type SecretBearingKey =
  | 'secret'
  | 'secretValue'
  | 'plaintext'
  | 'password'
  | 'value'
  | 'ciphertext'
  | 'encrypted'
  | 'payload';

/**
 * PROOF 1: `UserCredentialInfo` declares no secret-bearing field. If this
 * errors, the field being added is the bug.
 */
type _UserCredentialInfoCarriesNoSecret = AssertTrue<
  [Extract<keyof UserCredentialInfo, SecretBearingKey>] extends [never]
    ? true
    : false
>;

/**
 * PROOF 2: nor does the write-side metadata, and `hint` cannot quietly become
 * a caller-supplied field.
 */
type _UserCredentialMetaCarriesNoSecret = AssertTrue<
  [Extract<keyof UserCredentialMeta, SecretBearingKey | 'hint'>] extends [never]
    ? true
    : false
>;

/**
 * PROOF 3: no owner-scoping escape hatch — the presentation type carries
 * neither the row id nor the owner id.
 */
type _UserCredentialInfoCarriesNoId = AssertTrue<
  [Extract<keyof UserCredentialInfo, 'id' | 'userId'>] extends [never]
    ? true
    : false
>;
