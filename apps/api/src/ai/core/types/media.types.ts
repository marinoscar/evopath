// =============================================================================
// Media capability port types (issue #424, epic #419)
// =============================================================================
//
// Declared now, implemented in Phase 2/3 (#420 and later), so those stories
// only implement. Every result carries BYTES + a MIME type, never a provider
// URL: provider-hosted URLs expire and are not ours to authorize, so the
// caller persists the bytes to object storage and serves them itself.
// =============================================================================

import type { AiCallContext } from '../provider-adapter.interface';
import type { AiFunctionTool, AiUsage } from './responses.types';

/** Raw media going in or out of a provider. */
export interface AiBinaryPayload {
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}

interface AiMediaRequestBase {
  model: string;
  /** Keyed by provider id — same escape hatch as `AiResponseRequest`. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

interface AiMediaResultBase {
  provider: string;
  model: string;
  usage: AiUsage;
  providerRequestId?: string;
}

// ---- Images -----------------------------------------------------------------

/** The most images one generate/edit call may ask for (`n`). */
export const AI_IMAGES_MAX_N = 4;

/** The most source images one edit may send. */
export const AI_IMAGE_EDIT_MAX_INPUTS = 16;

/** The largest source image (or mask) an edit reads, in bytes (25 MiB). */
export const AI_IMAGE_INPUT_MAX_BYTES = 25 * 1024 * 1024;

/** The MIME types a source image may have. */
export const AI_IMAGE_INPUT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** The MIME types a mask may have (it needs an alpha channel). */
export const AI_IMAGE_MASK_MIME_TYPES = ['image/png'] as const;

/** The longest prompt accepted, in characters. */
export const AI_IMAGE_PROMPT_MAX_CHARS = 32_000;

export const AI_IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export const AI_IMAGE_BACKGROUNDS = ['transparent', 'opaque', 'auto'] as const;
export const AI_IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const;

export interface AiImageGenerationRequest extends AiMediaRequestBase {
  prompt: string;
  /** Provider-validated, e.g. `1024x1024` or `auto`. */
  size?: string;
  quality?: (typeof AI_IMAGE_QUALITIES)[number];
  background?: (typeof AI_IMAGE_BACKGROUNDS)[number];
  outputFormat?: (typeof AI_IMAGE_OUTPUT_FORMATS)[number];
  /** Number of images, 1 to `AI_IMAGES_MAX_N`; defaults to 1. */
  n?: number;
}

export interface AiImageEditRequest extends AiImageGenerationRequest {
  /** The source image(s) to edit. */
  images: AiBinaryPayload[];
  /** Optional mask; transparent areas mark what may change. */
  mask?: AiBinaryPayload;
}

export interface AiGeneratedImage extends AiBinaryPayload {
  revisedPrompt?: string;
}

export interface AiImageResult extends AiMediaResultBase {
  images: AiGeneratedImage[];
}

export interface AiImagesPort {
  generate(req: AiImageGenerationRequest, ctx: AiCallContext): Promise<AiImageResult>;
  /** Present only when the provider supports editing (`image_edit`). */
  edit?(req: AiImageEditRequest, ctx: AiCallContext): Promise<AiImageResult>;
}

// ---- Audio ------------------------------------------------------------------

/**
 * Media handed to a provider as a STREAM rather than a buffer (#438): the
 * bytes are read once, as the provider request is sent, so a 25 MB recording
 * is never held in memory whole. `size`, when known, lets an adapter refuse
 * an oversized input before it opens a connection.
 */
export interface AiStreamedPayload {
  stream: AsyncIterable<Uint8Array>;
  mimeType: string;
  filename?: string;
  /** Bytes, when known in advance. */
  size?: number;
}

/** Media going INTO a provider: whole bytes, or a stream (`'stream' in input`). */
export type AiMediaInput = AiBinaryPayload | AiStreamedPayload;

/** Whether `input` is streamed rather than buffered. */
export function isStreamedPayload(input: AiMediaInput): input is AiStreamedPayload {
  return 'stream' in input && input.stream !== undefined;
}

/**
 * The MIME types a transcription input may have: any audio, plus the two
 * video containers people record voice memos and meetings in. `type/*` is a
 * wildcard (`AiStorageInputResolver` understands it).
 */
export const AI_TRANSCRIPTION_INPUT_MIME_TYPES = ['audio/*', 'video/mp4', 'video/webm'] as const;

/**
 * The largest transcription input when the provider's audio port declares
 * no limit of its own (`AiAudioPort.transcriptionMaxBytes`): 25 MiB, OpenAI's.
 */
export const AI_TRANSCRIPTION_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** The longest vocabulary/context prompt accepted, in characters. */
export const AI_TRANSCRIPTION_PROMPT_MAX_CHARS = 4_000;

export const AI_TRANSCRIPTION_RESPONSE_FORMATS = ['text', 'json', 'verbose_json'] as const;
export const AI_TRANSCRIPTION_TIMESTAMP_GRANULARITIES = ['segment', 'word'] as const;

export type AiTranscriptionTimestampGranularity = (typeof AI_TRANSCRIPTION_TIMESTAMP_GRANULARITIES)[number];

export interface AiTranscriptionRequest extends AiMediaRequestBase {
  audio: AiMediaInput;
  /** ISO-639-1 hint. */
  language?: string;
  /** Vocabulary/context hint. */
  prompt?: string;
  /**
   * The provider's answer shape. Omit and the adapter asks for the richest
   * one the model supports (OpenAI: `verbose_json` for Whisper, `json` for
   * the GPT-4o transcribe family).
   */
  responseFormat?: (typeof AI_TRANSCRIPTION_RESPONSE_FORMATS)[number];
  /** Per-segment and/or per-word timestamps, where the model supports them. */
  timestampGranularities?: AiTranscriptionTimestampGranularity[];
}

export interface AiTranscriptionSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface AiTranscriptionWord {
  startSeconds: number;
  endSeconds: number;
  word: string;
}

export interface AiTranscriptionResult extends AiMediaResultBase {
  text: string;
  language?: string;
  /** The audio's length, when the provider reports it — what `audioSeconds` usage is metered on. */
  durationSeconds?: number;
  segments?: AiTranscriptionSegment[];
  words?: AiTranscriptionWord[];
}

/** The longest text one speech call may speak, in characters (OpenAI's limit). */
export const AI_SPEECH_INPUT_MAX_CHARS = 4_096;

/** The longest style/tone instruction accepted, in characters. */
export const AI_SPEECH_INSTRUCTIONS_MAX_CHARS = 4_096;

export const AI_SPEECH_FORMATS = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'] as const;
export type AiSpeechFormat = (typeof AI_SPEECH_FORMATS)[number];

/** The MIME type each speech format is stored and served as (`pcm`: raw 24 kHz 16-bit LE). */
export const AI_SPEECH_FORMAT_MIME: Record<AiSpeechFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pcm: 'audio/pcm',
};

