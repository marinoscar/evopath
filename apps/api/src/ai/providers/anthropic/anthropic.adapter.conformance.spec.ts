// Runs the #424 conformance kit against the Anthropic adapter (issue #446).
//
// The transport is MOCKED: `AnthropicMockServer.fetch` is injected into the
// real SDK, so the SDK's request building, error classes and SSE parsing all
// run — only the network is fake. The mock is as stateless as the real API
// (a `tool_result` must follow its `tool_use`), so the tool round-trip passes
// only because the kit — reading the adapter's declared
// `supportsPreviousResponseId: false` — resends the conversation. No
// scenario is skipped; the kit has no ports to check beyond `responses`.

import { AiProviderRegistry } from '../../core/provider-registry';
import { describeAiProviderConformance } from '../../testing/conformance';
import { AnthropicClientFactory } from './anthropic-client.factory';
import { AnthropicProviderAdapter } from './anthropic.adapter';
import { messageFixture, textBlock, toolUseBlock } from './testing/anthropic-fixtures';
import { AnthropicMockServer, MockAnthropicReply } from './testing/anthropic-mock-transport';

const VALID_KEY = 'sk-ant-api03-conformance-valid-0000';
const INVALID_KEY = 'sk-ant-api03-conformance-revoked-00';
const MODEL = 'claude-sonnet-4-5-20250929';
const NATIVE_SCHEMA_MODEL = 'claude-opus-5';
const BROKEN_MODEL = 'claude-sonnet-4-5-broken';

function reply(model: string, content: Parameters<typeof messageFixture>[0]['content']): MockAnthropicReply {
  return { kind: 'message', message: messageFixture({ model, content }), chunkSize: 5 };
}

/**
 * Answers the kit's canonical requests the way the real API would: the forced
 * structured-output tool is called with the answer, a function tool is
 * called when offered, a final answer comes once the tool's result is in the
 * (resent) history, and the "broken" model is a 529 overload.
 */
function respond(body: Record<string, unknown>): MockAnthropicReply {
  const model = String(body.model);

  if (model === BROKEN_MODEL) {
    return { kind: 'error', status: 529, type: 'overloaded_error', message: 'Overloaded' };
  }

  const toolChoice = body.tool_choice as { type?: string; name?: string } | undefined;
  const format = (body.output_config as { format?: { type?: string } } | undefined)?.format;
  const messages = body.messages as Array<{ role: string; content: Array<{ type: string }> }>;
  const last = messages[messages.length - 1];

  if (format?.type === 'json_schema') {
    return reply(model, [textBlock(JSON.stringify({ city: 'Paris', population: 2_100_000 }))]);
  }

  if (toolChoice?.type === 'tool' && toolChoice.name === 'city_facts') {
    return reply(model, [toolUseBlock('city_facts', { city: 'Paris', population: 2_100_000 })]);
  }

  if (last.content.some((block) => block.type === 'tool_result')) {
    return reply(model, [textBlock('It is 21°C and sunny in Paris.')]);
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return reply(model, [textBlock('Let me check.'), toolUseBlock('get_weather', { city: 'Paris' })]);
  }

  return reply(model, [textBlock('Hello there, it is lovely to meet you!')]);
}

describeAiProviderConformance('AnthropicProviderAdapter (mocked transport)', () => {
  const server = new AnthropicMockServer({
    validKeys: [VALID_KEY],
    models: [MODEL, NATIVE_SCHEMA_MODEL, 'claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022'],
    respond,
  });

  return {
    adapter: new AnthropicProviderAdapter(new AiProviderRegistry(), new AnthropicClientFactory({ fetch: server.fetch })),
    ctx: { apiKey: VALID_KEY, requestId: 'conformance-anthropic' },
    fixtures: {
      invalidApiKey: INVALID_KEY,
      expectedModelIds: [MODEL, NATIVE_SCHEMA_MODEL],
      classify: {
        known: [MODEL, NATIVE_SCHEMA_MODEL, 'claude-opus-4-1-20250805', 'claude-3-7-sonnet-20250219', 'claude-3-haiku-20240307', 'claude-fable-5-1'],
        unknown: ['claude-2.1', 'claude-instant-1.2', 'not-a-claude-model'],
      },
      responses: {
        // Sonnet 4.5 is the forced-tool structured-output path; Claude 3.5
        // Haiku has no extended thinking, so an effort is refused before any call.
        model: MODEL,
        unsupportedRequest: { model: 'claude-3-5-haiku-20241022', input: 'think hard', reasoning: { effort: 'high' } },
        failingRequest: { model: BROKEN_MODEL, input: 'anything' },
      },
    },
  };
});

describeAiProviderConformance('AnthropicProviderAdapter, native structured outputs (mocked transport)', () => {
  const server = new AnthropicMockServer({ validKeys: [VALID_KEY], models: [NATIVE_SCHEMA_MODEL], respond });

  return {
    adapter: new AnthropicProviderAdapter(new AiProviderRegistry(), new AnthropicClientFactory({ fetch: server.fetch })),
    ctx: { apiKey: VALID_KEY, requestId: 'conformance-anthropic-native' },
    fixtures: {
      invalidApiKey: INVALID_KEY,
      expectedModelIds: [NATIVE_SCHEMA_MODEL],
      classify: { known: [NATIVE_SCHEMA_MODEL], unknown: ['claude-2.0'] },
      responses: {
        model: NATIVE_SCHEMA_MODEL,
        // Opus 5 rejects sampling parameters.
        unsupportedRequest: { model: NATIVE_SCHEMA_MODEL, input: 'hi', temperature: 0.2 },
        failingRequest: { model: BROKEN_MODEL, input: 'anything' },
      },
    },
  };
});
