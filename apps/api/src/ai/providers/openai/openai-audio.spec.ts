// The OpenAI transcription port (issue #438): the adapter against the mocked
// transport (the real SDK builds the multipart request — streamed or not —
// and parses the reply), plus the mapper's pure edge cases.

import { AiError } from '../../core/ai-error';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import { OpenAiClientFactory } from './openai-client.factory';
import {
  fromOpenAiTranscriptionResponse,
  isOpenAiWhisper,
  OPENAI_TRANSCRIPTION_MAX_BYTES,
  openAiAudioFileName,
  toOpenAiTranscriptionRequest,
} from './openai-audio.mapper';
import { OpenAiProviderAdapter } from './openai.adapter';
import { MOCK_TRANSCRIPT, OpenAiMockServer } from './testing/openai-mock-transport';

const VALID_KEY = 'sk-proj-AUDIO-valid-abcdefghijklm';
const INVALID_KEY = 'sk-proj-AUDIO-revoked-nopqrstuv';
const AUDIO = Buffer.from('RIFF....WAVEfmt fake audio bytes for the mock');

function setup() {
  const server = new OpenAiMockServer({ validKeys: [VALID_KEY] });
  const adapter = new OpenAiProviderAdapter(new AiProviderRegistry(), new OpenAiClientFactory({ fetch: server.fetch }));
  const ctx: AiCallContext = { apiKey: VALID_KEY, requestId: 'req-audio-1' };

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

async function* chunked(bytes: Buffer, size = 7): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe('OpenAI audio port (transcription)', () => {
  it('is carried with transcribe and a 25 MiB limit — presence is the declaration', () => {
    const { adapter } = setup();

    expect(typeof adapter.audio.transcribe).toBe('function');
    expect(adapter.audio.transcriptionMaxBytes).toBe(25 * 1024 * 1024);
    expect(OPENAI_TRANSCRIPTION_MAX_BYTES).toBe(26_214_400);
  });

  describe('transcribe', () => {
    it('POSTs /v1/audio/transcriptions as multipart; Whisper is asked for verbose_json and answers segments', async () => {
      const { adapter, ctx, server } = setup();

      const result = await adapter.audio.transcribe!(
        {
          model: 'whisper-1',
          audio: { data: AUDIO, mimeType: 'audio/wav', filename: 'meeting.wav' },
          language: 'en',
          prompt: 'Acme, Zorblax',
          timestampGranularities: ['segment', 'word'],
        },
        ctx,
      );

      const [req] = server.requestsTo('/v1/audio/transcriptions');

      expect(req.method).toBe('POST');
      expect(req.apiKey).toBe(VALID_KEY);
      expect(req.body).toEqual({
        file: { filename: 'meeting.wav', type: 'audio/wav', size: AUDIO.length },
        model: 'whisper-1',
        response_format: 'verbose_json',
        stream: 'false',
        language: 'en',
        prompt: 'Acme, Zorblax',
        'timestamp_granularities[]': ['segment', 'word'],
      });
      expect(server.uploads[0].equals(AUDIO)).toBe(true);

      expect(result).toEqual({
        provider: 'openai',
        model: 'whisper-1',
        text: MOCK_TRANSCRIPT,
        language: 'english',
        durationSeconds: 3.5,
        segments: [
          { startSeconds: 0, endSeconds: 1.5, text: 'Hello from' },
          { startSeconds: 1.5, endSeconds: 3.5, text: 'the mock transcription.' },
        ],
        words: [
          { startSeconds: 0, endSeconds: 0.4, word: 'Hello' },
          { startSeconds: 0.4, endSeconds: 0.8, word: 'from' },
        ],
        usage: {},
        providerRequestId: 'req_mock_1',
      });
    });

    it('streams a streamed input: the request body is sent as it is read, byte for byte', async () => {
      const { adapter, ctx, server } = setup();
      let pulled = 0;

      async function* counted(): AsyncGenerator<Uint8Array> {
        for await (const chunk of chunked(AUDIO)) {
          pulled += chunk.length;
          yield chunk;
        }
      }

      const result = await adapter.audio.transcribe!(
        { model: 'whisper-1', audio: { stream: counted(), mimeType: 'audio/mpeg', filename: 'memo.mp3', size: AUDIO.length } },
        ctx,
      );

      const [req] = server.requestsTo('/v1/audio/transcriptions');

      expect(req.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
      expect(req.body).toMatchObject({ file: { filename: 'memo.mp3', type: 'audio/mpeg', size: AUDIO.length } });
      expect(pulled).toBe(AUDIO.length);
      expect(server.uploads[0].equals(AUDIO)).toBe(true);
      expect(result.text).toBe(MOCK_TRANSCRIPT);
    });

    it('asks the GPT-4o transcribe family for json, drops timestamp_granularities, and keeps token usage', async () => {
      const { adapter, ctx, server } = setup();

      const result = await adapter.audio.transcribe!(
        {
          model: 'gpt-4o-mini-transcribe',
          audio: { data: AUDIO, mimeType: 'audio/webm', filename: 'clip.webm' },
          timestampGranularities: ['segment'],
        },
        ctx,
      );

      const [req] = server.requestsTo('/v1/audio/transcriptions');

      expect(req.body).toMatchObject({ model: 'gpt-4o-mini-transcribe', response_format: 'json' });
      expect(req.body).not.toHaveProperty('timestamp_granularities[]');
      expect(result).toMatchObject({ text: MOCK_TRANSCRIPT, usage: { inputTokens: 40, outputTokens: 8 } });
      expect(result.durationSeconds).toBeUndefined();
      expect(result.segments).toBeUndefined();
    });

    it('reads a Whisper json duration usage as durationSeconds', async () => {
      const { adapter, ctx } = setup();

      const result = await adapter.audio.transcribe!(
        { model: 'whisper-1', audio: { data: AUDIO, mimeType: 'audio/wav' }, responseFormat: 'json' },
        ctx,
      );

      expect(result).toMatchObject({ text: MOCK_TRANSCRIPT, durationSeconds: 4, usage: {} });
    });

    it('accepts a plain-text answer (responseFormat: text)', async () => {
      const { adapter, ctx } = setup();

      const result = await adapter.audio.transcribe!(
        { model: 'gpt-4o-transcribe', audio: { data: AUDIO, mimeType: 'audio/wav' }, responseFormat: 'text' },
        ctx,
      );

      expect(result).toMatchObject({ text: MOCK_TRANSCRIPT, usage: {} });
    });

    it('merges providerOptions.openai under the port\'s own fields', async () => {
      const { adapter, ctx, server } = setup();

      await adapter.audio.transcribe!(
        {
          model: 'whisper-1',
          audio: { data: AUDIO, mimeType: 'audio/wav' },
          providerOptions: { openai: { temperature: 0.2, model: 'overridden?' } },
        },
        ctx,
      );

      expect(server.requestsTo('/v1/audio/transcriptions')[0].body).toMatchObject({ temperature: '0.2', model: 'whisper-1' });
    });

    it('refuses an input declared larger than 25 MiB without calling OpenAI', async () => {
      const { adapter, ctx, server } = setup();

      const err = await caught(() =>
        adapter.audio.transcribe!(
          { model: 'whisper-1', audio: { stream: chunked(AUDIO), mimeType: 'audio/wav', size: OPENAI_TRANSCRIPTION_MAX_BYTES + 1 } },
          ctx,
        ),
      );

      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(server.requests).toEqual([]);
    });

    it('refuses empty audio bytes without calling OpenAI', async () => {
      const { adapter, ctx, server } = setup();

      const err = await caught(() =>
        adapter.audio.transcribe!({ model: 'whisper-1', audio: { data: new Uint8Array(0), mimeType: 'audio/wav' } }, ctx),
      );

      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(server.requests).toEqual([]);
    });

    it('maps a rejected key to AI_KEY_INVALID, never echoing it', async () => {
      const { adapter, server } = setup();

      const err = await caught(() =>
        adapter.audio.transcribe!(
          { model: 'whisper-1', audio: { data: AUDIO, mimeType: 'audio/wav' } },
          { apiKey: INVALID_KEY, requestId: 'r' },
        ),
      );

      expect(err.code).toBe('AI_KEY_INVALID');
      expect(JSON.stringify(err)).not.toContain(INVALID_KEY);
      expect(err.message).not.toContain(INVALID_KEY);
      expect(server.requestsTo('/v1/audio/transcriptions')).toHaveLength(1);
    });

    it.each([
      [400, { message: 'Invalid file format.', type: 'invalid_request_error', param: 'file', code: null }, 'AI_INVALID_REQUEST'],
      [413, { message: 'Maximum content size limit (26214400) exceeded.', type: 'invalid_request_error', param: null, code: null }, 'AI_INVALID_REQUEST'],
      [429, { message: 'Rate limit reached.', type: 'requests', param: null, code: 'rate_limit_exceeded' }, 'AI_RATE_LIMITED'],
      [500, { message: 'The server had an error.', type: 'server_error', param: null, code: null }, 'AI_PROVIDER_UNAVAILABLE'],
    ])('maps an HTTP %s to its AiError code', async (status, error, code) => {
      const { adapter, ctx, server } = setup();

      server.transcribeWith(() => ({ kind: 'error', status, error }));

      const err = await caught(() =>
        adapter.audio.transcribe!({ model: 'whisper-1', audio: { data: AUDIO, mimeType: 'audio/wav' } }, ctx),
      );

      expect(err.code).toBe(code);
    });

    it('a network failure is AI_PROVIDER_UNAVAILABLE, never a raw error', async () => {
      const { adapter, ctx, server } = setup();

      server.transcribeWith(() => ({ kind: 'network' }));

      const err = await caught(() =>
        adapter.audio.transcribe!({ model: 'whisper-1', audio: { data: AUDIO, mimeType: 'audio/wav' } }, ctx),
      );

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
    });

    it('an answer without text is a malformed-response AI_PROVIDER_UNAVAILABLE', async () => {
      const { adapter, ctx, server } = setup();

      server.transcribeWith(() => ({ kind: 'transcription', body: { usage: { type: 'duration', seconds: 1 } } }));

      const err = await caught(() =>
        adapter.audio.transcribe!({ model: 'whisper-1', audio: { data: AUDIO, mimeType: 'audio/wav' } }, ctx),
      );

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ problem: 'missing_text', providerRequestId: 'req_mock_1' });
    });
  });

  describe('mapper', () => {
    it('isOpenAiWhisper tells the families apart', () => {
      expect(isOpenAiWhisper('whisper-1')).toBe(true);
      expect(isOpenAiWhisper(' Whisper-1 ')).toBe(true);
      expect(isOpenAiWhisper('gpt-4o-transcribe')).toBe(false);
    });

    it.each([
      [{ filename: 'memo.m4a', mimeType: 'audio/mp4' }, 'memo.m4a'],
      [{ filename: 'memo', mimeType: 'audio/mp4' }, 'memo.m4a'],
      [{ filename: 'call.recording', mimeType: 'audio/mpeg' }, 'call.recording.mp3'],
      [{ filename: 'folder/sub\\voice.WAV', mimeType: 'audio/wav' }, 'voice.WAV'],
      [{ mimeType: 'video/webm' }, 'audio.webm'],
      [{ filename: '  ', mimeType: 'audio/x-unknown' }, 'audio.mp3'],
    ])('openAiAudioFileName(%j) is %s', (input, expected) => {
      expect(openAiAudioFileName(input)).toBe(expected);
    });

    it('builds a streamed file for a streamed input and a File for bytes', async () => {
      const streamed = await toOpenAiTranscriptionRequest({
        model: 'whisper-1',
        audio: { stream: chunked(AUDIO), mimeType: 'audio/ogg', filename: 'x' },
      });
      const buffered = await toOpenAiTranscriptionRequest({ model: 'whisper-1', audio: { data: AUDIO, mimeType: 'audio/ogg' } });

      expect(streamed.file).not.toBeInstanceOf(File);
      expect((streamed.file as { name: string }).name).toBe('x.ogg');
      expect(buffered.file).toBeInstanceOf(File);
      expect((buffered.file as File).name).toBe('audio.ogg');
    });

    it('respects an explicit responseFormat and sends granularities only with verbose_json', async () => {
      const body = await toOpenAiTranscriptionRequest({
        model: 'whisper-1',
        audio: { data: AUDIO, mimeType: 'audio/wav' },
        responseFormat: 'text',
        timestampGranularities: ['word'],
      });

      expect(body.response_format).toBe('text');
      expect(body.timestamp_granularities).toBeUndefined();
    });

    it('drops malformed segments and words, and reads a languages[] code', () => {
      const result = fromOpenAiTranscriptionResponse(
        {
          text: 'hi',
          languages: [{ code: 'fr' }],
          segments: [{ start: 0, end: 1, text: ' ok ' }, { start: 'x', end: 2, text: 'bad' }],
          words: [{ start: 0, end: 1, word: 'hi' }, { start: 0, word: 'no-end' }],
        },
        { request: { model: 'whisper-1', audio: { data: AUDIO, mimeType: 'audio/wav' } } },
      );

      expect(result).toMatchObject({
        text: 'hi',
        language: 'fr',
        segments: [{ startSeconds: 0, endSeconds: 1, text: 'ok' }],
        words: [{ startSeconds: 0, endSeconds: 1, word: 'hi' }],
      });
    });
  });
});
