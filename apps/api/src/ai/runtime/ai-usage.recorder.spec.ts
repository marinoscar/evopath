// =============================================================================
// AiUsageRecorder (issue #432) — one ai_usage_events row per provider
// round-trip, success and failure, with the right keySource.
// =============================================================================

import { Logger } from '@nestjs/common';

import { AiError } from '../core/ai-error';
import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_USER,
} from '../testing/ai-runtime-harness';
import { AiUsageRecorder } from './ai-usage.recorder';

describe('AiUsageRecorder', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes every accounted field', async () => {
    const create = jest.fn().mockResolvedValue({});
    const recorder = new AiUsageRecorder({ aiUsageEvent: { create } } as never);

    await recorder.record({
      userId: 'u1',
      provider: 'openai',
      modelId: 'gpt-x',
      operation: 'responses',
      keySource: 'org',
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5, cachedInputTokens: 2 },
      latencyMs: 123.6,
      status: 'succeeded',
      providerRequestId: 'req_1',
      jobId: 'job-1',
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        provider: 'openai',
        modelId: 'gpt-x',
        operation: 'responses',
        keySource: 'org',
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
        cachedInputTokens: 2,
        latencyMs: 124,
        status: 'succeeded',
        errorCode: null,
        providerRequestId: 'req_1',
        jobId: 'job-1',
      },
    });
  });

  it('stores missing or nonsensical token counts as null', async () => {
    const create = jest.fn().mockResolvedValue({});
    const recorder = new AiUsageRecorder({ aiUsageEvent: { create } } as never);

    await recorder.record({
      userId: null,
      provider: 'openai',
      modelId: 'm',
      operation: 'responses',
      keySource: 'user',
      usage: { inputTokens: Number.NaN, outputTokens: -1 },
      latencyMs: -5,
      status: 'failed',
      errorCode: 'AI_PROVIDER_UNAVAILABLE',
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedInputTokens: null,
      latencyMs: 0,
      errorCode: 'AI_PROVIDER_UNAVAILABLE',
      providerRequestId: null,
      jobId: null,
    });
  });

  it('writes units for a non-token-metered operation (#437), generic over the unit names', async () => {
    const create = jest.fn().mockResolvedValue({});
    const recorder = new AiUsageRecorder({ aiUsageEvent: { create } } as never);
    const base = {
      userId: 'u',
      provider: 'openai',
      modelId: 'm',
      keySource: 'user' as const,
      latencyMs: 1,
      status: 'succeeded' as const,
    };

    await recorder.record({ ...base, operation: 'images', units: { images: 2 } });
    await recorder.record({ ...base, operation: 'audio.transcribe', units: { audioSeconds: 31.4 } });
    await recorder.record({ ...base, operation: 'audio.speech', units: { characters: 1200 } });

    expect(create.mock.calls.map((call) => call[0].data.units)).toEqual([
      { images: 2 },
      { audioSeconds: 31.4 },
      { characters: 1200 },
    ]);
  });

  it('drops unusable unit values, and stores no units at all when none are left', async () => {
    const create = jest.fn().mockResolvedValue({});
    const recorder = new AiUsageRecorder({ aiUsageEvent: { create } } as never);
    const base = {
      userId: 'u',
      provider: 'openai',
      modelId: 'm',
      operation: 'images' as const,
      keySource: 'user' as const,
      latencyMs: 1,
      status: 'succeeded' as const,
    };

    await recorder.record({ ...base, units: { images: 2, bad: Number.NaN, negative: -1, inf: Infinity } });
    await recorder.record({ ...base, units: { bad: Number.NaN } });
    await recorder.record({ ...base, units: {} });

    expect(create.mock.calls[0][0].data.units).toEqual({ images: 2 });
    expect('units' in create.mock.calls[1][0].data).toBe(false);
    expect('units' in create.mock.calls[2][0].data).toBe(false);
  });

  it('never throws: a failed insert is logged, not propagated', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const recorder = new AiUsageRecorder({
      aiUsageEvent: { create: jest.fn().mockRejectedValue(new Error('db down')) },
    } as never);

    await expect(
      recorder.record({
        userId: 'u',
        provider: 'openai',
        modelId: 'm',
        operation: 'responses',
        keySource: 'user',
        latencyMs: 1,
        status: 'succeeded',
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  describe('through the facade: exactly one row per provider round-trip', () => {
    it('success — tokens, provider request id and keySource user', async () => {
      const h = createAiRuntimeHarness({
        fake: {
          responses: [
            {
              outputText: 'hi',
              usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 1 },
              providerRequestId: 'req_abc',
            },
          ],
        },
      });

      await h.ai.forUser(HARNESS_USER).respond({ model: HARNESS_MODEL, input: 'x' });

      expect(h.usageEvents).toHaveLength(1);
      expect(h.usageEvents[0]).toMatchObject({
        userId: HARNESS_USER,
        provider: 'openai',
        modelId: HARNESS_MODEL,
        operation: 'responses',
        keySource: 'user',
        inputTokens: 7,
        outputTokens: 3,
        reasoningTokens: 1,
        status: 'succeeded',
        errorCode: null,
        providerRequestId: 'req_abc',
        jobId: null,
      });
      expect(h.usageEvents[0].latencyMs).toEqual(expect.any(Number));
    });

    it('failure — status failed with the error code', async () => {
      const h = createAiRuntimeHarness({
        userKey: false,
        orgKey: true,
        policy: { keyPolicy: 'byok_with_org_fallback' },
        fake: {
          responses: () => {
            throw new AiError('AI_CONTENT_FILTERED', 'Filtered.');
          },
        },
      });

      await h.ai.forUser(HARNESS_USER).respond({ model: HARNESS_MODEL, input: 'x' }).catch(() => undefined);

      expect(h.usageEvents).toEqual([
        expect.objectContaining({ status: 'failed', errorCode: 'AI_CONTENT_FILTERED', keySource: 'org' }),
      ]);
    });

    it('a usage insert failure does not fail the response the user already paid for', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const h = createAiRuntimeHarness();
      h.prisma.aiUsageEvent.create.mockRejectedValueOnce(new Error('db down'));

      await expect(
        h.ai.forUser(HARNESS_USER).respond({ model: HARNESS_MODEL, input: 'x' }),
      ).resolves.toMatchObject({ outputText: 'fake: x' });
    });

    it('rows carry the job id when the call runs under a job', async () => {
      const h = createAiRuntimeHarness();

      await h.ai.forUser(HARNESS_USER, { jobId: 'job-42' }).respond({ model: HARNESS_MODEL, input: 'x' });

      expect(h.usageEvents[0]).toMatchObject({ jobId: 'job-42' });
    });
  });
});
