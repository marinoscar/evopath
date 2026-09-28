import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_HOSTED_TOOL_TYPES } from '../../core/types/responses.types';
import { AI_SPEECH_FORMATS } from '../../core/types/media.types';
import { AI_RUN_STATUSES } from '../../runtime/ai-runtime.types';

// =============================================================================
// AI consumer API — response shapes (issue #433, epic #419)
// =============================================================================
//
// Documentation schemas for the provider-neutral `AiResponse`
// (`core/types/responses.types.ts`) and the background-run views. The
// controller returns the facade's objects as they are; these schemas describe
// them for the OpenAPI document.
//
// ⚠ None of these has a field able to carry a key. `ai-responses.integration
// .spec.ts` serialises every response body and every SSE frame and searches
// them for the user's and the organisation's key.
// =============================================================================

/** A web-search citation: `text.slice(startIndex, endIndex)` is the passage it supports. */
export const aiUrlCitationSchema = z.object({
  url: z.string(),
  title: z.string(),
  startIndex: z.number().int(),
  endIndex: z.number().int(),
});

/**
 * A hosted tool call's `result`, by `tool` (#442). `image_generation` never
 * carries image data inline: `storageObjectId` names the stored image, a
 * storage object the caller owns (download it through
 * `GET /api/storage/objects/{id}/download`); null with `storageError` when
 * storage was unavailable.
 */
export const aiHostedToolResultSchema = z.union([
  z.object({ queries: z.array(z.string()), sources: z.array(z.object({ url: z.string() })) }).describe('web_search'),
  z
    .object({
      queries: z.array(z.string()),
      results: z.array(
        z.object({
          fileId: z.string().optional(),
          filename: z.string().optional(),
          score: z.number().optional(),
          text: z.string().optional(),
        }),
      ),
    })
    .describe('file_search'),
  z
    .object({
      code: z.string().nullable(),
      containerId: z.string(),
      outputs: z.array(
        z.union([
          z.object({ type: z.literal('logs'), logs: z.string() }),
          z.object({ type: z.literal('image'), url: z.string() }),
        ]),
      ),
    })
    .describe('code_interpreter'),
  z
    .object({
      storageObjectId: z.string().nullable(),
      /** Set when the image was generated but storage was unavailable. */
      storageError: z.literal('AI_STORAGE_UNAVAILABLE').optional(),
      mimeType: z.string().optional(),
      revisedPrompt: z.string().optional(),
      size: z.string().optional(),
      quality: z.string().optional(),
    })
    .describe('image_generation'),
  z
    .object({
      kind: z.enum(['call', 'list_tools', 'approval_request']),
      serverLabel: z.string(),
      name: z.string().optional(),
      arguments: z.string().optional(),
      output: z.string().nullable().optional(),
      tools: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
      error: z.string().nullable().optional(),
    })
    .describe('mcp'),
]);

export const aiOutputItemSchema = z.union([
  z.object({
    type: z.literal('message'),
    text: z.string(),
    /** Web sources the text cites (hosted `web_search`). */
    citations: z.array(aiUrlCitationSchema).optional(),
  }),
  z.object({ type: z.literal('reasoning'), summary: z.array(z.string()) }),
  z.object({
    type: z.literal('function_call'),
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal('hosted_tool_call'),
    /** The provider's id for this output item. */
    id: z.string().optional(),
    tool: z.enum(AI_HOSTED_TOOL_TYPES),
    /** Provider status, e.g. `in_progress`, `searching`, `completed`, `failed`. */
    status: z.string(),
    result: aiHostedToolResultSchema.optional(),
  }),
]);

export const aiUsageSchema = z.object({
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  reasoningTokens: z.number().int().optional(),
  cachedInputTokens: z.number().int().optional(),
});

export const aiResponseSchema = z.object({
  /** The provider's response id — pass it back as `previousResponseId` to chain. */
  id: z.string(),
  provider: z.string(),
  model: z.string(),
  output: z.array(aiOutputItemSchema),
  /** Every `message` item's text, concatenated in order. */
  outputText: z.string(),
  /** Present only when the request carried `structuredOutput` — already validated against it. */
  parsed: z.unknown().optional(),
  usage: aiUsageSchema,
  finishReason: z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'error']),
  providerRequestId: z.string().optional(),
});

