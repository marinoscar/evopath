import { Injectable } from '@nestjs/common';

import { AiConfigService, providerPolicy, providerRequiresKey } from '../config/ai-config.service';
import { AiError } from '../core/ai-error';
import { AI_KEYLESS_API_KEY } from '../core/provider-adapter.interface';
import { UserAiKeysService } from './user-ai-keys.service';

// =============================================================================
// AiKeyResolver — THE key-resolution rule (issue #431, epic #419)
// =============================================================================
//
// docs/specs/ai-platform.md §2.2. Every caller that needs a key to serve a user
// — the runtime facade (#432) and the usable-models computation — goes through
// this file rather than re-deriving the rule:
//
//   0. the provider is keyless (`requiresKey: false`, #448)     -> { none }
//   1. the user has a key for the provider                    -> { user }
//   2. keyPolicy 'byok_with_org_fallback' AND an org key exists -> { org }
//   3. otherwise                                               -> AI_KEY_REQUIRED
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
// ⚠ UNDER keyPolicy = 'byok' THE ORG (ADMIN) KEY IS NEVER RETURNED — not read,
// not decrypted, not handed to anyone. That is the platform's core security
// invariant: an administrator who chose strict BYOK promised every user that
// only their own provider account can be billed for their calls.
// `ai-key-resolver.service.spec.ts` pins the full matrix, and #435 re-verifies
// it end to end.
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
  ) {}

  /**
   * The key that serves `userId`'s call to `provider`, decrypted.
   *
   * @throws AiError('AI_KEY_REQUIRED') when neither rule applies.
   */
  async resolve(userId: string, provider: string): Promise<ResolvedAiKey> {
    if (await this.keyless(provider)) {
      return { apiKey: AI_KEYLESS_API_KEY, keySource: 'none' };
    }

    const userKey = await this.userKeys.getDecrypted(userId, provider);

    if (userKey) {
      return { apiKey: userKey, keySource: 'user' };
    }

    if (await this.orgFallbackApplies()) {
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
   */
  async sourceFor(provider: string, hasUserKey: boolean): Promise<AiKeySource | null> {
    if (await this.keyless(provider)) {
      return 'none';
    }

    if (hasUserKey) {
      return 'user';
    }

    if ((await this.orgFallbackApplies()) && (await this.aiConfig.hasOrgKey(provider))) {
      return 'org';
    }

    return null;
  }

  /** Rule 0: the administrator marked this provider `requiresKey: false`. */
  private async keyless(provider: string): Promise<boolean> {
    return !providerRequiresKey(providerPolicy(await this.aiConfig.resolve(), provider));
  }

  private async orgFallbackApplies(): Promise<boolean> {
    return (await this.aiConfig.resolve()).keyPolicy === 'byok_with_org_fallback';
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
