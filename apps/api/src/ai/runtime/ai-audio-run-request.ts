// =============================================================================
// An audio run's request, as stored in `ai_runs.request` (issues #438, #439)
// =============================================================================
//
// Transcription and speech are ALWAYS background runs (`ai.audio.transcribe`
// / `ai.audio.speech` jobs): the same `ai_runs` table and `AiRunsService`
// state machine as every other run, told apart by `request.operation` (see
// `ai-run-operation.ts`):
//
//   'audio.transcribe'   `AiUserClient.transcribe` (#438)
//   'audio.speech'       `AiUserClient.speak` (#439)
//
// INPUT BY REFERENCE. A recording is stored as its storage object id, never
// as bytes: the job re-resolves it (ownership included — see
// `AiStorageInputResolver`) and streams it to the provider when it runs.
// Speech stores the text to speak, the resolved voice and the format, so
// the job re-issues exactly the call that was gated.
//
// ⚠ NEVER KEY MATERIAL — named fields only, exactly as `toStoredRunRequest`.
// =============================================================================

import { z } from 'zod';

import { AiError } from '../core/ai-error';
import {
  AI_SPEECH_FORMATS,
  AI_SPEECH_INPUT_MAX_CHARS,
  AI_SPEECH_INSTRUCTIONS_MAX_CHARS,
  AI_SPEECH_SPEED_MAX,
  AI_SPEECH_SPEED_MIN,
  AI_TRANSCRIPTION_PROMPT_MAX_CHARS,
  AI_TRANSCRIPTION_TIMESTAMP_GRANULARITIES,
} from '../core/types/media.types';

/** The transcription operation. Permanent string (stored in `ai_runs.request`). */
export const AI_TRANSCRIBE_OPERATION = 'audio.transcribe';

/** An ISO-639-1 (or -3) language code, lower case: `en`, `pt`, `yue`. */
export const AI_LANGUAGE_CODE = /^[a-z]{2,3}$/;

export const storedAiTranscriptionRunRequestSchema = z.object({
  operation: z.literal(AI_TRANSCRIBE_OPERATION),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** The recording, as a storage object id. */
  storageObjectId: z.string().min(1),
  language: z.string().regex(AI_LANGUAGE_CODE).optional(),
  prompt: z.string().min(1).max(AI_TRANSCRIPTION_PROMPT_MAX_CHARS).optional(),
  timestampGranularities: z.array(z.enum(AI_TRANSCRIPTION_TIMESTAMP_GRANULARITIES)).min(1).max(2).optional(),
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export type StoredAiTranscriptionRunRequest = z.infer<typeof storedAiTranscriptionRunRequestSchema>;

/** The stored request, validated on the way back in (a JSONB column is a trust boundary). */
export function parseStoredTranscriptionRunRequest(value: unknown): StoredAiTranscriptionRunRequest {
  const parsed = storedAiTranscriptionRunRequestSchema.safeParse(value);

  if (!parsed.success) {
    throw new AiError('AI_INVALID_REQUEST', 'The stored transcription run request is invalid.');
  }

  return parsed.data;
}

/** The speech operation. Permanent string (stored in `ai_runs.request`). */
export const AI_SPEECH_OPERATION = 'audio.speech';

export const storedAiSpeechRunRequestSchema = z.object({
  operation: z.literal(AI_SPEECH_OPERATION),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** The text to speak. */
  input: z.string().min(1).max(AI_SPEECH_INPUT_MAX_CHARS),
  /** The voice, resolved at queue time. */
  voice: z.string().min(1).max(64),
  /** The audio format, resolved at queue time (default `mp3`). */
  format: z.enum(AI_SPEECH_FORMATS),
  instructions: z.string().min(1).max(AI_SPEECH_INSTRUCTIONS_MAX_CHARS).optional(),
  speed: z.number().min(AI_SPEECH_SPEED_MIN).max(AI_SPEECH_SPEED_MAX).optional(),
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export type StoredAiSpeechRunRequest = z.infer<typeof storedAiSpeechRunRequestSchema>;

/** The stored request, validated on the way back in (a JSONB column is a trust boundary). */
export function parseStoredSpeechRunRequest(value: unknown): StoredAiSpeechRunRequest {
  const parsed = storedAiSpeechRunRequestSchema.safeParse(value);

  if (!parsed.success) {
    throw new AiError('AI_INVALID_REQUEST', 'The stored speech run request is invalid.');
  }

  return parsed.data;
}
