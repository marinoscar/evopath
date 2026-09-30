import { randomUUID } from 'node:crypto';

import type { z } from 'zod';

import { AiError } from '../../../src/ai/core/ai-error';
import type { AiCallContext } from '../../../src/ai/core/provider-adapter.interface';
import { AiProviderRegistry } from '../../../src/ai/core/provider-registry';
import { parseStructured } from '../../../src/ai/core/structured-output';
import type { AiResponse, AiResponseRequest } from '../../../src/ai/core/types/responses.types';
import { AnthropicClientFactory } from '../../../src/ai/providers/anthropic/anthropic-client.factory';
import { AnthropicProviderAdapter } from '../../../src/ai/providers/anthropic/anthropic.adapter';
import { GeminiClientFactory } from '../../../src/ai/providers/gemini/gemini-client.factory';
import { GeminiProviderAdapter } from '../../../src/ai/providers/gemini/gemini.adapter';
import { OpenAiClientFactory } from '../../../src/ai/providers/openai/openai-client.factory';
import { OpenAiProviderAdapter } from '../../../src/ai/providers/openai/openai.adapter';
import { runToolLoop } from '../../../src/ai/runtime/ai-tool-loop';
import type { AiUserClient } from '../../../src/ai/runtime/ai.service';
import type { LiveProvider } from '../training/eval-env';

// =============================================================================
// A thin AiUserClient over the REAL provider adapters (TEST-ONLY)
// =============================================================================
//
// The seam: `AiService` needs the database-backed key and model tables, so the
// live evals do not use it. This client is what `AgentCaller` needs and no
// more: `respond`, `respondStructured` and the tool loop, straight to the
// adapter with the key the test process holds. The gateway's gates (kill
// switch, RBAC, usage rows) are covered by the scripted suites; a live eval
// is about the model's answers.
//
// THE KEY LIVES ONLY IN THIS CLOSURE. It is passed to the adapter call and
// nowhere else: not logged, not put in a report, not in an error.
//
// A provider throttle (`AI_RATE_LIMITED`) is retried with backoff, honouring
// the provider's `retryAfter`, then thrown.
// =============================================================================

export interface ResponsesPortLike {
  create(req: AiResponseRequest, ctx: AiCallContext): Promise<AiResponse>;
}

export interface LiveClientOptions {
  keys: Partial<Record<LiveProvider, string>>;
  /** Retries after a throttle (default 4). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the real adapters (unit tests). */
  ports?: Partial<Record<LiveProvider, ResponsesPortLike>>;
  /** Sees every response (request, response) after it succeeded. */
  onResponse?: (req: AiResponseRequest, response: AiResponse) => void;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Delay before retry `attempt` (0-based): the provider's hint, else 1 s doubling to 30 s. */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  return Math.min(30_000, retryAfterMs ?? 1_000 * 2 ** attempt);
}

function realPort(provider: LiveProvider): ResponsesPortLike {
  const registry = new AiProviderRegistry();
  switch (provider) {
    case 'openai':
      return new OpenAiProviderAdapter(registry, new OpenAiClientFactory()).responses!;
    case 'anthropic':
      return new AnthropicProviderAdapter(registry, new AnthropicClientFactory()).responses!;
    case 'gemini':
      return new GeminiProviderAdapter(registry, new GeminiClientFactory()).responses!;
  }
}

export function createLiveClient(options: LiveClientOptions): AiUserClient {
  const ports = new Map<LiveProvider, ResponsesPortLike>();
  const portFor = (provider: LiveProvider) => {
    let port = ports.get(provider) ?? options.ports?.[provider];
    if (!port) {
      port = realPort(provider);
    }
    ports.set(provider, port);
    return port;
  };
  const sleep = options.sleep ?? realSleep;
  const maxRetries = options.maxRetries ?? 4;

  const call = async (req: AiResponseRequest & { provider?: string }, signal?: AbortSignal): Promise<AiResponse> => {
    const { provider, ...rest } = req;
    const key = options.keys[provider as LiveProvider];
    if (!key) throw new AiError('AI_INVALID_REQUEST', `The live eval has no test key for provider "${String(provider)}".`);

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await portFor(provider as LiveProvider).create(rest as AiResponseRequest, { apiKey: key, requestId: `eval-${randomUUID()}`, signal });
        options.onResponse?.(rest as AiResponseRequest, response);
        return response;
      } catch (err) {
        if (!(err instanceof AiError) || err.code !== 'AI_RATE_LIMITED' || attempt >= maxRetries) throw err;
        await sleep(backoffMs(attempt, err.retryAfterMs));
      }
    }
  };

  const respond = (req: never, opts?: { signal?: AbortSignal }) => call(req, opts?.signal);

  const client: Pick<AiUserClient, 'userId' | 'respond' | 'respondStructured' | 'runTools'> = {
    userId: 'eval',
    respond: respond as AiUserClient['respond'],
    respondStructured: (async <S extends z.ZodTypeAny>(req: never, opts?: { signal?: AbortSignal }) => {
      const { schema, schemaName, strict, ...rest } = req as { schema: S; schemaName?: string; strict?: boolean };
      const response = await call({ ...(rest as object), structuredOutput: { name: schemaName ?? 'response', schema, strict: strict ?? true } } as never, opts?.signal);
      // The adapter validates itself; a truncated or unparsed answer is validated here, as the gateway does.
      return response.parsed === undefined ? { ...response, parsed: parseStructured(schema, response.outputText) } : response;
    }) as AiUserClient['respondStructured'],
    runTools: ((req: never, opts?: { signal?: AbortSignal }) => runToolLoop((next, callOpts) => call(next as never, callOpts.signal), req, { userId: 'eval', signal: opts?.signal })) as AiUserClient['runTools'],
  };

  return client as AiUserClient;
}

/** Routes a request to `primary` or `secondary` by the agent named in its metadata. */
export function routeByAgent(primary: AiUserClient, secondary: AiUserClient, useSecondary: (agent: string | undefined) => boolean): AiUserClient {
  const pick = (req: { metadata?: Record<string, string> }) => (useSecondary(req.metadata?.agent) ? secondary : primary);

  const routed: Pick<AiUserClient, 'userId' | 'respond' | 'respondStructured' | 'runTools'> = {
    userId: primary.userId,
    respond: ((req: never, opts: never) => pick(req).respond(req, opts)) as AiUserClient['respond'],
    respondStructured: ((req: never, opts: never) => pick(req).respondStructured(req, opts)) as AiUserClient['respondStructured'],
    runTools: ((req: never, opts: never) => pick(req).runTools(req, opts)) as AiUserClient['runTools'],
  };
  return routed as AiUserClient;
}
