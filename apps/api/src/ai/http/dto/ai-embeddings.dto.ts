import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_EMBEDDINGS_MAX_INPUTS } from '../../core/types/media.types';
import { aiUsageSchema } from './ai-response.dto';

// =============================================================================
// POST /api/ai/embeddings — request and response (issue #440, epic #420)
// =============================================================================
//
// The HTTP shape of the facade's `AiEmbedRequest`. `model` is required: an
// embedding model is never inferred from the caller's chat default. The batch
// size is deliberately NOT capped here — `AiService.embed` is the one place
// that refuses a batch over `AI_EMBEDDINGS_MAX_INPUTS`, as `AI_INVALID_REQUEST`
// with guidance to chunk, for HTTP and in-process callers alike.
//
// `.strict()`: an unknown key (an `encoding_format`, say) is a 400 rather
// than silently dropped. ⚠ No field here can carry a key.
// =============================================================================

export const aiEmbeddingsRequestSchema = z
  .object({
    /** Provider id. Omit to use your default model's provider (or the only registered one). */
    provider: z.string().min(1).max(64).optional(),
    /** The embedding model. Required: vectors are only comparable within one model. */
    model: z.string().min(1).max(200),
    /** One text, or up to 256 texts (a larger batch is `AI_INVALID_REQUEST`). */
    input: z.union([
      z.string().min(1),
      z
        .array(z.string().min(1))
        .min(1)
        .describe(`At most ${AI_EMBEDDINGS_MAX_INPUTS} items; split a larger batch into chunks.`),
    ]),
    /** Shorten every vector to this length, where the model supports it. */
    dimensions: z.number().int().positive().optional(),
    /** Keyed by provider id — the escape hatch for provider features this contract does not model. */
    providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

export class AiEmbeddingsRequestDto extends createZodDto(aiEmbeddingsRequestSchema) {}
export type AiEmbeddingsRequestInput = z.output<typeof aiEmbeddingsRequestSchema>;

export const aiEmbeddingsResponseSchema = z.object({
  provider: z.string(),
  /** The model that produced the vectors — store it beside them. */
  model: z.string(),
  /** The length of every vector. */
  dimensions: z.number().int(),
  /** One vector per input, in input order. */
  vectors: z.array(z.array(z.number())),
  usage: aiUsageSchema,
});

export class AiEmbeddingsResponseDto extends createZodDto(aiEmbeddingsResponseSchema) {}
export type AiEmbeddingsHttpResponse = z.output<typeof aiEmbeddingsResponseSchema>;
