// =============================================================================
// OpenAI audio mapper (issue #438, epic #420)
// =============================================================================
//
// AiTranscriptionRequest <-> `POST /v1/audio/transcriptions`, and (#439)
// AiSpeechRequest <-> `POST /v1/audio/speech`. Pure functions
// (plus the SDK's `toFile`/`toStreamingFile`, which only wrap bytes); every
// failure is an `AiError`, never an SDK error.
//
// STREAMED, NOT BUFFERED. A streamed input (`AiStreamedPayload`) becomes the
// SDK's `toStreamingFile`: the multipart body is encoded lazily as the
// request is sent, so the recording is read from storage once and never held
// in memory whole. Bytes already in hand go through `toFile`.
//
// 25 MiB. OpenAI refuses a larger upload; `OPENAI_TRANSCRIPTION_MAX_BYTES` is
// declared on the port so the runtime refuses it FIRST (`AI_INVALID_REQUEST`,
// no provider call), and this mapper refuses one whose size it can see too.
//
// THE FILE NAME CARRIES THE FORMAT. OpenAI decides how to decode an upload
// from its file extension, so a storage object named `memo` (no extension)
// is sent as `memo.m4a` when its MIME type is `audio/mp4`.
//
// TWO FAMILIES. `whisper-1` answers `verbose_json` (language, duration,
// segments, word timestamps) and is asked for it by default; the GPT-4o
// transcribe family answers `json`/`text` only and does not take
// `timestamp_granularities`, so for it that field is left out rather than
// sent to a 400 — the same "what the family cannot honour is dropped" rule
// the images mapper follows.
// =============================================================================

import { toFile, toStreamingFile } from 'openai';
import type { SpeechCreateParams } from 'openai/resources/audio/speech';
import type {
  Transcription,
  TranscriptionCreateParamsNonStreaming,
  TranscriptionVerbose,
} from 'openai/resources/audio/transcriptions';

import { AiError } from '../../core/ai-error';
import {
  AI_SPEECH_FORMAT_MIME,
  AI_SPEECH_INPUT_MAX_CHARS,
  AI_SPEECH_SPEED_MAX,
  AI_SPEECH_SPEED_MIN,
  isStreamedPayload,
  type AiMediaInput,
  type AiSpeechRequest,
  type AiSpeechResult,
  type AiTranscriptionRequest,
  type AiTranscriptionResult,
  type AiTranscriptionSegment,
  type AiTranscriptionWord,
} from '../../core/types/media.types';
import type { AiUsage } from '../../core/types/responses.types';
import { OPENAI_PROVIDER_ID } from './openai-errors';

/** OpenAI's upload limit for `/v1/audio/transcriptions` (25 MiB). */
export const OPENAI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

const WHISPER = /^whisper-/;

/** The extension OpenAI needs to see for each MIME type it can decode. */
const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpga': 'mpga',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

const KNOWN_EXTENSIONS = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'oga', 'wav', 'webm']);

/** Whether OpenAI model `modelId` is a Whisper model (verbose_json, timestamps). */
export function isOpenAiWhisper(modelId: string): boolean {
  return WHISPER.test(modelId.trim().toLowerCase());
}

/**
 * The name the upload is sent under: the caller's own base name (no path),
 * with an extension OpenAI can decode — appended from the MIME type when the
 * name has none it recognises.
 */
export function openAiAudioFileName(input: Pick<AiMediaInput, 'filename' | 'mimeType'>): string {
  const base = (input.filename ?? '').split(/[\\/]/).pop()?.trim() || 'audio';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';

  if (KNOWN_EXTENSIONS.has(ext)) return base;

  const mime = input.mimeType.split(';')[0].trim().toLowerCase();

  return `${base}.${AUDIO_EXTENSIONS[mime] ?? 'mp3'}`;
}

function tooLarge(size: number): AiError {
  return new AiError('AI_INVALID_REQUEST', `The audio is larger than ${OPENAI_TRANSCRIPTION_MAX_BYTES} bytes.`, {
    details: { provider: OPENAI_PROVIDER_ID, size, maxBytes: OPENAI_TRANSCRIPTION_MAX_BYTES },
  });
}

/**
 * The `/v1/audio/transcriptions` multipart body. A streamed input stays a
 * stream (`toStreamingFile`); bytes become a `File`.
 */
