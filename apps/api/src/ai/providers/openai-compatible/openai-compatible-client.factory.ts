// =============================================================================
// OpenAI-compatible SDK client factory (issue #448, epic #421)
// =============================================================================
//
// One OpenAI SDK client PER CALL, pointed at the administrator's `baseUrl`
// (the server's API root, `/v1` included), with the options every
// OpenAI-family client pins (no environment reads, no retries, no SDK
// logging) and a `fetch` that follows no redirect (`openai-redirect-guard.ts`).
//
// KEYLESS (`keySource: 'none'`). A call whose key is `AI_KEYLESS_API_KEY` —
// the marker the key resolver hands out for a `requiresKey: false` server —
// carries NO credential: the SDK's `Authorization` header is explicitly
// removed (`defaultHeaders: { Authorization: null }`), so the marker never
// reaches the wire. Any other key is sent as a bearer token, as OpenAI does;
// that is what vLLM's `--api-key`, LM Studio and most gateways check.
// =============================================================================

import { Inject, Injectable, Optional } from '@nestjs/common';
import { OpenAI } from 'openai';

import { AiError } from '../../core/ai-error';
import { AI_KEYLESS_API_KEY, type AiCallContext } from '../../core/provider-adapter.interface';
import {
  assertOpenAiApiKey,
  type OpenAiClientOptions,
  pinnedOpenAiClientOptions,
} from '../openai/openai-client.factory';
import { noRedirectFetch } from '../openai/openai-redirect-guard';
import { OPENAI_COMPATIBLE_FAMILY } from './openai-compatible-settings';

/** DI token for the client's options (tests inject a mocked `fetch`). */
export const OPENAI_COMPATIBLE_CLIENT_OPTIONS = Symbol('OPENAI_COMPATIBLE_CLIENT_OPTIONS');

@Injectable()
export class OpenAiCompatibleClientFactory {
  private readonly options: OpenAiClientOptions;

  constructor(@Optional() @Inject(OPENAI_COMPATIBLE_CLIENT_OPTIONS) options?: OpenAiClientOptions) {
    this.options = options ?? {};
  }

  /**
   * The client for one call. Throws `AI_KEY_INVALID` for an empty key and
   * `AI_PROVIDER_UNAVAILABLE` when no base URL is configured — there is no
   * default host for a self-hosted server.
   */
  create(ctx: AiCallContext): OpenAI {
    assertOpenAiApiKey(ctx, OPENAI_COMPATIBLE_FAMILY);

    if (!ctx.baseUrl) {
      throw new AiError('AI_PROVIDER_UNAVAILABLE', 'No OpenAI-compatible base URL is configured.', {
        details: { provider: OPENAI_COMPATIBLE_FAMILY.providerId, missing: 'baseUrl' },
      });
    }

    const keyless = ctx.apiKey === AI_KEYLESS_API_KEY;

    return new OpenAI({
      apiKey: ctx.apiKey,
      baseURL: ctx.baseUrl,
      ...(keyless ? { defaultHeaders: { Authorization: null } } : {}),
      ...pinnedOpenAiClientOptions(this.options, noRedirectFetch(this.options.fetch)),
    });
  }
}
