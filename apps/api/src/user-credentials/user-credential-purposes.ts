// =============================================================================
// User credential purpose registry (issue #387)
// =============================================================================
//
// ONE entry per kind of key a user may bring themselves (BYOK), shaped like
// `notifications/notification-events.ts`: a declaration, not a provider. The
// entry answers three questions for every consumer at once:
//
//   purpose      what the key is, as stored (`user_credentials.purpose`, and
//                the last segment of the owner-bound cipher domain
//                `user:<userId>:<purpose>` — so PERMANENT once rows exist)
//   label /      what a user is told it is
//   description
//   system       where the DEPLOYMENT's own key for the same thing lives in
//                the `credentials` table, or `null` when there is none —
//                what `UserCredentialResolver` falls back to
//
// THE RESOLUTION RULE IS FIXED, NOT PER ENTRY: the user's own key wins, else
// the system counterpart, else none. There is deliberately no per-purpose
// "allow fallback" flag here: a boolean that decides whose key pays is the
// knob that gets flipped under pressure and is invisible at the call site. A
// type that must never fall back declares `system: null`; a deployment that
// wants no fallback simply does not configure the system credential.
//
// -----------------------------------------------------------------------------
// WHY THE PRODUCTION LIST IS EMPTY
// -----------------------------------------------------------------------------
//
// The only BYO key type this application has today is an AI provider key,
// and it already has a home: `user_ai_keys` (epic #419, issue #431), with its
// own cipher purpose ('ai_user_key'), reachability bookkeeping
// (`reachable_model_ids`, `verified_at`) and resolver (`AiKeyResolver`), and
// its system counterpart at `credentials('ai', '<providerId>')`. Declaring
// 'ai' here would create a SECOND store for the same key — two places a
// user's OpenAI key could be, two resolvers that could disagree about which
// one answers. Migrating `user_ai_keys` onto this store is out of scope for
// #387 (and would have to carry that bookkeeping with it).
//
// So this ships as the foundation — schema, owner-bound cipher, store,
// resolver — with no production entry. The next feature that needs a user's
// own key for something (a user's own webhook signing secret, a personal
// token for an integration) adds ONE entry here and gets storage, no-egress
// presentation types and user-over-system resolution for free. The resolver
// reads this list through the `USER_CREDENTIAL_PURPOSE_REGISTRY` injection
// token (see `user-credentials.module.ts`), which is also how its tests
// supply a fixture registry.
//
// This file is intentionally NOT a Nest provider and imports nothing: pure
// data plus pure lookup, like the notification event registry.
// =============================================================================

/** Where the deployment's key for a purpose lives in the `credentials` table. */
export interface SystemCredentialAddress {
  readonly purpose: string;
  readonly name: string;
}

/** One kind of key a user may supply themselves. */
export interface UserCredentialPurposeDef {
  /**
   * Stable identifier — stored on every row and bound into the cipher domain,
   * so renaming it strands every stored key. Must not contain `:`.
   */
  readonly purpose: string;

  /** Short user-facing name ("Webhook signing secret"). */
  readonly label: string;

  /** One or two sentences of user-facing copy: what the key is used for. */
  readonly description: string;

  /**
   * The deployment's own key for the same thing, used when the user has not
   * supplied one — or `null` when there is no deployment-wide counterpart and
   * the user's key is the only possible answer.
   */
  readonly system: SystemCredentialAddress | null;
}

/**
 * Every BYO key type. Empty in production today — see the header for why the
 * AI provider key is not (and must not be) declared here.
 */
export const USER_CREDENTIAL_PURPOSES: readonly UserCredentialPurposeDef[] = [];

/** The `name` a user's credential is stored under when a purpose has one key. */
export const DEFAULT_USER_CREDENTIAL_NAME = 'default';

/** Look up one purpose in a registry; `undefined` when it is not declared. */
export function findUserCredentialPurpose(
  registry: readonly UserCredentialPurposeDef[],
  purpose: string,
): UserCredentialPurposeDef | undefined {
  return registry.find((def) => def.purpose === purpose);
}
