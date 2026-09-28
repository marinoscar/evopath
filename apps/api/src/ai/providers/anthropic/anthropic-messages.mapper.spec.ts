import { z } from 'zod';

import { AiError } from '../../core/ai-error';
import { defineTool } from '../../core/tools';
import { AI_PROVIDER_STATE, AiResponseRequest } from '../../core/types/responses.types';
import { fromAnthropicMessage, toAnthropicRequest } from './anthropic-messages.mapper';
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGETS,
  anthropicModelProfile,
} from './anthropic-model-catalog';
import {
  messageFixture,
  redactedThinkingBlock,
  textBlock,
  thinkingBlock,
  toolUseBlock,
} from './testing/anthropic-fixtures';

const SONNET_45 = anthropicModelProfile('claude-sonnet-4-5'); // budget thinking, tool-path schemas
const OPUS_5 = anthropicModelProfile('claude-opus-5'); // adaptive thinking, native schemas, no sampling
const OPUS_46 = anthropicModelProfile('claude-opus-4-6'); // adaptive thinking, sampling allowed
const HAIKU_35 = anthropicModelProfile('claude-3-5-haiku-20241022'); // no thinking

const weather = defineTool({
  name: 'get_weather',
  description: 'Weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: () => 'sunny',
});

const schema = z.object({ city: z.string(), population: z.number().int() });

