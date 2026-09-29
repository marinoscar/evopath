import { Injectable } from '@nestjs/common';

import { AiConfigService, providerPolicy, providerRequiresKey } from '../config/ai-config.service';
import { AiError } from '../core/ai-error';
import { AI_KEYLESS_API_KEY } from '../core/provider-adapter.interface';
import { AiConfigWriterLookup } from './ai-config-writer.lookup';
import { UserAiKeysService } from './user-ai-keys.service';

// =============================================================================
// AiKeyResolver — THE key-resolution rule (issue #431, epic #419)
// =============================================================================
//
// docs/specs/ai-platform.md §2.2. Every caller that needs a key to serve a user
// — the runtime facade (#432) and the usable-models computation — goes through
// this file rather than re-deriving the rule:
//
//   0. the provider is keyless (`requiresKey: false`, #448)       -> { none }
//   1. the user has a key for the provider                      -> { user }
//   2. the user holds `ai_config:write` AND an org key exists   -> { org }
//      (under EITHER key policy — #593)
//   3. keyPolicy 'byok_with_org_fallback' AND an org key exists -> { org }
//   4. otherwise                                                 -> AI_KEY_REQUIRED
//
// RULE 0 IS AN ADMINISTRATOR'S OPT-IN, NEVER A FALLBACK. Only the
// OpenAI-compatible slot has a `requiresKey` field, and only an administrator
// (`ai_config:write`) can set it to false — for a self-hosted server (Ollama,
// vLLM, LM Studio) that authenticates nobody. The call then carries the
// `AI_KEYLESS_API_KEY` marker, which the adapter turns into NO credential on
// the wire; no key is read or decrypted, and usage is recorded with
// `keySource: 'none'`. It precedes rule 1 because the server would ignore a
// user's key anyway, and it does not depend on the key policy: `byok`
// promises that only a user's own account is BILLED, and a keyless server
// bills no account.
//
// ⚠ UNDER keyPolicy = 'byok' THE ORG (ADMIN) KEY IS NEVER RETURNED TO A
// NON-ADMINISTRATOR — not read, not decrypted, not handed to anyone. That is
// the platform's core security invariant: an administrator who chose strict
// BYOK promised every user that only their own provider account can be billed
// for their calls. `ai-key-resolver.service.spec.ts` pins the full matrix, and
// #435 re-verifies it end to end.
//
// RULE 2 DOES NOT BREAK THAT PROMISE (#593). The org key is stored by a holder
// of `ai_config:write`, from the organisation's own provider account; that
// account is the administrator's own, not somebody else's. Serving an
// administrator's OWN calls with it bills exactly the account the byok
// promise lets them bill — it would be absurd to make the person who
// configured the org key also paste a personal copy at /settings/ai. The
// promise is to everyone else: for a user without the permission, rule 2 is
// never taken, and under 'byok' the org key is still never read. The order of
// checks keeps that literal — the permission is looked up (one `count`) only
// when the user has no key of their own, and the org key is read only AFTER
// the permission check succeeds or the policy is the fallback. An
// administrator may still override with a personal key (rule 1 precedes rule
// 2), and these calls are recorded `keySource: 'org'` like any other org-key
// call, so usage reporting shows exactly whose account paid.
//
// The permission is read from the database on every resolution
// (`AiConfigWriterLookup`), never from a token claim, so revoking the role
// stops rule 2 on the next call.
//
// The policy is read on every call (through `AiConfigService`'s 5 s cache), so
// an admin switching to strict BYOK stops the fallback within one cache window.
// =============================================================================

/**
 * Whose key serves a user's call — `'none'` (#448) for a keyless provider.
 * `'admin_discovery'` is never a runtime answer.
 */
export type AiKeySource = 'user' | 'org' | 'none';

export interface ResolvedAiKey {
  /**
   * ⚠ PLAINTEXT. Hand it straight to an adapter; never log, persist or return
   * it. `AI_KEYLESS_API_KEY` when `keySource` is `'none'`.
   */
  apiKey: string;
  keySource: AiKeySource;
}

@Injectable()
export class AiKeyResolver {
  constructor(
    private readonly userKeys: UserAiKeysService,
    private readonly aiConfig: AiConfigService,
    private readonly configWriters: AiConfigWriterLookup,
  ) {}

  /**
   * The key that serves `userId`'s call to `provider`, decrypted.
   *
   * @throws AiError('AI_KEY_REQUIRED') when no rule applies.
   */
  async resolve(userId: string, provider: string): Promise<ResolvedAiKey> {
    if (await this.keyless(provider)) {
      return { apiKey: AI_KEYLESS_API_KEY, keySource: 'none' };
    }

    const userKey = await this.userKeys.getDecrypted(userId, provider);

    if (userKey) {
      return { apiKey: userKey, keySource: 'user' };
    }

    if (await this.orgKeyMayServe(() => this.holdsAiConfigWrite(userId))) {
      const orgKey = await this.aiConfig.getOrgKey(provider);

      if (orgKey) {
        return { apiKey: orgKey, keySource: 'org' };
      }
    }

    throw keyRequired(provider);
  }

  /**
   * The same rule, answered WITHOUT decrypting anything: which source WOULD
   * serve the call, or null when none would. For listings that must not hold
   * plaintext they will not use.
   *
   * `hasUserKey` is the caller's own knowledge of whether a `user_ai_keys`
   * row exists (it usually just read it); the rest of the rule is applied
   * here, so the ordering and the byok invariant live in one file.
   *
   * `holdsAiConfigWrite` lets a caller that asks about several providers for
   * the same user (the usable-models listing) share one memoised permission
   * lookup; omitted, it is looked up here, and only if rule 2 is reached.
   */
  async sourceFor(
    userId: string,
    provider: string,
    hasUserKey: boolean,
    holdsAiConfigWrite: () => Promise<boolean> = () => this.holdsAiConfigWrite(userId),
  ): Promise<AiKeySource | null> {
    if (await this.keyless(provider)) {
      return 'none';
    }

    if (hasUserKey) {
      return 'user';
    }

    if ((await this.orgKeyMayServe(holdsAiConfigWrite)) && (await this.aiConfig.hasOrgKey(provider))) {
      return 'org';
    }

    return null;
  }

  /**
   * Whether `userId` holds `ai_config:write` (rule 2's permission half). One
   * query; callers resolving several providers for one user should memoise it.
   */
  holdsAiConfigWrite(userId: string): Promise<boolean> {
    return this.configWriters.holdsAiConfigWrite(userId);
  }

  /** Rule 0: the administrator marked this provider `requiresKey: false`. */
  private async keyless(provider: string): Promise<boolean> {
    return !providerRequiresKey(providerPolicy(await this.aiConfig.resolve(), provider));
  }

  /**
   * Rules 2 and 3, WITHOUT touching the org key: may an org key (if one is
   * stored) serve this user? The policy is checked first, so under the
   * fallback no permission query runs; under 'byok' only the permission can
   * open it. Callers read the org key only when this is true — which is what
   * keeps the org key unread for a non-administrator under 'byok'.
   */
  private async orgKeyMayServe(holdsAiConfigWrite: () => Promise<boolean>): Promise<boolean> {
    if ((await this.aiConfig.resolve()).keyPolicy === 'byok_with_org_fallback') {
      return true;
    }

    return holdsAiConfigWrite();
  }
}

/** `AI_KEY_REQUIRED` (403), naming the provider so a client can link to the keys page. */
export function keyRequired(provider: string): AiError {
  return new AiError(
    'AI_KEY_REQUIRED',
    `Add your own API key for "${provider}" to use it.`,
    { details: { provider } },
  );
}
