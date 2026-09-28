// =============================================================================
// OpenAI embeddings mapper (issue #440, epic #420)
// =============================================================================
//
// AiEmbeddingRequest <-> `POST /v1/embeddings`. Pure functions; every failure
// is an `AiError`, never an SDK error.
//
// FLOATS ON THE WIRE, ALWAYS. The SDK asks for `base64` when no
// `encoding_format` is given and decodes it into `Float32Array`s, which are
// not `number[]` (JSON.stringify turns one into an object keyed by index).
// This mapper pins `encoding_format: 'float'` and forbids the escape hatch
// from changing it, so a vector is a plain `number[]` end to end.
//
// `dimensions`. Only `text-embedding-3` and later accept it; `ada-002` is the
// one family known NOT to, and is refused here rather than sent to a 400 the
// caller would have to decode. An unknown id passes through — the provider
// is the authority, and its 400 maps to `AI_INVALID_REQUEST` anyway.
// =============================================================================

import type { CreateEmbeddingResponse, EmbeddingCreateParams } from 'openai/resources/embeddings';

import { AiError } from '../../core/ai-error';
import type { AiEmbeddingRequest, AiEmbeddingResult } from '../../core/types/media.types';
import { OPENAI_FAMILY, type OpenAiFamily } from './openai-errors';

/** Embedding families that do not accept `dimensions`. */
const FIXED_DIMENSION_MODELS = /^text-embedding-ada-/;

/** Whether OpenAI model `modelId` accepts the `dimensions` parameter. */
export function openAiEmbeddingSupportsDimensions(modelId: string): boolean {
  return !FIXED_DIMENSION_MODELS.test(modelId.trim().toLowerCase());
}

export type OpenAiEmbeddingBody = EmbeddingCreateParams & { encoding_format: 'float' };

/** The `/v1/embeddings` body for `req`. `providerOptions.openai` merges first; the port's own fields win. */
export function toOpenAiEmbeddingRequest(
  req: AiEmbeddingRequest,
  family: OpenAiFamily = OPENAI_FAMILY,
): OpenAiEmbeddingBody {
  if (req.dimensions !== undefined && !openAiEmbeddingSupportsDimensions(req.model)) {
    throw new AiError(
      'AI_INVALID_REQUEST',
      `Model "${req.model}" does not support a custom embedding length (dimensions).`,
      { details: { provider: family.providerId, model: req.model, dimensions: req.dimensions } },
    );
  }

  const escapeHatch = (req.providerOptions?.[family.providerId] ?? {}) as Partial<EmbeddingCreateParams>;

  return {
    ...escapeHatch,
    model: req.model,
    input: req.input,
    ...(req.dimensions !== undefined ? { dimensions: req.dimensions } : {}),
    encoding_format: 'float',
  };
}

export interface FromOpenAiEmbeddingOptions {
  request: AiEmbeddingRequest;
  providerRequestId?: string | null;
  /** Which OpenAI-family provider answered (#448); OpenAI by default. */
  family?: OpenAiFamily;
}

/**
 * The neutral result. Vectors are ordered by OpenAI's `index` (never trusted
 * to already be in order), and the answer must hold exactly one vector per
 * input, all the same length — anything else is a provider fault
 * (`AI_PROVIDER_UNAVAILABLE`), not something to hand a caller who will store
 * it next to a row.
 */
export function fromOpenAiEmbeddingResponse(
  data: CreateEmbeddingResponse,
  opts: FromOpenAiEmbeddingOptions,
): AiEmbeddingResult {
  const family = opts.family ?? OPENAI_FAMILY;
  const expected = typeof opts.request.input === 'string' ? 1 : opts.request.input.length;
  const items = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
  const vectors = items.map((item) => item.embedding);
  const dimensions = vectors[0]?.length ?? 0;

  const malformed =
    vectors.length !== expected ||
    dimensions === 0 ||
    vectors.some((vector) => !Array.isArray(vector) || vector.length !== dimensions);

  if (malformed) {
    throw new AiError('AI_PROVIDER_UNAVAILABLE', `${family.label} returned a malformed embeddings response.`, {
      details: {
        provider: family.providerId,
        expected,
        received: vectors.length,
        ...(opts.providerRequestId ? { providerRequestId: opts.providerRequestId } : {}),
      },
    });
  }

  return {
    provider: family.providerId,
    model: data.model || opts.request.model,
    vectors,
    dimensions,
    usage: typeof data.usage?.prompt_tokens === 'number' ? { inputTokens: data.usage.prompt_tokens } : {},
    ...(opts.providerRequestId ? { providerRequestId: opts.providerRequestId } : {}),
  };
}
