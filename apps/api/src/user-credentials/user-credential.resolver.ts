import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';

import {
  assertCredentialAddress,
  assertCredentialPurpose,
} from '../credentials/credential-internals';
import { CredentialsService } from '../credentials/credentials.service';
import {
  DEFAULT_USER_CREDENTIAL_NAME,
  findUserCredentialPurpose,
  type UserCredentialPurposeDef,
} from './user-credential-purposes';
import { UserCredentialsService } from './user-credentials.service';

// =============================================================================
// UserCredentialResolver — whose key answers? (issue #387)
// =============================================================================
//
// ONE FIXED RULE, for every purpose in the registry:
//
//   1. the user's own credential, if they stored one;
//   2. else the deployment's credential (the registry entry's `system`
//      counterpart, read through `CredentialsService`), if there is one;
//   3. else none.
//
// The result says WHICH source answered (`source`), so a caller can attribute
// usage/billing to the right party and tell a user "using your key" vs.
// "using the organisation's key" without re-deriving the rule itself.
//
// There is no per-purpose "may fall back" flag (see the registry header).
//
// FAILURES DO NOT FALL THROUGH. A user credential that exists but will not
// decrypt throws (from `UserCredentialsService.getSecret`) rather than
// quietly resolving to the deployment's key: silently billing the
// organisation for a user whose own key is broken is exactly the invisible
// failure both stores refuse to produce.
// =============================================================================

/** DI token for the purpose registry the resolver consults. */
export const USER_CREDENTIAL_PURPOSE_REGISTRY = Symbol(
  'USER_CREDENTIAL_PURPOSE_REGISTRY',
);

/**
 * The outcome of a resolution. SERVER-SIDE ONLY — the `user`/`system` arms
 * carry plaintext; never return one from a controller.
 */
export type ResolvedCredential =
  | { readonly source: 'user'; readonly purpose: string; readonly secret: string }
  | { readonly source: 'system'; readonly purpose: string; readonly secret: string }
  | { readonly source: 'none'; readonly purpose: string };

/** Which source answered, without the secret — safe to log or return. */
export type ResolvedCredentialSource = ResolvedCredential['source'];

@Injectable()
export class UserCredentialResolver {
  constructor(
    private readonly userCredentials: UserCredentialsService,
    private readonly credentials: CredentialsService,
    @Inject(USER_CREDENTIAL_PURPOSE_REGISTRY)
    private readonly registry: readonly UserCredentialPurposeDef[],
  ) {
    assertValidRegistry(registry);
  }

  /**
   * Resolve the credential `userId` should use for `purpose`.
   *
   * @param name the user-side discriminator; defaults to `'default'` for a
   *             purpose with one key per user. The system counterpart's
   *             address is fixed by the registry and does not vary with it.
   * @throws InternalServerErrorException for a purpose not in the registry —
   *         a programming error, not a missing credential.
   */
  async resolve(
    userId: string,
    purpose: string,
    name: string = DEFAULT_USER_CREDENTIAL_NAME,
  ): Promise<ResolvedCredential> {
    const def = findUserCredentialPurpose(this.registry, purpose);
    if (!def) {
      throw new InternalServerErrorException(
        `Unknown user credential purpose "${purpose}": it is not declared in USER_CREDENTIAL_PURPOSES.`,
      );
    }

    const own = await this.userCredentials.getSecret(userId, purpose, name);
    if (own !== null) {
      return { source: 'user', purpose, secret: own };
    }

    if (def.system) {
      const system = await this.credentials.getSecret(
        def.system.purpose,
        def.system.name,
      );
      if (system !== null) {
        return { source: 'system', purpose, secret: system };
      }
    }

    return { source: 'none', purpose };
  }
}

/**
 * Fail at boot (provider construction) on a malformed registry rather than at
 * the first resolution: a duplicate purpose would make `find` silently pick
 * one entry, and a bad identifier could never be stored under anyway.
 */
function assertValidRegistry(registry: readonly UserCredentialPurposeDef[]): void {
  const seen = new Set<string>();

  for (const def of registry) {
    try {
      assertCredentialPurpose(def.purpose);
      if (def.system) {
        assertCredentialAddress(def.system.purpose, def.system.name);
      }
    } catch (err) {
      throw new Error(
        `Invalid user credential registry entry "${String(def.purpose)}": ${(err as Error).message}`,
      );
    }

    if (!def.label || !def.description) {
      throw new Error(
        `Invalid user credential registry entry "${def.purpose}": label and description are required.`,
      );
    }

    if (seen.has(def.purpose)) {
      throw new Error(`Duplicate user credential registry entry "${def.purpose}".`);
    }
    seen.add(def.purpose);
  }
}
