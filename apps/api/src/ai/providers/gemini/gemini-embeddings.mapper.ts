// =============================================================================
// Gemini embeddings mapper (issue #447, epic #421)
// =============================================================================
//
// AiEmbeddingRequest <-> `embedContent` (on the Gemini API the SDK sends it as
// `models/{model}:batchEmbedContents`, one request per input). Pure
// functions; every failure is an `AiError`, never an SDK error. The contract
// mirrors `openai-embeddings.mapper.ts`:
//
//   - ONE CONTENT PER INPUT. Every input is sent as its own `Content`
//     (`{ role: 'user', parts: [{ text }] }`), never as a bare string array:
//     for a multimodal embedding model (`gemini-embedding-2`) the SDK folds a
//     string array into ONE content with several parts — one vector for the
//     whole batch — which would break "one vector per input, in order".
//   - `dimensions` -> `outputDimensionality` (Matryoshka truncation). Every
//     embedding family this adapter classifies accepts it; an id the
//     classifier knows NOT to (none today) is refused here, and an unknown id
//     passes through — Gemini is the authority, and its 400 maps to
//     `AI_INVALID_REQUEST` anyway.
//   - The answer must hold exactly one vector per input, all the same
//     length; anything else is a provider fault (`AI_PROVIDER_UNAVAILABLE`).
//   - Usage: the Gemini API reports no token count for embeddings, so usage
//     is `{}`.
//
// `providerOptions.gemini` merges into the config first (e.g. a `taskType`
// such as `RETRIEVAL_DOCUMENT`); the port's own fields win.
// =============================================================================

import type { Content, EmbedContentConfig, EmbedContentResponse } from '@google/genai';

import { AiError } from '../../core/ai-error';
import type { AiEmbeddingRequest, AiEmbeddingResult } from '../../core/types/media.types';
import { GEMINI_PROVIDER_ID } from './gemini-errors';
import type { GeminiModelProfile } from './gemini-model-catalog';

export interface GeminiEmbeddingRequest {
  model: string;
  contents: Content[];
  config: EmbedContentConfig;
}

/** The `embedContent` parameters for `req` (the adapter adds the signal). */
export function toGeminiEmbeddingRequest(
  req: AiEmbeddingRequest,
  profile: GeminiModelProfile | null,
): GeminiEmbeddingRequest {
  if (profile && profile.kind !== 'embedding') {
    throw new AiError('AI_CAPABILITY_UNSUPPORTED', `Model "${req.model}" is not an embedding model.`, {
      details: { provider: GEMINI_PROVIDER_ID, model: req.model, capability: 'embeddings' },
    });
  }

  if (req.dimensions !== undefined && profile && profile.embeddingDimensions !== true) {
    throw new AiError(
      'AI_INVALID_REQUEST',
      `Model "${req.model}" does not support a custom embedding length (dimensions).`,
      { details: { provider: GEMINI_PROVIDER_ID, model: req.model, dimensions: req.dimensions } },
    );
  }

  const inputs = typeof req.input === 'string' ? [req.input] : req.input;
  const { abortSignal: _signal, ...escapeHatch } = (req.providerOptions?.[GEMINI_PROVIDER_ID] ?? {}) as Partial<
    EmbedContentConfig
  >;

  return {
    model: req.model,
    contents: inputs.map((text): Content => ({ role: 'user', parts: [{ text }] })),
    config: {
      ...escapeHatch,
      ...(req.dimensions !== undefined ? { outputDimensionality: req.dimensions } : {}),
    },
  };
}

/** The neutral result, or `AI_PROVIDER_UNAVAILABLE` for a malformed answer. */
export function fromGeminiEmbeddingResponse(
  data: EmbedContentResponse,
  request: AiEmbeddingRequest,
): AiEmbeddingResult {
  const expected = typeof request.input === 'string' ? 1 : request.input.length;
  const vectors = (data.embeddings ?? []).map((embedding) => embedding.values ?? []);
  const dimensions = vectors[0]?.length ?? 0;

  const malformed =
    vectors.length !== expected ||
    dimensions === 0 ||
    vectors.some(
      (vector) =>
        !Array.isArray(vector) ||
        vector.length !== dimensions ||
        vector.some((value) => typeof value !== 'number' || !Number.isFinite(value)),
    );

  if (malformed) {
    throw new AiError('AI_PROVIDER_UNAVAILABLE', 'Gemini returned a malformed embeddings response.', {
      details: { provider: GEMINI_PROVIDER_ID, expected, received: vectors.length },
    });
  }

  return {
    provider: GEMINI_PROVIDER_ID,
    model: request.model,
    vectors,
    dimensions,
    usage: {},
  };
}
