// =============================================================================
// An image run's request, as stored in `ai_runs.request` (issue #437)
// =============================================================================
//
// Image generation and editing are ALWAYS background runs (`ai.image.generate`
// jobs): the same `ai_runs` table and `AiRunsService` state machine as
// `ai.response.run`, told apart by `request.operation`:
//
//   (absent)          a responses run (`ai-run-request.ts`) — every row written
//                     before #437, and every `startRun` row since
//   'images.generate' `AiUserClient.generateImage`
//   'images.edit'     `AiUserClient.editImage`
//
// The discriminator lives IN the request rather than in a new column so no
// migration is needed and an old row reads exactly as before (`aiRunOperation`,
// `ai-run-operation.ts`, treats a missing `operation` as `'responses'`).
//
// INPUTS BY REFERENCE. An edit's source images and mask are stored as
// storage object ids, never as bytes: the job re-resolves them (ownership
// included — see `AiStorageInputResolver`) when it runs.
//
// ⚠ NEVER KEY MATERIAL — named fields only, exactly as `toStoredRunRequest`.
// =============================================================================

import { z } from 'zod';

import { AiError } from '../core/ai-error';
import {
  AI_IMAGE_BACKGROUNDS,
  AI_IMAGE_EDIT_MAX_INPUTS,
  AI_IMAGE_OUTPUT_FORMATS,
  AI_IMAGE_PROMPT_MAX_CHARS,
  AI_IMAGE_QUALITIES,
  AI_IMAGES_MAX_N,
  type AiImageGenerationRequest,
} from '../core/types/media.types';

/** The image operations a run can carry. Permanent strings (stored in `ai_runs.request`). */
export const AI_IMAGE_OPERATIONS = ['images.generate', 'images.edit'] as const;
export type AiImageOperation = (typeof AI_IMAGE_OPERATIONS)[number];

export const storedAiImageRunRequestSchema = z.object({
  operation: z.enum(AI_IMAGE_OPERATIONS),
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().min(1).max(AI_IMAGE_PROMPT_MAX_CHARS),
  size: z.string().min(1).optional(),
  quality: z.enum(AI_IMAGE_QUALITIES).optional(),
  background: z.enum(AI_IMAGE_BACKGROUNDS).optional(),
  outputFormat: z.enum(AI_IMAGE_OUTPUT_FORMATS).optional(),
  n: z.number().int().min(1).max(AI_IMAGES_MAX_N).optional(),
  /** `images.edit` only: the source images, as storage object ids. */
  imageStorageObjectIds: z.array(z.string().min(1)).min(1).max(AI_IMAGE_EDIT_MAX_INPUTS).optional(),
  /** `images.edit` only: the mask, as a storage object id. */
  maskStorageObjectId: z.string().min(1).optional(),
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export type StoredAiImageRunRequest = z.infer<typeof storedAiImageRunRequestSchema>;

/** The stored request, validated on the way back in (a JSONB column is a trust boundary). */
export function parseStoredImageRunRequest(value: unknown): StoredAiImageRunRequest {
  const parsed = storedAiImageRunRequestSchema.safeParse(value);

  if (!parsed.success) {
    throw new AiError('AI_INVALID_REQUEST', 'The stored image run request is invalid.');
  }

  if (parsed.data.operation === 'images.edit' && !parsed.data.imageStorageObjectIds?.length) {
    throw new AiError('AI_INVALID_REQUEST', 'The stored image edit names no source image.');
  }

  return parsed.data;
}

/** The provider-facing generation fields of a stored request (named fields only). */
export function toImageGenerationRequest(stored: StoredAiImageRunRequest): AiImageGenerationRequest {
  const request: AiImageGenerationRequest = { model: stored.model, prompt: stored.prompt };

  if (stored.size !== undefined) request.size = stored.size;
  if (stored.quality !== undefined) request.quality = stored.quality;
  if (stored.background !== undefined) request.background = stored.background;
  if (stored.outputFormat !== undefined) request.outputFormat = stored.outputFormat;
  if (stored.n !== undefined) request.n = stored.n;
  if (stored.providerOptions !== undefined) request.providerOptions = stored.providerOptions;

  return request;
}
