// Runs the #424 conformance kit against the Gemini adapter (issue #447).
//
// The transport is MOCKED: `GeminiMockServer.fetch` is injected into the real
// SDK, so the SDK's request building, error class and SSE parsing all run —
// only the network is fake. The mock is as stateless as the real API (a
// function response must immediately follow its function call, one response
// per call), so the tool round-trip passes only because the kit — reading
// the adapter's declared `supportsPreviousResponseId: false` — resends the
// conversation. The Gemini 3 subject additionally proves `thoughtSignature`
// replay: that mock refuses a function-call turn whose signature did not come
// back. No scenario is skipped; the kit checks `responses` and `embeddings`.

import { AiProviderRegistry } from '../../core/provider-registry';
import { describeAiProviderConformance } from '../../testing/conformance';
import { GeminiClientFactory } from './gemini-client.factory';
import { GeminiProviderAdapter } from './gemini.adapter';
import { functionCallPart, responseFixture, signature, textPart, thoughtPart } from './testing/gemini-fixtures';
import { GeminiMockServer, MockGeminiReply } from './testing/gemini-mock-transport';

const VALID_KEY = 'AIzaSy-conformance-valid-000000000000';
const INVALID_KEY = 'AIzaSy-conformance-revoked-0000000000';
const MODEL = 'gemini-2.5-flash';
const GEMINI_3 = 'gemini-3-pro-preview';
const LEGACY = 'gemini-2.0-flash';
const EMBEDDING = 'gemini-embedding-001';
const BROKEN = 'gemini-2.5-flash-broken';
const BROKEN_EMBEDDING = 'gemini-embedding-001-broken';

function reply(model: string, parts: Parameters<typeof responseFixture>[0]['parts']): MockGeminiReply {
  return { kind: 'response', response: responseFixture({ model, parts }), chunkSize: 5 };
}

/**
 * Answers the kit's canonical requests the way the real API would: a JSON
 * answer under a response schema, a function call when tools are offered
 * (named and signed on Gemini 3, as the real API does), a final answer once
 * the function's response is in the (resent) history, and a 503 for the
 * "broken" model.
 */
function respond(body: Record<string, unknown>, model: string): MockGeminiReply {
  if (model === BROKEN) {
    return { kind: 'error', status: 503, grpcStatus: 'UNAVAILABLE', message: 'The model is overloaded.' };
  }

  const generation = (body.generationConfig ?? {}) as Record<string, unknown>;
  const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  const last = contents[contents.length - 1];
  const gemini3 = model.startsWith('gemini-3');

  if (generation.responseMimeType === 'application/json') {
    return reply(model, [textPart(JSON.stringify({ city: 'Paris', population: 2_100_000 }))]);
  }

  if (last.parts.some((part) => part.functionResponse)) {
    return reply(model, [textPart('It is 21°C and sunny in Paris.', gemini3 ? signature() : undefined)]);
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return reply(model, [
      ...(gemini3 ? [thoughtPart('The user wants the weather; I should call the tool.')] : []),
      textPart('Let me check.'),
      functionCallPart('get_weather', { city: 'Paris' }, gemini3 ? { id: 'fc_1', thoughtSignature: signature() } : {}),
    ]);
  }

  return reply(model, [textPart('Hello there, it is lovely to meet you!')]);
}

const MODELS = [
  MODEL,
  GEMINI_3,
  LEGACY,
  BROKEN,
  { id: EMBEDDING, kind: 'embedding' as const },
  { id: BROKEN_EMBEDDING, kind: 'embedding' as const },
];

function embedError(model: string): MockGeminiReply | null {
  return model === BROKEN_EMBEDDING
    ? { kind: 'error', status: 500, grpcStatus: 'INTERNAL', message: 'An internal error has occurred.' }
    : null;
}

describeAiProviderConformance('GeminiProviderAdapter (mocked transport)', () => {
  const server = new GeminiMockServer({ validKeys: [VALID_KEY], models: MODELS, respond, embedError });

  return {
    adapter: new GeminiProviderAdapter(new AiProviderRegistry(), new GeminiClientFactory({ fetch: server.fetch })),
    ctx: { apiKey: VALID_KEY, requestId: 'conformance-gemini' },
    fixtures: {
      invalidApiKey: INVALID_KEY,
      expectedModelIds: [MODEL, GEMINI_3, EMBEDDING],
      classify: {
        known: [MODEL, GEMINI_3, LEGACY, 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-3-flash-preview', 'gemini-1.5-pro-002', EMBEDDING, 'text-embedding-004'],
        unknown: ['gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'imagen-4.0-generate-001', 'gemma-3-27b-it', 'not-a-gemini-model'],
      },
      responses: {
        // Gemini 2.0 Flash has no thinking, so an effort is refused before any call.
        model: MODEL,
        unsupportedRequest: { model: LEGACY, input: 'think hard', reasoning: { effort: 'high' } },
        failingRequest: { model: BROKEN, input: 'anything' },
      },
      embeddings: {
        model: EMBEDDING,
        shortenTo: 256,
        failingRequest: { model: BROKEN_EMBEDDING, input: 'anything' },
      },
    },
  };
});

describeAiProviderConformance('GeminiProviderAdapter, Gemini 3 thought signatures (mocked transport)', () => {
  const server = new GeminiMockServer({ validKeys: [VALID_KEY], models: MODELS, respond, embedError });

  return {
    adapter: new GeminiProviderAdapter(new AiProviderRegistry(), new GeminiClientFactory({ fetch: server.fetch })),
    ctx: { apiKey: VALID_KEY, requestId: 'conformance-gemini-3' },
    fixtures: {
      invalidApiKey: INVALID_KEY,
      expectedModelIds: [GEMINI_3],
      classify: { known: [GEMINI_3], unknown: ['veo-3.0-generate-001'] },
      responses: {
        model: GEMINI_3,
        // No hosted tool is mapped (`supportsHostedTools: false`).
        unsupportedRequest: { model: GEMINI_3, input: 'search the web', tools: [{ type: 'web_search' }] },
        failingRequest: { model: BROKEN, input: 'anything' },
      },
      // The embeddings port is the adapter's, not the model's: the same fixture as above.
      embeddings: {
        model: EMBEDDING,
        failingRequest: { model: BROKEN_EMBEDDING, input: 'anything' },
      },
    },
  };
});
