// =============================================================================
// AiService (issue #432) — the gate pipeline, key policy, structured output,
// streaming, and what never leaves the facade (prompt text, keys).
// =============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { AiError, type AiErrorCode } from '../core/ai-error';
import type { AiModelCapabilities } from '../core/capabilities';
import { AI_KEYLESS_API_KEY } from '../core/provider-adapter.interface';
import type { AiStreamEvent } from '../core/types/responses.types';
import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_ORG_KEY,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../testing/fake-ai-provider';
import type { AiRequest } from './ai-runtime.types';
import { AI_PROMPT_LOG_MAX_CHARS, clampOutputTokens } from './ai.service';

const TEXT_ONLY: AiModelCapabilities = {
  capabilities: ['responses'],
  inputModalities: ['text'],
  outputModalities: ['text'],
};

async function codeOf(promise: Promise<unknown>): Promise<AiErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);
    return (err as AiError).code;
  }
}

async function collect(iterable: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const hello: AiRequest = { model: HARNESS_MODEL, input: 'hello' };

describe('AiService', () => {
  describe('gate matrix — each gate produces its exact code, before any provider call', () => {
    interface GateCase {
      name: string;
      harness: AiRuntimeHarnessOptions;
      request?: AiRequest;
      stream?: boolean;
      expected: AiErrorCode;
    }

    const CASES: GateCase[] = [
      { name: 'kill switch off', harness: { policy: { enabled: false } }, expected: 'AI_DISABLED' },
      {
        name: 'provider disabled in settings',
        harness: { policy: { providerEnabled: false } },
        expected: 'AI_PROVIDER_DISABLED',
      },
      {
        name: 'provider not registered in this process',
        harness: { registerProvider: false },
        request: { ...hello, provider: 'openai' },
        expected: 'AI_PROVIDER_DISABLED',
      },
      {
        name: 'model not in the catalog',
        harness: {},
        request: { model: 'no-such-model', input: 'x' },
        expected: 'AI_MODEL_NOT_ENABLED',
      },
      {
        name: 'model disabled by the admin',
        harness: { models: [{ modelId: HARNESS_MODEL, enabled: false }] },
        expected: 'AI_MODEL_NOT_ENABLED',
      },
      {
        name: 'model deprecated',
        harness: { models: [{ modelId: HARNESS_MODEL, deprecatedAt: new Date() }] },
        expected: 'AI_MODEL_NOT_ENABLED',
      },
      {
        name: 'structured output on a text-only model',
        harness: { models: [{ modelId: HARNESS_MODEL, capabilities: TEXT_ONLY }] },
        request: { ...hello, structuredOutput: { name: 'x', schema: z.object({ a: z.string() }) } },
        expected: 'AI_CAPABILITY_UNSUPPORTED',
      },
      {
        name: 'function tools on a text-only model',
        harness: { models: [{ modelId: HARNESS_MODEL, capabilities: TEXT_ONLY }] },
        request: {
          ...hello,
          tools: [{ type: 'function', name: 'f', description: 'f', parameters: z.object({}) }],
        },
        expected: 'AI_CAPABILITY_UNSUPPORTED',
      },
      {
        name: 'reasoning on a text-only model',
        harness: { models: [{ modelId: HARNESS_MODEL, capabilities: TEXT_ONLY }] },
        request: { ...hello, reasoning: { effort: 'low' } },
        expected: 'AI_CAPABILITY_UNSUPPORTED',
      },
      {
        name: 'reasoning effort the model does not offer',
        harness: {
          models: [
            { modelId: HARNESS_MODEL, capabilities: { ...FAKE_TEXT_MODEL_CAPABILITIES, reasoningEfforts: ['high'] } },
          ],
        },
        request: { ...hello, reasoning: { effort: 'minimal' } },
        expected: 'AI_CAPABILITY_UNSUPPORTED',
      },
      {
        name: 'image input on a text-only model',
        harness: { models: [{ modelId: HARNESS_MODEL, capabilities: TEXT_ONLY }] },
        request: {
          model: HARNESS_MODEL,
          input: [{ type: 'message', role: 'user', content: [{ type: 'image', url: 'https://x/y.png' }] }],
        },
        expected: 'AI_CAPABILITY_UNSUPPORTED',
      },
      {
        name: 'streaming on a text-only model',
        harness: { models: [{ modelId: HARNESS_MODEL, capabilities: TEXT_ONLY }] },
        stream: true,
        expected: 'AI_CAPABILITY_UNSUPPORTED',
      },
      {
        name: 'provider without a responses port',
        harness: { fake: { responsesPort: false } },
        expected: 'AI_CAPABILITY_UNSUPPORTED',
      },
      { name: 'no key under byok', harness: { userKey: false }, expected: 'AI_KEY_REQUIRED' },
      {
        name: "the user's key cannot reach the model",
        harness: { reachable: [] },
        expected: 'AI_MODEL_NOT_REACHABLE',
      },
      {
        name: 'no model and no default model',
        harness: {},
        request: { input: 'x' },
        expected: 'AI_INVALID_REQUEST',
      },
      {
        name: 'a non-integer maxOutputTokens',
        harness: {},
        request: { ...hello, maxOutputTokens: 1.5 },
        expected: 'AI_INVALID_REQUEST',
      },
    ];

    it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
      const h = createAiRuntimeHarness(c.harness);
      const client = h.ai.forUser(HARNESS_USER);
      const request = c.request ?? hello;

      const code = await codeOf(c.stream ? client.openStream(request) : client.respond(request));

      expect(code).toBe(c.expected);
      expect(h.fake.calls).toHaveLength(0);
      // A refused call is not a provider round-trip: no usage row.
      expect(h.usageEvents).toHaveLength(0);
    });

    it('runs the gates in order: the kill switch wins over everything else', async () => {
      const h = createAiRuntimeHarness({
        policy: { enabled: false, providerEnabled: false },
        userKey: false,
        models: [],
      });

      expect(await codeOf(h.ai.forUser(HARNESS_USER).respond(hello))).toBe('AI_DISABLED');
    });

    it('... then the provider, then the model, then capabilities, then the key, then reach', async () => {
      const h = createAiRuntimeHarness({
        policy: { providerEnabled: false },
        userKey: false,
        models: [{ modelId: HARNESS_MODEL, capabilities: TEXT_ONLY }],
      });
      const client = h.ai.forUser(HARNESS_USER);
      const structured = { ...hello, structuredOutput: { name: 'x', schema: z.object({}) } };

      expect(await codeOf(client.respond({ ...structured, model: 'missing' }))).toBe('AI_PROVIDER_DISABLED');
      h.setPolicy({ providers: { openai: { enabled: true }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } });
      expect(await codeOf(client.respond({ ...structured, model: 'missing' }))).toBe('AI_MODEL_NOT_ENABLED');
      expect(await codeOf(client.respond(structured))).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(await codeOf(client.respond(hello))).toBe('AI_KEY_REQUIRED');
      h.addUserKey(HARNESS_USER, HARNESS_USER_KEY, []);
      expect(await codeOf(client.respond(hello))).toBe('AI_MODEL_NOT_REACHABLE');
    });
  });

  describe('key policy', () => {
    it("⚠ byok: a user without a key gets AI_KEY_REQUIRED and the org key is never used, nor read", async () => {
      const h = createAiRuntimeHarness({ userKey: false, orgKey: true, policy: { keyPolicy: 'byok' } });

      expect(await codeOf(h.ai.forUser(HARNESS_USER).respond(hello))).toBe('AI_KEY_REQUIRED');
      expect(await codeOf(h.ai.forUser(HARNESS_USER).openStream(hello))).toBe('AI_KEY_REQUIRED');

      expect(h.fake.calls.filter((call) => call.apiKey === HARNESS_ORG_KEY)).toHaveLength(0);
      expect(h.fake.calls).toHaveLength(0);
      expect(h.getSecret).not.toHaveBeenCalled();
    });

    it("byok: a user with a key is served with THEIR key, recorded as keySource 'user'", async () => {
      const h = createAiRuntimeHarness({ orgKey: true });

      await h.ai.forUser(HARNESS_USER).respond(hello);

      expect(h.fake.apiKeys).toEqual([HARNESS_USER_KEY]);
      expect(h.usageEvents).toHaveLength(1);
      expect(h.usageEvents[0]).toMatchObject({ keySource: 'user', userId: HARNESS_USER });
      expect(h.getSecret).not.toHaveBeenCalled();
    });

    it("byok_with_org_fallback: a user without a key is served with the org key, keySource 'org'", async () => {
      const h = createAiRuntimeHarness({
        userKey: false,
        orgKey: true,
        policy: { keyPolicy: 'byok_with_org_fallback' },
      });

      await h.ai.forUser(HARNESS_USER).respond(hello);

      expect(h.fake.apiKeys).toEqual([HARNESS_ORG_KEY]);
      expect(h.usageEvents[0]).toMatchObject({ keySource: 'org' });
    });

    it('passes the provider baseUrl override and a fresh request id to the adapter', async () => {
      const h = createAiRuntimeHarness({ policy: { baseUrl: 'https://gateway.example.com/v1' } });

      await h.ai.forUser(HARNESS_USER).respond(hello);
      await h.ai.forUser(HARNESS_USER).respond(hello);

      expect(h.fake.calls[0].baseUrl).toBe('https://gateway.example.com/v1');
      expect(h.fake.calls[0].requestId).not.toBe(h.fake.calls[1].requestId);
      expect(h.fake.calls[0]).not.toHaveProperty('providerSettings');
    });

    it("keyless provider (requiresKey: false, #448): served with no key, keySource 'none', under strict byok", async () => {
      const h = createAiRuntimeHarness({
        userKey: false,
        orgKey: true,
        policy: { keyPolicy: 'byok', providerSlot: { requiresKey: false, apiStyle: 'chat_completions' } },
      });

      await h.ai.forUser(HARNESS_USER).respond(hello);
      await collect(h.ai.forUser(HARNESS_USER).stream(hello));

      expect(h.fake.calls.map((call) => call.apiKey)).toEqual([AI_KEYLESS_API_KEY, AI_KEYLESS_API_KEY]);
      expect(h.usageEvents.map((row) => row.keySource)).toEqual(['none', 'none']);
      expect(h.getSecret).not.toHaveBeenCalled();
      // The slot's other settings reach the adapter as-is.
      expect(h.fake.calls[0].providerSettings).toEqual({ requiresKey: false, apiStyle: 'chat_completions' });
      // The marker is never recorded anywhere a row or a log could carry it.
      expect(JSON.stringify(h.usageEvents)).not.toContain(AI_KEYLESS_API_KEY);
    });
  });

  describe('model selection', () => {
    it("falls back to the user's ai.defaultModel setting", async () => {
      const h = createAiRuntimeHarness({ defaultModel: { provider: 'openai', modelId: HARNESS_MODEL } });

      const response = await h.ai.forUser(HARNESS_USER).respond({ input: 'hi' });

      expect(response.model).toBe(HARNESS_MODEL);
      expect(h.fake.calls[0].request?.model).toBe(HARNESS_MODEL);
    });

    it('refuses a default model belonging to a different provider than the one requested', async () => {
      const h = createAiRuntimeHarness({ defaultModel: { provider: 'openai', modelId: HARNESS_MODEL } });

      expect(await codeOf(h.ai.forUser(HARNESS_USER).respond({ provider: 'other', input: 'hi' }))).toBe(
        'AI_INVALID_REQUEST',
      );
    });

    it('infers the provider for a bare model id when only one provider is registered', async () => {
      const h = createAiRuntimeHarness();

      await expect(h.ai.forUser(HARNESS_USER).respond(hello)).resolves.toMatchObject({ provider: 'openai' });
    });

    it('never forwards the facade-only provider field to the adapter', async () => {
      const h = createAiRuntimeHarness();

      await h.ai.forUser(HARNESS_USER).respond({ ...hello, provider: 'openai' });

      expect(h.fake.calls[0].request).not.toHaveProperty('provider');
    });
  });

  describe('maxOutputTokens clamp', () => {
    it('bounds the caller by the deployment cap and the model limit', () => {
      expect(clampOutputTokens(500, 100, 16_384)).toBe(100);
      expect(clampOutputTokens(50_000, undefined, 16_384)).toBe(16_384);
      expect(clampOutputTokens(200, 1_000, 16_384)).toBe(200);
      expect(clampOutputTokens(undefined, 300, 16_384)).toBe(300);
      expect(clampOutputTokens(undefined, 300, 100)).toBe(100);
      expect(clampOutputTokens(undefined, undefined, 16_384)).toBeUndefined();
    });

    it('applies the clamp to the request the adapter receives', async () => {
      const h = createAiRuntimeHarness({ policy: { defaults: { maxOutputTokensCap: 64 } } });

      await h.ai.forUser(HARNESS_USER).respond({ ...hello, maxOutputTokens: 4_096 });
      await h.ai.forUser(HARNESS_USER).respond(hello);

      expect(h.fake.calls[0].request?.maxOutputTokens).toBe(64);
      expect(h.fake.calls[1].request?.maxOutputTokens).toBe(64);
    });
  });

  describe('respondStructured', () => {
    const schema = z.object({ city: z.string(), population: z.number().int() });

    it('returns a typed, validated `parsed`', async () => {
      const h = createAiRuntimeHarness({
        fake: { responses: [{ outputText: JSON.stringify({ city: 'Lima', population: 10_000_000 }) }] },
      });

      const response = await h.ai
        .forUser(HARNESS_USER)
        .respondStructured({ model: HARNESS_MODEL, input: 'Largest city in Peru?', schema, schemaName: 'city' });

      const population: number = response.parsed.population;

      expect(population).toBe(10_000_000);
      expect(response.parsed).toEqual({ city: 'Lima', population: 10_000_000 });
      expect(h.fake.calls[0].request?.structuredOutput).toMatchObject({ name: 'city', strict: true });
      expect(h.usageEvents[0]).toMatchObject({ status: 'succeeded' });
    });

    it('a schema mismatch is AI_STRUCTURED_OUTPUT_INVALID and records a failed usage row', async () => {
      const h = createAiRuntimeHarness({
        fake: { responses: [{ outputText: JSON.stringify({ city: 'Lima', population: 'lots' }) }] },
      });

      const code = await codeOf(
        h.ai.forUser(HARNESS_USER).respondStructured({ model: HARNESS_MODEL, input: 'x', schema }),
      );

      expect(code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
      expect(h.usageEvents).toHaveLength(1);
      expect(h.usageEvents[0]).toMatchObject({ status: 'failed', errorCode: 'AI_STRUCTURED_OUTPUT_INVALID' });
    });

    it('validates a response the adapter left unparsed (a truncated answer)', async () => {
      const h = createAiRuntimeHarness({
        fake: { responses: [{ outputText: '{"city": "Li', finishReason: 'length' }] },
      });

      const code = await codeOf(
        h.ai.forUser(HARNESS_USER).respondStructured({ model: HARNESS_MODEL, input: 'x', schema }),
      );

      expect(code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
      // The round-trip happened: the failed row keeps the billed tokens.
      expect(h.usageEvents[0]).toMatchObject({ status: 'failed', errorCode: 'AI_STRUCTURED_OUTPUT_INVALID' });
      expect(h.usageEvents[0].outputTokens).toEqual(expect.any(Number));
    });
  });

  describe('streaming', () => {
    it('streams well-ordered events whose deltas equal the final text, with one usage row', async () => {
      const h = createAiRuntimeHarness({ fake: { responses: [{ outputText: 'Hello, streaming world' }] } });

      const events = await collect(h.ai.forUser(HARNESS_USER).stream(hello));

      expect(events[0].type).toBe('response.created');
      expect(events.at(-1)?.type).toBe('response.completed');
      const text = events
        .filter((e): e is Extract<AiStreamEvent, { type: 'output_text.delta' }> => e.type === 'output_text.delta')
        .map((e) => e.delta)
        .join('');
      expect(text).toBe('Hello, streaming world');
      expect(h.fake.callsTo('responses.stream')).toHaveLength(1);
      expect(h.usageEvents).toHaveLength(1);
      expect(h.usageEvents[0]).toMatchObject({ status: 'succeeded', keySource: 'user' });
    });

    it('openStream rejects gate failures before any event (an SSE route can still answer JSON)', async () => {
      const h = createAiRuntimeHarness({ userKey: false });

      await expect(h.ai.forUser(HARNESS_USER).openStream(hello)).rejects.toMatchObject({
        code: 'AI_KEY_REQUIRED',
      });
    });

    it('openStream rejects a provider refusal that happens before the stream starts', async () => {
      const h = createAiRuntimeHarness({ fake: { validKeys: ['some-other-key'] } });

      await expect(h.ai.forUser(HARNESS_USER).openStream(hello)).rejects.toMatchObject({
        code: 'AI_KEY_INVALID',
      });
      expect(h.usageEvents).toHaveLength(1);
      expect(h.usageEvents[0]).toMatchObject({ status: 'failed', errorCode: 'AI_KEY_INVALID' });
    });

    it('a consumer that stops early records a cancelled usage row', async () => {
      const h = createAiRuntimeHarness({ fake: { responses: [{ outputText: 'a long answer indeed' }] } });

      for await (const event of h.ai.forUser(HARNESS_USER).stream(hello)) {
        if (event.type === 'output_text.delta') break;
      }

      expect(h.usageEvents).toHaveLength(1);
      expect(h.usageEvents[0]).toMatchObject({ status: 'cancelled' });
    });

    it('an aborted signal stops the provider call and records a cancelled row', async () => {
      const h = createAiRuntimeHarness({ fake: { delayMs: 20, responses: [{ outputText: 'x'.repeat(40) }] } });
      const controller = new AbortController();
      const stream = await h.ai.forUser(HARNESS_USER).openStream(hello, { signal: controller.signal });

      const consumed = (async () => {
        for await (const _event of stream) controller.abort();
      })();

      await expect(consumed).rejects.toBeInstanceOf(AiError);
      expect(h.fake.callsTo('responses.stream')[0].aborted).toBe(true);
      expect(h.usageEvents).toHaveLength(1);
      expect(h.usageEvents[0]).toMatchObject({ status: 'cancelled' });
    });
  });

  describe('respond — usage and failure', () => {
    it('a provider failure is an AiError, with one failed usage row carrying the code', async () => {
      const h = createAiRuntimeHarness({
        fake: {
          responses: () => {
            throw new AiError('AI_RATE_LIMITED', 'Slow down.', { retryAfterMs: 1_000 });
          },
        },
      });

      expect(await codeOf(h.ai.forUser(HARNESS_USER).respond(hello))).toBe('AI_RATE_LIMITED');
      expect(h.usageEvents).toEqual([
        expect.objectContaining({ status: 'failed', errorCode: 'AI_RATE_LIMITED', keySource: 'user' }),
      ]);
    });

    it('a raw error from an adapter never escapes: it is wrapped', async () => {
      const h = createAiRuntimeHarness();
      h.fake.responses!.create = async () => {
        throw new TypeError('socket hang up');
      };

      expect(await codeOf(h.ai.forUser(HARNESS_USER).respond(hello))).toBe('AI_PROVIDER_UNAVAILABLE');
    });

    it('an already-aborted signal refuses the call without reaching the provider', async () => {
      const h = createAiRuntimeHarness();
      const controller = new AbortController();
      controller.abort();

      await expect(
        h.ai.forUser(HARNESS_USER).respond(hello, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(AiError);
      expect(h.fake.calls).toHaveLength(0);
    });

    it('never puts a key into an error, a usage row or a log line', async () => {
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const h = createAiRuntimeHarness({
        policy: { logPromptContent: true },
        fake: {
          responses: () => {
            throw new Error(`upstream said no to ${HARNESS_USER_KEY}`);
          },
        },
      });

      const error = await h.ai.forUser(HARNESS_USER).respond(hello).catch((e: unknown) => e);

      const logged = JSON.stringify(debug.mock.calls);
      debug.mockRestore();
      expect(JSON.stringify(error)).not.toContain(HARNESS_USER_KEY);
      expect((error as Error).message).not.toContain(HARNESS_USER_KEY);
      expect(JSON.stringify(h.usageEvents)).not.toContain(HARNESS_USER_KEY);
      expect(logged).not.toContain(HARNESS_USER_KEY);
    });
  });

  describe('prompt logging', () => {
    const secretPrompt = 'my private medical question';

    afterEach(() => jest.restoreAllMocks());

    it('never logs prompt text while ai.logPromptContent is off', async () => {
      const spies = (['log', 'debug', 'warn', 'verbose'] as const).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      );
      const h = createAiRuntimeHarness();

      await h.ai.forUser(HARNESS_USER).respond({ model: HARNESS_MODEL, input: secretPrompt });

      for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(secretPrompt);
    });

    it('logs it at debug level, truncated, when an admin turned it on', async () => {
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const h = createAiRuntimeHarness({ policy: { logPromptContent: true } });
      const long = `${secretPrompt} ${'x'.repeat(5_000)}`;

      await h.ai.forUser(HARNESS_USER).respond({ model: HARNESS_MODEL, input: long });

      const line = debug.mock.calls.map((c) => String(c[0])).find((m) => m.includes(secretPrompt));
      expect(line).toBeDefined();
      expect(line!.length).toBeLessThan(AI_PROMPT_LOG_MAX_CHARS + 200);
      expect(line).toContain('(truncated)');
    });
  });

  it('nothing under ai/runtime imports a provider SDK', () => {
    const dir = __dirname;
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /from\s+['"](openai|@anthropic-ai\/[^'"]+|@google\/genai(?:\/[^'"]+)?)['"]/.test(readFileSync(join(dir, file), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