/** Speaking-rate bounds (1 is normal). */
export const AI_SPEECH_SPEED_MIN = 0.25;
export const AI_SPEECH_SPEED_MAX = 4;

export interface AiSpeechRequest extends AiMediaRequestBase {
  /** 1 to `AI_SPEECH_INPUT_MAX_CHARS` characters. */
  input: string;
  voice: string;
  /** Defaults to `mp3`. */
  format?: AiSpeechFormat;
  /** Style/tone instructions where supported (OpenAI: not the `tts-1` family). */
  instructions?: string;
  /** `AI_SPEECH_SPEED_MIN` to `AI_SPEECH_SPEED_MAX`; 1 is normal. */
  speed?: number;
}

export interface AiSpeechResult extends AiMediaResultBase {
  audio: AiBinaryPayload;
}

export interface AiAudioPort {
  /** Present only when the provider supports `audio_transcription`. */
  transcribe?(req: AiTranscriptionRequest, ctx: AiCallContext): Promise<AiTranscriptionResult>;
  /**
   * The largest audio input `transcribe` accepts, in bytes. The runtime
   * refuses a larger input with `AI_INVALID_REQUEST` BEFORE calling. Omitted:
   * `AI_TRANSCRIPTION_DEFAULT_MAX_BYTES`.
   */
  readonly transcriptionMaxBytes?: number;
  /** Present only when the provider supports `audio_speech`. */
  speech?(req: AiSpeechRequest, ctx: AiCallContext): Promise<AiSpeechResult>;
  /**
   * Every voice `speech` accepts, as static data (#439). A model may offer a
   * subset — its catalog capabilities' `voices`; this is the provider-wide
   * list the runtime falls back to when a model does not say.
   */
  readonly voices?: readonly string[];
}

// ---- Embeddings -------------------------------------------------------------

/**
 * The most inputs one `embed` call accepts. A larger batch is refused with
 * `AI_INVALID_REQUEST` rather than silently split: chunk it yourself, and for
 * a backfill of thousands of rows enqueue your own job type that calls
 * `embed` per chunk (docs/specs/ai-platform.md, "Embeddings").
 */
