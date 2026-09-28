// Runs the #424 conformance kit against the Azure OpenAI adapter (#448), in
// both API styles.
//
// The transport is MOCKED: `OpenAiMockServer.fetch` is injected into the real
// `AzureOpenAI` SDK client (through the redirect guard), so the SDK's Azure
// request building — `api-key` header, `api-version` query, deployment paths
// — its error classes and its SSE parsing all run; only the network is fake.
// The mock checks the `api-key` header, not a bearer token.
//
// Every scenario runs; the kit skips the ports Azure does not carry (images,
// audio) by itself.

import { AiProviderRegistry } from '../../core/provider-registry';
import { describeAiProviderConformance } from '../../testing/conformance';
import { conformanceChatResponder, conformanceResponsesResponder } from '../openai/testing/conformance-responders';
import { OpenAiMockServer, mockEmbeddingsBody } from '../openai/testing/openai-mock-transport';
import { AzureOpenAiClientFactory } from './azure-openai-client.factory';
import { AzureOpenAiProviderAdapter } from './azure-openai.adapter';

const VALID_KEY = 'azure-conformance-valid-0000000000';
const INVALID_KEY = 'azure-conformance-revoked-00000000';
const ENDPOINT = 'https://contoso.openai.azure.com';
const MODEL = 'gpt-4o-2024-08-06';
const BROKEN_MODEL = 'gpt-4o-broken';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const BROKEN_EMBEDDING_MODEL = 'text-embedding-3-broken';

const SERVER_ERROR = { message: 'The server had an error.', type: 'server_error', param: null, code: null };

for (const apiStyle of ['responses', 'chat_completions'] as const) {
  describeAiProviderConformance(`AzureOpenAiProviderAdapter, ${apiStyle} (mocked transport)`, () => {
    const server = new OpenAiMockServer({
      auth: 'api-key',
      validKeys: [VALID_KEY],
      models: [MODEL, 'gpt-4o-mini', EMBEDDING_MODEL],
      // The wire model is the DEPLOYMENT: the broken model has none, so it is sent as itself.
      respond: conformanceResponsesResponder(MODEL, BROKEN_MODEL),
      chat: conformanceChatResponder(MODEL, BROKEN_MODEL),
      embed: (body) =>
        body.model === BROKEN_EMBEDDING_MODEL
          ? { kind: 'error', status: 500, error: SERVER_ERROR }
          : { kind: 'embeddings', body: mockEmbeddingsBody(body) },
    });

    return {
      adapter: new AzureOpenAiProviderAdapter(new AiProviderRegistry(), new AzureOpenAiClientFactory({ fetch: server.fetch })),
      ctx: {
        apiKey: VALID_KEY,
        baseUrl: ENDPOINT,
        providerSettings: { apiStyle, deployments: { [MODEL]: 'prod-4o', [EMBEDDING_MODEL]: EMBEDDING_MODEL } },
        requestId: `conformance-azure-${apiStyle}`,
      },
      fixtures: {
        invalidApiKey: INVALID_KEY,
        // With a deployments map, its keys are the model list.
        expectedModelIds: [MODEL, EMBEDDING_MODEL],
        classify: {
          known: [MODEL, 'gpt-5', 'o3-mini', 'text-embedding-3-large'],
          unknown: ['gpt-35-turbo', 'not-an-openai-model'],
        },
        responses: {
          model: MODEL,
          // gpt-4o does not reason (responses style), and Chat Completions takes no effort at all.
          unsupportedRequest: { model: MODEL, input: 'think hard', reasoning: { effort: 'high' } },
          failingRequest: { model: BROKEN_MODEL, input: 'anything' },
        },
        embeddings: {
          model: EMBEDDING_MODEL,
          shortenTo: 256,
          failingRequest: { model: BROKEN_EMBEDDING_MODEL, input: 'anything' },
        },
      },
    };
  });
}
