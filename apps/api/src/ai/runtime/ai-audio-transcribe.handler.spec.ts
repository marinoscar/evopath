// =============================================================================
// AiAudioTranscribeHandler (issue #438) — the `ai.audio.transcribe` job
// =============================================================================
//
// Over the #432 harness: the real facade and run state machine, the real
// storage input resolver over in-memory object storage, and
// `FakeAiProvider`'s audio port. Also pins the retry behaviour
// `AiMediaRunHandler` gives a multi-attempt media type.
// =============================================================================

import { Logger } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JOB_TYPE_LABELS } from '../../jobs/job-type-labels';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { AiError } from '../core/ai-error';
import {
  createAiRuntimeHarness,
  HARNESS_IMAGE_MODEL,
  HARNESS_TRANSCRIPTION_MODEL,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';
import { AiAudioTranscribeHandler } from './ai-audio-transcribe.handler';
import { AI_AUDIO_TRANSCRIBE_TYPE } from './ai-runs.service';
import type { AiTranscriptionRunOutput } from './ai-runtime.types';

const RECORDING = Buffer.from('a'.repeat(2500)); // 2.5 s from the fake

function setup(opts: AiRuntimeHarnessOptions = {}) {
  const h = createAiRuntimeHarness(opts);
  const registry = new JobHandlerRegistry();
  const handler = new AiAudioTranscribeHandler(registry, h.ai, h.runs);
  const jobFor = (handle: { runId: string; jobId: string }, attempts?: number) =>
    ({
      id: handle.jobId,
      type: AI_AUDIO_TRANSCRIBE_TYPE,
      payload: { runId: handle.runId },
      ...(attempts !== undefined ? { attempts } : {}),
    }) as unknown as Job;
  const row = (runId: string) => h.runRows.find((r) => r.id === runId)!;
  const recording = () =>
    h.storage.addObject({ uploadedById: HARNESS_USER, bytes: RECORDING, mimeType: 'audio/mp4', name: 'standup.m4a' });
  const transcribe = (patch: Record<string, unknown> = {}) =>
    h.ai.forUser(HARNESS_USER).transcribe({ storageObjectId: recording().id, model: HARNESS_TRANSCRIPTION_MODEL, ...patch });

  return { h, handler, registry, jobFor, row, transcribe };
}

describe('AiAudioTranscribeHandler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('declaration', () => {
    it('self-registers under ai.audio.transcribe, with a label', () => {
      const { handler, registry } = setup();

      handler.onModuleInit();

      expect(registry.get('ai.audio.transcribe')).toBe(handler);
      expect(JOB_TYPE_LABELS['ai.audio.transcribe']).toBe('AI audio transcription');
    });

    it("is server-only — a user's key must never leave the server", () => {
      const { handler, registry } = setup();
      handler.onModuleInit();
      const asHandler: JobHandler = handler;

      expect(asHandler.nodeResultSchema).toBeUndefined();
      expect(asHandler.persistNodeResult).toBeUndefined();
      expect(asHandler.nodeSecretBroker).toBeUndefined();
      expect(registry.serverOnlyTypes()).toContain('ai.audio.transcribe');
    });

    it('declares the fifteen-minute, two-attempt profile (transcription is idempotent)', () => {
      expect(setup().handler.profile).toEqual({ maxRuntimeMs: 15 * 60_000, maxAttempts: 2 });
    });
  });

  describe('a transcription', () => {
    it('completes the run with the transcript, writes nothing to storage, and records audioSeconds', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe({ language: 'en', timestampGranularities: ['segment'] });
      const objectsBefore = h.storage.objects.length;

      await handler.process(jobFor(handle, 1));

      const run = row(handle.runId);
      const output = run.output as AiTranscriptionRunOutput;

      expect(run.status).toBe('succeeded');
      expect(output).toEqual({
        type: 'transcription',
        provider: 'openai',
        model: HARNESS_TRANSCRIPTION_MODEL,
        storageObjectId: (run.request as { storageObjectId: string }).storageObjectId,
        text: 'fake transcript of 2500 bytes',
        language: 'en',
        durationSeconds: 2.5,
        segments: [{ startSeconds: 0, endSeconds: 2.5, text: 'fake transcript of 2500 bytes' }],
        usage: { outputTokens: expect.any(Number) },
      });
      expect(h.storage.objects).toHaveLength(objectsBefore);
      expect(h.storage.provider.upload).not.toHaveBeenCalled();
      expect(h.fake.apiKeys).toEqual([HARNESS_USER_KEY]);
      expect(h.usageEvents).toEqual([
        expect.objectContaining({
          operation: 'audio.transcribe',
          units: { audioSeconds: 2.5 },
          jobId: handle.jobId,
          status: 'succeeded',
        }),
      ]);
    });

    it('an expected refusal (AI switched off) fails the run, makes no call, and the job returns', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe();

      h.setPolicy({ enabled: false });

      await expect(handler.process(jobFor(handle, 1))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_DISABLED' });
      expect(h.fake.calls).toEqual([]);
    });

    it('a recording deleted since queueing fails the run AI_INVALID_REQUEST; the job returns, nothing is called', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe();

      h.storage.objects.length = 0;

      await expect(handler.process(jobFor(handle, 1))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_INVALID_REQUEST' });
      expect(h.fake.calls).toEqual([]);
    });

    // Issue #509: terminal on the FIRST attempt — no retry, and no rate-limit
    // deferral of the 503 it used to rethrow, can configure storage.
    it('unconfigured storage (the recording cannot be read) fails the run AI_STORAGE_UNAVAILABLE on attempt 1 of 2; the job returns', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe();
      const release = jest.spyOn(h.runs, 'release');

      h.storage.setConfigured(false);

      await expect(handler.process(jobFor(handle, 1))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_STORAGE_UNAVAILABLE' });
      expect(release).not.toHaveBeenCalled();
      expect(h.fake.calls).toEqual([]);
    });

    it('a provider throttle defers the job and puts the run back to pending', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe();

      h.fake.audio!.transcribe = async () => {
        throw new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1234 });
      };

      const err = await handler.process(jobFor(handle, 1)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RateLimitError);
      expect(row(handle.runId).status).toBe('pending');
    });
  });

  describe('retries (maxAttempts: 2)', () => {
    it('an outage on the first attempt releases the run to pending and the job throws, so the queue retries it', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe();
      const port = h.fake.audio!;
      const original = port.transcribe!;
      let calls = 0;

      port.transcribe = async (req, ctx) => {
        calls += 1;
        if (calls === 1) throw new Error('socket hang up');
        return original(req, ctx);
      };

      await expect(handler.process(jobFor(handle, 1))).rejects.toBeDefined();
      expect(row(handle.runId)).toMatchObject({ status: 'pending', errorCode: null });

      // The queue's retry: the same job, its second attempt.
      await handler.process(jobFor(handle, 2));

      expect(row(handle.runId).status).toBe('succeeded');
      expect(calls).toBe(2);
      expect(h.usageEvents.map((e) => e.status)).toEqual(['failed', 'succeeded']);
    });

    it('an outage on the last attempt fails the run and the job throws', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe();

      h.fake.audio!.transcribe = async () => {
        throw new Error('socket hang up');
      };

      await expect(handler.process(jobFor(handle, 2))).rejects.toBeDefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
    });

    it('an expected refusal is never retried, whatever attempts remain', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe();

      h.fake.audio!.transcribe = async () => {
        throw new AiError('AI_CONTENT_FILTERED', 'no');
      };

      await expect(handler.process(jobFor(handle, 1))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_CONTENT_FILTERED' });
    });

    it('a run left running under this job (its process died mid-call) is resumed by the next attempt', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe();

      // Attempt 1 claimed it, then the process died before it settled.
      await h.runs.claim(handle.runId, handle.jobId);

      await handler.process(jobFor(handle, 2));

      expect(row(handle.runId).status).toBe('succeeded');
    });

    it('a run running under ANOTHER job is left alone', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe();

      await h.runs.claim(handle.runId, '99999999-9999-4999-8999-999999999999');
      await handler.process(jobFor(handle, 2));

      expect(row(handle.runId).status).toBe('running');
      expect(h.fake.calls).toEqual([]);
    });
  });

  describe('cancellation', () => {
    it('a run cancelled before it starts is a no-op', async () => {
      const { h, handler, jobFor, row, transcribe } = setup();
      const handle = await transcribe();

      await h.runs.cancel(HARNESS_USER, handle.runId);
      await handler.process(jobFor(handle, 1));

      expect(row(handle.runId).status).toBe('cancelled');
      expect(h.fake.calls).toEqual([]);
    });

    it('a cancel while the provider call runs aborts it and keeps no transcript', async () => {
      const { h, handler, jobFor, row, transcribe } = setup({ fake: { delayMs: 200 } });
      const handle = await transcribe();

      const running = handler.process(jobFor(handle, 1));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await h.runs.cancel(HARNESS_USER, handle.runId);
      await running;

      expect(row(handle.runId)).toMatchObject({ status: 'cancelled', output: null });
      expect(h.fake.callsTo('audio.transcribe')[0].aborted).toBe(true);
      expect(h.usageEvents).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    });
  });

  describe('bookkeeping', () => {
    it('an image run handed to this job is failed as AI_INVALID_REQUEST', async () => {
      const { h, handler, row } = setup();
      const handle = await h.ai.forUser(HARNESS_USER).generateImage({ model: HARNESS_IMAGE_MODEL, prompt: 'x' });

      await handler.process({ id: handle.jobId, payload: { runId: handle.runId } } as unknown as Job);

      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_INVALID_REQUEST' });
      expect(h.fake.calls).toEqual([]);
    });

    it('rejects a malformed payload', async () => {
      const { handler } = setup();

      await expect(handler.process({ id: 'j', payload: {} } as unknown as Job)).rejects.toThrow(
        /Invalid ai.audio.transcribe payload/,
      );
    });

    it('a job that settled failed while its run was active fails the run', async () => {
      const { handler, row, transcribe } = setup();
      const handle = await transcribe();

      await handler.onJobSettled({
        jobId: handle.jobId,
        type: AI_AUDIO_TRANSCRIBE_TYPE,
        succeeded: false,
        subjectType: 'ai_run',
        subjectId: handle.runId,
      } as JobSettledEvent);

      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
      expect(row(handle.runId).errorMessage).toContain('transcription run');
    });

    it('ignores other job types settling', async () => {
      const { handler, row, transcribe } = setup();
      const handle = await transcribe();

      await handler.onJobSettled({
        jobId: handle.jobId,
        type: 'ai.image.generate',
        succeeded: false,
        subjectType: 'ai_run',
        subjectId: handle.runId,
      } as JobSettledEvent);

      expect(row(handle.runId).status).toBe('pending');
    });
  });
});