export async function toOpenAiTranscriptionRequest(
  req: AiTranscriptionRequest,
): Promise<TranscriptionCreateParamsNonStreaming> {
  const { audio } = req;
  const name = openAiAudioFileName(audio);
  const type = audio.mimeType;

  let file: TranscriptionCreateParamsNonStreaming['file'];

  if (isStreamedPayload(audio)) {
    if (audio.size !== undefined && audio.size > OPENAI_TRANSCRIPTION_MAX_BYTES) throw tooLarge(audio.size);

    file = toStreamingFile(audio.stream, name, { type });
  } else {
    if (audio.data.byteLength === 0) {
      throw new AiError('AI_INVALID_REQUEST', 'The audio is empty.', { details: { provider: OPENAI_PROVIDER_ID } });
    }

    if (audio.data.byteLength > OPENAI_TRANSCRIPTION_MAX_BYTES) throw tooLarge(audio.data.byteLength);

    file = await toFile(audio.data, name, { type });
  }

  const whisper = isOpenAiWhisper(req.model);
  const format = req.responseFormat ?? (whisper ? 'verbose_json' : 'json');
  const escapeHatch = (req.providerOptions?.[OPENAI_PROVIDER_ID] ?? {}) as Record<string, unknown>;

  const body: TranscriptionCreateParamsNonStreaming = {
    ...escapeHatch,
    file,
    model: req.model,
    response_format: format,
    stream: false,
  };

  if (req.language !== undefined) body.language = req.language;
  if (req.prompt !== undefined) body.prompt = req.prompt;

  if (whisper && format === 'verbose_json' && req.timestampGranularities?.length) {
    body.timestamp_granularities = [...new Set(req.timestampGranularities)];
  }

  return body;
}

export interface FromOpenAiTranscriptionOptions {
  request: AiTranscriptionRequest;
  providerRequestId?: string | null;
}