export class AiResponseDto extends createZodDto(aiResponseSchema) {}

/** `POST /api/ai/runs` — 202. */
export const aiRunStartedSchema = z.object({
  /** Poll `GET /api/ai/runs/{runId}`. */
  runId: z.uuid(),
  /** The queue job executing it (`ai.response.run`; `ai.image.generate` / `ai.audio.*` for a media run). */
  jobId: z.uuid(),
});

export class AiRunStartedDto extends createZodDto(aiRunStartedSchema) {}

/** `GET /api/ai/runs/{id}` and `POST /api/ai/runs/{id}/cancel`. */
/**
 * A succeeded image run's `output` (#437): the storage objects it created,
 * owned by the caller. Download each with
 * `GET /api/storage/objects/{id}/download`; the image bytes are never here.
 */
export const aiImageRunOutputSchema = z.object({
  type: z.literal('images'),
  provider: z.string(),
  model: z.string(),
  /** One storage object per image, in the order the provider returned them. */
  storageObjectIds: z.array(z.uuid()),
  images: z.array(
    z.object({
      storageObjectId: z.uuid(),
      mimeType: z.string(),
      /** Bytes. */
      size: z.number().int(),
      /** The prompt the provider actually used, where it rewrote it. */
      revisedPrompt: z.string().optional(),
    }),
  ),
  usage: aiUsageSchema,
});

/**
 * A succeeded transcription run's `output` (#438): the transcript.
 * `storageObjectId` is the recording it was made from.
 */
export const aiTranscriptionRunOutputSchema = z.object({
  type: z.literal('transcription'),
  provider: z.string(),
  model: z.string(),
  /** The recording that was transcribed (your storage object). */
  storageObjectId: z.uuid(),
  text: z.string(),
  /** As the provider reports it — an ISO code, or a name such as `english` (OpenAI Whisper). */
  language: z.string().optional(),
  /** The recording's length, when the provider reports it. */
  durationSeconds: z.number().optional(),
  /** Timestamped segments, where the model produces them. */
  segments: z
    .array(z.object({ startSeconds: z.number(), endSeconds: z.number(), text: z.string() }))
    .optional(),
  /** Word timestamps, when requested and supported. */
  words: z.array(z.object({ startSeconds: z.number(), endSeconds: z.number(), word: z.string() })).optional(),
  usage: aiUsageSchema,
});

/**
 * A succeeded speech run's `output` (#439): the audio, a storage object the
 * caller owns (download it with `GET /api/storage/objects/{id}/download`).
 * `aiGenerated` is always `true` — tell listeners the voice is AI-generated.
 */
export const aiSpeechRunOutputSchema = z.object({
  type: z.literal('speech'),
  provider: z.string(),
  model: z.string(),
  storageObjectId: z.uuid(),
  mimeType: z.string(),
  /** Bytes. */
  size: z.number().int(),
  format: z.enum(AI_SPEECH_FORMATS),
  voice: z.string(),
  /** Characters spoken. */
  characters: z.number().int(),
  aiGenerated: z.literal(true),
  usage: aiUsageSchema,
});

export const aiRunSchema = z.object({
  id: z.uuid(),
  status: z.enum(AI_RUN_STATUSES),
  provider: z.string(),
  modelId: z.string(),
  /**
   * Once `succeeded`: the completed response; for an image run
   * (`type: "images"`) the storage objects it created; for a transcription
   * (`type: "transcription"`) the transcript; for speech (`type: "speech"`)
   * the stored audio. Otherwise null.
   */
  output: z
    .union([aiResponseSchema, aiImageRunOutputSchema, aiTranscriptionRunOutputSchema, aiSpeechRunOutputSchema])
    .nullable(),
  /** The AI error code (e.g. `AI_KEY_REQUIRED`) once `failed`; otherwise null. */
  errorCode: z.string().nullable(),
  /** A safe, generic description of the failure; never provider output. */
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export class AiRunDto extends createZodDto(aiRunSchema) {}
export type AiRunHttpView = z.input<typeof aiRunSchema>;
