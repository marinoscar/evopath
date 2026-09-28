// Runs the #424 conformance kit against the OpenAI-compatible adapter (#448),
// in both API styles.
//
// The transport is MOCKED: `OpenAiMockServer.fetch` is injected into the real
// OpenAI SDK (through the redirect guard), so the SDK's request building,
// error classes and SSE parsing all run; only the network is fake.
//
// SKIPPED, with reason:
//   - `classifyModel`: the kit needs at least one id the adapter classifies,
//     and this adapter classifies none BY DESIGN — a compatible server's ids
//     carry no capability, so every model is `unclassified` for an
//     administrator to declare. `openai-compatible.adapter.spec.ts` pins the
//     `null` answer instead.
// The kit skips the ports this adapter does not carry (images, audio).

import type { AiResponseRequest } from '../../core/types/responses.types';
import { AiProviderRegistry } from '../../core/provider-registry';
import { describeAiProviderConformance } from '../../testing/conformance';
import { conformanceChatResponder, conformanceResponsesResponder } from '../openai/testing/conformance-responders';
import { OpenAiMockServer, mockEmbeddingsBody } from '../openai/testing/openai-mock-transport';
import { OpenAiCompatibleClientFactory } from './openai-compatible-client.factory';
import { OpenAiCompatibleProviderAdapter } from './openai-compatible.adapter';

const VALID_KEY = 'vllm-conformance-valid-000000';
const INVALID_KEY = 'vllm-conformance-revoked-0000';
const BASE_URL = 'http://vllm.internal:8000/v1';
const MODEL = 'meta-llama/Llama-3.1-8B-Instruct';
const BROKEN_MODEL = 'broken-model';
const EMBEDDING_MODEL = 'nomic-embed-text';
const BROKEN_EMBEDDING_MODEL = 'nomic-embed-broken';

const SERVER_ERROR = { message: 'The server had an error.', type: 'server_error', param: null, code: null };

/** What each style refuses: an effort (Chat Completions has none), or a hosted tool (never run here). */
const UNSUPPORTED: Record<'chat_completions' | 'responses', AiResponseRequest> = {
  chat_completions: { model: MODEL, input: 'think hard', reasoning: { effort: 'high' } },
  responses: { model: MODEL, input: 'search', tools: [{ type: 'web_search' }] },
};

for (const apiStyle of ['chat_completions', 'responses'] as const) {
  describeAiProviderConformance(
    `OpenAiCompatibleProviderAdapter, ${apiStyle} (mocked transport)`,
    () => {
      const server = new OpenAiMockServer({
        validKeys: [VALID_KEY],
        models: [MODEL, EMBEDDING_MODEL],
        respond: conformanceResponsesResponder(MODEL, BROKEN_MODEL),
        chat: conformanceChatResponder(MODEL, BROKEN_MODEL),
        embed: (body) =>
          body.model === BROKEN_EMBEDDING_MODEL
            ? { kind: 'error', status: 500, error: SERVER_ERROR }
            : { kind: 'embeddings', body: mockEmbeddingsBody(body) },
      });

      return {
        adapter: new OpenAiCompatibleProviderAdapter(
          new AiProviderRegistry(),
          new OpenAiCompatibleClientFactory({ fetch: server.fetch }),
        ),
        ctx: { apiKey: VALID_KEY, baseUrl: BASE_URL, providerSettings: { apiStyle }, requestId: `conformance-compat-${apiStyle}` },
        fixtures: {
          invalidApiKey: INVALID_KEY,
          expectedModelIds: [MODEL, EMBEDDING_MODEL],
          classify: { known: [], unknown: [MODEL, EMBEDDING_MODEL, 'gpt-4o'] },
          responses: {
            model: MODEL,
            unsupportedRequest: UNSUPPORTED[apiStyle],
            failingRequest: { model: BROKEN_MODEL, input: 'anything' },
          },
          embeddings: {
            model: EMBEDDING_MODEL,
            shortenTo: 256,
            failingRequest: { model: BROKEN_EMBEDDING_MODEL, input: 'anything' },
          },
        },
      };
    },
    { skip: ['classifyModel'] },
  );
}
