import type { GenerateContentResponse, Part } from '@google/genai';
import { z } from 'zod';

import { AiError } from '../../core/ai-error';
import { asInputItems, replayOutput } from '../../core/conversation';
import { defineTool } from '../../core/tools';
import { AI_PROVIDER_STATE, type AiInputItem, type AiResponseRequest } from '../../core/types/responses.types';
import {
  GEMINI_SYNTHETIC_CALL_ID_PREFIX,
  GeminiOutputAssembler,
  fromGeminiResponse,
  geminiFinishReason,
  geminiFunctionResponse,
  geminiMimeTypeFromUrl,
  geminiReasoningState,
  geminiStorageObjectIds,
  geminiUsage,
  toGeminiRequest,
} from './gemini-content.mapper';
import { GEMINI_THINKING_BUDGETS, geminiModelProfile } from './gemini-model-catalog';

const weather = defineTool({
  name: 'get_weather',
  description: 'Weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: ({ city }) => `${city}: sunny`,
});

function build(req: AiResponseRequest) {
  return toGeminiRequest(req, geminiModelProfile(req.model));
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);

    return (err as AiError).code;
  }

  throw new Error('expected an AiError');
}

function response(parts: Part[], patch: Partial<GenerateContentResponse> = {}): GenerateContentResponse {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' as never, index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3, cachedContentTokenCount: 2 },
    modelVersion: 'gemini-2.5-flash',
    responseId: 'resp_1',
    ...patch,
  } as GenerateContentResponse;
}

