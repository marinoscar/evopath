import { z } from 'zod';

import { AiError } from '../../core/ai-error';
import { AI_PROVIDER_STATE, AiResponseRequest } from '../../core/types/responses.types';
import { defineTool } from '../../core/tools';
import { classifyOpenAiModel } from './openai-model-catalog';
import { fromOpenAiResponse, toOpenAiRequest } from './openai-responses.mapper';
import {
  functionCallItem,
  messageItem,
  reasoningItem,
  responseFixture,
} from './testing/openai-fixtures';

const GPT4O = classifyOpenAiModel('gpt-4o');
const GPT5 = classifyOpenAiModel('gpt-5');

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

describe('toOpenAiRequest', () => {
  it('passes a string input and the scalar fields through', () => {
    const body = toOpenAiRequest(
      {
        model: 'gpt-4o',
        instructions: 'Be terse.',
        input: 'hi',
        maxOutputTokens: 100,
        temperature: 0.2,
        previousResponseId: 'resp_1',
        metadata: { feature: 'test' },
      },
      GPT4O,
    );

    expect(body).toEqual({
      model: 'gpt-4o',
      instructions: 'Be terse.',
      input: 'hi',
      max_output_tokens: 100,
      temperature: 0.2,
      previous_response_id: 'resp_1',
      metadata: { feature: 'test' },
    });
  });

  it('maps replayed function calls and drops replayed reasoning (#446)', () => {
    const body = toOpenAiRequest(
      {
        model: 'gpt-4o',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'weather?' }] },
          { type: 'reasoning', summary: ['think'], [AI_PROVIDER_STATE]: { provider: 'anthropic', data: { x: 1 } } },
          { type: 'function_call', callId: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
          { type: 'function_call_output', callId: 'call_1', output: 'sunny' },
        ],
      },
      GPT4O,
    );

    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ]);
  });

  it('maps message items with text, image and file parts', () => {
    const body = toOpenAiRequest(
      {
        model: 'gpt-4o',
        input: [
          { type: 'message', role: 'developer', content: [{ type: 'text', text: 'rules' }] },
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'text', text: 'Look:' },
              { type: 'image', url: 'https://example.com/cat.png', detail: 'high' },
              { type: 'image', url: 'data:image/png;base64,AAAA' },
              { type: 'file', url: 'https://example.com/doc.pdf', filename: 'doc.pdf' },
              { type: 'file', url: 'data:application/pdf;base64,JVBE', filename: 'inline.pdf' },
            ],
          },
          { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Sure, ' }, { type: 'text', text: 'ok.' }] },
          { type: 'function_call_output', callId: 'call_1', output: '{"ok":true}' },
        ],
      },
      GPT4O,
    );

    expect(body.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Look:' },
          { type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'high' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
          { type: 'input_file', file_url: 'https://example.com/doc.pdf', filename: 'doc.pdf' },
          { type: 'input_file', file_data: 'data:application/pdf;base64,JVBE', filename: 'inline.pdf' },
        ],
      },
      { type: 'message', role: 'assistant', content: 'Sure, ok.' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ]);
  });

  it.each([
    ['image', { type: 'image' as const, storageObjectId: 'obj_1' }],
    ['file', { type: 'file' as const, storageObjectId: 'obj_1' }],
  ])('rejects a storage-object %s part the runtime did not deliver with AI_INVALID_REQUEST', (_kind, part) => {
    expectAiError(
      () => toOpenAiRequest({ model: 'gpt-4o', input: [{ type: 'message', role: 'user', content: [part] }] }, GPT4O),
      'AI_INVALID_REQUEST',
    );
  });

  it('maps delivered storage-object parts by their modality: URL -> image_url/file_url, file id -> file_id (#441)', () => {
    const storage = new Map([
      ['img', { modality: 'image' as const, filename: 'cat.png', url: 'https://bucket.test/cat.png?X-Amz-Signature=s' }],
      ['pdf', { modality: 'file' as const, filename: 'contract.pdf', fileId: 'file-abc' }],
      ['png-as-file', { modality: 'image' as const, filename: 'scan.png', fileId: 'file-img' }],
      ['csv', { modality: 'file' as const, filename: 'rows.csv', url: 'data:text/csv;base64,YSxi' }],
    ]);

    const body = toOpenAiRequest(
      {
        model: 'gpt-4o',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'image', storageObjectId: 'img', detail: 'low' },
              { type: 'file', storageObjectId: 'pdf' },
              { type: 'file', storageObjectId: 'png-as-file' },
              { type: 'file', storageObjectId: 'csv', filename: 'override.csv' },
            ],
          },
        ],
      },
      GPT4O,
      storage,
    );

    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'https://bucket.test/cat.png?X-Amz-Signature=s', detail: 'low' },
          { type: 'input_file', file_id: 'file-abc' },
          { type: 'input_image', file_id: 'file-img', detail: 'auto' },
          { type: 'input_file', file_data: 'data:text/csv;base64,YSxi', filename: 'override.csv' },
        ],
      },
    ]);
  });

  it('rejects a media part with neither url nor storage object as AI_INVALID_REQUEST', () => {
    expectAiError(
      () => toOpenAiRequest({ model: 'gpt-4o', input: [{ type: 'message', role: 'user', content: [{ type: 'image' }] }] }, GPT4O),
      'AI_INVALID_REQUEST',
    );
  });

  it('rejects a non-text part in an assistant message', () => {
    expectAiError(
      () =>
        toOpenAiRequest(
          { model: 'gpt-4o', input: [{ type: 'message', role: 'assistant', content: [{ type: 'image', url: 'https://x/y.png' }] }] },
          GPT4O,
        ),
      'AI_INVALID_REQUEST',
    );
  });

  it('maps a function tool to strict JSON Schema, and tool choice', () => {
    const tool = defineTool({
      name: 'lookup',
      description: 'Look something up.',
      parameters: z.object({ q: z.string(), limit: z.number().int().optional() }),
      execute: () => null,
    });

    const body = toOpenAiRequest(
      { model: 'gpt-4o', input: 'x', tools: [tool.tool], toolChoice: { type: 'function', name: 'lookup' } },
      GPT4O,
    );

    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'Look something up.',
        parameters: expect.objectContaining({ type: 'object', additionalProperties: false }),
        strict: true,
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'function', name: 'lookup' });
    expect(toOpenAiRequest({ model: 'gpt-4o', input: 'x', toolChoice: 'required' }, GPT4O).tool_choice).toBe('required');
  });

  it('maps structured output to a strict json_schema text format', () => {
    const body = toOpenAiRequest(
      { model: 'gpt-4o', input: 'x', structuredOutput: { name: 'facts', schema: z.object({ a: z.string() }) } },
      GPT4O,
    );

    expect(body.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'facts',
        schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
        strict: true,
      },
    });
  });

  describe('reasoning', () => {
    it('passes effort and summary for a reasoning model', () => {
      const body = toOpenAiRequest({ model: 'gpt-5', input: 'x', reasoning: { effort: 'minimal', summary: 'auto' } }, GPT5);

      expect(body.reasoning).toEqual({ effort: 'minimal', summary: 'auto' });
    });

    it('rejects an effort the model does not offer', () => {
      expectAiError(
        () => toOpenAiRequest({ model: 'o3', input: 'x', reasoning: { effort: 'minimal' } }, classifyOpenAiModel('o3')),
        'AI_CAPABILITY_UNSUPPORTED',
      );
    });

    it('ignores a summary for a non-reasoning model', () => {
      const body = toOpenAiRequest({ model: 'gpt-4o', input: 'x', reasoning: { summary: 'detailed' } }, GPT4O);

      expect(body.reasoning).toBeUndefined();
    });

    it('rejects an effort for a non-reasoning model', () => {
      expectAiError(
        () => toOpenAiRequest({ model: 'gpt-4o', input: 'x', reasoning: { effort: 'high' } }, GPT4O),
        'AI_CAPABILITY_UNSUPPORTED',
      );
    });

    it('passes reasoning through for an unclassified model', () => {
      const body = toOpenAiRequest({ model: 'gpt-9', input: 'x', reasoning: { effort: 'high' } }, null);

      expect(body.reasoning).toEqual({ effort: 'high' });
    });
  });

  it('shallow-merges providerOptions.openai last, but never stream', () => {
    const body = toOpenAiRequest(
      {
        model: 'gpt-4o',
        input: 'x',
        temperature: 0.5,
        providerOptions: {
          openai: { store: false, service_tier: 'flex', temperature: 0.1, stream: true },
          anthropic: { ignored: true },
        },
      },
      GPT4O,
    );

    expect(body).toEqual({ model: 'gpt-4o', input: 'x', temperature: 0.1, store: false, service_tier: 'flex' });
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('ignored');
  });
});

