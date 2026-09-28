import { z } from 'zod';

import { AiError } from '../../core/ai-error';
import { defineTool } from '../../core/tools';
import type { AiResponseRequest } from '../../core/types/responses.types';
import { fromChatCompletion, toChatCompletionsRequest } from './openai-chat-completions.mapper';
import type { OpenAiFamily } from './openai-errors';
import type { OpenAiStorageDeliveries } from './openai-responses.mapper';
import { chatCompletionFixture } from './testing/chat-completions-fixtures';

const COMPAT: OpenAiFamily = { providerId: 'openai-compatible', label: 'The OpenAI-compatible server' };

const weather = defineTool({
  name: 'get_weather',
  description: 'Weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: () => ({}),
});

function caught(run: () => unknown): AiError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);

    return err as AiError;
  }

  throw new Error('expected an AiError');
}

describe('toChatCompletionsRequest', () => {
  it('maps a string input and instructions to a system and a user message', () => {
    expect(toChatCompletionsRequest({ model: 'llama3', instructions: 'Be brief.', input: 'Hi' })).toEqual({
      model: 'llama3',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
    });
  });

  it('sends a text-only user turn as a string and a mixed one as parts', () => {
    const body = toChatCompletionsRequest({
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', url: 'https://img.example/cat.png', detail: 'low' },
          ],
        },
      ],
    });

    expect(body.messages).toEqual([
      { role: 'user', content: 'ab' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'https://img.example/cat.png', detail: 'low' } },
        ],
      },
    ]);
  });

  it('sends developer and system turns as system messages, text only', () => {
    const body = toChatCompletionsRequest({
      model: 'm',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'text', text: 'rules' }] },
        { type: 'message', role: 'system', content: [{ type: 'text', text: 'more' }] },
      ],
    });

    expect(body.messages).toEqual([
      { role: 'system', content: 'rules' },
      { role: 'system', content: 'more' },
    ]);

    expect(
      caught(() =>
        toChatCompletionsRequest({
          model: 'm',
          input: [{ type: 'message', role: 'system', content: [{ type: 'image', url: 'https://x.example/i.png' }] }],
        }),
      ).code,
    ).toBe('AI_INVALID_REQUEST');
  });

  it('replays a tool round-trip: calls join their assistant turn, outputs become tool messages, reasoning is dropped', () => {
    const body = toChatCompletionsRequest({
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'Weather?' }] },
        { type: 'reasoning', summary: ['thinking'] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }] },
        { type: 'function_call', callId: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call', callId: 'call_2', name: 'get_weather', arguments: '{"city":"Rome"}' },
        { type: 'function_call_output', callId: 'call_1', output: '{"t":21}' },
        { type: 'function_call_output', callId: 'call_2', output: '{"t":25}' },
        { type: 'function_call', callId: 'call_3', name: 'get_weather', arguments: '{"city":"Oslo"}' },
      ],
    });

    expect(body.messages).toEqual([
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"t":21}' },
      { role: 'tool', tool_call_id: 'call_2', content: '{"t":25}' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }],
      },
    ]);
  });

  it('maps storage-object deliveries by modality, and refuses a remote file URL', () => {
    const storage: OpenAiStorageDeliveries = new Map([
      ['img-1', { modality: 'image' as const, filename: 'a.png', url: 'https://signed.example/a.png?sig=x' }],
      ['doc-1', { modality: 'file' as const, filename: 'a.pdf', url: 'data:application/pdf;base64,QUJD' }],
      ['doc-2', { modality: 'file' as const, filename: 'b.pdf', fileId: 'file-9' }],
    ]);
    const body = toChatCompletionsRequest(
      {
        model: 'm',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'file', storageObjectId: 'img-1' },
              { type: 'file', storageObjectId: 'doc-1' },
              { type: 'file', storageObjectId: 'doc-2' },
            ],
          },
        ],
      },
      { storage },
    );

    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'https://signed.example/a.png?sig=x', detail: 'auto' } },
        { type: 'file', file: { file_data: 'data:application/pdf;base64,QUJD', filename: 'a.pdf' } },
        { type: 'file', file: { file_id: 'file-9' } },
      ],
    });

    const remote = caught(() =>
      toChatCompletionsRequest(
        { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'file', url: 'https://x.example/a.pdf' }] }] },
        { family: COMPAT },
      ),
    );

    expect(remote.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(remote.toJSON().details.provider).toBe('openai-compatible');

    expect(
      caught(() =>
        toChatCompletionsRequest({
          model: 'm',
          input: [{ type: 'message', role: 'user', content: [{ type: 'image', storageObjectId: 'missing' }] }],
        }),
      ).code,
    ).toBe('AI_INVALID_REQUEST');
  });

  it('maps function tools, the tool choice and structured output', () => {
    const body = toChatCompletionsRequest({
      model: 'm',
      input: 'x',
      tools: [weather.tool],
      toolChoice: { type: 'function', name: 'get_weather' },
      structuredOutput: { name: 'city', schema: z.object({ city: z.string() }) },
    });

    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Weather for a city.',
          parameters: expect.objectContaining({ type: 'object', properties: { city: { type: 'string' } } }),
          strict: true,
        },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'city', schema: expect.objectContaining({ type: 'object' }), strict: true },
    });
    expect(toChatCompletionsRequest({ model: 'm', input: 'x', toolChoice: 'required' }).tool_choice).toBe('required');
  });

  it.each([
    ['a hosted tool', { tools: [{ type: 'web_search' as const }] }, 'hosted_tools'],
    ['a reasoning effort', { reasoning: { effort: 'high' as const } }, 'reasoning'],
    ['previousResponseId', { previousResponseId: 'resp_1' }, 'previous_response_id'],
  ])('refuses %s as AI_CAPABILITY_UNSUPPORTED', (_label, extra, capability) => {
    const err = caught(() => toChatCompletionsRequest({ model: 'm', input: 'x', ...extra } as AiResponseRequest, { family: COMPAT }));

    expect(err.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(err.toJSON().details).toMatchObject({ provider: 'openai-compatible', capability });
  });

  it('ignores a reasoning summary request on its own', () => {
    expect(() => toChatCompletionsRequest({ model: 'm', input: 'x', reasoning: { summary: 'auto' } })).not.toThrow();
  });

  it('puts the output-token limit in the declared parameter', () => {
    expect(toChatCompletionsRequest({ model: 'm', input: 'x', maxOutputTokens: 64 })).toMatchObject({
      max_completion_tokens: 64,
    });
    expect(
      toChatCompletionsRequest({ model: 'm', input: 'x', maxOutputTokens: 64 }, { tokenParameter: 'max_tokens' }),
    ).toEqual(expect.objectContaining({ max_tokens: 64 }));
  });

  it('merges the provider escape hatch last, never stream or stream_options, and drops metadata', () => {
    const body = toChatCompletionsRequest(
      {
        model: 'm',
        input: 'x',
        temperature: 0.2,
        metadata: { a: 'b' },
        providerOptions: {
          'openai-compatible': { seed: 7, stream: true, stream_options: { include_usage: false } },
          openai: { seed: 1 },
        },
      },
      { family: COMPAT },
    );

    expect(body).toEqual({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.2, seed: 7 });
  });
});

