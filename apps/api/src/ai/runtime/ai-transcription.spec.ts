// =============================================================================
// AiService — transcription (issue #438)
// =============================================================================
//
// The facade's gate pipeline for `transcribe` (queue time) and
// `executeTranscriptionRun` (job time), over the #432 harness: the real
// AiService/AiConfigService/AiKeyResolver/UsableModelsService/
// AiUsageRecorder/AiRunsService/AiStorageInputResolver, `FakeAiProvider`'s
// audio port recording every call, key and byte, and in-memory storage.
// =============================================================================

import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AiError } from '../core/ai-error';
import { FAKE_TRANSCRIPTION_MODEL_CAPABILITIES } from '../testing/fake-ai-provider';
import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_ORG_KEY,
  HARNESS_OTHER_USER,
  HARNESS_TRANSCRIPTION_MODEL,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';
import { parseStoredTranscriptionRunRequest } from './ai-audio-run-request';
import { AI_AUDIO_TRANSCRIBE_TYPE } from './ai-runs.service';

const RECORDING = Buffer.from('0123456789'.repeat(150)); // 1500 bytes -> 1.5 s from the fake

function setup(opts: AiRuntimeHarnessOptions = {}) {
  const h = createAiRuntimeHarness(opts);
  const client = h.ai.forUser(HARNESS_USER);
  const row = (runId: string) => h.runRows.find((r) => r.id === runId)!;
  const recording = (patch: Partial<Parameters<typeof h.storage.addObject>[0]> = {}) =>
    h.storage.addObject({ uploadedById: HARNESS_USER, bytes: RECORDING, mimeType: 'audio/mpeg', name: 'memo.mp3', ...patch });

  return { h, client, row, recording };
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }

  throw new Error('expected a rejection');
}