describe('toGeminiRequest', () => {
  describe('content', () => {
    it('sends a bare string as one user turn and instructions as the systemInstruction', () => {
      const req = build({ model: 'gemini-2.5-flash', input: 'hi', instructions: 'Be brief.' });

      expect(req).toEqual({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: { systemInstruction: { parts: [{ text: 'Be brief.' }] } },
      });
    });

    it('folds system and developer messages into the systemInstruction, and refuses media there', () => {
      const req = build({
        model: 'gemini-2.5-flash',
        instructions: 'A',
        input: [
          { type: 'message', role: 'developer', content: [{ type: 'text', text: 'B' }] },
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      });

      expect(req.config.systemInstruction).toEqual({ parts: [{ text: 'A\n\nB' }] });
      expect(
        codeOf(() =>
          build({
            model: 'gemini-2.5-flash',
            input: [{ type: 'message', role: 'system', content: [{ type: 'image', url: 'https://x/y.png' }] }],
          }),
        ),
      ).toBe('AI_INVALID_REQUEST');
    });

    it('maps media parts: a data URL inline, any other URL as fileData with a MIME type when the path names one', () => {
      const req = build({
        model: 'gemini-2.5-flash',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', url: 'data:image/png;base64,AAAA' },
              { type: 'image', url: 'https://cdn.example.com/cat.JPG?x=1' },
              { type: 'file', url: 'https://example.com/report.pdf' },
              { type: 'file', url: 'https://example.com/blob' },
            ],
          },
        ],
      });

      expect(req.contents[0].parts).toEqual([
        { text: 'look' },
        { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
        { fileData: { fileUri: 'https://cdn.example.com/cat.JPG?x=1', mimeType: 'image/jpeg' } },
        { fileData: { fileUri: 'https://example.com/report.pdf', mimeType: 'application/pdf' } },
        { fileData: { fileUri: 'https://example.com/blob' } },
      ]);
    });

    it('sends a storage object inline from the delivered bytes, and refuses one that was not delivered', () => {
      const input: AiInputItem[] = [
        { type: 'message', role: 'user', content: [{ type: 'file', storageObjectId: 'obj-1' }] },
      ];
      const storage = new Map([
        ['obj-1', { modality: 'file' as const, mimeType: 'application/pdf', filename: 'a.pdf', data: Buffer.from('%PDF') }],
      ]);

      expect(geminiStorageObjectIds({ model: 'm', input })).toEqual(['obj-1']);
      expect(toGeminiRequest({ model: 'gemini-2.5-flash', input }, null, storage).contents[0].parts).toEqual([
        { inlineData: { mimeType: 'application/pdf', data: Buffer.from('%PDF').toString('base64') } },
      ]);
      expect(codeOf(() => toGeminiRequest({ model: 'gemini-2.5-flash', input }, null))).toBe('AI_INVALID_REQUEST');
    });

    it('merges consecutive items of the same role into one turn', () => {
      const req = build({
        model: 'gemini-2.5-flash',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'a' }] },
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'b' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'c' }] },
        ],
      });

      expect(req.contents).toEqual([
        { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
        { role: 'model', parts: [{ text: 'c' }] },
      ]);
    });

    it('refuses a request with no turns, and an assistant message with media', () => {
      expect(codeOf(() => build({ model: 'gemini-2.5-flash', input: [] }))).toBe('AI_INVALID_REQUEST');
      expect(
        codeOf(() =>
          build({
            model: 'gemini-2.5-flash',
            input: [{ type: 'message', role: 'assistant', content: [{ type: 'image', url: 'https://x/y.png' }] }],
          }),
        ),
      ).toBe('AI_INVALID_REQUEST');
    });
  });

  describe('function calls', () => {
    it('replays a call and its output, matching the response to the call by name', () => {
      const req = build({
        model: 'gemini-2.5-flash',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'weather?' }] },
          { type: 'function_call', callId: `${GEMINI_SYNTHETIC_CALL_ID_PREFIX}abc`, name: 'get_weather', arguments: '{"city":"Paris"}' },
          { type: 'function_call', callId: 'fc_real', name: 'get_time', arguments: '' },
          { type: 'function_call_output', callId: `${GEMINI_SYNTHETIC_CALL_ID_PREFIX}abc`, output: '{"tempC":21}' },
          { type: 'function_call_output', callId: 'fc_real', output: 'noon' },
        ],
      });

      expect(req.contents).toEqual([
        { role: 'user', parts: [{ text: 'weather?' }] },
        {
          role: 'model',
          parts: [
            // A synthetic id is never sent back; a real one is.
            { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
            { functionCall: { name: 'get_time', args: {}, id: 'fc_real' } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'get_weather', response: { tempC: 21 } } },
            { functionResponse: { name: 'get_time', response: { output: 'noon' }, id: 'fc_real' } },
          ],
        },
      ]);
    });

    it('refuses an output whose call is not in the input — Gemini stores nothing', () => {
      expect(
        codeOf(() =>
          build({ model: 'gemini-2.5-flash', input: [{ type: 'function_call_output', callId: 'x', output: 'y' }] }),
        ),
      ).toBe('AI_INVALID_REQUEST');
    });

    it('refuses replayed arguments that are not a JSON object', () => {
      for (const args of ['not json', '[1,2]', '"s"']) {
        expect(
          codeOf(() =>
            build({
              model: 'gemini-2.5-flash',
              input: [
                { type: 'message', role: 'user', content: [{ type: 'text', text: 'x' }] },
                { type: 'function_call', callId: 'c', name: 'f', arguments: args },
              ],
            }),
          ),
        ).toBe('AI_INVALID_REQUEST');
      }
    });

    it('wraps an output that is not a JSON object as { output }', () => {
      expect(geminiFunctionResponse('{"a":1}')).toEqual({ a: 1 });
      expect(geminiFunctionResponse('[1]')).toEqual({ output: [1] });
      expect(geminiFunctionResponse('42')).toEqual({ output: 42 });
      expect(geminiFunctionResponse('plain text')).toEqual({ output: 'plain text' });
    });

    it('declares function tools with a JSON Schema, and maps every tool choice', () => {
      const req = build({ model: 'gemini-2.5-flash', input: 'x', tools: [weather.tool], toolChoice: 'required' });

      expect(req.config.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Weather for a city.',
              parametersJsonSchema: expect.objectContaining({ type: 'object', required: ['city'] }),
            },
          ],
        },
      ]);
      expect(req.config.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });

      const choices = [
        ['auto', { mode: 'AUTO' }],
        ['none', { mode: 'NONE' }],
        [{ type: 'function', name: 'get_weather' }, { mode: 'ANY', allowedFunctionNames: ['get_weather'] }],
      ] as const;

      for (const [toolChoice, config] of choices) {
        expect(
          build({ model: 'gemini-2.5-flash', input: 'x', tools: [weather.tool], toolChoice }).config.toolConfig,
        ).toEqual({ functionCallingConfig: config });
      }
    });

    it('refuses every hosted tool', () => {
      for (const tool of [
        { type: 'web_search' as const },
        { type: 'code_interpreter' as const },
        { type: 'file_search' as const, vectorStoreIds: ['vs'] },
      ]) {
        expect(codeOf(() => build({ model: 'gemini-2.5-flash', input: 'x', tools: [tool] }))).toBe(
          'AI_CAPABILITY_UNSUPPORTED',
        );
      }
    });
  });

  describe('thinking', () => {
    it('asks Gemini 3 for a level and Gemini 2.5 for a budget, always with thought summaries', () => {
      expect(
        build({ model: 'gemini-3-pro-preview', input: 'x', reasoning: { effort: 'medium' } }).config.thinkingConfig,
      ).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
      expect(
        build({ model: 'gemini-3-flash-preview', input: 'x', reasoning: { effort: 'minimal' } }).config.thinkingConfig,
      ).toEqual({ includeThoughts: true, thinkingLevel: 'MINIMAL' });
      expect(build({ model: 'gemini-2.5-pro', input: 'x', reasoning: { effort: 'low' } }).config.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingBudget: GEMINI_THINKING_BUDGETS.low,
      });
    });

    it('asks only for summaries when no effort is named, and nothing when reasoning is absent', () => {
      expect(
        build({ model: 'gemini-2.5-flash', input: 'x', reasoning: { summary: 'auto' } }).config.thinkingConfig,
      ).toEqual({ includeThoughts: true });
      expect(build({ model: 'gemini-2.5-flash', input: 'x' }).config.thinkingConfig).toBeUndefined();
    });

    it('refuses an effort on a model that does not think; a summary request there is a no-op', () => {
      expect(codeOf(() => build({ model: 'gemini-2.0-flash', input: 'x', reasoning: { effort: 'high' } }))).toBe(
        'AI_CAPABILITY_UNSUPPORTED',
      );
      expect(
        build({ model: 'gemini-2.0-flash', input: 'x', reasoning: { summary: 'auto' } }).config.thinkingConfig,
      ).toBeUndefined();
    });

    it('asks an unclassified model with a budget', () => {
      expect(
        toGeminiRequest({ model: 'gemini-flash-latest', input: 'x', reasoning: { effort: 'high' } }, null).config
          .thinkingConfig,
      ).toEqual({ includeThoughts: true, thinkingBudget: GEMINI_THINKING_BUDGETS.high });
    });
  });

  describe('structured output', () => {
    const structured = { name: 'city', schema: z.object({ city: z.string() }) };

    it('sends a JSON MIME type and the JSON Schema', () => {
      const { config } = build({ model: 'gemini-2.5-flash', input: 'x', structuredOutput: structured });

      expect(config.responseMimeType).toBe('application/json');
      expect(config.responseJsonSchema).toEqual(expect.objectContaining({ type: 'object', required: ['city'] }));
      expect(config.responseJsonSchema).not.toHaveProperty('$schema');
    });

    it('refuses it on a family that is not sent a schema, and with tools where the family rejects the pair', () => {
      expect(codeOf(() => build({ model: 'gemini-2.0-flash', input: 'x', structuredOutput: structured }))).toBe(
        'AI_CAPABILITY_UNSUPPORTED',
      );
      expect(
        codeOf(() =>
          build({ model: 'gemini-2.5-flash', input: 'x', structuredOutput: structured, tools: [weather.tool] }),
        ),
      ).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(
        build({ model: 'gemini-3-pro-preview', input: 'x', structuredOutput: structured, tools: [weather.tool] }).config
          .responseMimeType,
      ).toBe('application/json');
    });
  });

  describe('refusals and pass-through', () => {
    it('refuses previousResponseId and an embedding model', () => {
      expect(codeOf(() => build({ model: 'gemini-2.5-flash', input: 'x', previousResponseId: 'r' }))).toBe(
        'AI_CAPABILITY_UNSUPPORTED',
      );
      expect(codeOf(() => build({ model: 'gemini-embedding-001', input: 'x' }))).toBe('AI_CAPABILITY_UNSUPPORTED');
    });

    it('maps maxOutputTokens and temperature, drops metadata, and merges providerOptions.gemini last', () => {
      const signal = new AbortController().signal;
      const req = build({
        model: 'gemini-2.5-flash',
        input: 'x',
        maxOutputTokens: 100,
        temperature: 0.3,
        metadata: { traceId: 't' },
        providerOptions: { gemini: { topK: 5, temperature: 0.9, abortSignal: signal }, openai: { store: false } },
      });

      expect(req.config).toEqual({ maxOutputTokens: 100, temperature: 0.9, topK: 5 });
    });
  });
});

