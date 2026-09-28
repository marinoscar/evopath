// The OpenAI speech port (issue #439): the adapter against the mocked
// transport (the real SDK builds the JSON request and hands back the binary
// body), the mapper's pure edge cases, and the classifier's voices.

import { AiError } from '../../core/ai-error';
import { aiModelCapabilitiesSchema } from '../../core/capabilities';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import { OpenAiClientFactory } from './openai-client.factory';
import { fromOpenAiSpeechResponse, isOpenAiTts1, toOpenAiSpeechRequest } from './openai-audio.mapper';
import { classifyOpenAiModel, OPENAI_SPEECH_VOICES, OPENAI_TTS1_VOICES } from './openai-model-catalog';
import { OpenAiProviderAdapter } from './openai.adapter';
import { mockSpeechBytes, OpenAiMockServer } from './testing/openai-mock-transport';

const VALID_KEY = 'sk-proj-SPEECH-valid-abcdefghijk';
const INVALID_KEY = 'sk-proj-SPEECH-revoked-lmnopqrs';

function setup() {
  const server = new OpenAiMockServer({ validKeys: [VALID_KEY] });
  const adapter = new OpenAiProviderAdapter(new AiProviderRegistry(), new OpenAiClientFactory({ fetch: server.fetch }));
  const ctx: AiCallContext = { apiKey: VALID_KEY, requestId: 'req-speech-1' };

  return { server, adapter, ctx };
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

describe('OpenAI audio port (speech)', () => {
  it('is carried with speech and the static voice list — presence is the declaration', () => {
    const { adapter } = setup();

    expect(typeof adapter.audio.speech).toBe('function');
    expect(adapter.audio.voices).toEqual(OPENAI_SPEECH_VOICES);
    expect(adapter.audio.voices).toEqual(expect.arrayContaining(['alloy', 'coral', 'marin', 'cedar']));
  });

  describe('speech', () => {
    it('POSTs /v1/audio/speech as JSON with the key and answers the audio bytes, typed by format', async () => {
      const { adapter, ctx, server } = setup();

      const result = await adapter.audio.speech!(
        {
          model: 'gpt-4o-mini-tts',
          input: 'Welcome aboard.',
          voice: 'coral',
          format: 'wav',
          instructions: 'Cheerful and brisk.',
          speed: 1.25,
        },
        ctx,
      );

      const [req] = server.requestsTo('/v1/audio/speech');

      expect(req.method).toBe('POST');
      expect(req.apiKey).toBe(VALID_KEY);
      expect(req.body).toEqual({
        model: 'gpt-4o-mini-tts',
        input: 'Welcome aboard.',
        voice: 'coral',
        response_format: 'wav',
        instructions: 'Cheerful and brisk.',
        speed: 1.25,
      });

      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o-mini-tts');
      expect(result.audio.mimeType).toBe('audio/wav');
      expect(Buffer.from(result.audio.data).equals(mockSpeechBytes(req.body!))).toBe(true);
      expect(result.usage).toEqual({});
      expect(result.providerRequestId).toBe('req_mock_1');
    });

    it('defaults to mp3 and drops instructions for the tts-1 family, which rejects them', async () => {
      const { adapter, ctx, server } = setup();

      const result = await adapter.audio.speech!(
        { model: 'tts-1-hd', input: 'Hi.', voice: 'alloy', instructions: 'whisper it' },
        ctx,
      );

      expect(server.requestsTo('/v1/audio/speech')[0].body).toEqual({
        model: 'tts-1-hd',
        input: 'Hi.',
        voice: 'alloy',
        response_format: 'mp3',
      });
      expect(result.audio.mimeType).toBe('audio/mpeg');
    });

    it.each([
      ['more than 4096 characters', { input: 'x'.repeat(4097) }],
      ['an empty input', { input: '   ' }],
      ['an empty voice', { voice: '' }],
      ['a speed of 5', { speed: 5 }],
      ['a speed of 0.1', { speed: 0.1 }],
    ])('%s is AI_INVALID_REQUEST without calling OpenAI', async (_name, patch) => {
      const { adapter, ctx, server } = setup();

      const err = await caught(() =>
        adapter.audio.speech!({ model: 'gpt-4o-mini-tts', input: 'Hi.', voice: 'alloy', ...patch }, ctx),
      );

      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(server.requests).toEqual([]);
    });

    it('exactly 4096 characters is accepted', async () => {
      const { adapter, ctx } = setup();

      await expect(
        adapter.audio.speech!({ model: 'gpt-4o-mini-tts', input: 'x'.repeat(4096), voice: 'alloy' }, ctx),
      ).resolves.toMatchObject({ provider: 'openai' });
    });

    it('maps a rejected key to AI_KEY_INVALID, never echoing it', async () => {
      const { adapter } = setup();

      const err = await caught(() =>
        adapter.audio.speech!({ model: 'tts-1', input: 'Hi.', voice: 'alloy' }, { apiKey: INVALID_KEY, requestId: 'r' }),
      );

      expect(err.code).toBe('AI_KEY_INVALID');
      expect(JSON.stringify(err)).not.toContain(INVALID_KEY);
      expect(err.message).not.toContain(INVALID_KEY);
    });

    it.each([
      [400, { message: "Invalid value for 'voice'.", type: 'invalid_request_error', param: 'voice', code: null }, 'AI_INVALID_REQUEST'],
      [404, { message: 'The model does not exist.', type: 'invalid_request_error', param: 'model', code: 'model_not_found' }, 'AI_MODEL_NOT_REACHABLE'],
      [429, { message: 'Rate limit reached.', type: 'requests', param: null, code: 'rate_limit_exceeded' }, 'AI_RATE_LIMITED'],
      [500, { message: 'The server had an error.', type: 'server_error', param: null, code: null }, 'AI_PROVIDER_UNAVAILABLE'],
    ])('maps an HTTP %s to its AiError code', async (status, error, code) => {
      const { adapter, ctx, server } = setup();

      server.speechWith(() => ({ kind: 'error', status, error }));

      const err = await caught(() => adapter.audio.speech!({ model: 'tts-1', input: 'Hi.', voice: 'alloy' }, ctx));

      expect(err.code).toBe(code);
    });

    it('an empty body is a malformed-response AI_PROVIDER_UNAVAILABLE', async () => {
      const { adapter, ctx, server } = setup();

      server.speechWith(() => ({ kind: 'speech', bytes: Buffer.alloc(0) }));

      const err = await caught(() => adapter.audio.speech!({ model: 'tts-1', input: 'Hi.', voice: 'alloy' }, ctx));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ problem: 'empty_audio', providerRequestId: 'req_mock_1' });
    });

    it('a network failure is AI_PROVIDER_UNAVAILABLE, never a raw error', async () => {
      const { adapter, ctx, server } = setup();

      server.speechWith(() => ({ kind: 'network' }));

      const err = await caught(() => adapter.audio.speech!({ model: 'tts-1', input: 'Hi.', voice: 'alloy' }, ctx));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
    });
  });

  describe('mapper', () => {
    it('isOpenAiTts1 tells the families apart', () => {
      expect(isOpenAiTts1('tts-1')).toBe(true);
      expect(isOpenAiTts1('tts-1-hd-1106')).toBe(true);
      expect(isOpenAiTts1('gpt-4o-mini-tts')).toBe(false);
    });

    it('merges providerOptions.openai under the port\'s own fields', () => {
      expect(
        toOpenAiSpeechRequest({
          model: 'gpt-4o-mini-tts',
          input: 'Hi.',
          voice: 'alloy',
          providerOptions: { openai: { stream_format: 'audio', voice: 'nope' } },
        }),
      ).toEqual({ stream_format: 'audio', model: 'gpt-4o-mini-tts', input: 'Hi.', voice: 'alloy', response_format: 'mp3' });
    });

    it.each([
      ['mp3', 'audio/mpeg'],
      ['opus', 'audio/opus'],
      ['aac', 'audio/aac'],
      ['flac', 'audio/flac'],
      ['pcm', 'audio/pcm'],
    ] as const)('format %s is stored as %s', (format, mimeType) => {
      const result = fromOpenAiSpeechResponse(new Uint8Array([1, 2, 3]), {
        request: { model: 'tts-1', input: 'x', voice: 'alloy', format },
      });

      expect(result.audio.mimeType).toBe(mimeType);
    });
  });

  describe('classifier voices (surfaced through GET /api/ai/models)', () => {
    it('tts-1 and tts-1-hd speak the nine original voices', () => {
      for (const id of ['tts-1', 'tts-1-hd', 'tts-1-1106']) {
        const caps = classifyOpenAiModel(id);

        expect(caps?.capabilities).toEqual(['audio_speech']);
        expect(caps?.voices).toEqual([...OPENAI_TTS1_VOICES]);
        expect(caps?.voices).not.toContain('marin');
      }
    });

    it('the GPT-4o TTS family speaks every voice', () => {
      const caps = classifyOpenAiModel('gpt-4o-mini-tts-2025-12-15');

      expect(caps?.voices).toEqual([...OPENAI_SPEECH_VOICES]);
      expect(aiModelCapabilitiesSchema.safeParse(caps).success).toBe(true);
    });

    it('non-speech models carry no voices', () => {
      expect(classifyOpenAiModel('whisper-1')?.voices).toBeUndefined();
      expect(classifyOpenAiModel('gpt-4o')?.voices).toBeUndefined();
    });
  });
});