describe('AiService — transcription', () => {
  describe('transcribe (queue time)', () => {
    it('gates the request, stores it with operation audio.transcribe and the object id only, and enqueues ai.audio.transcribe', async () => {
      const { h, client, row, recording } = setup();
      const object = recording();

      const handle = await client.transcribe({
        storageObjectId: object.id,
        model: HARNESS_TRANSCRIPTION_MODEL,
        language: 'en',
        prompt: 'Acme',
        timestampGranularities: ['segment'],
      });

      expect(row(handle.runId)).toMatchObject({
        status: 'pending',
        userId: HARNESS_USER,
        provider: 'openai',
        modelId: HARNESS_TRANSCRIPTION_MODEL,
        jobId: handle.jobId,
        request: {
          operation: 'audio.transcribe',
          provider: 'openai',
          model: HARNESS_TRANSCRIPTION_MODEL,
          storageObjectId: object.id,
          language: 'en',
          prompt: 'Acme',
          timestampGranularities: ['segment'],
        },
      });
      expect(parseStoredTranscriptionRunRequest(row(handle.runId).request)).toBeDefined();
      expect(h.enqueued).toEqual([
        expect.objectContaining({ type: AI_AUDIO_TRANSCRIBE_TYPE, subjectType: 'ai_run', subjectId: handle.runId }),
      ]);

      // Nothing was read, nobody was called, and no key is in the row.
      expect(h.storage.provider.download).not.toHaveBeenCalled();
      expect(h.fake.calls).toEqual([]);
      expect(JSON.stringify(h.runRows)).not.toContain(HARNESS_USER_KEY);
    });

    it('is not subject to allowBackgroundRuns (there is no synchronous form)', async () => {
      const { client, recording } = setup({ policy: { defaults: { allowBackgroundRuns: false } } });

      await expect(client.transcribe({ storageObjectId: recording().id })).resolves.toMatchObject({
        runId: expect.any(String),
      });
    });

    it('an omitted model is the first usable model declaring audio_transcription — never the chat default', async () => {
      const { client, row, recording } = setup({
        defaultModel: { provider: 'openai', modelId: HARNESS_MODEL },
        models: [
          { modelId: HARNESS_MODEL },
          { modelId: 'fake-transcription-b', capabilities: FAKE_TRANSCRIPTION_MODEL_CAPABILITIES },
          { modelId: 'fake-transcription-a', capabilities: FAKE_TRANSCRIPTION_MODEL_CAPABILITIES },
        ],
      });

      const handle = await client.transcribe({ storageObjectId: recording().id });

      expect(row(handle.runId).modelId).toBe('fake-transcription-a');
    });

    it('with no usable transcription model and none named, it is AI_INVALID_REQUEST', async () => {
      const { client, recording } = setup({ models: [{ modelId: HARNESS_MODEL }] });

      await expect(client.transcribe({ storageObjectId: recording().id })).rejects.toMatchObject({
        code: 'AI_INVALID_REQUEST',
      });
    });

    it('a model without audio_transcription is AI_CAPABILITY_UNSUPPORTED', async () => {
      const { h, client, recording } = setup();

      await expect(client.transcribe({ storageObjectId: recording().id, model: HARNESS_MODEL })).rejects.toMatchObject({
        code: 'AI_CAPABILITY_UNSUPPORTED',
      });
      expect(h.runRows).toEqual([]);
    });

    it('a provider without the transcribe method is AI_CAPABILITY_UNSUPPORTED, whatever the catalog says', async () => {
      const { h, client, recording } = setup({ fake: { audioPort: false } });

      await expect(client.transcribe({ storageObjectId: recording().id, model: HARNESS_TRANSCRIPTION_MODEL })).rejects.toMatchObject({
        code: 'AI_CAPABILITY_UNSUPPORTED',
      });
      expect(h.runRows).toEqual([]);
    });

    it('is refused by the kill switch before anything is read', async () => {
      const { h, client, recording } = setup({ policy: { enabled: false } });
      const object = recording();

      await expect(client.transcribe({ storageObjectId: object.id })).rejects.toMatchObject({ code: 'AI_DISABLED' });
      expect(h.storage.prisma.storageObject.findUnique).not.toHaveBeenCalled();
    });

    it('needs a key: byok with no user key is AI_KEY_REQUIRED and the org key is never looked at', async () => {
      const { h, client, recording } = setup({ userKey: false, orgKey: true });

      await expect(
        client.transcribe({ storageObjectId: recording().id, model: HARNESS_TRANSCRIPTION_MODEL }),
      ).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
      expect(h.getSecret).not.toHaveBeenCalled();
    });

    it("an unknown recording is a 404 and another user's a 403 — the storage API's own answers", async () => {
      const { h, client } = setup();
      const foreign = h.storage.addObject({ uploadedById: HARNESS_OTHER_USER, mimeType: 'audio/mpeg' });

      expect(
        await caught(() => client.transcribe({ storageObjectId: '33333333-3333-4333-8333-333333333333', model: HARNESS_TRANSCRIPTION_MODEL })),
      ).toBeInstanceOf(NotFoundException);
      expect(await caught(() => client.transcribe({ storageObjectId: foreign.id, model: HARNESS_TRANSCRIPTION_MODEL }))).toBeInstanceOf(
        ForbiddenException,
      );
      expect(h.runRows).toEqual([]);
    });

    it.each([
      ['a PDF', { mimeType: 'application/pdf' }],
      ['an image', { mimeType: 'image/png' }],
      ['a QuickTime video', { mimeType: 'video/quicktime' }],
      ['a pending upload', { status: 'pending' }],
      ['a file over the provider limit', { size: 25 * 1024 * 1024 + 1 }],
    ])('%s is AI_INVALID_REQUEST, nothing queued', async (_name, patch) => {
      const { h, client, recording } = setup();

      await expect(
        client.transcribe({ storageObjectId: recording(patch).id, model: HARNESS_TRANSCRIPTION_MODEL }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
      expect(h.runRows).toEqual([]);
    });

    it.each([['audio/mpeg'], ['audio/x-m4a'], ['audio/wav'], ['audio/ogg'], ['video/mp4'], ['video/webm']])(
      'accepts %s',
      async (mimeType) => {
        const { client, recording } = setup();

        await expect(
          client.transcribe({ storageObjectId: recording({ mimeType }).id, model: HARNESS_TRANSCRIPTION_MODEL }),
        ).resolves.toMatchObject({ runId: expect.any(String) });
      },
    );

    it('honours the port\'s own transcriptionMaxBytes', async () => {
      const { client, recording } = setup({ fake: { transcriptionMaxBytes: 1000 } });

      await expect(
        client.transcribe({ storageObjectId: recording().id, model: HARNESS_TRANSCRIPTION_MODEL }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    });

    it.each([
      ['an empty storageObjectId', { storageObjectId: '' }],
      ['a language that is not an ISO code', { language: 'English' }],
      ['an over-long prompt', { prompt: 'x'.repeat(4001) }],
      ['an empty prompt', { prompt: '' }],
      ['repeated granularities', { timestampGranularities: ['word', 'word'] }],
      ['an unknown granularity', { timestampGranularities: ['sentence'] }],
    ])('%s is AI_INVALID_REQUEST before any table is read', async (_name, patch) => {
      const { h, client, recording } = setup();
      const object = recording();

      const err = await caught(() =>
        client.transcribe({ storageObjectId: object.id, model: HARNESS_TRANSCRIPTION_MODEL, ...(patch as object) }),
      );

      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).code).toBe('AI_INVALID_REQUEST');
      expect(h.storage.prisma.storageObject.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('executeTranscriptionRun (job time)', () => {
    async function queued(h: ReturnType<typeof setup>, patch: Record<string, unknown> = {}) {
      const object = h.recording();
      const handle = await h.client.transcribe({ storageObjectId: object.id, model: HARNESS_TRANSCRIPTION_MODEL, ...patch });

      return { object, stored: parseStoredTranscriptionRunRequest(h.row(handle.runId).request), handle };
    }

    it('streams the recording to the port with the user key, and records audioSeconds usage', async () => {
      const t = setup();
      const { stored } = await queued(t, { language: 'de', timestampGranularities: ['segment', 'word'] });

      const result = await t.h.ai.executeTranscriptionRun(HARNESS_USER, stored, { jobId: 'job-1' });

      const [call] = t.h.fake.callsTo('audio.transcribe');

      expect(call.apiKey).toBe(HARNESS_USER_KEY);
      expect(call.transcriptionRequest).toMatchObject({
        model: HARNESS_TRANSCRIPTION_MODEL,
        language: 'de',
        timestampGranularities: ['segment', 'word'],
        audio: { mimeType: 'audio/mpeg', filename: 'memo.mp3', size: RECORDING.length, streamed: true },
      });
      expect(call.audioBytes!.equals(RECORDING)).toBe(true);

      expect(result).toMatchObject({ text: 'fake transcript of 1500 bytes', language: 'de', durationSeconds: 1.5 });
      expect(result.segments).toHaveLength(1);
      expect(result.words?.length).toBeGreaterThan(0);

      expect(t.h.usageEvents).toEqual([
        expect.objectContaining({
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: HARNESS_TRANSCRIPTION_MODEL,
          operation: 'audio.transcribe',
          keySource: 'user',
          units: { audioSeconds: 1.5 },
          status: 'succeeded',
          jobId: 'job-1',
        }),
      ]);
    });

    it('a row that does not know its size yet is read with the cap enforced BEFORE the call', async () => {
      const t = setup({ fake: { transcriptionMaxBytes: 1000 } });
      const object = t.recording({ size: 0 });
      const handle = await t.client.transcribe({ storageObjectId: object.id, model: HARNESS_TRANSCRIPTION_MODEL });
      const stored = parseStoredTranscriptionRunRequest(t.row(handle.runId).request);

      await expect(t.h.ai.executeTranscriptionRun(HARNESS_USER, stored)).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
      expect(t.h.fake.calls).toEqual([]);
      expect(t.h.usageEvents).toEqual([]);
    });

    it('a size-0 row within the cap is sent as bytes', async () => {
      const t = setup();
      const object = t.recording({ size: 0 });
      const handle = await t.client.transcribe({ storageObjectId: object.id, model: HARNESS_TRANSCRIPTION_MODEL });

      await t.h.ai.executeTranscriptionRun(HARNESS_USER, parseStoredTranscriptionRunRequest(t.row(handle.runId).request));

      const [call] = t.h.fake.callsTo('audio.transcribe');
      expect(call.transcriptionRequest?.audio.streamed).toBe(false);
      expect(call.audioBytes!.equals(RECORDING)).toBe(true);
    });

    it('a recording larger than its row claimed is stopped mid-stream and answered AI_INVALID_REQUEST', async () => {
      const t = setup({ fake: { transcriptionMaxBytes: 1000 } });
      // The row says 500 bytes (passes the queue-time check); storage holds 1500.
      const object = t.recording({ size: 500 });
      const handle = await t.client.transcribe({ storageObjectId: object.id, model: HARNESS_TRANSCRIPTION_MODEL });

      await expect(
        t.h.ai.executeTranscriptionRun(HARNESS_USER, parseStoredTranscriptionRunRequest(t.row(handle.runId).request)),
      ).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
      expect(t.h.usageEvents).toEqual([
        expect.objectContaining({ operation: 'audio.transcribe', status: 'failed', errorCode: 'AI_INVALID_REQUEST' }),
      ]);
    });

    it('re-runs every gate: a recording deleted since queueing is a 404, and nobody is called', async () => {
      const t = setup();
      const { stored } = await queued(t);

      t.h.storage.objects.length = 0;

      expect(await caught(() => t.h.ai.executeTranscriptionRun(HARNESS_USER, stored))).toBeInstanceOf(NotFoundException);
      expect(t.h.fake.calls).toEqual([]);
    });

    it('re-runs the kill switch', async () => {
      const t = setup();
      const { stored } = await queued(t);

      t.h.setPolicy({ enabled: false });

      await expect(t.h.ai.executeTranscriptionRun(HARNESS_USER, stored)).rejects.toMatchObject({ code: 'AI_DISABLED' });
      expect(t.h.fake.calls).toEqual([]);
    });

    it('spends the org key under byok_with_org_fallback when the user has none, and says so on the usage row', async () => {
      const t = setup({ userKey: false, orgKey: true, policy: { keyPolicy: 'byok_with_org_fallback' } });
      const { stored } = await queued(t);

      await t.h.ai.executeTranscriptionRun(HARNESS_USER, stored);

      expect(t.h.fake.apiKeys).toEqual([HARNESS_ORG_KEY]);
      expect(t.h.usageEvents).toEqual([expect.objectContaining({ keySource: 'org', operation: 'audio.transcribe' })]);
    });

    it('a provider failure is recorded as a failed usage row and rethrown as an AiError', async () => {
      const t = setup();
      const { stored } = await queued(t);
      const port = t.h.fake.audio!;
      const original = port.transcribe;

      port.transcribe = async () => {
        throw new Error('socket hang up');
      };

      try {
        const err = await caught(() => t.h.ai.executeTranscriptionRun(HARNESS_USER, stored));

        expect(err).toBeInstanceOf(AiError);
        expect(t.h.usageEvents).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' })]);
      } finally {
        port.transcribe = original;
      }
    });

    it('an aborted call is recorded as cancelled', async () => {
      const t = setup({ fake: { delayMs: 50 } });
      const { stored } = await queued(t);
      const controller = new AbortController();
      const pending = t.h.ai.executeTranscriptionRun(HARNESS_USER, stored, { signal: controller.signal });

      setTimeout(() => controller.abort(new Error('cancelled')), 5);

      await expect(pending).rejects.toBeInstanceOf(AiError);
      expect(t.h.usageEvents).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    });

    it('omits units when the provider reports no duration (a token-billed model)', async () => {
      const t = setup();
      const { stored } = await queued(t);
      const port = t.h.fake.audio!;
      const original = port.transcribe!;

      port.transcribe = async (req, ctx) => {
        const { durationSeconds: _d, ...rest } = await original(req, ctx);
        return rest;
      };

      try {
        await t.h.ai.executeTranscriptionRun(HARNESS_USER, stored);

        expect(t.h.usageEvents[0]).not.toHaveProperty('units');
      } finally {
        port.transcribe = original;
      }
    });
  });
});
