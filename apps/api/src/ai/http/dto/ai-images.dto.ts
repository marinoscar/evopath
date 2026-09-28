import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  AI_IMAGE_BACKGROUNDS,
  AI_IMAGE_EDIT_MAX_INPUTS,
  AI_IMAGE_OUTPUT_FORMATS,
  AI_IMAGE_PROMPT_MAX_CHARS,
  AI_IMAGE_QUALITIES,
  AI_IMAGES_MAX_N,
} from '../../core/types/media.types';

// =============================================================================
// POST /api/ai/images and /api/ai/images/edits — requests (issue #437)
// =============================================================================
//
// The HTTP shape of the facade's `AiGenerateImageRequest` /
// `AiEditImageRequest`. `model` is required (an image model is never
// inferred from the caller's chat default). An edit names its inputs by
// STORAGE OBJECT ID — upload first through `/api/storage/objects` — never by
// bytes in this body. Both answer 202 `{ runId, jobId }`; the result is read
// from `GET /api/ai/runs/{runId}`.
//
// `.strict()`: an unknown key (`response_format`, say) is a 400 rather than
// silently dropped. ⚠ No field here can carry a key.
// =============================================================================

const imageFields = {
  /** Provider id. Omit to use your default model's provider (or the only registered one). */
  provider: z.string().min(1).max(64).optional(),
  /** The image model. Required. */
  model: z.string().min(1).max(200),
  prompt: z.string().min(1).max(AI_IMAGE_PROMPT_MAX_CHARS),
  /** `WIDTHxHEIGHT` (e.g. `1024x1024`) or `auto`; the provider decides which sizes a model accepts. */
  size: z
    .string()
    .regex(/^(auto|\d{2,5}x\d{2,5})$/, 'size must be "auto" or WIDTHxHEIGHT')
    .optional(),
  quality: z.enum(AI_IMAGE_QUALITIES).optional(),
  background: z.enum(AI_IMAGE_BACKGROUNDS).optional(),
  /** The format of the stored images. Defaults to PNG. */
  outputFormat: z.enum(AI_IMAGE_OUTPUT_FORMATS).optional(),
  /** How many images, 1 to 4. Defaults to 1. */
  n: z.number().int().min(1).max(AI_IMAGES_MAX_N).optional(),
  /** Keyed by provider id — the escape hatch for provider features this contract does not model. */
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
};

export const aiImageGenerateRequestSchema = z.object(imageFields).strict();

export class AiImageGenerateRequestDto extends createZodDto(aiImageGenerateRequestSchema) {}
export type AiImageGenerateRequestInput = z.output<typeof aiImageGenerateRequestSchema>;

export const aiImageEditRequestSchema = z
  .object({
    ...imageFields,
    /** The images to edit: your own storage objects (PNG, JPEG or WebP, at most 25 MiB each). */
    imageStorageObjectIds: z.array(z.uuid()).min(1).max(AI_IMAGE_EDIT_MAX_INPUTS),
    /** Optional PNG mask (your own storage object): transparent areas mark what may change. */
    maskStorageObjectId: z.uuid().optional(),
  })
  .strict();

export class AiImageEditRequestDto extends createZodDto(aiImageEditRequestSchema) {}
export type AiImageEditRequestInput = z.output<typeof aiImageEditRequestSchema>;