describe('fromOpenAiResponse', () => {
  const textRequest: AiResponseRequest = { model: 'gpt-4o', input: 'hi' };

  it('maps message, reasoning and usage', () => {
    const resp = responseFixture({
      id: 'resp_1',
      output: [reasoningItem(['Thinking', 'about it']), messageItem('Hello '), messageItem('world')],
      usage: { input_tokens: 10, output_tokens: 20, reasoning_tokens: 5, cached_tokens: 3 },
    });

    const result = fromOpenAiResponse(resp, { request: textRequest, providerRequestId: 'req_9' });

    expect(result).toEqual({
      id: 'resp_1',
      provider: 'openai',
      model: 'gpt-4o-2024-08-06',
      output: [
        { type: 'reasoning', summary: ['Thinking', 'about it'] },
        { type: 'message', text: 'Hello ' },
        { type: 'message', text: 'world' },
      ],
      outputText: 'Hello world',
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5, cachedInputTokens: 3 },
      finishReason: 'stop',
      providerRequestId: 'req_9',
    });
  });

  it('maps a function call and finishes with tool_calls', () => {
    const result = fromOpenAiResponse(
      responseFixture({ output: [functionCallItem('get_weather', '{"city":"Paris"}', 'call_7')] }),
      { request: textRequest },
    );

    expect(result.output).toEqual([
      { type: 'function_call', callId: 'call_7', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.outputText).toBe('');
    expect(result.providerRequestId).toBeUndefined();
  });

  it('maps a known hosted tool call and drops unknown item types', () => {
    const result = fromOpenAiResponse(
      responseFixture({
        output: [
          { id: 'ws_1', type: 'web_search_call', status: 'completed' } as never,
          { id: 'x_1', type: 'compaction' } as never,
          messageItem('Found it.'),
        ],
      }),
      { request: textRequest },
    );

    expect(result.output).toEqual([
      { type: 'hosted_tool_call', id: 'ws_1', tool: 'web_search', status: 'completed', result: { queries: [], sources: [] } },
      { type: 'message', text: 'Found it.' },
    ]);
  });

  it.each([
    ['incomplete (max_output_tokens)', { status: 'incomplete' as const, incompleteReason: 'max_output_tokens' as const }, 'length'],
    ['incomplete (content_filter)', { status: 'incomplete' as const, incompleteReason: 'content_filter' as const }, 'content_filter'],
    ['cancelled', { status: 'cancelled' as const }, 'error'],
    ['a refusal', { output: [messageItem('', { refusal: 'I cannot help with that.' })] }, 'content_filter'],
  ])('finishReason for %s', (_name, opts, expected) => {
    expect(fromOpenAiResponse(responseFixture(opts), { request: textRequest }).finishReason).toBe(expected);
  });

  it('excludes refusal text from outputText', () => {
    const result = fromOpenAiResponse(
      responseFixture({ output: [messageItem('', { refusal: 'No.' })] }),
      { request: textRequest },
    );

    expect(result.outputText).toBe('');
  });

  it('throws the mapped AiError for a failed response', () => {
    expectAiError(
      () =>
        fromOpenAiResponse(
          responseFixture({ status: 'failed', error: { code: 'server_error', message: 'boom' } }),
          { request: textRequest },
        ),
      'AI_PROVIDER_UNAVAILABLE',
    );
  });

  it('tolerates a missing usage block', () => {
    expect(fromOpenAiResponse(responseFixture({ usage: null }), { request: textRequest }).usage).toEqual({});
  });

  describe('structured output', () => {
    const schema = z.object({ city: z.string(), population: z.number().int() });
    const request: AiResponseRequest = { model: 'gpt-4o', input: 'x', structuredOutput: { name: 'facts', schema } };

    it('returns typed parsed data', () => {
      const result = fromOpenAiResponse(
        responseFixture({ output: [messageItem('{"city":"Paris","population":2100000}')] }),
        { request },
      );

      expect(result.parsed).toEqual({ city: 'Paris', population: 2_100_000 });
    });

    it('throws AI_STRUCTURED_OUTPUT_INVALID for invalid JSON', () => {
      expectAiError(
        () => fromOpenAiResponse(responseFixture({ output: [messageItem('{"city": "Par')] }), { request }),
        'AI_STRUCTURED_OUTPUT_INVALID',
      );
    });

    it('throws AI_STRUCTURED_OUTPUT_INVALID for a schema mismatch', () => {
      expectAiError(
        () => fromOpenAiResponse(responseFixture({ output: [messageItem('{"city":"Paris","population":"lots"}')] }), { request }),
        'AI_STRUCTURED_OUTPUT_INVALID',
      );
    });

    it('does not parse while a tool call is pending', () => {
      const result = fromOpenAiResponse(
        responseFixture({ output: [functionCallItem('lookup', '{}')] }),
        { request },
      );

      expect(result.parsed).toBeUndefined();
    });
  });
});
