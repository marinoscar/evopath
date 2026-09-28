import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  AI_SPEECH_FORMATS,
  AI_SPEECH_INPUT_MAX_CHARS,
  AI_SPEECH_INSTRUCTIONS_MAX_CHARS,
  AI_SPEECH_SPEED_MAX,
  AI_SPEECH_SPEED_MIN,
  AI_TRANSCRIPTION_PROMPT_MAX_CHARS,
  AI_TRANSCRIPTION_TIMESTAMP_GRANULARITIES,
} from '../../core/types/media.types';
import { AI_LANGUAGE_CODE } from '../../runtime/ai-audio-run-request';

// =============================================================================
// POST /api/ai/audio/transcriptions (#438) and /api/ai/audio/speech (#439) — requests
// =============================================================================
//
// The HTTP shape of the facade's `AiTranscribeRequest`. The recording is
// named by STORAGE OBJECT ID — upload it first through
// `/api/storage/objects` — never sent as bytes in this body. Answers 202
// `{ runId, jobId }`; the transcript is read from `GET /api/ai/runs/{runId}`.
//
// `.strict()`: an unknown key (`response_format`, say) is a 400 rather than
// silently dropped. ⚠ No field here can carry a key.
// =============================================================================

export const aiTranscriptionRequestSchema = z
  .object({
    /** Provider id. Omit to use your default model's provider (or the only registered one). */
    provider: z.string().min(1).max(64).optional(),
    /** The recording: your own storage object — audio, or MP4/WebM video — at most 25 MiB (OpenAI). */
    storageObjectId: z.uuid(),
    /**
     * A model with `audio_transcription`. Omit to use the first such model available to you
     * (in `GET /api/ai/models` order).
     */
    model: z.string().min(1).max(200).optional(),
    /** ISO-639-1 language of the recording (`en`) — improves accuracy and latency. */
    language: z.string().regex(AI_LANGUAGE_CODE, 'language must be an ISO-639-1 code such as "en"').optional(),
    /** Vocabulary or context the model should expect (names, jargon). */
    prompt: z.string().min(1).max(AI_TRANSCRIPTION_PROMPT_MAX_CHARS).optional(),
    /** Timestamps to return, where the model supports them (OpenAI: Whisper). */
    timestampGranularities: z
      .array(z.enum(AI_TRANSCRIPTION_TIMESTAMP_GRANULARITIES))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length, 'timestampGranularities must not repeat a value')
      .optional(),
    /** Keyed by provider id — the escape hatch for provider features this contract does not model. */
    providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

export class AiTranscriptionRequestDto extends createZodDto(aiTranscriptionRequestSchema) {}
export type AiTranscriptionRequestInput = z.output<typeof aiTranscriptionRequestSchema>;

// Speech (#439): text in, a storage object the caller owns out. `input` over
// 4096 characters is a 400 here, before anything is gated or queued.

export const aiSpeechRequestSchema = z
  .object({
    /** Provider id. Omit to use your default model's provider (or the only registered one). */
    provider: z.string().min(1).max(64).optional(),
    /** The text to speak: 1 to 4096 characters. */
    input: z.string().min(1).max(AI_SPEECH_INPUT_MAX_CHARS),
    /**
     * A model with `audio_speech`. Omit to use the first such model available to you
     * (in `GET /api/ai/models` order).
     */
    model: z.string().min(1).max(200).optional(),
    /**
     * One of the model's voices (its `capabilities.voices` in `GET /api/ai/models`). Omit to use
     * the first it lists.
     */
    voice: z.string().min(1).max(64).optional(),
    /** The audio format stored. Defaults to `mp3`. */
    format: z.enum(AI_SPEECH_FORMATS).optional(),
    /** Style/tone instructions ("calm, slow"), where the model supports them. */
    instructions: z.string().min(1).max(AI_SPEECH_INSTRUCTIONS_MAX_CHARS).optional(),
    /** Speaking rate, 0.25 to 4; 1 is normal. */
    speed: z.number().min(AI_SPEECH_SPEED_MIN).max(AI_SPEECH_SPEED_MAX).optional(),
    /** Keyed by provider id — the escape hatch for provider features this contract does not model. */
    providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

export class AiSpeechRequestDto extends createZodDto(aiSpeechRequestSchema) {}
export type AiSpeechRequestInput = z.output<typeof aiSpeechRequestSchema>;
