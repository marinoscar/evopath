// =============================================================================
// AiService × ai.limits (issue #450) — where the limits sit in the gate
// pipeline, what counts, and the per-model output-token clamp
// =============================================================================

import { z } from 'zod';

import { AiError, type AiErrorCode } from '../core/ai-error';
import { defineTool } from '../core/tools';
import type { AiStreamEvent } from '../core/types/responses.types';
import {
  createAiRuntimeHarness,
  HARNESS_EMBEDDING_MODEL,
  HARNESS_IMAGE_MODEL,
  HARNESS_MODEL,
  HARNESS_ORG_KEY,
  HARNESS_USER,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';
import type { AiRequest } from './ai-runtime.types';

const hello: AiRequest = { model: HARNESS_MODEL, input: 'hello' };
const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);

function setup(opts: AiRuntimeHarnessOptions = {}) {
  let now = T0;
  const h = createAiRuntimeHarness({ ...opts, clock: () => now });

  return {
    h,
    client: h.ai.forUser(HARNESS_USER),
    advance(ms: number) {
      now += ms;
    },
  };
}

async function errorOf(promise: Promise<unknown>): Promise<AiError> {
  const err = await promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (e: unknown) => e,
  );

  expect(err).toBeInstanceOf(AiError);

  return err as AiError;
}

const codeOf = async (promise: Promise<unknown>): Promise<AiErrorCode> => (await errorOf(promise)).code;

