// =============================================================================
// AiService — speech synthesis (issue #439)
// =============================================================================
//
// The facade's gate pipeline for `speak` (queue time) and `executeSpeechRun`
// (job time), over the #432 harness: the real AiService and its
// collaborators, `FakeAiProvider`'s audio port recording every call and key.
// =============================================================================

import { AiError } from '../core/ai-error';
import { FAKE_SPEECH_MODEL_CAPABILITIES } from '../testing/fake-ai-provider';
import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_ORG_KEY,
  HARNESS_SPEECH_MODEL,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';
import { parseStoredSpeechRunRequest } from './ai-audio-run-request';
import { AI_AUDIO_SPEECH_TYPE } from './ai-runs.service';

function setup(opts: AiRuntimeHarnessOptions = {}) {
  const h = createAiRuntimeHarness(opts);
  const client = h.ai.forUser(HARNESS_USER);
  const row = (runId: string) => h.runRows.find((r) => r.id === runId)!;

  return { h, client, row };
}

async function caught(run: () => Promise<unknown>): Promise<AiError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);

    return err as AiError;
  }

  throw new Error('expected an AiError');
}

describe('AiService — speech', () => {
  describe('speak (queue time)', () => {
    it('gates the request, stores it with the resolved voice and format, and enqueues ai.audio.speech', async () => {
      const { h, client, row } = setup();

      const handle = await client.speak({
        input: 'Your order has shipped.',
        model: HARNESS_SPEECH_MODEL,
        voice: 'echo',
        instructions: 'Warm.',
        speed: 1.5,
      });

      expect(row(handle.runId)).toMatchObject({
        status: 'pending',
        userId: HARNESS_USER,
        provider: 'openai',
        modelId: HARNESS_SPEECH_MODEL,
        jobId: handle.jobId,
        request: {
          operation: 'audio.speech',
          provider: 'openai',
          model: HARNESS_SPEECH_MODEL,
          input: 'Your order has shipped.',
          voice: 'echo',
          format: 'mp3',
          instructions: 'Warm.',
          speed: 1.5,
        },
      });
      expect(parseStoredSpeechRunRequest(row(handle.runId).request)).toBeDefined();
      expect(h.enqueued).toEqual([
        expect.objectContaining({ type: AI_AUDIO_SPEECH_TYPE, subjectType: 'ai_run', subjectId: handle.runId }),
      ]);
      expect(h.fake.calls).toEqual([]);
      expect(JSON.stringify(h.runRows)).not.toContain(HARNESS_USER_KEY);
    });

    it('omitted model and voice: the first usable audio_speech model, and the first voice it lists', async () => {
      const { client, row } = setup({ defaultModel: { provider: 'openai', modelId: HARNESS_MODEL } });

      const handle = await client.speak({ input: 'Hello.' });

      expect(row(handle.runId)).toMatchObject({ modelId: HARNESS_SPEECH_MODEL, request: { voice: 'alloy', format: 'mp3' } });
    });

    it("a model that lists no voices falls back to the port's own list", async () => {
      const { voices: _voices, ...noVoices } = FAKE_SPEECH_MODEL_CAPABILITIES;
      const { client, row } = setup({ models: [{ modelId: 'fake-speech-plain', capabilities: noVoices }] });

      const handle = await client.speak({ input: 'Hello.', voice: 'nova' });
      expect(row(handle.runId).request).toMatchObject({ voice: 'nova' });

      await expect(client.speak({ input: 'Hello.', voice: 'shimmer' })).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    });

    it("a voice the model does not speak is AI_INVALID_REQUEST, naming the model's voices", async () => {
      const { h, client } = setup();

      const err = await caught(() => client.speak({ input: 'Hello.', model: HARNESS_SPEECH_MODEL, voice: 'nova' }));

      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(err.toJSON().details).toMatchObject({ voice: 'nova', voices: ['alloy', 'echo'] });
      expect(h.runRows).toEqual([]);
    });

    it('a model without audio_speech is AI_CAPABILITY_UNSUPPORTED', async () => {
      const { h, client } = setup();

      await expect(client.speak({ input: 'Hello.', model: HARNESS_MODEL, voice: 'alloy' })).rejects.toMatchObject({
        code: 'AI_CAPABILITY_UNSUPPORTED',
      });
      expect(h.runRows).toEqual([]);
    });

    it('with no usable speech model and none named, it is AI_INVALID_REQUEST', async () => {
      const { client } = setup({ models: [{ modelId: HARNESS_MODEL }] });

      await expect(client.speak({ input: 'Hello.' })).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
    });

    it('is refused by the kill switch first', async () => {
      const { h, client } = setup({ policy: { enabled: false } });

      await expect(client.speak({ input: 'x'.repeat(5000) })).rejects.toMatchObject({ code: 'AI_DISABLED' });
      expect(h.runRows).toEqual([]);
    });

    it('needs a key: byok with no user key is AI_KEY_REQUIRED and the org key is never looked at', async () => {
      const { h, client } = setup({ userKey: false, orgKey: true });

      await expect(client.speak({ input: 'Hi.', model: HARNESS_SPEECH_MODEL })).rejects.toMatchObject({
        code: 'AI_KEY_REQUIRED',
      });
      expect(h.getSecret).not.toHaveBeenCalled();
    });

    it.each([
      ['more than 4096 characters', { input: 'x'.repeat(4097) }],
      ['an empty input', { input: '' }],
      ['a blank input', { input: '   ' }],
      ['an empty voice', { voice: '' }],
      ['an unknown format', { format: 'ogg' }],
      ['a speed of 4.5', { speed: 4.5 }],
      ['empty instructions', { instructions: '' }],
    ])('%s is AI_INVALID_REQUEST before any table is read, nothing queued', async (_name, patch) => {
      const { h, client } = setup();

      const err = await caught(() =>
        client.speak({ input: 'Hello.', model: HARNESS_SPEECH_MODEL, ...(patch as object) } as never),
      );

      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(h.runRows).toEqual([]);
      expect(h.fake.calls).toEqual([]);
    });

    it('exactly 4096 characters is accepted', async () => {
      const { client } = setup();

      await expect(client.speak({ input: 'x'.repeat(4096), model: HARNESS_SPEECH_MODEL })).resolves.toMatchObject({
        runId: expect.any(String),
      });
    });
  });

  describe('executeSpeechRun (job time)', () => {
    async function queued(t: ReturnType<typeof setup>, patch: Record<string, unknown> = {}) {
      const handle = await t.client.speak({ input: 'Hello there.', model: HARNESS_SPEECH_MODEL, ...patch });

      return parseStoredSpeechRunRequest(t.row(handle.runId).request);
    }

    it('calls the port with the stored request and the user key, and records characters usage', async () => {
      const t = setup();
      const stored = await queued(t, { voice: 'echo', format: 'flac', speed: 0.75, instructions: 'Slow.' });

      const result = await t.h.ai.executeSpeechRun(HARNESS_USER, stored, { jobId: 'job-9' });

      const [call] = t.h.fake.callsTo('audio.speech');

      expect(call.apiKey).toBe(HARNESS_USER_KEY);
      expect(call.speechRequest).toEqual({
        model: HARNESS_SPEECH_MODEL,
        input: 'Hello there.',
        voice: 'echo',
        format: 'flac',
        speed: 0.75,
        instructions: 'Slow.',
      });
      expect(result.audio.mimeType).toBe('audio/flac');
      expect(Buffer.from(result.audio.data).toString()).toBe('FAKE-flac:echo:Hello there.');
      expect(t.h.usageEvents).toEqual([
        expect.objectContaining({
          operation: 'audio.speech',
          keySource: 'user',
          units: { characters: 12 },
          status: 'succeeded',
          jobId: 'job-9',
        }),
      ]);
    });

    it('runs beforeCall after the gates and before the provider', async () => {
      const t = setup();
      const stored = await queued(t);
      const order: string[] = [];
      const port = t.h.fake.audio!;
      const original = port.speech!;

      port.speech = async (req, ctx) => {
        order.push('provider');
        return original(req, ctx);
      };

      try {
        await t.h.ai.executeSpeechRun(HARNESS_USER, stored, {
          beforeCall: async () => {
            order.push('beforeCall');
          },
        });
      } finally {
        port.speech = original;
      }

      expect(order).toEqual(['beforeCall', 'provider']);
    });

    it('re-runs the gates: a key removed since queueing is AI_KEY_REQUIRED and nobody is called', async () => {
      const t = setup();
      const stored = await queued(t);

      t.h.removeUserKeys(HARNESS_USER);

      await expect(t.h.ai.executeSpeechRun(HARNESS_USER, stored)).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
      expect(t.h.fake.calls).toEqual([]);
    });

    it('spends the org key under byok_with_org_fallback when the user has none', async () => {
      const t = setup({ userKey: false, orgKey: true, policy: { keyPolicy: 'byok_with_org_fallback' } });
      const stored = await queued(t);

      await t.h.ai.executeSpeechRun(HARNESS_USER, stored);

      expect(t.h.fake.apiKeys).toEqual([HARNESS_ORG_KEY]);
      expect(t.h.usageEvents).toEqual([expect.objectContaining({ keySource: 'org', operation: 'audio.speech' })]);
    });

    it('a provider failure is a failed usage row without units, rethrown as an AiError', async () => {
      const t = setup();
      const stored = await queued(t);
      const port = t.h.fake.audio!;
      const original = port.speech;

      port.speech = async () => {
        throw new Error('socket hang up');
      };

      try {
        await expect(t.h.ai.executeSpeechRun(HARNESS_USER, stored)).rejects.toBeInstanceOf(AiError);
      } finally {
        port.speech = original;
      }

      expect(t.h.usageEvents).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' })]);
      expect(t.h.usageEvents[0]).not.toHaveProperty('units');
    });
  });
});
