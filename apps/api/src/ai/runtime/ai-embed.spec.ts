// =============================================================================
// AiService.embed (issue #440) — the embeddings facade: the same gate
// pipeline as `respond`, with `embeddings` as the one capability needed,
// synchronous, one `operation: 'embeddings'` usage row per round-trip.
// =============================================================================

import { Logger } from '@nestjs/common';

import { AiError, type AiErrorCode } from '../core/ai-error';
import { AI_EMBEDDINGS_MAX_INPUTS } from '../core/types/media.types';
import {
  createAiRuntimeHarness,
  HARNESS_EMBEDDING_MODEL,
  HARNESS_MODEL,
  HARNESS_ORG_KEY,
  HARNESS_USER,
  HARNESS_USER_KEY,
} from '../testing/ai-runtime-harness';
import { FAKE_EMBEDDING_MODEL_CAPABILITIES } from '../testing/fake-ai-provider';
import type { AiEmbedRequest } from './ai-runtime.types';

async function codeOf(promise: Promise<unknown>): Promise<AiErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);
    return (err as AiError).code;
  }
}

const embedReq = (input: string | string[], extra: Partial<AiEmbedRequest> = {}): AiEmbedRequest => ({
  model: HARNESS_EMBEDDING_MODEL,
  input,
  ...extra,
});

