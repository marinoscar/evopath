// =============================================================================
// Anthropic SDK client factory (issue #446, epic #421)
// =============================================================================
//
// One client PER CALL, built from that call's `AiCallContext` — the same
// shape as `OpenAiClientFactory`, for the same reason: the key is resolved
// per call (org key or the user's own), so a long-lived client holding one
// key would be the wrong shape.
//
// Every credential and endpoint the SDK would otherwise discover on its own
// is pinned explicitly. There is no `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
// configuration in this application (docs/specs/ai-platform.md §2.1), and the
// SDK's credential chain (`ANTHROPIC_AUTH_TOKEN`, an `ant auth login` profile,
// workload identity federation) must never silently decide which account a
// call bills: passing `apiKey` explicitly short-circuits that whole chain
// (the SDK resolves no default credentials once `apiKey` is set), and
// `authToken: null` keeps an ambient bearer token off the request.
//
// `maxRetries: 0` — retries are the caller's job (the queue for a job, the
// user for an interactive call); the SDK retrying a 429/529 underneath would
// multiply every attempt and hide the throttle from `toRateLimitError()`.
//
// An explicit `timeout` also disables the SDK's "streaming is required"
// pre-check for a large non-streaming `max_tokens`: the adapter sizes
// `max_tokens` itself (see `anthropic-model-catalog.ts`).
// =============================================================================

import { Anthropic } from '@anthropic-ai/sdk';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { AiError } from '../../core/ai-error';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import { ANTHROPIC_PROVIDER_ID } from './anthropic-errors';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** A generous ceiling for one request; long extended-thinking turns take minutes. */
export const ANTHROPIC_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** The `fetch` the SDK uses. Tests inject a mocked one; production uses the global. */
export type AnthropicFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AnthropicClientOptions {
  fetch?: AnthropicFetch;
  timeoutMs?: number;
}

/** DI token for `AnthropicClientOptions` (optional; tests and forks provide it). */
export const ANTHROPIC_CLIENT_OPTIONS = Symbol('ANTHROPIC_CLIENT_OPTIONS');

@Injectable()
export class AnthropicClientFactory {
  private readonly options: AnthropicClientOptions;

  constructor(@Optional() @Inject(ANTHROPIC_CLIENT_OPTIONS) options?: AnthropicClientOptions) {
    this.options = options ?? {};
  }

  /** The SDK client for one call. Throws `AI_KEY_INVALID` for an empty key. */
  create(ctx: AiCallContext): Anthropic {
    if (!ctx.apiKey || ctx.apiKey.trim().length === 0) {
      throw new AiError('AI_KEY_INVALID', 'No Anthropic API key was supplied.', {
        details: { provider: ANTHROPIC_PROVIDER_ID },
      });
    }

    return new Anthropic({
      apiKey: ctx.apiKey,
      authToken: null,
      webhookKey: null,
      baseURL: ctx.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
      maxRetries: 0,
      timeout: this.options.timeoutMs ?? ANTHROPIC_DEFAULT_TIMEOUT_MS,
      // The SDK's own logger writes to the console and, at debug level, the
      // request — never let an ambient ANTHROPIC_LOG turn that on.
      logLevel: 'off',
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }
}
