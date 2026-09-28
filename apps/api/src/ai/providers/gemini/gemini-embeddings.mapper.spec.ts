import type { EmbedContentResponse } from '@google/genai';

import { AiError } from '../../core/ai-error';
import { fromGeminiEmbeddingResponse, toGeminiEmbeddingRequest } from './gemini-embeddings.mapper';
import { geminiModelProfile } from './gemini-model-catalog';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);

    return (err as AiError).code;
  }

  throw new Error('expected an AiError');
}

describe('gemini embeddings mapper', () => {
  it('sends one content per input — never a string array a multimodal model would fold into one', () => {
    const req = toGeminiEmbeddingRequest(
      { model: 'gemini-embedding-2-preview', input: ['a', 'b'], dimensions: 256 },
      geminiModelProfile('gemini-embedding-2-preview'),
    );

    expect(req).toEqual({
      model: 'gemini-embedding-2-preview',
      contents: [
        { role: 'user', parts: [{ text: 'a' }] },
        { role: 'user', parts: [{ text: 'b' }] },
      ],
      config: { outputDimensionality: 256 },
    });
  });

  it('merges providerOptions.gemini first; the port fields win and the signal is dropped', () => {
    const req = toGeminiEmbeddingRequest(
      {
        model: 'gemini-embedding-001',
        input: 'a',
        dimensions: 128,
        providerOptions: {
          gemini: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 9, abortSignal: new AbortController().signal },
        },
      },
      geminiModelProfile('gemini-embedding-001'),
    );

    expect(req.config).toEqual({ taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 128 });
  });

  it('refuses a generative model, and passes an unclassified one through', () => {
    expect(
      codeOf(() => toGeminiEmbeddingRequest({ model: 'gemini-2.5-flash', input: 'a' }, geminiModelProfile('gemini-2.5-flash'))),
    ).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(toGeminiEmbeddingRequest({ model: 'future-embed', input: 'a', dimensions: 8 }, null).config).toEqual({
      outputDimensionality: 8,
    });
  });

  it('refuses dimensions on an embedding profile that does not accept them', () => {
    const profile = { ...geminiModelProfile('gemini-embedding-001')!, embeddingDimensions: false };

    expect(codeOf(() => toGeminiEmbeddingRequest({ model: 'x', input: 'a', dimensions: 8 }, profile))).toBe(
      'AI_INVALID_REQUEST',
    );
  });

  it('maps vectors in order with no token usage', () => {
    const data = { embeddings: [{ values: [1, 2] }, { values: [3, 4] }] } as EmbedContentResponse;

    expect(fromGeminiEmbeddingResponse(data, { model: 'gemini-embedding-001', input: ['a', 'b'] })).toEqual({
      provider: 'gemini',
      model: 'gemini-embedding-001',
      vectors: [
        [1, 2],
        [3, 4],
      ],
      dimensions: 2,
      usage: {},
    });
  });

  it.each([
    ['too few vectors', { embeddings: [{ values: [1, 2] }] }],
    ['ragged vectors', { embeddings: [{ values: [1, 2] }, { values: [3] }] }],
    ['empty vectors', { embeddings: [{ values: [] }, { values: [] }] }],
    ['a non-number', { embeddings: [{ values: [1, 'x'] }, { values: [3, 4] }] }],
    ['no embeddings at all', {}],
  ])('treats %s as a provider fault', (_label, data) => {
    expect(
      codeOf(() => fromGeminiEmbeddingResponse(data as EmbedContentResponse, { model: 'm', input: ['a', 'b'] })),
    ).toBe('AI_PROVIDER_UNAVAILABLE');
  });
});