describe('Gemini responses', () => {
  it('assembles text, thought summaries and calls, keeping signatures out of JSON', () => {
    const result = fromGeminiResponse(
      response([
        { text: 'Thinking ', thought: true },
        { text: 'hard.', thought: true, thoughtSignature: 'SIG_T' },
        { text: 'Hello ' },
        { text: 'world', thoughtSignature: 'SIG_X' },
        { functionCall: { name: 'get_weather', args: { city: 'Paris' }, id: 'fc_1' }, thoughtSignature: 'SIG_F' },
        { functionCall: { name: 'get_time', args: {} } },
      ]),
      { model: 'gemini-3-pro-preview', input: 'x' },
    );

    expect(result.output.map((item) => item.type)).toEqual([
      'reasoning',
      'message',
      'reasoning',
      'reasoning',
      'function_call',
      'function_call',
    ]);
    expect(result.output[0]).toMatchObject({ summary: ['Thinking hard.'] });
    expect(result.output[1]).toEqual({ type: 'message', text: 'Hello world' });
    expect(result.output[4]).toEqual({
      type: 'function_call',
      callId: 'fc_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    });

    const idless = result.output[5] as { callId: string };

    expect(idless.callId.startsWith(GEMINI_SYNTHETIC_CALL_ID_PREFIX)).toBe(true);
    expect(result.outputText).toBe('Hello world');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.id).toBe('resp_1');
    expect(result.provider).toBe('gemini');

    const states = result.output.flatMap((item) =>
      item.type === 'reasoning' ? [geminiReasoningState(item)] : [],
    );

    expect(states).toEqual([
      { signature: 'SIG_T', target: 'thought' },
      { signature: 'SIG_X', target: 'text' },
      { signature: 'SIG_F', target: 'function_call', callId: 'fc_1' },
    ]);

    const serialised = JSON.stringify(result);

    for (const sig of ['SIG_T', 'SIG_X', 'SIG_F']) expect(serialised).not.toContain(sig);
  });

  it('round-trips signatures through replayOutput back onto the parts they came from', () => {
    const first = fromGeminiResponse(
      response([
        { text: 'plan', thought: true, thoughtSignature: 'SIG_T' },
        { text: 'Checking.', thoughtSignature: 'SIG_X' },
        { functionCall: { name: 'get_weather', args: { city: 'Paris' }, id: 'fc_1' }, thoughtSignature: 'SIG_F' },
      ]),
      { model: 'gemini-3-pro-preview', input: 'x' },
    );
    const req = build({
      model: 'gemini-3-pro-preview',
      input: [
        ...asInputItems('weather?'),
        ...replayOutput(first.output),
        { type: 'function_call_output', callId: 'fc_1', output: '{"tempC":21}' },
      ],
    });

    expect(req.contents).toEqual([
      { role: 'user', parts: [{ text: 'weather?' }] },
      {
        role: 'model',
        parts: [
          { text: 'plan', thought: true, thoughtSignature: 'SIG_T' },
          { text: 'Checking.', thoughtSignature: 'SIG_X' },
          { functionCall: { name: 'get_weather', args: { city: 'Paris' }, id: 'fc_1' }, thoughtSignature: 'SIG_F' },
        ],
      },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { tempC: 21 }, id: 'fc_1' } }] },
    ]);
  });

  it("ignores another provider's reasoning state and a reasoning item with none", () => {
    const req = build({
      model: 'gemini-2.5-flash',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'x' }] },
        { type: 'reasoning', summary: ['s'], [AI_PROVIDER_STATE]: { provider: 'anthropic', data: { signature: 'A' } } },
        { type: 'reasoning', summary: ['plain'] },
      ],
    });

    expect(req.contents).toEqual([{ role: 'user', parts: [{ text: 'x' }] }]);
  });

  it('attaches a signature-only part to the item it follows', () => {
    const assembler = new GeminiOutputAssembler();

    assembler.push({ text: 'Hi' });
    assembler.push({ text: '', thoughtSignature: 'SIG_END' });
    assembler.finish();

    expect(assembler.items.map((item) => item.type)).toEqual(['message', 'reasoning']);
    expect(geminiReasoningState(assembler.items[1] as never)).toEqual({ signature: 'SIG_END', target: 'text' });
  });

  it('parses structured output, and refuses a filtered structured answer', () => {
    const structuredOutput = { name: 'c', schema: z.object({ city: z.string() }) };

    expect(
      fromGeminiResponse(response([{ text: '{"city":"Paris"}' }]), { model: 'm', input: 'x', structuredOutput }).parsed,
    ).toEqual({ city: 'Paris' });

    const filtered = response([], {
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' as never, index: 0 }],
    });

    expect(codeOf(() => fromGeminiResponse(filtered, { model: 'm', input: 'x', structuredOutput }))).toBe(
      'AI_CONTENT_FILTERED',
    );
    expect(codeOf(() => fromGeminiResponse(response([{ text: 'nope' }]), { model: 'm', input: 'x', structuredOutput }))).toBe(
      'AI_STRUCTURED_OUTPUT_INVALID',
    );
  });

  it('answers a blocked prompt as content_filter with no output', () => {
    const blocked = fromGeminiResponse(
      { promptFeedback: { blockReason: 'SAFETY' }, responseId: 'r' } as GenerateContentResponse,
      { model: 'gemini-2.5-flash', input: 'x' },
    );

    expect(blocked).toMatchObject({ finishReason: 'content_filter', output: [], outputText: '', model: 'gemini-2.5-flash' });
  });

  it('names a response Gemini did not name', () => {
    expect(fromGeminiResponse(response([{ text: 'x' }], { responseId: undefined }), { model: 'm', input: 'x' }).id).toMatch(
      /^gemini-/,
    );
  });

  it.each([
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'content_filter'],
    ['RECITATION', 'content_filter'],
    ['PROHIBITED_CONTENT', 'content_filter'],
    ['MALFORMED_FUNCTION_CALL', 'error'],
    ['OTHER', 'error'],
    ['STOP', 'stop'],
    [undefined, 'stop'],
  ])('finish reason %s -> %s', (reason, expected) => {
    expect(geminiFinishReason(reason, [])).toBe(expected);
  });

  it('normalises usage: output includes thoughts, input includes tool-use prompt tokens', () => {
    expect(
      geminiUsage({
        promptTokenCount: 10,
        toolUsePromptTokenCount: 4,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 3,
        cachedContentTokenCount: 2,
      }),
    ).toEqual({ inputTokens: 14, outputTokens: 8, reasoningTokens: 3, cachedInputTokens: 2 });
    expect(geminiUsage(undefined)).toEqual({});
    expect(geminiUsage({ promptTokenCount: 1 })).toEqual({ inputTokens: 1 });
  });

  it('infers MIME types from a URL path only', () => {
    expect(geminiMimeTypeFromUrl('https://x/a.webp')).toBe('image/webp');
    expect(geminiMimeTypeFromUrl('https://x/a.pdf#page=2')).toBe('application/pdf');
    expect(geminiMimeTypeFromUrl('https://x/a')).toBeUndefined();
    expect(geminiMimeTypeFromUrl('not a url')).toBeUndefined();
  });
});
