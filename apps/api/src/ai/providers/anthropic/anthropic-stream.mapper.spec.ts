import { z } from 'zod';

import { AiError } from '../../core/ai-error';
import { AI_PROVIDER_STATE, AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import { AnthropicStreamMapper } from './anthropic-stream.mapper';
import { messageFixture, redactedThinkingBlock, streamEventsFor, textBlock, thinkingBlock, toolUseBlock } from './testing/anthropic-fixtures';

const request: AiResponseRequest = { model: 'claude-sonnet-4-5', input: 'x' };

function run(mapper: AnthropicStreamMapper, events: ReturnType<typeof streamEventsFor>): AiStreamEvent[] {
  return events.flatMap((event) => mapper.map(event));
}

describe('AnthropicStreamMapper', () => {
  it('maps a text stream: created, deltas, item done, completed — deltas equal the final text', () => {
    const message = messageFixture({ id: 'msg_s1', content: [textBlock('Hello there, friend.')], usage: { input_tokens: 9, output_tokens: 4 } });
    const mapper = new AnthropicStreamMapper({ request, providerRequestId: 'req_9' });
    const events = run(mapper, streamEventsFor(message, 4));

    expect(events[0]).toEqual({ type: 'response.created', id: 'msg_s1' });

    const completed = events[events.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>;
    const deltas = events.filter((e) => e.type === 'output_text.delta').map((e) => (e as { delta: string }).delta);

    expect(deltas.join('')).toBe('Hello there, friend.');
    expect(deltas.length).toBeGreaterThan(1);
    expect(events.filter((e) => e.type === 'output_item.done')).toEqual([
      { type: 'output_item.done', item: { type: 'message', text: 'Hello there, friend.' } },
    ]);
    expect(completed.response).toMatchObject({
      id: 'msg_s1',
      provider: 'anthropic',
      outputText: 'Hello there, friend.',
      finishReason: 'stop',
      providerRequestId: 'req_9',
      usage: { inputTokens: 9, outputTokens: 4 },
    });
    expect(mapper.terminated).toBe(true);
  });

  it('streams thinking as reasoning summary deltas and keeps the signature out of every event', () => {
    const message = messageFixture({ content: [thinkingBlock('Weigh the options.', 'sig-stream'), redactedThinkingBlock('ENC'), textBlock('Done.')] });
    const events = run(new AnthropicStreamMapper({ request }), streamEventsFor(message, 5));

    expect(
      events.filter((e) => e.type === 'reasoning_summary.delta').map((e) => (e as { delta: string }).delta).join(''),
    ).toBe('Weigh the options.');

    const completed = events[events.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>;
    const [thinking, redacted] = completed.response.output;

    expect(thinking).toMatchObject({ type: 'reasoning', summary: ['Weigh the options.'] });
    expect((thinking as { [AI_PROVIDER_STATE]?: unknown })[AI_PROVIDER_STATE]).toEqual({
      provider: 'anthropic',
      data: { blocks: [{ type: 'thinking', thinking: 'Weigh the options.', signature: 'sig-stream' }] },
    });
    expect(redacted).toMatchObject({ type: 'reasoning', summary: [] });
    expect(JSON.stringify(events)).not.toContain('sig-stream');
    expect(JSON.stringify(events)).not.toContain('ENC');
  });

  it('streams tool input as function_call.arguments.delta keyed by the tool_use id', () => {
    const message = messageFixture({ content: [toolUseBlock('get_weather', { city: 'Lima' }, 'toolu_s')] });
    const events = run(new AnthropicStreamMapper({ request }), streamEventsFor(message, 3));
    const args = events.filter((e) => e.type === 'function_call.arguments.delta') as Array<{ callId: string; delta: string }>;

    expect(args.every((e) => e.callId === 'toolu_s')).toBe(true);
    expect(args.map((e) => e.delta).join('')).toBe('{"city":"Lima"}');

    const completed = events[events.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>;

    expect(completed.response.finishReason).toBe('tool_calls');
    expect(completed.response.output).toEqual([
      { type: 'function_call', callId: 'toolu_s', name: 'get_weather', arguments: '{"city":"Lima"}' },
    ]);
  });

  it('streams the forced structured tool as output text and validates it on completion', () => {
    const schema = z.object({ city: z.string() });
    const message = messageFixture({ content: [toolUseBlock('facts', { city: 'Paris' })] });
    const events = run(
      new AnthropicStreamMapper({ request: { ...request, structuredOutput: { name: 'facts', schema } }, structuredToolName: 'facts' }),
      streamEventsFor(message, 4),
    );
    const completed = events[events.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>;
    const text = events.filter((e) => e.type === 'output_text.delta').map((e) => (e as { delta: string }).delta).join('');

    expect(text).toBe(completed.response.outputText);
    expect(completed.response.parsed).toEqual({ city: 'Paris' });
    expect(completed.response.finishReason).toBe('stop');
  });

  it('ends with an error event instead of completing when structured output is invalid', () => {
    const message = messageFixture({ content: [textBlock('not json')] });
    const events = run(
      new AnthropicStreamMapper({ request: { ...request, structuredOutput: { name: 's', schema: z.object({ a: z.string() }) } } }),
      streamEventsFor(message),
    );

    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'AI_STRUCTURED_OUTPUT_INVALID' });
  });

  it('emits nothing after a terminal event, and fail() is idempotent', () => {
    const mapper = new AnthropicStreamMapper({ request });
    const events = streamEventsFor(messageFixture({ content: [textBlock('x')] }));

    run(mapper, events);

    expect(mapper.map(events[1])).toEqual([]);
    expect(mapper.fail(new AiError('AI_PROVIDER_UNAVAILABLE', 'x'))).toEqual([]);

    const fresh = new AnthropicStreamMapper({ request });

    expect(fresh.fail(new AiError('AI_RATE_LIMITED', 'Anthropic rate-limited the request.'))).toEqual([
      { type: 'error', code: 'AI_RATE_LIMITED', message: 'Anthropic rate-limited the request.' },
    ]);
    expect(fresh.fail(new AiError('AI_RATE_LIMITED', 'again'))).toEqual([]);
  });
});