function expectAiError(run: () => unknown, code: string): AiError {
  let caught: unknown;

  try {
    run();
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(AiError);
  expect((caught as AiError).code).toBe(code);

  return caught as AiError;
}

describe('toAnthropicRequest', () => {
  it('maps instructions to system, a string input to one user turn, and defaults max_tokens', () => {
    const { body } = toAnthropicRequest(
      { model: 'claude-sonnet-4-5', instructions: 'Be terse.', input: 'hi', temperature: 0.2, metadata: { feature: 'x' } },
      SONNET_45,
    );

    expect(body).toEqual({
      model: 'claude-sonnet-4-5',
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      system: 'Be terse.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0.2,
    });
  });

  it('uses maxOutputTokens as max_tokens, and caps the default at the model limit', () => {
    expect(toAnthropicRequest({ model: 'm', input: 'x', maxOutputTokens: 300 }, SONNET_45).body.max_tokens).toBe(300);
    expect(toAnthropicRequest({ model: 'claude-3-haiku-20240307', input: 'x' }, anthropicModelProfile('claude-3-haiku-20240307')).body.max_tokens).toBe(4096);
    expect(toAnthropicRequest({ model: 'claude-unknown', input: 'x' }, null).body.max_tokens).toBe(4096);
  });

  it('folds system and developer messages into system, and merges same-role turns', () => {
    const { body } = toAnthropicRequest(
      {
        model: 'm',
        instructions: 'A.',
        input: [
          { type: 'message', role: 'developer', content: [{ type: 'text', text: 'B.' }] },
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'one' }] },
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'two' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        ],
      },
      SONNET_45,
    );

    expect(body.system).toBe('A.\n\nB.');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    ]);
  });

  it('maps image and file parts: URL, data: URL, PDF by URL and plain text inline', () => {
    const pngData = Buffer.from('png').toString('base64');
    const textData = Buffer.from('hello text').toString('base64');
    const { body } = toAnthropicRequest(
      {
        model: 'm',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'image', url: 'https://example.com/a.png' },
              { type: 'image', url: `data:image/png;base64,${pngData}` },
              { type: 'file', url: 'https://example.com/r.pdf', filename: 'r.pdf' },
              { type: 'file', url: `data:text/plain;base64,${textData}`, filename: 'notes.txt' },
            ],
          },
        ],
      },
      SONNET_45,
    );

    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngData } },
      { type: 'document', source: { type: 'url', url: 'https://example.com/r.pdf' }, title: 'r.pdf' },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello text' }, title: 'notes.txt' },
    ]);
  });

  it('refuses document types Anthropic cannot read, and malformed parts', () => {
    expectAiError(
      () =>
        toAnthropicRequest(
          { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'file', url: 'data:application/zip;base64,AAAA' }] }] },
          SONNET_45,
        ),
      'AI_CAPABILITY_UNSUPPORTED',
    );
    expectAiError(
      () => toAnthropicRequest({ model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'image' }] }] }, SONNET_45),
      'AI_INVALID_REQUEST',
    );
    expectAiError(
      () =>
        toAnthropicRequest(
          { model: 'm', input: [{ type: 'message', role: 'assistant', content: [{ type: 'image', url: 'https://x' }] }] },
          SONNET_45,
        ),
      'AI_INVALID_REQUEST',
    );
  });

  it('maps function tools to input_schema, and every tool choice', () => {
    const base: AiResponseRequest = { model: 'm', input: 'x', tools: [weather.tool] };
    const { body } = toAnthropicRequest({ ...base, toolChoice: 'required' }, SONNET_45);

    expect(body.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Weather for a city.',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(toAnthropicRequest({ ...base, toolChoice: 'auto' }, SONNET_45).body.tool_choice).toEqual({ type: 'auto' });
    expect(toAnthropicRequest({ ...base, toolChoice: 'none' }, SONNET_45).body.tool_choice).toEqual({ type: 'none' });
    expect(
      toAnthropicRequest({ ...base, toolChoice: { type: 'function', name: 'get_weather' } }, SONNET_45).body.tool_choice,
    ).toEqual({ type: 'tool', name: 'get_weather' });
  });

  it('asks for strict tool use only where the family has native structured outputs', () => {
    const strictTool = { ...weather.tool, strict: true };

    expect(toAnthropicRequest({ model: 'm', input: 'x', tools: [strictTool] }, OPUS_5).body.tools?.[0]).toMatchObject({ strict: true });
    expect(toAnthropicRequest({ model: 'm', input: 'x', tools: [strictTool] }, SONNET_45).body.tools?.[0]).not.toHaveProperty('strict');
  });

  it('refuses hosted tools', () => {
    expectAiError(
      () => toAnthropicRequest({ model: 'm', input: 'x', tools: [{ type: 'web_search' }] }, SONNET_45),
      'AI_CAPABILITY_UNSUPPORTED',
    );
  });

  it('replays function calls, tool outputs and Anthropic reasoning state as one assistant turn and one user turn', () => {
    const { body } = toAnthropicRequest(
      {
        model: 'm',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'weather?' }] },
          {
            type: 'reasoning',
            summary: ['think'],
            [AI_PROVIDER_STATE]: { provider: 'anthropic', data: { blocks: [{ type: 'thinking', thinking: 'think', signature: 'sig' }] } },
          },
          // Another provider's state is not Anthropic's to replay.
          { type: 'reasoning', summary: ['other'], [AI_PROVIDER_STATE]: { provider: 'openai', data: { id: 'rs_1' } } },
          { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Checking.' }] },
          { type: 'function_call', callId: 'toolu_1', name: 'get_weather', arguments: '{"city":"Lima"}' },
          { type: 'function_call', callId: 'toolu_2', name: 'get_weather', arguments: '{"city":"Quito"}' },
          { type: 'function_call_output', callId: 'toolu_1', output: 'sunny' },
          { type: 'function_call_output', callId: 'toolu_2', output: 'rain' },
        ],
      },
      SONNET_45,
    );

    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'think', signature: 'sig' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Lima' } },
          { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: { city: 'Quito' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'rain' },
        ],
      },
    ]);
  });

  it('refuses a replayed function call whose arguments are not JSON', () => {
    expectAiError(
      () =>
        toAnthropicRequest(
          {
            model: 'm',
            input: [
              { type: 'message', role: 'user', content: [{ type: 'text', text: 'x' }] },
              { type: 'function_call', callId: 'c', name: 'f', arguments: '{not json' },
            ],
          },
          SONNET_45,
        ),
      'AI_INVALID_REQUEST',
    );
  });

  it('refuses previousResponseId — Anthropic stores nothing', () => {
    const err = expectAiError(
      () => toAnthropicRequest({ model: 'm', input: 'x', previousResponseId: 'msg_1' }, SONNET_45),
      'AI_CAPABILITY_UNSUPPORTED',
    );

    expect(err.toJSON().details).toMatchObject({ capability: 'previous_response_id' });
  });

  describe('reasoning', () => {
    it('adaptive families: thinking adaptive (summarised) plus output_config.effort; minimal maps to low', () => {
      expect(toAnthropicRequest({ model: 'm', input: 'x', reasoning: { effort: 'high' } }, OPUS_5).body).toMatchObject({
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'high' },
      });
      expect(toAnthropicRequest({ model: 'm', input: 'x', reasoning: { effort: 'minimal' } }, OPUS_46).body.output_config).toEqual({
        effort: 'low',
      });
      // A summary alone asks to see the thinking, with no effort change.
      const summaryOnly = toAnthropicRequest({ model: 'm', input: 'x', reasoning: { summary: 'auto' } }, OPUS_5).body;
      expect(summaryOnly.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(summaryOnly).not.toHaveProperty('output_config');
    });

    it('budget families: budget_tokens from the documented ladder, added on top of the default answer allowance', () => {
      const { body } = toAnthropicRequest({ model: 'm', input: 'x', reasoning: { effort: 'medium' } }, SONNET_45);

      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGETS.medium });
      expect(body.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS + ANTHROPIC_THINKING_BUDGETS.medium);
      // A summary alone does not switch budget thinking on.
      expect(toAnthropicRequest({ model: 'm', input: 'x', reasoning: { summary: 'auto' } }, SONNET_45).body).not.toHaveProperty('thinking');
    });

    it('budget families: an explicit maxOutputTokens shrinks the budget to fit, and one too small is refused', () => {
      const { body } = toAnthropicRequest({ model: 'm', input: 'x', maxOutputTokens: 5000, reasoning: { effort: 'high' } }, SONNET_45);

      expect(body).toMatchObject({ max_tokens: 5000, thinking: { type: 'enabled', budget_tokens: 3976 } });
      expectAiError(
        () => toAnthropicRequest({ model: 'm', input: 'x', maxOutputTokens: 1500, reasoning: { effort: 'low' } }, SONNET_45),
        'AI_INVALID_REQUEST',
      );
    });

    it('refuses an effort for a family without extended thinking, ignores a summary there', () => {
      expectAiError(() => toAnthropicRequest({ model: 'm', input: 'x', reasoning: { effort: 'low' } }, HAIKU_35), 'AI_CAPABILITY_UNSUPPORTED');
      expect(toAnthropicRequest({ model: 'm', input: 'x', reasoning: { summary: 'auto' } }, HAIKU_35).body).not.toHaveProperty('thinking');
    });

    it('refuses temperature where sampling is rejected, and alongside extended thinking', () => {
      expectAiError(() => toAnthropicRequest({ model: 'm', input: 'x', temperature: 0.5 }, OPUS_5), 'AI_CAPABILITY_UNSUPPORTED');
      expectAiError(
        () => toAnthropicRequest({ model: 'm', input: 'x', temperature: 0.5, reasoning: { effort: 'low' } }, SONNET_45),
        'AI_CAPABILITY_UNSUPPORTED',
      );
    });
  });

  describe('structured output', () => {
    const structured = { name: 'city facts!', schema };

    it('native families: output_config.format with the JSON schema', () => {
      const plan = toAnthropicRequest({ model: 'm', input: 'x', structuredOutput: structured, reasoning: { effort: 'low' } }, OPUS_5);

      expect(plan.structuredToolName).toBeUndefined();
      expect(plan.body.output_config).toEqual({
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { city: { type: 'string' }, population: { type: 'integer', minimum: expect.any(Number), maximum: expect.any(Number) } },
            required: ['city', 'population'],
            additionalProperties: false,
          },
        },
      });
    });

    it('tool families: one forced tool named after the schema', () => {
      const plan = toAnthropicRequest({ model: 'm', input: 'x', structuredOutput: structured }, SONNET_45);

      expect(plan.structuredToolName).toBe('city_facts_');
      expect(plan.body.tools).toEqual([expect.objectContaining({ name: 'city_facts_', input_schema: expect.objectContaining({ type: 'object' }) })]);
      expect(plan.body.tool_choice).toEqual({ type: 'tool', name: 'city_facts_' });
    });

    it('tool families: refuses a schema together with thinking or other tools', () => {
      expectAiError(
        () => toAnthropicRequest({ model: 'm', input: 'x', structuredOutput: structured, reasoning: { effort: 'low' } }, SONNET_45),
        'AI_CAPABILITY_UNSUPPORTED',
      );
      expectAiError(
        () => toAnthropicRequest({ model: 'm', input: 'x', structuredOutput: structured, tools: [weather.tool] }, SONNET_45),
        'AI_CAPABILITY_UNSUPPORTED',
      );
    });
  });

  it('shallow-merges providerOptions.anthropic last, but never stream', () => {
    const { body } = toAnthropicRequest(
      { model: 'm', input: 'x', providerOptions: { anthropic: { top_k: 5, stream: true }, openai: { store: true } } },
      SONNET_45,
    );

    expect(body).toMatchObject({ top_k: 5 });
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('store');
  });
});

