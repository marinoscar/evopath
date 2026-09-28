import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { z } from 'zod';

import { AiError } from '../../core/ai-error';
import { AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import { OpenAiStreamMapper } from './openai-stream.mapper';
import {
  functionCallItem,
  messageItem,
  reasoningItem,
  responseFixture,
  streamEventsFor,
} from './testing/openai-fixtures';

const textRequest: AiResponseRequest = { model: 'gpt-4o', input: 'hi' };

function run(events: ResponseStreamEvent[], request: AiResponseRequest = textRequest): AiStreamEvent[] {
  const mapper = new OpenAiStreamMapper({ request, providerRequestId: 'req_stream' });

  return events.flatMap((event) => mapper.map(event));
}

function ofType<T extends AiStreamEvent['type']>(events: AiStreamEvent[], type: T) {
  return events.filter((e): e is Extract<AiStreamEvent, { type: T }> => e.type === type);
}

describe('OpenAiStreamMapper', () => {
  it('maps a text stream: created, deltas, item done, completed', () => {
    const final = responseFixture({ id: 'resp_s1', output: [messageItem('Hello there, friend!')] });
    const events = run(streamEventsFor(final, 3));

    expect(events[0]).toEqual({ type: 'response.created', id: 'resp_s1' });

    const last = events[events.length - 1];
    expect(last.type).toBe('response.completed');

    const completed = (last as Extract<AiStreamEvent, { type: 'response.completed' }>).response;
    const deltas = ofType(events, 'output_text.delta').map((e) => e.delta).join('');

    expect(deltas).toBe(completed.outputText);
    expect(completed.outputText).toBe('Hello there, friend!');
    expect(completed.id).toBe('resp_s1');
    expect(completed.providerRequestId).toBe('req_stream');
    expect(ofType(events, 'output_item.done')).toEqual([
      { type: 'output_item.done', item: { type: 'message', text: 'Hello there, friend!' } },
    ]);
  });

  it('maps reasoning summary deltas', () => {
    const final = responseFixture({ output: [reasoningItem(['Weighing options.']), messageItem('Done.')] });
    const events = run(streamEventsFor(final, 5));

    expect(ofType(events, 'reasoning_summary.delta').map((e) => e.delta).join('')).toBe('Weighing options.');
    expect(ofType(events, 'output_item.done')[0].item).toEqual({ type: 'reasoning', summary: ['Weighing options.'] });
  });

  it('keys function-call argument deltas by call id, not item id', () => {
    const final = responseFixture({ output: [functionCallItem('get_weather', '{"city":"Paris"}', 'call_abc')] });
    const events = run(streamEventsFor(final, 4));
    const argDeltas = ofType(events, 'function_call.arguments.delta');

    expect(argDeltas.length).toBeGreaterThan(1);
    expect(new Set(argDeltas.map((e) => e.callId))).toEqual(new Set(['call_abc']));
    expect(argDeltas.map((e) => e.delta).join('')).toBe('{"city":"Paris"}');

    const completed = ofType(events, 'response.completed')[0].response;
    expect(completed.finishReason).toBe('tool_calls');
  });

  it('treats response.incomplete as terminal with finishReason length', () => {
    const final = responseFixture({ status: 'incomplete', incompleteReason: 'max_output_tokens', output: [messageItem('Cut sh')] });
    const events = run(streamEventsFor(final));
    const completed = ofType(events, 'response.completed');

    expect(completed).toHaveLength(1);
    expect(completed[0].response.finishReason).toBe('length');
  });

  it('maps response.failed to one error event with a generic message', () => {
    const final = responseFixture({ status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Slow down sk-SECRET' }, output: [] });
    const events = run(streamEventsFor(final));
    const last = events[events.length - 1];

    expect(last).toEqual({ type: 'error', code: 'AI_RATE_LIMITED', message: expect.any(String) });
    expect(JSON.stringify(events)).not.toContain('sk-SECRET');
    expect(ofType(events, 'response.completed')).toHaveLength(0);
  });

  it('maps an error event', () => {
    const events = run([
      { type: 'response.created', response: responseFixture({ id: 'r' }), sequence_number: 0 } as ResponseStreamEvent,
      { type: 'error', code: 'server_error', message: 'Internal: sk-SECRET', param: null, sequence_number: 1 } as ResponseStreamEvent,
    ]);

    expect(events).toEqual([
      { type: 'response.created', id: 'r' },
      { type: 'error', code: 'AI_PROVIDER_UNAVAILABLE', message: expect.not.stringContaining('sk-SECRET') },
    ]);
  });

  it('emits nothing after a terminal event', () => {
    const final = responseFixture({ output: [messageItem('Hi')] });
    const mapper = new OpenAiStreamMapper({ request: textRequest });
    const events = streamEventsFor(final);

    events.forEach((event) => mapper.map(event));

    expect(mapper.terminated).toBe(true);
    expect(mapper.map(events[events.length - 1])).toEqual([]);
    expect(mapper.fail(new AiError('AI_PROVIDER_UNAVAILABLE', 'x'))).toEqual([]);
  });

  it('ignores event types it does not model', () => {
    expect(
      run([{ type: 'response.web_search_call.searching', item_id: 'x', output_index: 0, sequence_number: 0 } as ResponseStreamEvent]),
    ).toEqual([]);
  });

  describe('structured output', () => {
    const request: AiResponseRequest = {
      model: 'gpt-4o',
      input: 'x',
      structuredOutput: { name: 'facts', schema: z.object({ city: z.string() }) },
    };

    it('parses the completed text', () => {
      const events = run(streamEventsFor(responseFixture({ output: [messageItem('{"city":"Paris"}')] })), request);

      expect(ofType(events, 'response.completed')[0].response.parsed).toEqual({ city: 'Paris' });
    });

    it('ends with an AI_STRUCTURED_OUTPUT_INVALID error event when the text is invalid', () => {
      const events = run(streamEventsFor(responseFixture({ output: [messageItem('{"city":')] })), request);
      const last = events[events.length - 1];

      expect(last).toMatchObject({ type: 'error', code: 'AI_STRUCTURED_OUTPUT_INVALID' });
      expect(ofType(events, 'response.completed')).toHaveLength(0);
    });
  });
});
