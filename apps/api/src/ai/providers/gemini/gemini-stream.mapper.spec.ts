import type { GenerateContentResponse } from '@google/genai';
import { z } from 'zod';

import { AiError } from '../../core/ai-error';
import type { AiStreamEvent } from '../../core/types/responses.types';
import { fromGeminiResponse, geminiReasoningState } from './gemini-content.mapper';
import { GeminiStreamMapper } from './gemini-stream.mapper';
import { functionCallPart, responseFixture, streamChunksFor, textPart, thoughtPart } from './testing/gemini-fixtures';

const asSdk = (value: unknown) => value as GenerateContentResponse;

function run(chunks: unknown[], request = { model: 'gemini-2.5-flash', input: 'x' }) {
  const mapper = new GeminiStreamMapper({ request });
  const events: AiStreamEvent[] = [];

  for (const chunk of chunks) events.push(...mapper.map(asSdk(chunk)));
  if (mapper.finished) events.push(...mapper.complete());

  return { mapper, events };
}

describe('GeminiStreamMapper', () => {
  it('streams created, deltas, items, completed — and agrees with the non-streamed mapping', () => {
    const wire = responseFixture({
      responseId: 'resp_s',
      parts: [thoughtPart('Let me think.', 'SIG_T'), textPart('Hello there!'), functionCallPart('get_weather', { city: 'Paris' }, { id: 'fc_1', thoughtSignature: 'SIG_F' })],
      usage: { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 2 },
    });
    const { events } = run(streamChunksFor(wire, 4));

    expect(events[0]).toEqual({ type: 'response.created', id: 'resp_s' });
    expect(events.filter((e) => e.type === 'response.completed')).toHaveLength(1);
    expect(events[events.length - 1].type).toBe('response.completed');

    const deltas = events.filter((e) => e.type === 'output_text.delta').map((e) => (e as { delta: string }).delta);
    const summary = events.filter((e) => e.type === 'reasoning_summary.delta').map((e) => (e as { delta: string }).delta);
    const completed = (events[events.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>).response;

    expect(deltas.join('')).toBe('Hello there!');
    expect(deltas.length).toBeGreaterThan(1);
    expect(summary.join('')).toBe('Let me think.');
    expect(events).toContainEqual({ type: 'function_call.arguments.delta', callId: 'fc_1', delta: '{"city":"Paris"}' });
    expect(completed.outputText).toBe('Hello there!');
    expect(completed.finishReason).toBe('tool_calls');
    expect(completed.usage).toEqual({ inputTokens: 9, outputTokens: 6, reasoningTokens: 2 });

    // The same items, in the same order, as `create` makes of the whole response.
    const whole = fromGeminiResponse(asSdk(wire), { model: 'gemini-2.5-flash', input: 'x' });

    expect(completed.output).toEqual(whole.output);
    expect(completed.output.flatMap((i) => (i.type === 'reasoning' ? [geminiReasoningState(i)] : []))).toEqual([
      { signature: 'SIG_T', target: 'thought' },
      { signature: 'SIG_F', target: 'function_call', callId: 'fc_1' },
    ]);

    const done = events.filter((e) => e.type === 'output_item.done').map((e) => (e as { item: { type: string } }).item.type);

    expect(done).toEqual(['reasoning', 'message', 'reasoning', 'function_call']);
  });

  it('is not finished until a finish reason arrives', () => {
    const wire = responseFixture({ parts: [textPart('partial')] });
    const chunks = streamChunksFor(wire);
    const { mapper, events } = run(chunks.slice(0, -1));

    expect(mapper.started).toBe(true);
    expect(mapper.finished).toBe(false);
    expect(mapper.terminated).toBe(false);
    expect(events.some((e) => e.type === 'response.completed')).toBe(false);
  });

  it('completes a blocked prompt as content_filter', () => {
    const { events } = run([{ promptFeedback: { blockReason: 'SAFETY' }, responseId: 'r_b' }]);
    const last = events[events.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>;

    expect(last.type).toBe('response.completed');
    expect(last.response.finishReason).toBe('content_filter');
  });

  it('ends with an error event when structured output fails validation', () => {
    const wire = responseFixture({ parts: [textPart('not json')] });
    const { events, mapper } = run(streamChunksFor(wire), {
      model: 'gemini-2.5-flash',
      input: 'x',
      structuredOutput: { name: 'c', schema: z.object({ city: z.string() }) },
    } as never);

    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'AI_STRUCTURED_OUTPUT_INVALID' });
    expect(mapper.terminated).toBe(true);
  });

  it('fail() is idempotent and nothing is emitted after a terminal event', () => {
    const mapper = new GeminiStreamMapper({ request: { model: 'm', input: 'x' } });

    mapper.map(asSdk(streamChunksFor(responseFixture({ parts: [textPart('a')] }))[0]));

    const err = new AiError('AI_PROVIDER_UNAVAILABLE', 'down');

    expect(mapper.fail(err)).toEqual([{ type: 'error', code: 'AI_PROVIDER_UNAVAILABLE', message: 'down' }]);
    expect(mapper.fail(err)).toEqual([]);
    expect(mapper.map(asSdk({ candidates: [{ content: { parts: [{ text: 'late' }] } }] }))).toEqual([]);
    expect(mapper.complete()).toEqual([]);
  });

  it('names a stream Gemini did not name, once', () => {
    const { events } = run([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'a' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'b' }] }, finishReason: 'STOP' }] },
    ]);
    const created = events[0] as { id: string };
    const completed = events[events.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>;

    expect(created.id).toMatch(/^gemini-/);
    expect(completed.response.id).toBe(created.id);
    expect(completed.response.model).toBe('gemini-2.5-flash');
  });
});
