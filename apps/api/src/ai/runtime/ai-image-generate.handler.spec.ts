// =============================================================================
// AiImageGenerateHandler (issue #437) — the `ai.image.generate` job
// =============================================================================
//
// Over the #432 harness: the real facade and run state machine, the real
// AiOutputWriter over in-memory object storage (the "fake storage
// provider"), and `FakeAiProvider`'s images port.
// =============================================================================

import { Logger } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { AI_OUTPUTS_KEY_PREFIX } from '../../storage/storage-key-prefixes';
import { AiError } from '../core/ai-error';
import { aiOutputKeyPrefix } from '../storage/ai-output-writer';
import {
  createAiRuntimeHarness,
  HARNESS_IMAGE_MODEL,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';
import { AiImageGenerateHandler } from './ai-image-generate.handler';
import { AI_IMAGE_GENERATE_TYPE } from './ai-runs.service';
import type { AiImageRunOutput } from './ai-runtime.types';

function setup(opts: AiRuntimeHarnessOptions = {}) {
  const h = createAiRuntimeHarness(opts);
  const registry = new JobHandlerRegistry();
  const handler = new AiImageGenerateHandler(registry, h.ai, h.runs, h.outputs);
  const jobFor = (handle: { runId: string; jobId: string }) =>
    ({ id: handle.jobId, type: AI_IMAGE_GENERATE_TYPE, payload: { runId: handle.runId } }) as unknown as Job;
  const row = (runId: string) => h.runRows.find((r) => r.id === runId)!;
  const generate = (patch: Record<string, unknown> = {}) =>
    h.ai.forUser(HARNESS_USER).generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'a lighthouse', ...patch });

  return { h, handler, registry, jobFor, row, generate };
}