async function collect(iterable: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('AiService rate limits (#450)', () => {
  describe('placement in the gate pipeline', () => {
    it('runs AFTER key resolution: a user with no key is told AI_KEY_REQUIRED, not AI_RATE_LIMITED', async () => {
      const t = setup({ userKey: false, policy: { limits: { perUser: { requestsPerMinute: 1 } } } });
      t.h.usageEvents.push({ userId: HARNESS_USER, keySource: 'user', createdAt: new Date(T0 - 1_000) });

      expect(await codeOf(t.client.respond(hello))).toBe('AI_KEY_REQUIRED');
    });

    it('runs after the model gates: an unknown model is AI_MODEL_NOT_ENABLED, whatever the limits', async () => {
      const t = setup({ policy: { limits: { perUser: { requestsPerMinute: 1 } } } });

      await t.client.respond(hello);

      expect(await codeOf(t.client.respond({ ...hello, model: 'missing' }))).toBe('AI_MODEL_NOT_ENABLED');
    });

    it('a refused call reaches no provider and records no usage row', async () => {
      const t = setup({ policy: { limits: { perUser: { requestsPerMinute: 2 } } } });

      await t.client.respond(hello);
      await t.client.respond(hello);
      const err = await errorOf(t.client.respond(hello));

      expect(err.code).toBe('AI_RATE_LIMITED');
      expect(err.retryAfterMs).toBe(60_000);
      expect(err.toJSON().details).toMatchObject({ limit: 'perUser.requestsPerMinute', max: 2 });
      expect(t.h.fake.calls).toHaveLength(2);
      expect(t.h.usageEvents).toHaveLength(2);
    });

    it('with no limits configured, no usage query is made at all', async () => {
      const t = setup();

      await t.client.respond(hello);
      await t.client.embed({ model: HARNESS_EMBEDDING_MODEL, input: 'x' });

      expect(t.h.prisma.aiUsageEvent.count).not.toHaveBeenCalled();
      expect(t.h.prisma.aiUsageEvent.aggregate).not.toHaveBeenCalled();
      expect(t.h.prisma.aiUsageEvent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('org-key limits', () => {
    const orgLimits = { orgKey: { requestsPerDayPerUser: 1 } };

    it('apply when the org key pays', async () => {
      const t = setup({
        userKey: false,
        orgKey: true,
        policy: { keyPolicy: 'byok_with_org_fallback', limits: orgLimits },
      });

      await t.client.respond(hello);
      const err = await errorOf(t.client.respond(hello));

      expect(err.code).toBe('AI_RATE_LIMITED');
      expect(err.toJSON().details).toMatchObject({ limit: 'orgKey.requestsPerDayPerUser', keySource: 'org' });
      expect(t.h.fake.apiKeys).toEqual([HARNESS_ORG_KEY]);
    });

    it("don't affect a user on their own key, under the same policy", async () => {
      const t = setup({
        orgKey: true,
        policy: { keyPolicy: 'byok_with_org_fallback', limits: orgLimits },
      });

      for (let i = 0; i < 3; i += 1) await t.client.respond(hello);

      expect(t.h.fake.calls).toHaveLength(3);
      expect(t.h.usageEvents.every((e) => e.keySource === 'user')).toBe(true);
    });
  });

  describe('what counts', () => {
    it('every entry point that calls a provider: respond, openStream, stream, embed', async () => {
      const t = setup({ policy: { limits: { perUser: { requestsPerMinute: 3 } } } });

      await t.client.respond(hello);
      await collect(await t.client.openStream(hello));
      await t.client.embed({ model: HARNESS_EMBEDDING_MODEL, input: 'x' });

      expect(await codeOf(t.client.openStream(hello))).toBe('AI_RATE_LIMITED');
      expect(await codeOf(collect(t.client.stream(hello)))).toBe('AI_RATE_LIMITED');
      expect(await codeOf(t.client.embed({ model: HARNESS_EMBEDDING_MODEL, input: 'x' }))).toBe('AI_RATE_LIMITED');
      expect(await codeOf(t.client.respondStructured({ ...hello, schema: z.object({}) }))).toBe('AI_RATE_LIMITED');
    });

    it('each step of a tool loop is one request', async () => {
      const tool = defineTool({
        name: 'noop',
        description: 'Does nothing.',
        parameters: z.object({}),
        execute: () => 'ok',
      });
      const t = setup({
        policy: { limits: { perUser: { requestsPerMinute: 2 } } },
        fake: {
          responses: [
            { output: [{ type: 'function_call', callId: 'a', name: 'noop', arguments: '{}' }] },
            { output: [{ type: 'function_call', callId: 'b', name: 'noop', arguments: '{}' }] },
            { outputText: 'done' },
          ],
        },
      });

      expect(await codeOf(t.client.runTools({ ...hello, tools: [tool] }))).toBe('AI_RATE_LIMITED');
      expect(t.h.fake.calls).toHaveLength(2);
    });

    it('enqueueing is not counted — a queued run is checked when it executes', async () => {
      const t = setup({ policy: { limits: { perUser: { requestsPerMinute: 1 } } } });

      await t.client.startRun(hello);
      await t.client.startRun(hello);
      await t.client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'a lighthouse' });

      expect(t.h.runRows).toHaveLength(3);
      expect(t.h.prisma.aiUsageEvent.count).not.toHaveBeenCalled();

      // …and still leaves the budget intact for a synchronous call.
      await expect(t.client.respond(hello)).resolves.toBeDefined();
    });

    it('media runs count when they execute', async () => {
      const t = setup({ policy: { limits: { perUser: { requestsPerMinute: 1 } } } });

      await t.client.respond(hello);
      const handle = await t.client.generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'a lighthouse' });
      const stored = t.h.runRows.find((r) => r.id === handle.runId)!.request;

      expect(await codeOf(t.h.ai.executeImageRun(HARNESS_USER, stored as never))).toBe('AI_RATE_LIMITED');
      expect(t.h.fake.callsTo('images.generate')).toHaveLength(0);
    });
  });

  describe('per-model maxOutputTokens', () => {
    const perModel = { [`openai:${HARNESS_MODEL}`]: { maxOutputTokens: 100 } };

    it('clamps a larger request, and bounds a request that named none', async () => {
      const t = setup({ policy: { limits: { perModel } } });

      await t.client.respond({ ...hello, maxOutputTokens: 4_096 });
      await t.client.respond(hello);
      await t.client.respond({ ...hello, maxOutputTokens: 40 });

      expect(t.h.fake.calls.map((c) => c.request?.maxOutputTokens)).toEqual([100, 100, 40]);
    });

    it('combines with the deployment cap — the smaller wins', async () => {
      const lower = setup({ policy: { limits: { perModel }, defaults: { maxOutputTokensCap: 64 } } });
      const higher = setup({ policy: { limits: { perModel }, defaults: { maxOutputTokensCap: 1_000 } } });

      await lower.client.respond({ ...hello, maxOutputTokens: 4_096 });
      await higher.client.respond({ ...hello, maxOutputTokens: 4_096 });

      expect(lower.h.fake.calls[0].request?.maxOutputTokens).toBe(64);
      expect(higher.h.fake.calls[0].request?.maxOutputTokens).toBe(100);
    });

    it('leaves other models alone', async () => {
      const t = setup({ policy: { limits: { perModel: { 'openai:some-other-model': { maxOutputTokens: 5 } } } } });

      await t.client.respond({ ...hello, maxOutputTokens: 4_096 });
      await t.client.respond(hello);

      expect(t.h.fake.calls.map((c) => c.request?.maxOutputTokens)).toEqual([4_096, undefined]);
    });

    it('is stored with a background run and applied again when it executes', async () => {
      const t = setup({ policy: { limits: { perModel } } });

      const handle = await t.client.startRun({ ...hello, maxOutputTokens: 4_096 });

      expect(t.h.runRows.find((r) => r.id === handle.runId)!.request).toMatchObject({ maxOutputTokens: 100 });
    });
  });
});
