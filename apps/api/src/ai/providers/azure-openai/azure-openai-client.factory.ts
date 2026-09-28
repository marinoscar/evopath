// =============================================================================
// Azure OpenAI SDK client factory (issue #448, epic #421)
// =============================================================================
//
// One `AzureOpenAI` client PER CALL, built from that call's context — the
// key is resolved per call, exactly as for OpenAI — with every option the SDK
// would otherwise read from the environment pinned explicitly:
//
//   - `baseURL` is passed, never `endpoint`: `AzureOpenAI` defaults `baseURL`
//     to `OPENAI_BASE_URL` and refuses `endpoint` beside it, so an ambient
//     variable on a host would otherwise break (or redirect) every call. The
//     base is `<endpoint>/openai`, the path the SDK itself derives.
//   - `apiVersion` and `apiKey` are always explicit (the SDK falls back to
//     `OPENAI_API_VERSION` / `AZURE_OPENAI_API_KEY`).
//   - the key travels in Azure's `api-key` header (the SDK's own behaviour).
//   - `maxRetries: 0`, no SDK logging, and a `fetch` that follows no
//     redirect (`openai-redirect-guard.ts`).
//
// No `deployment` is pinned on the client: the adapter puts the DEPLOYMENT
// NAME in the request's `model`, and the SDK routes Chat Completions and
// embeddings to `/deployments/<model>/...` from it while the Responses API
// takes it as the body's `model` — so one client serves every model.
// =============================================================================

import { Inject, Injectable, Optional } from '@nestjs/common';
import { AzureOpenAI } from 'openai';

import { AiError } from '../../core/ai-error';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import {
  assertOpenAiApiKey,
  type OpenAiClientOptions,
  pinnedOpenAiClientOptions,
} from '../openai/openai-client.factory';
import { noRedirectFetch } from '../openai/openai-redirect-guard';
import { AZURE_OPENAI_FAMILY, type AzureOpenAiSettings } from './azure-openai-settings';

/** DI token for the Azure client's options (tests inject a mocked `fetch`). */
export const AZURE_OPENAI_CLIENT_OPTIONS = Symbol('AZURE_OPENAI_CLIENT_OPTIONS');

/**
 * `<endpoint>/openai` — the resource endpoint without trailing slashes, and
 * without a doubled `/openai` when the administrator already typed it.
 */
export function azureOpenAiBaseUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');

  return /\/openai$/i.test(trimmed) ? trimmed : `${trimmed}/openai`;
}

@Injectable()
export class AzureOpenAiClientFactory {
  private readonly options: OpenAiClientOptions;

  constructor(@Optional() @Inject(AZURE_OPENAI_CLIENT_OPTIONS) options?: OpenAiClientOptions) {
    this.options = options ?? {};
  }

  /**
   * The client for one call. Throws `AI_KEY_INVALID` for an empty key and
   * `AI_PROVIDER_UNAVAILABLE` when no endpoint is configured.
   */
  create(ctx: AiCallContext, settings: AzureOpenAiSettings): AzureOpenAI {
    assertOpenAiApiKey(ctx, AZURE_OPENAI_FAMILY);

    if (!ctx.baseUrl) {
      throw new AiError('AI_PROVIDER_UNAVAILABLE', 'No Azure OpenAI endpoint is configured.', {
        details: { provider: AZURE_OPENAI_FAMILY.providerId, missing: 'baseUrl' },
      });
    }

    return new AzureOpenAI({
      apiKey: ctx.apiKey,
      baseURL: azureOpenAiBaseUrl(ctx.baseUrl),
      apiVersion: settings.apiVersion,
      ...pinnedOpenAiClientOptions(this.options, noRedirectFetch(this.options.fetch)),
    });
  }
}