describe('AiImageGenerateHandler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('declaration', () => {
    it('self-registers under ai.image.generate', () => {
      const { handler, registry } = setup();

      handler.onModuleInit();

      expect(registry.get('ai.image.generate')).toBe(handler);
    });

    it("is server-only — a user's key must never leave the server", () => {
      const { handler, registry } = setup();
      handler.onModuleInit();
      const asHandler: JobHandler = handler;

      expect(asHandler.nodeResultSchema).toBeUndefined();
      expect(asHandler.persistNodeResult).toBeUndefined();
      expect(asHandler.nodeSecretBroker).toBeUndefined();
      expect(registry.serverOnlyTypes()).toContain('ai.image.generate');
    });

    it('declares the ten-minute, single-attempt profile', () => {
      expect(setup().handler.profile).toEqual({ maxRuntimeMs: 10 * 60_000, maxAttempts: 1 });
    });
  });

  describe('a generation', () => {
    it('stores every image as a storage object the user owns and completes the run with their ids', async () => {
      const { h, handler, jobFor, row, generate } = setup();
      const handle = await generate({ n: 2, outputFormat: 'webp' });

      await handler.process(jobFor(handle));

      const run = row(handle.runId);
      const output = run.output as AiImageRunOutput;

      expect(run.status).toBe('succeeded');
      expect(output).toEqual({
        type: 'images',
        provider: 'openai',
        model: HARNESS_IMAGE_MODEL,
        storageObjectIds: [expect.any(String), expect.any(String)],
        images: [
          { storageObjectId: output.storageObjectIds[0], mimeType: 'image/webp', size: expect.any(Number) },
          { storageObjectId: output.storageObjectIds[1], mimeType: 'image/webp', size: expect.any(Number) },
        ],
        usage: { inputTokens: 3 },
      });

      expect(h.storage.objects.map((o) => o.id)).toEqual(output.storageObjectIds);

      for (const object of h.storage.objects) {
        expect(object).toMatchObject({ uploadedById: HARNESS_USER, status: 'ready', mimeType: 'image/webp' });
        expect(object.storageKey.startsWith(aiOutputKeyPrefix(HARNESS_USER, handle.runId))).toBe(true);
        expect(object.storageKey.startsWith(AI_OUTPUTS_KEY_PREFIX)).toBe(true);
        expect(object.name).toMatch(/^ai-image-\d\.webp$/);
      }

      // Bytes live in storage, never in the run row.
      expect(JSON.stringify(run)).not.toContain(Buffer.from(h.storage.blobs.values().next().value!).toString('base64'));
      expect(h.fake.apiKeys).toEqual([HARNESS_USER_KEY]);
      expect(h.usageEvents).toEqual([
        expect.objectContaining({ operation: 'images', units: { images: 2 }, jobId: handle.jobId, status: 'succeeded' }),
      ]);
    });

    it('checks storage BEFORE the provider call: unconfigured storage fails the run AI_STORAGE_UNAVAILABLE and nothing is billed', async () => {
      const { h, handler, jobFor, row, generate } = setup();
      const handle = await generate();

      h.storage.setConfigured(false);

      // Terminal (#509): no retry can configure storage, and a thrown 503 was
      // deferred as a provider throttle. The run carries the remedy.
      await expect(handler.process(jobFor(handle))).resolves.toBeUndefined();

      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_STORAGE_UNAVAILABLE' });
      expect(row(handle.runId).errorMessage).toContain('/admin/settings/storage');
      expect(h.fake.calls).toEqual([]);
      expect(h.usageEvents).toEqual([]);
    });

    it('a storage failure while writing fails the run AI_STORAGE_UNAVAILABLE and leaves no objects', async () => {
      const { h, handler, jobFor, row, generate } = setup();
      const handle = await generate({ n: 2 });
      const upload = h.storage.provider.upload as jest.Mock;
      const real = upload.getMockImplementation()!;

      upload.mockImplementationOnce(real).mockImplementationOnce(async () => {
        throw new Error('S3 said no');
      });

      await expect(handler.process(jobFor(handle))).resolves.toBeUndefined();

      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_STORAGE_UNAVAILABLE' });
      expect(h.storage.objects).toEqual([]);
      // The call happened and was billed: its usage row stays.
      expect(h.usageEvents).toEqual([expect.objectContaining({ status: 'succeeded', units: { images: 2 } })]);
    });

    it('an expected refusal (AI switched off) fails the run with the code, makes no call, and the job returns', async () => {
      const { h, handler, jobFor, row, generate } = setup();
      const handle = await generate();

      h.setPolicy({ enabled: false });

      await expect(handler.process(jobFor(handle))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_DISABLED' });
      expect(h.fake.calls).toEqual([]);
    });

    it('a provider throttle defers the job and puts the run back to pending', async () => {
      const { h, handler, jobFor, row, generate } = setup();
      const handle = await generate();

      h.fake.images!.generate = async () => {
        throw new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1234 });
      };

      const err = await handler.process(jobFor(handle)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RateLimitError);
      expect(row(handle.runId).status).toBe('pending');
    });

    it('an ai.limits refusal (#450) defers the job too — checked when the run executes', async () => {
      const { h, handler, jobFor, row, generate } = setup({
        policy: { limits: { perUser: { requestsPerDay: 1 } } },
      });
      const first = await generate();
      const second = await generate();

      await handler.process(jobFor(first));
      const err = await handler.process(jobFor(second)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RateLimitError);
      expect(row(first.runId).status).toBe('succeeded');
      expect(row(second.runId).status).toBe('pending');
      expect(h.fake.callsTo('images.generate')).toHaveLength(1);
    });

    it('a provider outage fails the run and the job throws', async () => {
      const { h, handler, jobFor, row, generate } = setup();
      const handle = await generate();

      h.fake.images!.generate = async () => {
        throw new Error('socket hang up');
      };

      await expect(handler.process(jobFor(handle))).rejects.toBeDefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
      expect(h.storage.objects).toEqual([]);
    });
  });

  describe('an edit', () => {
    it("sends the user's image to the provider and stores the result", async () => {
      const { h, handler, jobFor, row } = setup();
      const source = h.storage.addObject({ uploadedById: HARNESS_USER, bytes: Buffer.from('original') });
      const handle = await h.ai
        .forUser(HARNESS_USER)
        .editImage({ model: HARNESS_IMAGE_MODEL, prompt: 'add a hat', imageStorageObjectIds: [source.id] });

      await handler.process(jobFor(handle));

      expect(row(handle.runId).status).toBe('succeeded');
      expect(h.fake.callsTo('images.edit')).toHaveLength(1);
      // The source plus one output.
      expect(h.storage.objects).toHaveLength(2);
      expect((row(handle.runId).output as AiImageRunOutput).storageObjectIds).not.toContain(source.id);
    });

    it('an input deleted since queueing fails the run AI_INVALID_REQUEST; the job returns, nothing is called', async () => {
      const { h, handler, jobFor, row } = setup();
      const source = h.storage.addObject({ uploadedById: HARNESS_USER });
      const handle = await h.ai
        .forUser(HARNESS_USER)
        .editImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x', imageStorageObjectIds: [source.id] });

      h.storage.objects.length = 0;

      await expect(handler.process(jobFor(handle))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_INVALID_REQUEST' });
      expect(h.fake.calls).toEqual([]);
    });
  });

  describe('cancellation', () => {
    it('a run cancelled before it starts is a no-op', async () => {
      const { h, handler, jobFor, row, generate } = setup();
      const handle = await generate();

      await h.runs.cancel(HARNESS_USER, handle.runId);
      await handler.process(jobFor(handle));

      expect(row(handle.runId).status).toBe('cancelled');
      expect(h.fake.calls).toEqual([]);
      expect(h.storage.objects).toEqual([]);
    });

    it('a cancel while the provider call runs aborts it and stores nothing', async () => {
      const { h, handler, jobFor, row, generate } = setup({ fake: { delayMs: 200 } });
      const handle = await generate();

      const running = handler.process(jobFor(handle));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await h.runs.cancel(HARNESS_USER, handle.runId);
      await running;

      expect(row(handle.runId).status).toBe('cancelled');
      expect(h.fake.callsTo('images.generate')[0].aborted).toBe(true);
      expect(h.storage.objects).toEqual([]);
      expect(h.usageEvents).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    });

    it('images written after a cancel won are discarded', async () => {
      const { h, handler, jobFor, row, generate } = setup();
      const handle = await generate();
      const write = h.outputs.write.bind(h.outputs);

      jest.spyOn(h.outputs, 'write').mockImplementation(async (opts) => {
        const stored = await write(opts);
        // The owner cancels between the write and `complete`, from another replica.
        h.runRows.find((r) => r.id === handle.runId)!.status = 'cancelled';
        return stored;
      });

      await handler.process(jobFor(handle));

      expect(row(handle.runId).status).toBe('cancelled');
      expect(h.storage.objects).toEqual([]);
    });
  });

  describe('bookkeeping', () => {
    it('a responses run handed to this job is failed as AI_INVALID_REQUEST', async () => {
      const { h, handler, row } = setup();
      const handle = await h.ai.forUser(HARNESS_USER).startRun({ model: 'fake-model', input: 'x' });

      await handler.process({ id: handle.jobId, payload: { runId: handle.runId } } as unknown as Job);

      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_INVALID_REQUEST' });
      expect(h.fake.calls).toEqual([]);
    });

    it('rejects a malformed payload', async () => {
      const { handler } = setup();

      await expect(handler.process({ id: 'j', payload: {} } as unknown as Job)).rejects.toThrow(/Invalid ai.image.generate payload/);
    });

    it('a job that settled failed while its run was active fails the run', async () => {
      const { handler, row, generate } = setup();
      const handle = await generate();

      await handler.onJobSettled({
        jobId: handle.jobId,
        type: AI_IMAGE_GENERATE_TYPE,
        succeeded: false,
        subjectType: 'ai_run',
        subjectId: handle.runId,
      } as JobSettledEvent);

      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
    });

    it('ignores other job types settling', async () => {
      const { handler, row, generate } = setup();
      const handle = await generate();

      await handler.onJobSettled({
        jobId: handle.jobId,
        type: 'ai.response.run',
        succeeded: false,
        subjectType: 'ai_run',
        subjectId: handle.runId,
      } as JobSettledEvent);

      expect(row(handle.runId).status).toBe('pending');
    });
  });
});
