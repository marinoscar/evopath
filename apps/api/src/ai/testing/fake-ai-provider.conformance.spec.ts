import { AiResponseRequest } from '../core/types/responses.types';
import { describeAiProviderConformance } from './conformance';
import {
  FAKE_EMBEDDING_MODEL_CAPABILITIES,
  FAKE_IMAGE_MODEL_CAPABILITIES,
  FAKE_SPEECH_MODEL_CAPABILITIES,
  FAKE_TEXT_MODEL_CAPABILITIES,
  FAKE_TRANSCRIPTION_MODEL_CAPABILITIES,
  FakeAiProvider,
  FakeAiScriptedResponse,
} from './fake-ai-provider';

/**
 * Answers the kit's canonical requests the way a real model would. The
 * failing model throws a RAW error on purpose: the fake must wrap it, exactly
 * as a real adapter must wrap an SDK error.
 */
function conformanceScript(req: AiResponseRequest): FakeAiScriptedResponse {
  if (req.model === 'fake-broken') {
    throw new Error('socket hang up');
  }

  if (req.structuredOutput) {
    return { outputText: JSON.stringify({ city: 'Paris', population: 2_100_000 }) };
  }

  const input = Array.isArray(req.input) ? req.input : [];

  if (input.some((item) => item.type === 'function_call_output')) {
    return { outputText: 'It is 21°C and sunny in Paris.' };
  }

  if (req.tools?.some((tool) => tool.type === 'function')) {
    return {
      output: [{ type: 'function_call', callId: 'call_fake_1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
    };
  }

  return { outputText: 'Hello there, it is lovely to meet you!' };
}

describeAiProviderConformance('FakeAiProvider', () => ({
  adapter: new FakeAiProvider({
    models: ['fake-model', 'fake-model-mini'],
    validKeys: ['fake-valid-key'],
    responses: conformanceScript,
  }),
  ctx: { apiKey: 'fake-valid-key', requestId: 'conformance-1' },
  fixtures: {
    invalidApiKey: 'fake-invalid-key',
    expectedModelIds: ['fake-model'],
    classify: { known: ['fake-model', 'fake-model-mini'], unknown: ['some-other-model'] },
    responses: {
      model: 'fake-model',
      // The fake declares no hosted tools.
      unsupportedRequest: { model: 'fake-model', input: 'search the web', tools: [{ type: 'web_search' }] },
      failingRequest: { model: 'fake-broken', input: 'anything' },
    },
  },
}));

describeAiProviderConformance('FakeAiProvider with its embeddings port', () => ({
  adapter: new FakeAiProvider({
    models: ['fake-model', 'fake-embedding-model'],
    validKeys: ['fake-valid-key'],
    responses: conformanceScript,
    embeddingsPort: true,
    classify: (id) =>
      id === 'fake-embedding-model' ? FAKE_EMBEDDING_MODEL_CAPABILITIES : id === 'fake-model' ? FAKE_TEXT_MODEL_CAPABILITIES : null,
  }),
  ctx: { apiKey: 'fake-valid-key', requestId: 'conformance-3' },
  fixtures: {
    invalidApiKey: 'fake-invalid-key',
    classify: { known: ['fake-model', 'fake-embedding-model'], unknown: ['nope'] },
    responses: {
      model: 'fake-model',
      unsupportedRequest: { model: 'fake-model', input: 'search the web', tools: [{ type: 'web_search' }] },
      failingRequest: { model: 'fake-broken', input: 'anything' },
    },
    embeddings: {
      model: 'fake-embedding-model',
      shortenTo: 4,
      // A model classified without `embeddings` is refused as an AiError.
      failingRequest: { model: 'fake-model', input: 'anything' },
    },
  },
}));

describeAiProviderConformance('FakeAiProvider with its images port', () => ({
  adapter: new FakeAiProvider({
    models: ['fake-model', 'fake-image-model'],
    validKeys: ['fake-valid-key'],
    responses: conformanceScript,
    imagesPort: true,
    classify: (id) =>
      id === 'fake-image-model' ? FAKE_IMAGE_MODEL_CAPABILITIES : id === 'fake-model' ? FAKE_TEXT_MODEL_CAPABILITIES : null,
  }),
  ctx: { apiKey: 'fake-valid-key', requestId: 'conformance-4' },
  fixtures: {
    invalidApiKey: 'fake-invalid-key',
    classify: { known: ['fake-model', 'fake-image-model'], unknown: ['nope'] },
    responses: {
      model: 'fake-model',
      unsupportedRequest: { model: 'fake-model', input: 'search the web', tools: [{ type: 'web_search' }] },
      failingRequest: { model: 'fake-broken', input: 'anything' },
    },
    images: {
      model: 'fake-image-model',
      // A model classified without `image_generation` is refused as an AiError.
      failingRequest: { model: 'fake-model', prompt: 'anything' },
    },
  },
}));

describeAiProviderConformance('FakeAiProvider with its audio port', () => ({
  adapter: new FakeAiProvider({
    models: ['fake-model', 'fake-transcription-model', 'fake-speech-model'],
    validKeys: ['fake-valid-key'],
    responses: conformanceScript,
    audioPort: true,
    transcriptionMaxBytes: 1024 * 1024,
    classify: (id) =>
      id === 'fake-transcription-model'
        ? FAKE_TRANSCRIPTION_MODEL_CAPABILITIES
        : id === 'fake-speech-model'
          ? FAKE_SPEECH_MODEL_CAPABILITIES
          : id === 'fake-model'
          ? FAKE_TEXT_MODEL_CAPABILITIES
          : null,
  }),
  ctx: { apiKey: 'fake-valid-key', requestId: 'conformance-5' },
  fixtures: {
    invalidApiKey: 'fake-invalid-key',
    classify: { known: ['fake-model', 'fake-transcription-model', 'fake-speech-model'], unknown: ['nope'] },
    responses: {
      model: 'fake-model',
      unsupportedRequest: { model: 'fake-model', input: 'search the web', tools: [{ type: 'web_search' }] },
      failingRequest: { model: 'fake-broken', input: 'anything' },
    },
    transcription: {
      model: 'fake-transcription-model',
      // A model classified without `audio_transcription` is refused as an AiError.
      failingModel: 'fake-model',
    },
    speech: {
      model: 'fake-speech-model',
      voice: 'alloy',
      // A model classified without `audio_speech` is refused as an AiError.
      failingModel: 'fake-model',
    },
  },
}));

describeAiProviderConformance('FakeAiProvider without a responses port', () => ({
  adapter: new FakeAiProvider({ responsesPort: false }),
  ctx: { apiKey: 'any-key', requestId: 'conformance-2' },
  fixtures: {
    invalidApiKey: '',
    classify: { known: ['fake-model'], unknown: ['nope'] },
  },
}));
