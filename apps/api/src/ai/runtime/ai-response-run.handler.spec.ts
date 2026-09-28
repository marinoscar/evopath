// =============================================================================
// AiResponseRunHandler + startRun (issue #432) — background runs
// =============================================================================

import { Logger } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { AiError } from '../core/ai-error';
import { defineTool } from '../core/tools';
import type { AiResponse } from '../core/types/responses.types';
import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_ORG_KEY,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../testing/fake-ai-provider';
import { AiResponseRunHandler } from './ai-response-run.handler';
import { AI_RESPONSE_RUN_TYPE } from './ai-runs.service';

function setup(opts: AiRuntimeHarnessOptions = {}) {
  const h = createAiRuntimeHarness(opts);
  const registry = new JobHandlerRegistry();
  const handler = new AiResponseRunHandler(registry, h.ai, h.runs, h.outputs);
  const jobFor = (handle: { runId: string; jobId: string }) =>
    ({ id: handle.jobId, type: AI_RESPONSE_RUN_TYPE, payload: { runId: handle.runId } }) as unknown as Job;
  const row = (runId: string) => h.runRows.find((r) => r.id === runId)!;

  return { h, handler, registry, jobFor, row };
}

describe('AiResponseRunHandler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('declaration', () => {
    it('self-registers under ai.response.run', () => {
      const { handler, registry } = setup();

      handler.onModuleInit();

      expect(registry.get('ai.response.run')).toBe(handler);
    });

    it("is server-only — a user's key must never leave the server", () => {
      const { handler, registry } = setup();
      handler.onModuleInit();
      const asHandler: JobHandler = handler;

      expect(asHandler.nodeResultSchema).toBeUndefined();
      expect(asHandler.persistNodeResult).toBeUndefined();
      expect(asHandler.nodeSecretBroker).toBeUndefined();
      expect(registry.serverOnlyTypes()).toContain('ai.response.run');
    });

    it('declares the thirty-minute, single-attempt profile', () => {
      expect(setup().handler.profile).toEqual({ maxRuntimeMs: 30 * 60_000, maxAttempts: 1 });
    });
  });

  describe('startRun', () => {
    it('gates the request, stores it without any key, and enqueues the job', async () => {
      const { h, row } = setup({ policy: { defaults: { maxOutputTokensCap: 256 } } });

      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'summarise' });

      expect(handle).toEqual({ runId: expect.any(String), jobId: expect.any(String) });
      expect(row(handle.runId)).toMatchObject({
        status: 'pending',
        userId: HARNESS_USER,
        provider: 'openai',
        modelId: HARNESS_MODEL,
        jobId: handle.jobId,
        request: { provider: 'openai', model: HARNESS_MODEL, input: 'summarise', maxOutputTokens: 256 },
      });
      const serialised = JSON.stringify(h.runRows) + JSON.stringify(h.enqueued);
      expect(serialised).not.toContain(HARNESS_USER_KEY);
      expect(serialised).not.toContain(HARNESS_ORG_KEY);
      expect(h.fake.calls).toHaveLength(0);
    });

    it('fails fast on a gate, creating nothing', async () => {
      const { h } = setup({ userKey: false });

      await expect(
        h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' }),
      ).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
      expect(h.runRows).toHaveLength(0);
      expect(h.enqueued).toHaveLength(0);
    });

    it('is refused when ai.defaults.allowBackgroundRuns is off', async () => {
      const { h } = setup({ policy: { defaults: { allowBackgroundRuns: false } } });

      await expect(
        h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
      expect(h.runRows).toHaveLength(0);
    });

    it('refuses function tools, which cannot survive the queue hop', async () => {
      const { h } = setup();
      const tool = defineTool({ name: 't', description: 't', parameters: z.object({}), execute: () => 1 });

      await expect(
        h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x', tools: [tool.tool] }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
      expect(h.runRows).toHaveLength(0);
    });
  });

  describe('process', () => {
    it('pending -> running -> succeeded with the output, usage row naming the job', async () => {
      const { h, handler, jobFor, row } = setup({
        fake: { responses: [{ outputText: 'the summary' }] },
      });
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'summarise' });
      let statusDuringCall: string | undefined;
      const create = h.fake.responses!.create;
      h.fake.responses!.create = async (req, ctx) => {
        statusDuringCall = row(handle.runId).status;
        return create(req, ctx);
      };

      await handler.process(jobFor(handle));

      expect(statusDuringCall).toBe('running');
      expect(row(handle.runId)).toMatchObject({
        status: 'succeeded',
        output: expect.objectContaining({ outputText: 'the summary' }),
        completedAt: expect.any(Date),
      });
      expect(h.fake.apiKeys).toEqual([HARNESS_USER_KEY]);
      expect(h.usageEvents).toEqual([expect.objectContaining({ jobId: handle.jobId, status: 'succeeded' })]);

      const view = await h.runs.get(HARNESS_USER, handle.runId);
      expect((view.output as AiResponse | null)?.outputText).toBe('the summary');
    });

    it('round-trips a structured-output schema through the queue', async () => {
      const { h, handler, jobFor, row } = setup({
        fake: { responses: [{ outputText: JSON.stringify({ title: 'T', tags: ['a'] }) }] },
      });
      const schema = z.object({ title: z.string(), tags: z.array(z.string()) });
      const handle = await h.ai.forUser(HARNESS_USER).startRun({
        model: HARNESS_MODEL,
        input: 'x',
        structuredOutput: { name: 'doc', schema },
      });

      await handler.process(jobFor(handle));

      expect(row(handle.runId)).toMatchObject({
        status: 'succeeded',
        output: expect.objectContaining({ parsed: { title: 'T', tags: ['a'] } }),
      });
    });

    it('a run cancelled before it starts never calls the provider', async () => {
      const { h, handler, jobFor, row } = setup();
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });

      await h.runs.cancel(HARNESS_USER, handle.runId);
      await handler.process(jobFor(handle));

      expect(h.fake.calls).toHaveLength(0);
      expect(h.usageEvents).toHaveLength(0);
      expect(row(handle.runId).status).toBe('cancelled');
    });

    it('a run cancelled while running aborts the provider call and stays cancelled', async () => {
      const { h, handler, jobFor, row } = setup({ fake: { delayMs: 5_000 } });
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });

      const processing = handler.process(jobFor(handle));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await h.runs.cancel(HARNESS_USER, handle.runId);
      await expect(processing).resolves.toBeUndefined();

      expect(h.fake.calls[0].aborted).toBe(true);
      expect(row(handle.runId).status).toBe('cancelled');
      expect(h.usageEvents).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    });

    describe('hosted image_generation outputs (#442)', () => {
      const imageRun = () =>
        setup({
          models: [
            {
              modelId: HARNESS_MODEL,
              capabilities: {
                ...FAKE_TEXT_MODEL_CAPABILITIES,
                capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'],
              },
            },
          ],
          policy: { hostedTools: { image_generation: true } },
          fake: {
            hostedTools: ['image_generation'],
            responses: () => ({
              output: [
                {
                  type: 'hosted_tool_call',
                  id: 'ig_1',
                  tool: 'image_generation',
                  status: 'completed',
                  result: { storageObjectId: null, mimeType: 'image/png', image: { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' } },
                },
              ],
            }),
          },
        });

      it('stores the image under the run id and records its object id in the output', async () => {
        const { h, handler, jobFor, row } = imageRun();
        const handle = await h.ai
          .forUser(HARNESS_USER)
          .startRun({ model: HARNESS_MODEL, input: 'draw', tools: [{ type: 'image_generation' }] });

        await handler.process(jobFor(handle));

        expect(h.storage.objects).toHaveLength(1);
        expect(h.storage.objects[0].storageKey.startsWith(`ai-outputs/${HARNESS_USER}/${handle.runId}/`)).toBe(true);
        const output = row(handle.runId).output as AiResponse;
        expect(output.output[0]).toMatchObject({ result: { storageObjectId: h.storage.objects[0].id } });
        expect(JSON.stringify(output)).not.toContain('"data"');
      });

      it('discards the stored image when the run was cancelled while it ran', async () => {
        const { h, handler, jobFor, row } = imageRun();
        const handle = await h.ai
          .forUser(HARNESS_USER)
          .startRun({ model: HARNESS_MODEL, input: 'draw', tools: [{ type: 'image_generation' }] });
        const create = h.fake.responses!.create;
        h.fake.responses!.create = async (req, ctx) => {
          const response = await create(req, ctx);
          await h.runs.cancel(HARNESS_USER, handle.runId);
          return response;
        };

        await handler.process(jobFor(handle));

        expect(row(handle.runId).status).toBe('cancelled');
        expect(h.storage.objects).toHaveLength(0);
      });
    });

    it('kill switch off at process time: run failed with AI_DISABLED, the job does NOT fail', async () => {
      const { h, handler, jobFor, row } = setup();
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });

      h.setPolicy({ enabled: false });

      await expect(handler.process(jobFor(handle))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_DISABLED' });
      expect(h.fake.calls).toHaveLength(0);
    });

    it('a rate limit defers the job (RateLimitError) and returns the run to pending', async () => {
      const { h, handler, jobFor, row } = setup({
        fake: {
          responses: () => {
            throw new AiError('AI_RATE_LIMITED', 'Slow down.', { retryAfterMs: 7_000 });
          },
        },
      });
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });

      const error = await handler.process(jobFor(handle)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(7_000);
      expect(row(handle.runId).status).toBe('pending');
    });

    it('an ai.limits refusal (#450) DEFERS the job with its retryAfterMs — the run is not failed', async () => {
      const { h, handler, jobFor, row } = setup({ policy: { limits: { perUser: { requestsPerMinute: 1 } } } });
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });

      // The user's one call this minute, made synchronously.
      await h.ai.forUser(HARNESS_USER).respond({ model: HARNESS_MODEL, input: 'first' });

      const error = await handler.process(jobFor(handle)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBeGreaterThanOrEqual(1_000);
      expect((error as RateLimitError).retryAfterMs).toBeLessThanOrEqual(60_000);
      expect(row(handle.runId)).toMatchObject({ status: 'pending', errorCode: null });
      // One provider call — the synchronous one; the run never reached it.
      expect(h.fake.calls).toHaveLength(1);
    });

    it('a provider outage fails the run AND the job (visible to operators)', async () => {
      const { h, handler, jobFor, row } = setup({
        fake: {
          responses: () => {
            throw new AiError('AI_PROVIDER_UNAVAILABLE', 'Down.');
          },
        },
      });
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });

      await expect(handler.process(jobFor(handle))).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
    });

    it("a rejected user key is the run's outcome, not an operator incident", async () => {
      const { h, handler, jobFor, row } = setup({ fake: { validKeys: ['another-key'] } });
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });

      await expect(handler.process(jobFor(handle))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_KEY_INVALID' });
    });

    it('is a no-op for a finished run, a missing run, and rejects a malformed payload', async () => {
      const { h, handler, jobFor } = setup();
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });

      await handler.process(jobFor(handle));
      await handler.process(jobFor(handle));
      expect(h.fake.calls).toHaveLength(1);

      await expect(
        handler.process(jobFor({ runId: '99999999-9999-4999-8999-999999999999', jobId: 'j' })),
      ).resolves.toBeUndefined();
      await expect(
        handler.process({ id: 'j', type: AI_RESPONSE_RUN_TYPE, payload: {} } as unknown as Job),
      ).rejects.toThrow(/Invalid ai.response.run payload/);
    });

    it('fails a run whose owner no longer exists without calling the provider', async () => {
      const { h, handler, jobFor, row } = setup();
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });
      row(handle.runId).userId = null;

      await handler.process(jobFor(handle));

      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_KEY_REQUIRED' });
      expect(h.fake.calls).toHaveLength(0);
    });
  });

  describe('job-settled safety net', () => {
    const settled = (jobId: string, runId: string, status: 'failed' | 'succeeded') =>
      new JobSettledEvent({
        id: jobId,
        type: AI_RESPONSE_RUN_TYPE,
        status,
        subjectType: 'ai_run',
        subjectId: runId,
      } as unknown as Job);

    it('fails a run its job abandoned (worker timeout, rate-limit budget spent)', async () => {
      const { h, handler, row } = setup();
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });

      await handler.onJobSettled(settled(handle.jobId, handle.runId, 'failed'));

      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
    });

    it('leaves finished runs and other job types alone', async () => {
      const { h, handler, row } = setup();
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: HARNESS_MODEL, input: 'x' });
      await h.runs.cancel(HARNESS_USER, handle.runId);

      await handler.onJobSettled(settled(handle.jobId, handle.runId, 'failed'));
      await handler.onJobSettled(settled(handle.jobId, handle.runId, 'succeeded'));

      expect(row(handle.runId).status).toBe('cancelled');
    });
  });
});
