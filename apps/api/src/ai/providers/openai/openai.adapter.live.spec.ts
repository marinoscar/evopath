// OPTIONAL live smoke test against the real OpenAI API (issue #426).
//
// Skipped unless OPENAI_API_KEY_FOR_TESTS is set — never in CI, and the
// variable is deliberately NOT in infra/compose/.env.example: this
// application has no OpenAI environment configuration (keys are runtime
// settings, docs/specs/ai-platform.md). To run it locally:
//
//   OPENAI_API_KEY_FOR_TESTS=sk-... \
//   [OPENAI_MODEL_FOR_TESTS=gpt-4o-mini] \
//   npx jest --config ./test/jest.config.js openai.adapter.live
//
// It costs a few cents of tokens per run.

import { AiProviderRegistry } from '../../core/provider-registry';
import { describeAiProviderConformance } from '../../testing/conformance';
import { OpenAiClientFactory } from './openai-client.factory';
import { OpenAiProviderAdapter } from './openai.adapter';

const LIVE_KEY = process.env.OPENAI_API_KEY_FOR_TESTS;
const LIVE_MODEL = process.env.OPENAI_MODEL_FOR_TESTS ?? 'gpt-4o-mini';

if (LIVE_KEY) {
  jest.setTimeout(120_000);

  describeAiProviderConformance('OpenAiProviderAdapter (LIVE)', () => ({
    adapter: new OpenAiProviderAdapter(new AiProviderRegistry(), new OpenAiClientFactory()),
    ctx: { apiKey: LIVE_KEY, requestId: 'live-smoke' },
    fixtures: {
      invalidApiKey: 'sk-proj-definitely-not-a-valid-key-000000000000',
      expectedModelIds: [LIVE_MODEL],
      classify: { known: [LIVE_MODEL], unknown: ['not-an-openai-model'] },
      responses: {
        model: LIVE_MODEL,
        unsupportedRequest: { model: LIVE_MODEL, input: 'search the web', tools: [{ type: 'web_search' }] },
        // An unknown model is a real 404 from OpenAI.
        failingRequest: { model: 'no-such-model-for-conformance', input: 'anything' },
      },
    },
  }));
} else {
  describe.skip('OpenAiProviderAdapter (LIVE) — set OPENAI_API_KEY_FOR_TESTS to run', () => {
    it('is skipped without a key', () => undefined);
  });
}