function malformed(reason: string, opts: FromOpenAiTranscriptionOptions): AiError {
  return new AiError('AI_PROVIDER_UNAVAILABLE', 'OpenAI returned a malformed transcription response.', {
    details: {
      provider: OPENAI_PROVIDER_ID,
      // Not `reason`: the error body's `details.reason` is always the AiErrorCode.
      problem: reason,
      ...(opts.providerRequestId ? { providerRequestId: opts.providerRequestId } : {}),
    },
  });
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Token usage (the GPT-4o family) and, separately, a billed duration (Whisper). */
function transcriptionUsage(usage: Transcription['usage'] | TranscriptionVerbose['usage']): {
  usage: AiUsage;
  seconds?: number;
} {
  if (!usage) return { usage: {} };

  if (usage.type === 'duration') {
    return { usage: {}, ...(finite(usage.seconds) ? { seconds: usage.seconds } : {}) };
  }

  const out: AiUsage = {};

  if (finite(usage.input_tokens)) out.inputTokens = usage.input_tokens;
  if (finite(usage.output_tokens)) out.outputTokens = usage.output_tokens;

  return { usage: out };
}

/**
 * The neutral result, from whichever shape the requested `response_format`
 * produced: a bare string (`text`), `{ text, usage? }` (`json`), or the
 * verbose object with language, duration, segments and words.
 */
export function fromOpenAiTranscriptionResponse(
  data: unknown,
  opts: FromOpenAiTranscriptionOptions,
): AiTranscriptionResult {
  const base = {
    provider: OPENAI_PROVIDER_ID,
    model: opts.request.model,
    ...(opts.providerRequestId ? { providerRequestId: opts.providerRequestId } : {}),
  };

  if (typeof data === 'string') {
    return { ...base, text: data.trim(), usage: {} };
  }

  if (!data || typeof data !== 'object' || typeof (data as { text?: unknown }).text !== 'string') {
    throw malformed('missing_text', opts);
  }

  const body = data as Partial<TranscriptionVerbose> & Partial<Transcription> & { text: string };
  const { usage, seconds } = transcriptionUsage(body.usage);
  const result: AiTranscriptionResult = { ...base, text: body.text, usage };

  const language = typeof body.language === 'string' && body.language ? body.language : body.languages?.[0]?.code;

  if (language) result.language = language;

  const duration = finite(body.duration) ? body.duration : seconds;

  if (duration !== undefined) result.durationSeconds = duration;

  if (Array.isArray(body.segments)) {
    result.segments = body.segments
      .filter((s) => finite(s.start) && finite(s.end) && typeof s.text === 'string')
      .map((s): AiTranscriptionSegment => ({ startSeconds: s.start, endSeconds: s.end, text: s.text.trim() }));
  }

  if (Array.isArray(body.words)) {
    result.words = body.words
      .filter((w) => finite(w.start) && finite(w.end) && typeof w.word === 'string')
      .map((w): AiTranscriptionWord => ({ startSeconds: w.start, endSeconds: w.end, word: w.word }));
  }

  return result;
}

// ---- Speech (#439) ------------------------------------------------------------
//
// The answer is the audio itself (a binary body), never a URL. `tts-1` and
// `tts-1-hd` do not take `instructions`; it is left out for them rather than
// sent to a 400. `stream_format` is never sent: the endpoint's default for a
// non-streamed call is the whole file.

const TTS1 = /^tts-1(?:-|$)/;

/** Whether OpenAI model `modelId` is `tts-1`/`tts-1-hd` (no `instructions`). */
export function isOpenAiTts1(modelId: string): boolean {
  return TTS1.test(modelId.trim().toLowerCase());
}

function invalidSpeech(message: string, details: Record<string, unknown> = {}): AiError {
  return new AiError('AI_INVALID_REQUEST', message, { details: { provider: OPENAI_PROVIDER_ID, ...details } });
}

/** The `/v1/audio/speech` JSON body. Refuses what OpenAI would refuse, before calling. */
export function toOpenAiSpeechRequest(req: AiSpeechRequest): SpeechCreateParams {
  if (typeof req.input !== 'string' || req.input.trim().length === 0) {
    throw invalidSpeech('Speech needs non-empty input text.');
  }

  if (req.input.length > AI_SPEECH_INPUT_MAX_CHARS) {
    throw invalidSpeech(`Speech input is longer than ${AI_SPEECH_INPUT_MAX_CHARS} characters.`, {
      length: req.input.length,
      max: AI_SPEECH_INPUT_MAX_CHARS,
    });
  }

  if (typeof req.voice !== 'string' || req.voice.trim().length === 0) {
    throw invalidSpeech('Speech needs a voice.');
  }

  if (req.speed !== undefined && !(req.speed >= AI_SPEECH_SPEED_MIN && req.speed <= AI_SPEECH_SPEED_MAX)) {
    throw invalidSpeech(`speed must be from ${AI_SPEECH_SPEED_MIN} to ${AI_SPEECH_SPEED_MAX}.`, { speed: req.speed });
  }

  const escapeHatch = (req.providerOptions?.[OPENAI_PROVIDER_ID] ?? {}) as Record<string, unknown>;
  const body: SpeechCreateParams = {
    ...escapeHatch,
    model: req.model,
    input: req.input,
    voice: req.voice,
    response_format: req.format ?? 'mp3',
  };

  if (req.speed !== undefined) body.speed = req.speed;
  if (req.instructions !== undefined && !isOpenAiTts1(req.model)) body.instructions = req.instructions;

  return body;
}

export interface FromOpenAiSpeechOptions {
  request: AiSpeechRequest;
  providerRequestId?: string | null;
}

/**
 * The neutral result: the bytes, typed by the format that was asked for
 * (the one OpenAI produces). No bytes is a provider fault.
 */
export function fromOpenAiSpeechResponse(bytes: Uint8Array, opts: FromOpenAiSpeechOptions): AiSpeechResult {
  if (bytes.byteLength === 0) {
    throw new AiError('AI_PROVIDER_UNAVAILABLE', 'OpenAI returned an empty speech response.', {
      details: {
        provider: OPENAI_PROVIDER_ID,
        problem: 'empty_audio',
        ...(opts.providerRequestId ? { providerRequestId: opts.providerRequestId } : {}),
      },
    });
  }

  const format = opts.request.format ?? 'mp3';

  return {
    provider: OPENAI_PROVIDER_ID,
    model: opts.request.model,
    audio: { data: bytes, mimeType: AI_SPEECH_FORMAT_MIME[format] },
    usage: {},
    ...(opts.providerRequestId ? { providerRequestId: opts.providerRequestId } : {}),
  };
}