describe('fromAnthropicMessage', () => {
  const request: AiResponseRequest = { model: 'claude-sonnet-4-5', input: 'x' };

  it('maps text, thinking (summary only) and usage — cached tokens folded into inputTokens', () => {
    const response = fromAnthropicMessage(
      messageFixture({
        id: 'msg_1',
        content: [thinkingBlock('Summarised thought.', 'sig-1'), redactedThinkingBlock('ENCRYPTED'), textBlock('Hello'), textBlock(' world')],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 3, output_tokens_details: { thinking_tokens: 4 } },
      }),
      { request, providerRequestId: 'req_1' },
    );

    expect(response).toMatchObject({
      id: 'msg_1',
      provider: 'anthropic',
      outputText: 'Hello world',
      finishReason: 'stop',
      providerRequestId: 'req_1',
      usage: { inputTokens: 103, outputTokens: 5, cachedInputTokens: 90, reasoningTokens: 4 },
    });
    expect(response.output.map((item) => item.type)).toEqual(['reasoning', 'reasoning', 'message', 'message']);
    expect(response.output[0]).toMatchObject({ type: 'reasoning', summary: ['Summarised thought.'] });
    expect(response.output[1]).toMatchObject({ type: 'reasoning', summary: [] });

    // Signatures and redacted thinking never reach a serialised response.
    const json = JSON.stringify(response);
    expect(json).not.toContain('sig-1');
    expect(json).not.toContain('ENCRYPTED');
  });

  it('maps a tool call and finishes with tool_calls', () => {
    const response = fromAnthropicMessage(
      messageFixture({ content: [textBlock('Checking.'), toolUseBlock('get_weather', { city: 'Lima' }, 'toolu_9')] }),
      { request },
    );

    expect(response.finishReason).toBe('tool_calls');
    expect(response.output[1]).toEqual({ type: 'function_call', callId: 'toolu_9', name: 'get_weather', arguments: '{"city":"Lima"}' });
  });

  it.each([
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['refusal', 'content_filter'],
    ['stop_sequence', 'stop'],
    ['end_turn', 'stop'],
  ] as const)('maps stop_reason %s to %s', (stopReason, finishReason) => {
    expect(fromAnthropicMessage(messageFixture({ content: [textBlock('x')], stopReason }), { request }).finishReason).toBe(finishReason);
  });

  it('turns the forced structured tool into validated text, not a function call', () => {
    const response = fromAnthropicMessage(
      messageFixture({ content: [toolUseBlock('city_facts', { city: 'Paris', population: 2 })] }),
      { request: { ...request, structuredOutput: { name: 'city_facts', schema } }, structuredToolName: 'city_facts' },
    );

    expect(response.finishReason).toBe('stop');
    expect(response.output).toEqual([{ type: 'message', text: '{"city":"Paris","population":2}' }]);
    expect(response.parsed).toEqual({ city: 'Paris', population: 2 });
  });

  it('throws AI_STRUCTURED_OUTPUT_INVALID for output that fails the schema', () => {
    expectAiError(
      () =>
        fromAnthropicMessage(messageFixture({ content: [textBlock('{"city":"Paris"}')] }), {
          request: { ...request, structuredOutput: { name: 's', schema } },
        }),
      'AI_STRUCTURED_OUTPUT_INVALID',
    );
  });
});