describe('AiService.embed', () => {
  describe('success', () => {
    it('returns one vector per input, in order, with dimensions', async () => {
      const h = createAiRuntimeHarness();

      const result = await h.ai.forUser(HARNESS_USER).embed(embedReq(['alpha', 'beta', 'gamma']));

      expect(result.provider).toBe('openai');
      expect(result.model).toBe(HARNESS_EMBEDDING_MODEL);
      expect(result.vectors).toHaveLength(3);
      expect(result.dimensions).toBe(8);
      expect(result.vectors.every((v) => v.length === 8)).toBe(true);

      const alone = await h.ai.forUser(HARNESS_USER).embed(embedReq('beta'));
      expect(alone.vectors).toEqual([result.vectors[1]]);
    });

    it('passes dimensions through and the adapter honours it', async () => {
      const h = createAiRuntimeHarness();

      const result = await h.ai.forUser(HARNESS_USER).embed(embedReq('x', { dimensions: 32 }));

      expect(h.fake.callsTo('embeddings.embed')[0].embeddingRequest).toMatchObject({ dimensions: 32 });
      expect(result.dimensions).toBe(32);
      expect(result.vectors[0]).toHaveLength(32);
    });

    it('hands the adapter named fields only, with the user key', async () => {
      const h = createAiRuntimeHarness();
      const req = { ...embedReq('x'), provider: 'openai', stray: 'must not travel' } as AiEmbedRequest;

      await h.ai.forUser(HARNESS_USER).embed(req);

      const [call] = h.fake.callsTo('embeddings.embed');
      expect(call.apiKey).toBe(HARNESS_USER_KEY);
      expect(call.embeddingRequest).toEqual({ model: HARNESS_EMBEDDING_MODEL, input: 'x' });
    });

    it('records one usage row: operation embeddings, input tokens, who paid', async () => {
      const h = createAiRuntimeHarness();

      await h.ai.forUser(HARNESS_USER).embed(embedReq(['12345678', '1234']));

      expect(h.usageEvents).toEqual([
        expect.objectContaining({
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: HARNESS_EMBEDDING_MODEL,
          operation: 'embeddings',
          keySource: 'user',
          inputTokens: 3,
          outputTokens: null,
          status: 'succeeded',
          errorCode: null,
          providerRequestId: expect.stringMatching(/^fake_req_/),
        }),
      ]);
    });

    it('accepts exactly AI_EMBEDDINGS_MAX_INPUTS inputs', async () => {
      const h = createAiRuntimeHarness();
      const batch = Array.from({ length: AI_EMBEDDINGS_MAX_INPUTS }, (_, i) => `text ${i}`);

      const result = await h.ai.forUser(HARNESS_USER).embed(embedReq(batch));

      expect(result.vectors).toHaveLength(AI_EMBEDDINGS_MAX_INPUTS);
    });
  });

  describe('request shape — AI_INVALID_REQUEST before any provider call or usage row', () => {
    it.each<[string, AiEmbedRequest]>([
      ['a batch over the limit', embedReq(Array.from({ length: AI_EMBEDDINGS_MAX_INPUTS + 1 }, () => 'x'))],
      ['an empty batch', embedReq([])],
      ['an empty string', embedReq('')],
      ['an empty string inside a batch', embedReq(['ok', ''])],
      ['dimensions of zero', embedReq('x', { dimensions: 0 })],
      ['fractional dimensions', embedReq('x', { dimensions: 1.5 })],
      ['no model', { input: 'x' } as AiEmbedRequest],
    ])('%s', async (_name, req) => {
      const h = createAiRuntimeHarness();

      expect(await codeOf(h.ai.forUser(HARNESS_USER).embed(req))).toBe('AI_INVALID_REQUEST');
      expect(h.fake.calls).toHaveLength(0);
      expect(h.usageEvents).toHaveLength(0);
    });

    it('the oversized-batch refusal tells the caller to chunk', async () => {
      const h = createAiRuntimeHarness();
      const err = (await h.ai
        .forUser(HARNESS_USER)
        .embed(embedReq(Array.from({ length: 300 }, () => 'x')))
        .catch((e: unknown) => e)) as AiError;

      expect(err.message).toMatch(/chunk/);
      expect(err.toJSON().details).toMatchObject({ inputs: 300, max: AI_EMBEDDINGS_MAX_INPUTS });
    });

    it('never falls back to ai.defaultModel — an embedding model must be named', async () => {
      const h = createAiRuntimeHarness({ defaultModel: { provider: 'openai', modelId: HARNESS_EMBEDDING_MODEL } });

      expect(await codeOf(h.ai.forUser(HARNESS_USER).embed({ input: 'x' } as AiEmbedRequest))).toBe(
        'AI_INVALID_REQUEST',
      );
    });
  });

  describe('gates', () => {
    it('a model without the embeddings capability is AI_CAPABILITY_UNSUPPORTED', async () => {
      const h = createAiRuntimeHarness();

      expect(await codeOf(h.ai.forUser(HARNESS_USER).embed(embedReq('x', { model: HARNESS_MODEL })))).toBe(
        'AI_CAPABILITY_UNSUPPORTED',
      );
      expect(h.fake.calls).toHaveLength(0);
    });

    it('a provider without an embeddings port is AI_CAPABILITY_UNSUPPORTED', async () => {
      const h = createAiRuntimeHarness({ fake: { embeddingsPort: false } });

      expect(await codeOf(h.ai.forUser(HARNESS_USER).embed(embedReq('x')))).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(h.fake.calls).toHaveLength(0);
    });

    it.each<[string, Parameters<typeof createAiRuntimeHarness>[0], AiErrorCode]>([
      ['the kill switch', { policy: { enabled: false } }, 'AI_DISABLED'],
      ['a disabled provider', { policy: { providerEnabled: false } }, 'AI_PROVIDER_DISABLED'],
      [
        'a model not enabled',
        {
          models: [{ modelId: HARNESS_EMBEDDING_MODEL, capabilities: FAKE_EMBEDDING_MODEL_CAPABILITIES, enabled: false }],
        },
        'AI_MODEL_NOT_ENABLED',
      ],
      ['no key under byok', { userKey: false, orgKey: true, policy: { keyPolicy: 'byok' } }, 'AI_KEY_REQUIRED'],
      ['a key that cannot reach the model', { reachable: [HARNESS_MODEL] }, 'AI_MODEL_NOT_REACHABLE'],
    ])('%s refuses before any provider call', async (_name, opts, code) => {
      const h = createAiRuntimeHarness(opts);

      expect(await codeOf(h.ai.forUser(HARNESS_USER).embed(embedReq('x')))).toBe(code);
      expect(h.fake.calls).toHaveLength(0);
      expect(h.usageEvents).toHaveLength(0);
    });

    it('byok_with_org_fallback and no user key: the org key pays, recorded keySource org', async () => {
      const h = createAiRuntimeHarness({ userKey: false, orgKey: true, policy: { keyPolicy: 'byok_with_org_fallback' } });

      await h.ai.forUser(HARNESS_USER).embed(embedReq('x'));

      expect(h.fake.apiKeys).toEqual([HARNESS_ORG_KEY]);
      expect(h.usageEvents[0]).toMatchObject({ operation: 'embeddings', keySource: 'org' });
    });
  });

  describe('failure', () => {
    it('a provider failure is an AiError with one failed usage row carrying the code', async () => {
      const h = createAiRuntimeHarness();
      h.fake.embeddings!.embed = async () => {
        throw new AiError('AI_RATE_LIMITED', 'Slow down.', { retryAfterMs: 1_000 });
      };

      expect(await codeOf(h.ai.forUser(HARNESS_USER).embed(embedReq('x')))).toBe('AI_RATE_LIMITED');
      expect(h.usageEvents).toEqual([
        expect.objectContaining({ operation: 'embeddings', status: 'failed', errorCode: 'AI_RATE_LIMITED' }),
      ]);
    });

    it('a raw adapter error never escapes: it is wrapped', async () => {
      const h = createAiRuntimeHarness();
      h.fake.embeddings!.embed = async () => {
        throw new TypeError('socket hang up');
      };

      expect(await codeOf(h.ai.forUser(HARNESS_USER).embed(embedReq('x')))).toBe('AI_PROVIDER_UNAVAILABLE');
    });

    it('an abort mid-call is recorded as cancelled', async () => {
      const h = createAiRuntimeHarness({ fake: { delayMs: 50 } });
      const controller = new AbortController();
      const pending = h.ai.forUser(HARNESS_USER).embed(embedReq('x'), { signal: controller.signal });

      setTimeout(() => controller.abort(), 5);

      await expect(pending).rejects.toBeInstanceOf(AiError);
      expect(h.fake.callsTo('embeddings.embed')[0].aborted).toBe(true);
      expect(h.usageEvents).toEqual([expect.objectContaining({ operation: 'embeddings', status: 'cancelled' })]);
    });
  });

  describe('logging', () => {
    const secret = 'my private diary entry';

    afterEach(() => jest.restoreAllMocks());

    it('never logs the input or the key while ai.logPromptContent is off', async () => {
      const spies = (['log', 'debug', 'warn', 'verbose'] as const).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      );
      const h = createAiRuntimeHarness();

      await h.ai.forUser(HARNESS_USER).embed(embedReq(secret));

      for (const spy of spies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(spy.mock.calls)).not.toContain(HARNESS_USER_KEY);
      }
    });

    it('logs the input at debug level when an admin turned prompt logging on — never the key', async () => {
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const h = createAiRuntimeHarness({ policy: { logPromptContent: true } });

      await h.ai.forUser(HARNESS_USER).embed(embedReq(secret));

      const logged = JSON.stringify(debug.mock.calls);
      expect(logged).toContain(secret);
      expect(logged).toContain('embeddings.create');
      expect(logged).not.toContain(HARNESS_USER_KEY);
    });
  });
});
