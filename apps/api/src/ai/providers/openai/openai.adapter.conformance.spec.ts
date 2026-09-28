// Runs the #424 conformance kit against the OpenAI adapter (issue #426).
//
// The transport is MOCKED: `OpenAiMockServer.fetch` is injected into the real
// SDK, so the SDK's request building, error classes and SSE parsing all run —
// only the network is fake. No scenario is skipped.

import type { Response as OpenAiSdkResponse } from 'openai/resources/responses/responses';

import { AiProviderRegistry } from '../../core/provider-registry';
import { describeAiProviderConformance } from '../../testing/conformance';
import { OpenAiClientFactory } from './openai-client.factory';
import { OpenAiProviderAdapter } from './openai.adapter';
import { functionCallItem, messageItem, responseFixture } from './testing/openai-fixtures';
import {
  MockReply,
  OpenAiMockServer,
  mockEmbeddingsBody,
  mockImagesBody,
  mockSpeechBytes,
  mockTranscriptionBody,
} from './testing/openai-mock-transport';

const VALID_KEY = 'sk-proj-conformance-valid-000000';
const INVALID_KEY = 'sk-proj-conformance-revoked-0000';
const MODEL = 'gpt-4o-2024-08-06';
const BROKEN_MODEL = 'gpt-4o-broken';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const BROKEN_EMBEDDING_MODEL = 'text-embedding-3-broken';
const IMAGE_MODEL = 'gpt-image-1';
const BROKEN_IMAGE_MODEL = 'gpt-image-broken';
const TRANSCRIPTION_MODEL = 'whisper-1';
const BROKEN_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe-broken';
const SPEECH_MODEL = 'gpt-4o-mini-tts';
const BROKEN_SPEECH_MODEL = 'gpt-4o-mini-tts-broken';

function reply(response: OpenAiSdkResponse): MockReply {
  return { kind: 'response', response, chunkSize: 5 };
}

/**
 * Answers the kit's canonical requests the way the real API would: a JSON
 * document for a json_schema format, a function call when a function tool
 * is offered, a final answer once the tool's output comes back, and a 500
 * for the "broken" model.
 */
function respond(body: Record<string, unknown>): MockReply {
  if (body.model === BROKEN_MODEL) {
    return { kind: 'error', status: 500, error: { message: 'The server had an error.', type: 'server_error', param: null, code: null } };
  }

  const input = Array.isArray(body.input) ? (body.input as Array<{ type?: string }>) : [];
  const format = (body.text as { format?: { type?: string } } | undefined)?.format;

  if (format?.type === 'json_schema') {
    return reply(responseFixture({ model: MODEL, output: [messageItem(JSON.stringify({ city: 'Paris', population: 2_100_000 }))] }));
  }

  if (input.some((item) => item.type === 'function_call_output')) {
    return reply(responseFixture({ model: MODEL, output: [messageItem('It is 21°C and sunny in Paris.')] }));
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return reply(responseFixture({ model: MODEL, output: [functionCallItem('get_weather', '{"city":"Paris"}')] }));
  }

  return reply(responseFixture({ model: MODEL, output: [messageItem('Hello there, it is lovely to meet you!')] }));
}

describeAiProviderConformance('OpenAiProviderAdapter (mocked transport)', () => {
  const server = new OpenAiMockServer({
    validKeys: [VALID_KEY],
    models: [MODEL, 'gpt-4o-mini', 'o3', 'text-embedding-3-small', 'whisper-1'],
    respond,
    embed: (body) =>
      body.model === BROKEN_EMBEDDING_MODEL
        ? { kind: 'error', status: 500, error: { message: 'The server had an error.', type: 'server_error', param: null, code: null } }
        : { kind: 'embeddings', body: mockEmbeddingsBody(body) },
    images: (_operation, body) =>
      body.model === BROKEN_IMAGE_MODEL
        ? { kind: 'error', status: 500, error: { message: 'The server had an error.', type: 'server_error', param: null, code: null } }
        : { kind: 'images', body: mockImagesBody(body) },
    transcribe: (body) =>
      body.model === BROKEN_TRANSCRIPTION_MODEL
        ? { kind: 'error', status: 500, error: { message: 'The server had an error.', type: 'server_error', param: null, code: null } }
        : { kind: 'transcription', body: mockTranscriptionBody(body) },
    speech: (body) =>
      body.model === BROKEN_SPEECH_MODEL
        ? { kind: 'error', status: 500, error: { message: 'The server had an error.', type: 'server_error', param: null, code: null } }
        : { kind: 'speech', bytes: mockSpeechBytes(body) },
  });

  return {
    adapter: new OpenAiProviderAdapter(new AiProviderRegistry(), new OpenAiClientFactory({ fetch: server.fetch })),
    ctx: { apiKey: VALID_KEY, requestId: 'conformance-openai' },
    fixtures: {
      invalidApiKey: INVALID_KEY,
      expectedModelIds: [MODEL, 'o3'],
      classify: {
        known: [MODEL, 'gpt-5', 'o3-mini', 'gpt-image-1', 'whisper-1', 'text-embedding-3-large'],
        unknown: ['davinci-002', 'not-an-openai-model'],
      },
      responses: {
        model: MODEL,
        // gpt-4o does not reason: a reasoning effort is refused before any call.
        unsupportedRequest: { model: MODEL, input: 'think hard', reasoning: { effort: 'high' } },
        failingRequest: { model: BROKEN_MODEL, input: 'anything' },
      },
      embeddings: {
        model: EMBEDDING_MODEL,
        shortenTo: 256,
        failingRequest: { model: BROKEN_EMBEDDING_MODEL, input: 'anything' },
      },
      images: {
        model: IMAGE_MODEL,
        failingRequest: { model: BROKEN_IMAGE_MODEL, prompt: 'anything' },
      },
      transcription: {
        model: TRANSCRIPTION_MODEL,
        failingModel: BROKEN_TRANSCRIPTION_MODEL,
      },
      speech: {
        model: SPEECH_MODEL,
        voice: 'coral',
        failingModel: BROKEN_SPEECH_MODEL,
      },
    },
  };
});