export const AI_EMBEDDINGS_MAX_INPUTS = 256;

export interface AiEmbeddingRequest extends AiMediaRequestBase {
  /** One text, or up to `AI_EMBEDDINGS_MAX_INPUTS` texts. None may be empty. */
  input: string | string[];
  /**
   * Shorten every vector to this many dimensions where the model supports it
   * (OpenAI: `text-embedding-3-*`). A model that cannot is refused with
   * `AI_INVALID_REQUEST` rather than answered at its native length.
   */
  dimensions?: number;
}

export interface AiEmbeddingResult extends AiMediaResultBase {
  /** One vector per input, in input order (a single string input yields one). */
  vectors: number[][];
  /** The length of every vector in `vectors`. */
  dimensions: number;
}

export interface AiEmbeddingsPort {
  embed(req: AiEmbeddingRequest, ctx: AiCallContext): Promise<AiEmbeddingResult>;
}

// ---- Realtime ---------------------------------------------------------------
//
// #449 (docs/specs/ai-platform.md §2.15). The server mints an EPHEMERAL,
// short-lived client secret with the resolved key; the browser connects to
// the provider directly (WebRTC) with that secret. The server never sees the
// media, so a session has no result beyond the secret itself.

/** How long a minted client secret may be used to OPEN a session (seconds). */
export const AI_REALTIME_CLIENT_SECRET_TTL_SECONDS = 60;

/** The longest initial `instructions` accepted, in characters. */
export const AI_REALTIME_INSTRUCTIONS_MAX_CHARS = 16_000;

/**
 * How the provider decides a user's turn has ended. `server_vad` detects
 * silence; `semantic_vad` judges whether the user has finished their
 * thought. `null` on a request switches detection off (push-to-talk: the
 * client commits the audio buffer itself).
 */
export type AiRealtimeTurnDetection =
  | {
      type: 'server_vad';
      /** Activation threshold, 0-1. */
      threshold?: number;
      prefixPaddingMs?: number;
      silenceDurationMs?: number;
    }
  | {
      type: 'semantic_vad';
      eagerness?: 'low' | 'medium' | 'high' | 'auto';
    };

export interface AiRealtimeSessionRequest extends AiMediaRequestBase {
  /** Initial system instructions — the client may change them over its data channel. */
  instructions?: string;
  /** The voice the model answers in; the runtime has already checked the model speaks it. */
  voice?: string;
  /** Output modalities; the provider's default (audio, with its transcript) when omitted. */
  modalities?: Array<'text' | 'audio'>;
  /** Client-executed function tools the session starts with. */
  tools?: AiFunctionTool[];
  /** Omitted: the provider's default. `null`: no automatic turn detection. */
  turnDetection?: AiRealtimeTurnDetection | null;
  /** Initial per-response output-token cap (a default the client can change, not an enforcement). */
  maxOutputTokens?: number;
  /** Seconds the client secret may open a session; defaults to `AI_REALTIME_CLIENT_SECRET_TTL_SECONDS`. */
  expiresInSeconds?: number;
}

/**
 * A short-lived session the BROWSER connects to directly. `clientSecret` is
 * an ephemeral, provider-minted token scoped to this one session
 * configuration — never the provider API key the server called with.
 *
 * ⚠ Treat `clientSecret` as a bearer credential: it is returned to the
 * caller (that is its purpose) and nowhere else — never logged, never put on
 * a span, never stored.
 */
export interface AiRealtimeSession {
  /** The provider's session id, when it reports one. */
  id?: string;
  provider: string;
  model: string;
  /** The ephemeral secret the browser authenticates the connection with. */
  clientSecret: string;
  /** When `clientSecret` stops being able to open a session. */
  expiresAt: Date;
  /** Where the browser POSTs its WebRTC SDP offer, with `Authorization: Bearer <clientSecret>`. */
  connectUrl: string;
  /** The voice the session speaks in, as the provider confirmed it. */
  voice?: string;
  /** The effective initial configuration, as neutral non-secret fields. */
  sessionConfig?: {
    modalities?: Array<'text' | 'audio'>;
    instructions?: string;
    turnDetection?: AiRealtimeTurnDetection | null;
    maxOutputTokens?: number;
  };
  providerRequestId?: string;
}

export interface AiRealtimePort {
  createSession(req: AiRealtimeSessionRequest, ctx: AiCallContext): Promise<AiRealtimeSession>;
  /**
   * Every voice `createSession` accepts, as static data. A model may offer a
   * subset — its catalog capabilities' `voices`; this is the fallback.
   */
  readonly voices?: readonly string[];
}
