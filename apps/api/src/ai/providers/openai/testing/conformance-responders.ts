// Mock-server responders that answer the conformance kit's canonical requests
// the way a real OpenAI-family server would (#426, shared by #448). Not
// imported by production code.
//
//   - a "broken" model answers 500;
//   - a json_schema format answers a JSON document matching the kit's schema;
//   - a request carrying a tool's output answers a final message;
//   - a request offering a function tool answers a call to it;
//   - anything else answers a greeting.

import type { Response as OpenAiSdkResponse } from 'openai/resources/responses/responses';

import { chatCompletionFixture } from './chat-completions-fixtures';
import { functionCallItem, messageItem, responseFixture } from './openai-fixtures';
import type { MockChatReply, MockReply } from './openai-mock-transport';

const SERVER_ERROR = { message: 'The server had an error.', type: 'server_error', param: null, code: null };

export const CONFORMANCE_STRUCTURED_ANSWER = JSON.stringify({ city: 'Paris', population: 2_100_000 });

function reply(response: OpenAiSdkResponse): MockReply {
  return { kind: 'response', response, chunkSize: 5 };
}

/** `POST /responses`. */
export function conformanceResponsesResponder(model: string, brokenModel: string) {
  return (body: Record<string, unknown>): MockReply => {
    if (body.model === brokenModel) return { kind: 'error', status: 500, error: SERVER_ERROR };

    const input = Array.isArray(body.input) ? (body.input as Array<{ type?: string }>) : [];
    const format = (body.text as { format?: { type?: string } } | undefined)?.format;

    if (format?.type === 'json_schema') {
      return reply(responseFixture({ model, output: [messageItem(CONFORMANCE_STRUCTURED_ANSWER)] }));
    }

    if (input.some((item) => item.type === 'function_call_output')) {
      return reply(responseFixture({ model, output: [messageItem('It is 21°C and sunny in Paris.')] }));
    }

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      return reply(responseFixture({ model, output: [functionCallItem('get_weather', '{"city":"Paris"}')] }));
    }

    return reply(responseFixture({ model, output: [messageItem('Hello there, it is lovely to meet you!')] }));
  };
}

/** `POST /chat/completions`. */
export function conformanceChatResponder(model: string, brokenModel: string) {
  return (body: Record<string, unknown>): MockChatReply => {
    if (body.model === brokenModel) return { kind: 'error', status: 500, error: SERVER_ERROR };

    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string }>) : [];
    const format = body.response_format as { type?: string } | undefined;
    const completion = (opts: Parameters<typeof chatCompletionFixture>[0]): MockChatReply => ({
      kind: 'completion',
      completion: chatCompletionFixture({ model, ...opts }),
      chunkSize: 5,
    });

    if (format?.type === 'json_schema') return completion({ content: CONFORMANCE_STRUCTURED_ANSWER });

    if (messages.some((message) => message.role === 'tool')) {
      return completion({ content: 'It is 21°C and sunny in Paris.' });
    }

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      return completion({ content: null, toolCalls: [{ name: 'get_weather', arguments: '{"city":"Paris"}' }] });
    }

    return completion({ content: 'Hello there, it is lovely to meet you!' });
  };
}
