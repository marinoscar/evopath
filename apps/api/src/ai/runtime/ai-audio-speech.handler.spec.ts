// =============================================================================
// AiAudioSpeechHandler (issue #439) — the `ai.audio.speech` job
// =============================================================================
//
// Over the #432 harness: the real facade and run state machine, the real
// AiOutputWriter over in-memory object storage, and `FakeAiProvider`'s
// audio port.
// =============================================================================

import { Logger } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JOB_TYPE_LABELS } from '../../jobs/job-type-labels';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { AI_OUTPUTS_KEY_PREFIX } from '../../storage/storage-key-prefixes';
import { AiError } from '../core/ai-error';
import { aiOutputKeyPrefix } from '../storage/ai-output-writer';
import {
  createAiRuntimeHarness,
  HARNESS_SPEECH_MODEL,
  HARNESS_TRANSCRIPTION_MODEL,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';
import { AiAudioSpeechHandler } from './ai-audio-speech.handler';
import { AI_AUDIO_SPEECH_TYPE } from './ai-runs.service';
import type { AiSpeechRunOutput } from './ai-runtime.types';

function setup(opts: AiRuntimeHarnessOptions = {}) {
  const h = createAiRuntimeHarness(opts);
  const registry = new JobHandlerRegistry();
  const handler = new AiAudioSpeechHandler(registry, h.ai, h.runs, h.outputs);
  const jobFor = (handle: { runId: string; jobId: string }, attempts?: number) =>
    ({
      id: handle.jobId,
      type: AI_AUDIO_SPEECH_TYPE,
      payload: { runId: handle.runId },
      ...(attempts !== undefined ? { attempts } : {}),
    }) as unknown as Job;
  const row = (runId: string) => h.runRows.find((r) => r.id === runId)!;
  const speak = (patch: Record<string, unknown> = {}) =>
    h.ai.forUser(HARNESS_USER).speak({ input: 'Your order has shipped.', model: HARNESS_SPEECH_MODEL, ...patch });

  return { h, handler, registry, jobFor, row, speak };
}

describe('AiAudioSpeechHandler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('declaration', () => {
    it('self-registers under ai.audio.speech, with a label', () => {
      const { handler, registry } = setup();

      handler.onModuleInit();

      expect(registry.get('ai.audio.speech')).toBe(handler);
      expect(JOB_TYPE_LABELS['ai.audio.speech']).toBe('AI speech synthesis');
    });

    it("is server-only — a user's key must never leave the server", () => {
      const { handler, registry } = setup();
      handler.onModuleInit();
      const asHandler: JobHandler = handler;

      expect(asHandler.nodeResultSchema).toBeUndefined();
      expect(asHandler.persistNodeResult).toBeUndefined();
      expect(asHandler.nodeSecretBroker).toBeUndefined();
      expect(registry.serverOnlyTypes()).toContain('ai.audio.speech');
    });

    it('declares the five-minute, two-attempt profile', () => {
      expect(setup().handler.profile).toEqual({ maxRuntimeMs: 5 * 60_000, maxAttempts: 2 });
    });
  });

  describe('a synthesis', () => {
    it('stores the audio as ONE storage object the user owns at ai-outputs/<user>/<run>/speech.<ext>, disclosed as AI-generated', async () => {
      const { h, handler, jobFor, row, speak } = setup();
      const handle = await speak({ voice: 'echo', format: 'wav' });

      await handler.process(jobFor(handle, 1));

      const run = row(handle.runId);
      const output = run.output as AiSpeechRunOutput;

      expect(run.status).toBe('succeeded');
      expect(output).toEqual({
        type: 'speech',
        provider: 'openai',
        model: HARNESS_SPEECH_MODEL,
        storageObjectId: expect.any(String),
        mimeType: 'audio/wav',
        size: Buffer.byteLength('FAKE-wav:echo:Your order has shipped.'),
        format: 'wav',
        voice: 'echo',
        characters: 23,
        aiGenerated: true,
        usage: {},
      });

      expect(h.storage.objects).toHaveLength(1);

      const [object] = h.storage.objects;

      expect(object).toMatchObject({
        id: output.storageObjectId,
        uploadedById: HARNESS_USER,
        status: 'ready',
        mimeType: 'audio/wav',
        name: 'ai-speech.wav',
        metadata: {
          source: 'ai',
          runId: handle.runId,
          provider: 'openai',
          model: HARNESS_SPEECH_MODEL,
          voice: 'echo',
          aiGenerated: 'true',
        },
      });
      expect(object.storageKey).toBe(`${aiOutputKeyPrefix(HARNESS_USER, handle.runId)}speech.wav`);
      expect(object.storageKey.startsWith(AI_OUTPUTS_KEY_PREFIX)).toBe(true);
      expect(h.storage.blobs.get(object.storageKey)?.toString()).toBe('FAKE-wav:echo:Your order has shipped.');

      // Bytes live in storage, never in the run row.
      expect(JSON.stringify(run)).not.toContain('FAKE-wav');
      expect(h.fake.apiKeys).toEqual([HARNESS_USER_KEY]);
      expect(h.usageEvents).toEqual([
        expect.objectContaining({ operation: 'audio.speech', units: { characters: 23 }, jobId: handle.jobId, status: 'succeeded' }),
      ]);
    });

    it('mp3 is the default format', async () => {
      const { h, handler, jobFor, row, speak } = setup();
      const handle = await speak();

      await handler.process(jobFor(handle, 1));

      expect(row(handle.runId).output).toMatchObject({ format: 'mp3', mimeType: 'audio/mpeg', voice: 'alloy' });
      expect(h.storage.objects[0].storageKey.endsWith('/speech.mp3')).toBe(true);
    });

    it('checks storage BEFORE the provider call: unconfigured storage fails the run AI_STORAGE_UNAVAILABLE, nothing billed', async () => {
      const { h, handler, jobFor, row, speak } = setup();
      const handle = await speak();

      h.storage.setConfigured(false);

      await expect(handler.process(jobFor(handle, 2))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_STORAGE_UNAVAILABLE' });
      expect(row(handle.runId).errorMessage).toContain('/admin/settings/storage');
      expect(h.fake.calls).toEqual([]);
      expect(h.usageEvents).toEqual([]);
    });

    it('a storage failure while writing fails the run AI_STORAGE_UNAVAILABLE and leaves no object', async () => {
      const { h, handler, jobFor, row, speak } = setup();
      const handle = await speak();

      (h.storage.provider.upload as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('S3 said no');
      });

      await expect(handler.process(jobFor(handle, 2))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_STORAGE_UNAVAILABLE' });
      expect(h.storage.objects).toEqual([]);
      // The call happened and was billed: its usage row stays.
      expect(h.usageEvents).toEqual([expect.objectContaining({ status: 'succeeded', units: { characters: 23 } })]);
    });

    // Issue #509: AI_STORAGE_UNAVAILABLE is terminal. Before, the run was
    // released and the AiError (a 503) rethrown, and the queue deferred it as
    // a provider throttle up to JOBS_RATELIMIT_MAX_HITS times, never failing.
    it('unconfigured storage on attempt 1 of 2 fails the run at once: never released, never retried, the job returns', async () => {
      const { h, handler, jobFor, row, speak } = setup();
      const handle = await speak();
      const release = jest.spyOn(h.runs, 'release');
      const fail = jest.spyOn(h.runs, 'fail');

      h.storage.setConfigured(false);

      await expect(handler.process(jobFor(handle, 1))).resolves.toBeUndefined();
      expect(fail).toHaveBeenCalledWith(handle.runId, 'AI_STORAGE_UNAVAILABLE', expect.stringContaining('/admin/settings/storage'));
      expect(release).not.toHaveBeenCalled();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_STORAGE_UNAVAILABLE' });
      expect(h.fake.calls).toEqual([]);
    });

    it('an expected refusal (AI switched off) fails the run with the code, makes no call, and the job returns', async () => {
      const { h, handler, jobFor, row, speak } = setup();
      const handle = await speak();

      h.setPolicy({ enabled: false });

      await expect(handler.process(jobFor(handle, 1))).resolves.toBeUndefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_DISABLED' });
      expect(h.fake.calls).toEqual([]);
    });

    it('a provider throttle defers the job and puts the run back to pending', async () => {
      const { h, handler, jobFor, row, speak } = setup();
      const handle = await speak();

      h.fake.audio!.speech = async () => {
        throw new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1234 });
      };

      const err = await handler.process(jobFor(handle, 1)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RateLimitError);
      expect(row(handle.runId).status).toBe('pending');
    });

    it('an outage on the first attempt is retried; on the last it fails the run', async () => {
      const { h, handler, jobFor, row, speak } = setup();
      const handle = await speak();

      h.fake.audio!.speech = async () => {
        throw new Error('socket hang up');
      };

      await expect(handler.process(jobFor(handle, 1))).rejects.toBeDefined();
      expect(row(handle.runId).status).toBe('pending');

      await expect(handler.process(jobFor(handle, 2))).rejects.toBeDefined();
      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
      expect(h.storage.objects).toEqual([]);
    });
  });

  describe('cancellation', () => {
    it('a run cancelled before it starts is a no-op', async () => {
      const { h, handler, jobFor, row, speak } = setup();
      const handle = await speak();

      await h.runs.cancel(HARNESS_USER, handle.runId);
      await handler.process(jobFor(handle, 1));

      expect(row(handle.runId).status).toBe('cancelled');
      expect(h.fake.calls).toEqual([]);
      expect(h.storage.objects).toEqual([]);
    });

    it('a cancel while the provider call runs aborts it and stores nothing', async () => {
      const { h, handler, jobFor, row, speak } = setup({ fake: { delayMs: 200 } });
      const handle = await speak();

      const running = handler.process(jobFor(handle, 1));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await h.runs.cancel(HARNESS_USER, handle.runId);
      await running;

      expect(row(handle.runId).status).toBe('cancelled');
      expect(h.fake.callsTo('audio.speech')[0].aborted).toBe(true);
      expect(h.storage.objects).toEqual([]);
    });

    it('audio written after a cancel won is discarded', async () => {
      const { h, handler, jobFor, row, speak } = setup();
      const handle = await speak();
      const write = h.outputs.write.bind(h.outputs);

      jest.spyOn(h.outputs, 'write').mockImplementation(async (opts) => {
        const stored = await write(opts);
        h.runRows.find((r) => r.id === handle.runId)!.status = 'cancelled';
        return stored;
      });

      await handler.process(jobFor(handle, 1));

      expect(row(handle.runId).status).toBe('cancelled');
      expect(h.storage.objects).toEqual([]);
    });
  });

  describe('bookkeeping', () => {
    it('a transcription run handed to this job is failed as AI_INVALID_REQUEST', async () => {
      const { h, handler, row } = setup();
      const recording = h.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'audio/mpeg' });
      const handle = await h.ai
        .forUser(HARNESS_USER)
        .transcribe({ storageObjectId: recording.id, model: HARNESS_TRANSCRIPTION_MODEL });

      await handler.process({ id: handle.jobId, payload: { runId: handle.runId } } as unknown as Job);

      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_INVALID_REQUEST' });
      expect(h.fake.calls).toEqual([]);
    });

    it('rejects a malformed payload', async () => {
      const { handler } = setup();

      await expect(handler.process({ id: 'j', payload: { runId: 'nope' } } as unknown as Job)).rejects.toThrow(
        /Invalid ai.audio.speech payload/,
      );
    });

    it('a job that settled failed while its run was active fails the run', async () => {
      const { handler, row, speak } = setup();
      const handle = await speak();

      await handler.onJobSettled({
        jobId: handle.jobId,
        type: AI_AUDIO_SPEECH_TYPE,
        succeeded: false,
        subjectType: 'ai_run',
        subjectId: handle.runId,
      } as JobSettledEvent);

      expect(row(handle.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
    });
  });
});