describe('fromChatCompletion', () => {
  const request: AiResponseRequest = { model: 'llama3', input: 'x' };

  it('maps text, usage and the provider id', () => {
    const completion = chatCompletionFixture({
      id: 'chatcmpl-1',
      content: 'Hello!',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        completion_tokens_details: { reasoning_tokens: 1 },
        prompt_tokens_details: { cached_tokens: 4 },
      },
    });

    expect(fromChatCompletion(completion, { request, providerRequestId: 'req_1', family: COMPAT })).toEqual({
      id: 'chatcmpl-1',
      provider: 'openai-compatible',
      model: 'llama3.1:8b',
      output: [{ type: 'message', text: 'Hello!' }],
      outputText: 'Hello!',
      usage: { inputTokens: 10, outputTokens: 3, reasoningTokens: 1, cachedInputTokens: 4 },
      finishReason: 'stop',
      providerRequestId: 'req_1',
    });
  });

  it('maps tool calls to function_call items with finishReason tool_calls', () => {
    const response = fromChatCompletion(
      chatCompletionFixture({ content: null, toolCalls: [{ id: 'call_a', name: 'get_weather', arguments: '{"city":"Paris"}' }] }),
      { request },
    );

    expect(response.output).toEqual([
      { type: 'function_call', callId: 'call_a', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ]);
    expect(response.finishReason).toBe('tool_calls');
    expect(response.outputText).toBe('');
  });

  it.each([
    ['length', { finishReason: 'length' as const }, 'length'],
    ['content_filter', { finishReason: 'content_filter' as const }, 'content_filter'],
    ['a refusal', { content: null, refusal: 'I cannot help with that.' }, 'content_filter'],
  ])('maps %s', (_label, opts, expected) => {
    expect(fromChatCompletion(chatCompletionFixture(opts), { request }).finishReason).toBe(expected);
  });

  it('parses structured output, and refuses output that does not match the schema', () => {
    const structured: AiResponseRequest = { ...request, structuredOutput: { name: 'c', schema: z.object({ city: z.string() }) } };

    expect(fromChatCompletion(chatCompletionFixture({ content: '{"city":"Paris"}' }), { request: structured }).parsed).toEqual({
      city: 'Paris',
    });

    expect(caught(() => fromChatCompletion(chatCompletionFixture({ content: 'not json' }), { request: structured })).code).toBe(
      'AI_STRUCTURED_OUTPUT_INVALID',
    );
  });

  it('fills a missing id and model, and treats a choice-less completion as a provider fault', () => {
    const bare = { ...chatCompletionFixture({ usage: null }), id: '', model: '' };
    const response = fromChatCompletion(bare, { request });

    expect(response.id).toMatch(/^chatcmpl-/);
    expect(response.model).toBe('llama3');
    expect(response.usage).toEqual({});

    const err = caught(() => fromChatCompletion({ ...bare, choices: [] }, { request, family: COMPAT }));

    expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(err.toJSON().details.provider).toBe('openai-compatible');
  });
});
