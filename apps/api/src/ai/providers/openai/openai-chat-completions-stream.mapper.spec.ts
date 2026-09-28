import { z } from 'zod';

import type { AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import { AiError } from '../../core/ai-error';
import { ChatCompletionsStreamMapper } from './openai-chat-completions-stream.mapper';
import { chatChunksFor, chatCompletionFixture } from './testing/chat-completions-fixtures';

const request: AiResponseRequest = { model: 'llama3', input: 'x' };

function run(mapper: ChatCompletionsStreamMapper, chunks: ReturnType<typeof chatChunksFor>): AiStreamEvent[] {
  return [...chunks.flatMap((chunk) => mapper.map(chunk)), ...mapper.finish()];
}

describe('ChatCompletionsStreamMapper', () => {
  it('streams created, text deltas, the message item and a completed response equal to create()', () => {
    const completion = chatCompletionFixture({ id: 'chatcmpl-s1', content: 'Hello there, friend!' });
    const mapper = new ChatCompletionsStreamMapper({
      request,
      providerRequestId: 'req_9',
      family: { providerId: 'azure-openai', label: 'Azure OpenAI' },
    });
    const events = run(mapper, chatChunksFor(completion, 5));

    expect(events[0]).toEqual({ type: 'response.created', id: 'chatcmpl-s1' });
    expect(
      events.filter((e) => e.type === 'output_text.delta').map((e) => (e as { delta: string }).delta).join(''),
    ).toBe('Hello there, friend!');
    expect(events.at(-2)).toEqual({ type: 'output_item.done', item: { type: 'message', text: 'Hello there, friend!' } });

    const last = events.at(-1) as Extract<AiStreamEvent, { type: 'response.completed' }>;

    expect(last.type).toBe('response.completed');
    expect(last.response).toMatchObject({
      id: 'chatcmpl-s1',
      provider: 'azure-openai',
      outputText: 'Hello there, friend!',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 7 },
      providerRequestId: 'req_9',
    });
    expect(mapper.terminated).toBe(true);
  });

  it('keys tool-call argument deltas by the call id and completes with the calls', () => {
    const completion = chatCompletionFixture({
      content: null,
      toolCalls: [
        { id: 'call_a', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { id: 'call_b', name: 'get_weather', arguments: '{"city":"Rome"}' },
      ],
    });
    const events = run(new ChatCompletionsStreamMapper({ request }), chatChunksFor(completion, 4));

    const deltas = events.filter(
      (e): e is Extract<AiStreamEvent, { type: 'function_call.arguments.delta' }> => e.type === 'function_call.arguments.delta',
    );

    expect(deltas.filter((d) => d.callId === 'call_a').map((d) => d.delta).join('')).toBe('{"city":"Paris"}');
    expect(deltas.filter((d) => d.callId === 'call_b').map((d) => d.delta).join('')).toBe('{"city":"Rome"}');

    const completed = events.at(-1) as Extract<AiStreamEvent, { type: 'response.completed' }>;

    expect(completed.response.finishReason).toBe('tool_calls');
    expect(completed.response.output).toEqual([
      { type: 'function_call', callId: 'call_a', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call', callId: 'call_b', name: 'get_weather', arguments: '{"city":"Rome"}' },
    ]);
    expect(events.filter((e) => e.type === 'output_item.done')).toHaveLength(2);
  });

  it('records no usage when the server sends no usage chunk', () => {
    const events = run(new ChatCompletionsStreamMapper({ request }), chatChunksFor(chatCompletionFixture(), 4, false));

    expect((events.at(-1) as Extract<AiStreamEvent, { type: 'response.completed' }>).response.usage).toEqual({});
  });

  it('completes nothing when the stream ended without a finish reason', () => {
    const mapper = new ChatCompletionsStreamMapper({ request });
    const chunks = chatChunksFor(chatCompletionFixture({ content: 'Hello' }), 2, false).slice(0, 2);

    for (const chunk of chunks) mapper.map(chunk);

    expect(mapper.started).toBe(true);
    expect(mapper.finished).toBe(false);
    expect(mapper.finish()).toEqual([]);
    expect(mapper.terminated).toBe(false);
  });

  it('ends with an error event when structured output does not validate', () => {
    const events = run(
      new ChatCompletionsStreamMapper({
        request: { ...request, structuredOutput: { name: 'c', schema: z.object({ city: z.string() }) } },
      }),
      chatChunksFor(chatCompletionFixture({ content: 'nope' })),
    );

    expect(events.at(-1)).toEqual({ type: 'error', code: 'AI_STRUCTURED_OUTPUT_INVALID', message: expect.any(String) });
  });

  it('emits nothing after a terminal event, and fail is idempotent', () => {
    const mapper = new ChatCompletionsStreamMapper({ request });
    const chunks = chatChunksFor(chatCompletionFixture());

    mapper.map(chunks[0]);

    expect(mapper.fail(new AiError('AI_PROVIDER_UNAVAILABLE', 'x'))).toEqual([
      { type: 'error', code: 'AI_PROVIDER_UNAVAILABLE', message: 'x' },
    ]);
    expect(mapper.fail(new AiError('AI_PROVIDER_UNAVAILABLE', 'x'))).toEqual([]);
    expect(mapper.map(chunks[1])).toEqual([]);
    expect(mapper.finish()).toEqual([]);
  });

  it('invents an id when the server sends none', () => {
    const chunk = { ...chatChunksFor(chatCompletionFixture())[0], id: '' };

    expect(new ChatCompletionsStreamMapper({ request }).map(chunk)[0]).toEqual({
      type: 'response.created',
      id: expect.stringMatching(/^chatcmpl-/),
    });
  });
});
