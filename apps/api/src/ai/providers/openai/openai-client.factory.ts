// =============================================================================
// OpenAI SDK client factory (issue #426, epic #419)
// =============================================================================
//
// One client PER CALL, built from that call's `AiCallContext`: the key is
// resolved per call by the runtime (org key or the user's own), so a
// long-lived client holding one key would be the wrong shape.
//
// Every option the SDK would otherwise read from the environment is pinned
// explicitly. There is no `OPENAI_API_KEY` / `OPENAI_BASE_URL` configuration
// in this application (docs/specs/ai-platform.md) and an ambient variable on
// a host must not silently change which account or endpoint a call uses.
//
// `maxRetries: 0` — retries are the caller's job (the queue for a job, the
// user for an interactive call); the SDK retrying underneath would multiply
// every attempt and hide a 429 from `toRateLimitError()`.
// =============================================================================

import { Inject, Injectable, Optional } from '@nestjs/common';
import { OpenAI } from 'openai';

import { AiError } from '../../core/ai-error';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import { OPENAI_FAMILY, type OpenAiFamily } from './openai-errors';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** A generous ceiling for one request; long reasoning turns take minutes. */
export const OPENAI_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** The `fetch` the SDK uses. Tests inject a mocked one; production uses the global. */
export type OpenAiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpenAiClientOptions {
  fetch?: OpenAiFetch;
  timeoutMs?: number;
}

/**
 * Every SDK option this application pins, whatever member of the OpenAI
 * family the client talks to (#448): nothing may be read from the
 * environment (`OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_LOG`, ...), the
 * SDK never retries, and it never logs. The Azure and OpenAI-compatible
 * factories spread this into their own clients.
 */
export function pinnedOpenAiClientOptions(options: OpenAiClientOptions, fetch?: OpenAiFetch) {
  const chosenFetch = fetch ?? options.fetch;

  return {
    organization: null,
    project: null,
    adminAPIKey: null,
    webhookSecret: null,
    maxRetries: 0,
    timeout: options.timeoutMs ?? OPENAI_DEFAULT_TIMEOUT_MS,
    // The SDK's own logger writes to the console and, at debug level, the
    // request — never let an ambient OPENAI_LOG turn that on.
    logLevel: 'off' as const,
    ...(chosenFetch ? { fetch: chosenFetch } : {}),
  };
}

/** Throws `AI_KEY_INVALID` for an empty key — before any client is built. */
export function assertOpenAiApiKey(ctx: AiCallContext, family: OpenAiFamily = OPENAI_FAMILY): void {
  if (!ctx.apiKey || ctx.apiKey.trim().length === 0) {
    throw new AiError('AI_KEY_INVALID', `No ${family.label} API key was supplied.`, {
      details: { provider: family.providerId },
    });
  }
}

/** DI token for `OpenAiClientOptions` (optional; tests and forks provide it). */
export const OPENAI_CLIENT_OPTIONS = Symbol('OPENAI_CLIENT_OPTIONS');

@Injectable()
export class OpenAiClientFactory {
  private readonly options: OpenAiClientOptions;

  constructor(@Optional() @Inject(OPENAI_CLIENT_OPTIONS) options?: OpenAiClientOptions) {
    this.options = options ?? {};
  }

  /** The SDK client for one call. Throws `AI_KEY_INVALID` for an empty key. */
  create(ctx: AiCallContext): OpenAI {
    assertOpenAiApiKey(ctx);

    return new OpenAI({
      apiKey: ctx.apiKey,
      baseURL: ctx.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
      ...pinnedOpenAiClientOptions(this.options),
    });
  }
}
