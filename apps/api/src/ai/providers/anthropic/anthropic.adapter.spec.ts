import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Span, SpanStatus, trace, Tracer, TracerProvider } from '@opentelemetry/api';

import { replayOutput } from '../../core/conversation';
import { AiError } from '../../core/ai-error';
import { AiProviderRegistry } from '../../core/provider-registry';
import { AiCallContext } from '../../core/provider-adapter.interface';
import type { AiResolvedStorageInput } from '../../core/types/file-inputs.types';
import { AI_PROVIDER_STATE, AiInputItem, AiStreamEvent } from '../../core/types/responses.types';
import { defineTool } from '../../core/tools';
import { z } from 'zod';
import { AnthropicClientFactory } from './anthropic-client.factory';
import { ANTHROPIC_PROVIDER_CALL_SPAN, AnthropicProviderAdapter } from './anthropic.adapter';
import { AnthropicProviderModule } from './anthropic.module';
import { messageFixture, textBlock, thinkingBlock, toolUseBlock } from './testing/anthropic-fixtures';
import { AnthropicMockServer } from './testing/anthropic-mock-transport';

// ---- a recording tracer (no SDK dependency) -----------------------------------

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: SpanStatus;
  ended: boolean;
}

const spans: RecordedSpan[] = [];

function recordingSpan(record: RecordedSpan): Span {
  const span = {
    setAttribute: (key: string, value: unknown) => {
      record.attributes[key] = value;
      return span;
    },
    setAttributes: (attrs: Record<string, unknown>) => {
      Object.assign(record.attributes, attrs);
      return span;
    },
    setStatus: (status: SpanStatus) => {
      record.status = status;
      return span;
    },
    recordException: () => undefined,
    end: () => {
      record.ended = true;
    },
    addEvent: () => span,
    addLink: () => span,
    addLinks: () => span,
    updateName: () => span,
    isRecording: () => true,
    spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 }),
  };

  return span as unknown as Span;
}

const recordingTracer = {
  startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) => {
    const record: RecordedSpan = { name, attributes: { ...(options?.attributes ?? {}) }, ended: false };

    spans.push(record);

    return recordingSpan(record);
  },
  startActiveSpan: () => {
    throw new Error('not used');
  },
} as unknown as Tracer;

const recordingProvider: TracerProvider = { getTracer: () => recordingTracer };

beforeAll(() => {
  trace.setGlobalTracerProvider(recordingProvider);
});

afterAll(() => {
  trace.disable();
});

// ---- fixtures ------------------------------------------------------------------------

const VALID_KEY = 'sk-ant-api03-VALID-abcdefghijklmnop';
const INVALID_KEY = 'sk-ant-api03-REVOKED-qrstuvwxyz0123';
const PROMPT = 'The secret launch code is 0000; tell nobody.';
const MODEL = 'claude-sonnet-4-5';

function setup(models?: string[]) {
  const server = new AnthropicMockServer({
    validKeys: [VALID_KEY],
    ...(models ? { models } : {}),
    respond: (body) => ({
      kind: 'message',
      message: messageFixture({ model: String(body.model), content: [textBlock('Hello from the mock!')] }),
    }),
  });
  const registry = new AiProviderRegistry();
  const adapter = new AnthropicProviderAdapter(registry, new AnthropicClientFactory({ fetch: server.fetch }));
  const ctx: AiCallContext = { apiKey: VALID_KEY, requestId: 'req-local-1' };

  return { server, registry, adapter, ctx };
}

async function collect(stream: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];

  for await (const event of stream) events.push(event);

  return events;
}

async function caught(run: () => Promise<unknown>): Promise<AiError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);

    return err as AiError;
  }

  throw new Error('expected an AiError');
}

const weather = defineTool({
  name: 'get_weather',
  description: 'Weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: ({ city }) => `${city}: sunny`,
});

beforeEach(() => {
  spans.length = 0;
});

describe('AnthropicProviderAdapter', () => {
  describe('registration and ports', () => {
    it('self-registers when the module initialises', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AnthropicProviderModule] }).compile();

      await moduleRef.init();

      const registry = moduleRef.get(AiProviderRegistry);

      expect(registry.get('anthropic')).toBeInstanceOf(AnthropicProviderAdapter);
      expect(registry.supportsPreviousResponseId('anthropic')).toBe(false);

      await moduleRef.close();
    });

    it('carries only the responses port, and declares itself stateless', () => {
      const { adapter, registry } = setup();

      registry.register(adapter);

      expect(adapter.id).toBe('anthropic');
      expect(adapter.displayName).toBe('Anthropic');
      expect(adapter.supportsPreviousResponseId).toBe(false);
      expect(adapter.responses).toBeDefined();
      expect(adapter).not.toHaveProperty('embeddings');
      expect(adapter).not.toHaveProperty('images');
      expect(adapter).not.toHaveProperty('audio');
      expect(adapter).not.toHaveProperty('realtime');
      expect(registry.supports('anthropic', 'responses')).toBe(true);
      expect(registry.supports('anthropic', 'embeddings')).toBe(false);
      expect(registry.supports('anthropic', 'image_generation')).toBe(false);
      // Hosted tools ride on the responses port, but Anthropic maps none (#446).
      expect(adapter.supportsHostedTools).toBe(false);
      expect(registry.supports('anthropic', 'hosted_tools')).toBe(false);
      expect(registry.capabilities('anthropic')).not.toContain('hosted_tools');
      expect(adapter.fileInputStrategy).toEqual({ image: 'presigned_url', file: 'inline' });
    });

    it('classifyModel delegates to the classifier table', () => {
      const { adapter } = setup();

      expect(adapter.classifyModel('claude-opus-5')?.capabilities).toContain('reasoning');
      expect(adapter.classifyModel('gpt-4o')).toBeNull();
    });
  });

  describe('listModels / verifyKey', () => {
    it('lists every page of models with a creation time', async () => {
      const ids = Array.from({ length: 3 }, (_, i) => `claude-test-${i}`);
      const { adapter, ctx, server } = setup(ids);

      const models = await adapter.listModels(ctx);

      expect(models.map((m) => m.id)).toEqual(ids);
      expect(models[0]).toMatchObject({ ownedBy: 'anthropic', createdAt: expect.any(Date) });
      expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models', apiKey: VALID_KEY });
    });

    it('verifyKey answers ok, AI_KEY_INVALID, or the mapped code', async () => {
      const { adapter, ctx } = setup();

      await expect(adapter.verifyKey(ctx)).resolves.toEqual({ ok: true });
      await expect(adapter.verifyKey({ ...ctx, apiKey: INVALID_KEY })).resolves.toEqual({
        ok: false,
        code: 'AI_KEY_INVALID',
      });
    });

    it('verifyKey maps a network failure instead of throwing', async () => {
      const registry = new AiProviderRegistry();
      const adapter = new AnthropicProviderAdapter(
        registry,
        new AnthropicClientFactory({ fetch: async () => Promise.reject(new TypeError('fetch failed')) }),
      );

      await expect(adapter.verifyKey({ apiKey: VALID_KEY, requestId: 'r' })).resolves.toMatchObject({
        ok: false,
        code: 'AI_PROVIDER_UNAVAILABLE',
      });
    });
  });

  describe('responses.create', () => {
    it('sends the mapped body with the key header and returns the providerRequestId', async () => {
      const { adapter, ctx, server } = setup();

      const response = await adapter.responses.create({ model: MODEL, instructions: 'Be brief.', input: 'hi' }, ctx);

      expect(response).toMatchObject({
        provider: 'anthropic',
        outputText: 'Hello from the mock!',
        finishReason: 'stop',
        providerRequestId: 'req_mock_1',
      });
      expect(server.messageRequests[0].apiKey).toBe(VALID_KEY);
      expect(server.messageRequests[0].body).toEqual({
        model: MODEL,
        max_tokens: 16000,
        system: 'Be brief.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        stream: false,
      });
    });

    it.each([
      [429, 'rate_limit_error', 'AI_RATE_LIMITED'],
      [529, 'overloaded_error', 'AI_PROVIDER_UNAVAILABLE'],
      [500, 'api_error', 'AI_PROVIDER_UNAVAILABLE'],
    ])('makes exactly one HTTP attempt on a %i (maxRetries: 0)', async (status, type, code) => {
      const { adapter, ctx, server } = setup();

      server.queue({ kind: 'error', status, type, headers: { 'retry-after': '7' } });

      const err = await caught(() => adapter.responses.create({ model: MODEL, input: 'hi' }, ctx));

      expect(err.code).toBe(code);
      expect(err.retryAfterMs).toBe(7000);
      expect(server.messageRequests).toHaveLength(1);
    });

    it('rejects an unsupported request before any network call', async () => {
      const { adapter, ctx, server } = setup();

      const err = await caught(() =>
        adapter.responses.create({ model: 'claude-3-5-haiku-20241022', input: 'x', reasoning: { effort: 'high' } }, ctx),
      );

      expect(err.code).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(server.requests).toHaveLength(0);
    });

    it('refuses previousResponseId before any network call — Anthropic stores nothing', async () => {
      const { adapter, ctx, server } = setup();

      const err = await caught(() =>
        adapter.responses.create({ model: MODEL, input: 'more', previousResponseId: 'msg_1' }, ctx),
      );

      expect(err.code).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(err.toJSON().details).toMatchObject({ capability: 'previous_response_id' });
      expect(server.requests).toHaveLength(0);
    });

    it('maps a 404 model to AI_MODEL_NOT_REACHABLE', async () => {
      const { adapter, ctx, server } = setup();

      server.queue({ kind: 'error', status: 404, type: 'not_found_error', message: 'model: claude-nope' });

      expect((await caught(() => adapter.responses.create({ model: 'claude-nope', input: 'x' }, ctx))).code).toBe(
        'AI_MODEL_NOT_REACHABLE',
      );
    });

    it('honours an already-aborted signal', async () => {
      const { adapter, ctx } = setup();
      const controller = new AbortController();

      controller.abort();

      const err = await caught(() => adapter.responses.create({ model: MODEL, input: 'x' }, { ...ctx, signal: controller.signal }));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ aborted: true });
    });

    it('replays a thinking tool-use turn the stateless API accepts (signed thinking first)', async () => {
      const { adapter, ctx, server } = setup();
      const thinking = thinkingBlock('I should look up the weather.', 'sig-abc');

      server.queue(
        { kind: 'message', message: messageFixture({ model: MODEL, content: [thinking, toolUseBlock('get_weather', { city: 'Lima' }, 'toolu_1')] }) },
        { kind: 'message', message: messageFixture({ model: MODEL, content: [textBlock('Sunny in Lima.')] }) },
      );

      const request = {
        model: MODEL,
        input: 'Weather in Lima?',
        tools: [weather.tool],
        reasoning: { effort: 'low' as const },
      };
      const first = await adapter.responses.create(request, ctx);

      expect(first.finishReason).toBe('tool_calls');
      expect(first.output[0]).toEqual({
        type: 'reasoning',
        summary: ['I should look up the weather.'],
        [AI_PROVIDER_STATE]: { provider: 'anthropic', data: { blocks: [{ type: 'thinking', thinking: 'I should look up the weather.', signature: 'sig-abc' }] } },
      });
      // The signature is never part of what a caller can serialise.
      expect(JSON.stringify(first)).not.toContain('sig-abc');

      const history: AiInputItem[] = [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'Weather in Lima?' }] },
        ...replayOutput(first.output),
        { type: 'function_call_output', callId: 'toolu_1', output: 'Lima: sunny' },
      ];
      const second = await adapter.responses.create({ ...request, input: history }, ctx);

      expect(second.outputText).toBe('Sunny in Lima.');
      expect(server.messageRequests[1].body?.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Weather in Lima?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should look up the weather.', signature: 'sig-abc' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Lima' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Lima: sunny' }] },
      ]);
    });

    it('delivers storage inputs: an image by presigned URL, a PDF inline', async () => {
      const { adapter, ctx, server } = setup();
      const pdf = new Uint8Array(Buffer.from('%PDF-1.7 mock'));
      const storageInputs = new Map<string, AiResolvedStorageInput>([
        ['img-1', { storageObjectId: 'img-1', modality: 'image', mimeType: 'image/png', filename: 'a.png', strategy: 'presigned_url', url: 'https://bucket.example/a.png?sig=1' }],
        ['doc-1', { storageObjectId: 'doc-1', modality: 'file', mimeType: 'application/pdf', filename: 'report.pdf', strategy: 'inline', read: async () => ({ data: pdf, mimeType: 'application/pdf' }) }],
      ]);

      await adapter.responses.create(
        {
          model: MODEL,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'image', storageObjectId: 'img-1' },
                { type: 'file', storageObjectId: 'doc-1' },
                { type: 'text', text: 'Summarise.' },
              ],
            },
          ],
        },
        { ...ctx, storageInputs },
      );

      expect(server.messageRequests[0].body?.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'https://bucket.example/a.png?sig=1' } },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(pdf).toString('base64') }, title: 'report.pdf' },
            { type: 'text', text: 'Summarise.' },
          ],
        },
      ]);
    });

    it('refuses a storage input the runtime did not resolve', async () => {
      const { adapter, ctx, server } = setup();

      const err = await caught(() =>
        adapter.responses.create(
          { model: MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'image', storageObjectId: 'nope' }] }] },
          ctx,
        ),
      );

      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('responses.stream', () => {
    it('sends stream: true and yields deltas that equal the final text', async () => {
      const { adapter, ctx, server } = setup();

      const events = await collect(adapter.responses.stream({ model: MODEL, input: 'hi' }, ctx));
      const completed = events[events.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>;
      const deltas = events
        .filter((e): e is Extract<AiStreamEvent, { type: 'output_text.delta' }> => e.type === 'output_text.delta')
        .map((e) => e.delta)
        .join('');

      expect(server.messageRequests[0].body?.stream).toBe(true);
      expect(events[0].type).toBe('response.created');
      expect(completed.type).toBe('response.completed');
      expect(deltas).toBe('Hello from the mock!');
      expect(completed.response.outputText).toBe(deltas);
      expect(completed.response.providerRequestId).toBe('req_mock_1');
    });

    it('throws AI_KEY_INVALID before the stream starts', async () => {
      const { adapter, ctx } = setup();

      const err = await caught(() => collect(adapter.responses.stream({ model: MODEL, input: 'hi' }, { ...ctx, apiKey: INVALID_KEY })));

      expect(err.code).toBe('AI_KEY_INVALID');
    });

    it('ends with one error event when Anthropic sends an error frame mid-stream', async () => {
      const { adapter, ctx, server } = setup();
      const message = messageFixture({ model: MODEL, content: [textBlock('Hel')] });

      server.queue({
        kind: 'sse',
        frames: [
          { event: 'message_start', data: { type: 'message_start', message: { ...message, content: [] } } },
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } },
          { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: `Overloaded ${VALID_KEY}` } } },
        ],
      });

      const events = await collect(adapter.responses.stream({ model: MODEL, input: 'hi' }, ctx));

      expect(events.map((e) => e.type)).toEqual(['response.created', 'output_text.delta', 'error']);
      expect(events[2]).toEqual({ type: 'error', code: 'AI_PROVIDER_UNAVAILABLE', message: 'Anthropic is unavailable or the request failed.' });
      expect(JSON.stringify(events)).not.toContain(VALID_KEY);
    });

    it('ends with an error event when the stream closes without message_stop', async () => {
      const { adapter, ctx, server } = setup();
      const message = messageFixture({ model: MODEL, content: [] });

      server.queue({
        kind: 'sse',
        frames: [{ event: 'message_start', data: { type: 'message_start', message } }],
      });

      const events = await collect(adapter.responses.stream({ model: MODEL, input: 'hi' }, ctx));

      expect(events.map((e) => e.type)).toEqual(['response.created', 'error']);
    });

    it('closes the HTTP stream when the consumer stops early', async () => {
      const { adapter, ctx, server } = setup();
      const message = messageFixture({ model: MODEL, content: [] });

      server.queue({
        kind: 'sse',
        hang: true,
        frames: [{ event: 'message_start', data: { type: 'message_start', message } }],
      });

      for await (const event of adapter.responses.stream({ model: MODEL, input: 'hi' }, ctx)) {
        expect(event.type).toBe('response.created');
        break;
      }

      expect(server.messageRequests[0].signal?.aborted).toBe(true);
    });
  });

  describe('observability', () => {
    it('wraps each call in an ai.provider.call span with safe attributes only', async () => {
      const { adapter, ctx } = setup();

      await adapter.responses.create({ model: MODEL, input: PROMPT }, ctx);
      await collect(adapter.responses.stream({ model: MODEL, input: PROMPT }, ctx));
      await adapter.verifyKey({ ...ctx, apiKey: INVALID_KEY });

      expect(spans.map((s) => [s.name, s.attributes['ai.operation'], s.attributes['ai.status']])).toEqual([
        [ANTHROPIC_PROVIDER_CALL_SPAN, 'messages.create', 'ok'],
        [ANTHROPIC_PROVIDER_CALL_SPAN, 'messages.stream', 'ok'],
        [ANTHROPIC_PROVIDER_CALL_SPAN, 'verify_key', 'AI_KEY_INVALID'],
      ]);
      expect(spans.every((s) => s.ended)).toBe(true);
      expect(spans[0].attributes).toEqual({
        'ai.provider': 'anthropic',
        'ai.model': MODEL,
        'ai.operation': 'messages.create',
        'ai.status': 'ok',
      });

      const serialised = JSON.stringify(spans);

      expect(serialised).not.toContain(PROMPT);
      expect(serialised).not.toContain(VALID_KEY);
      expect(serialised).not.toContain(INVALID_KEY);
    });

    it('never logs the API key or the prompt (redaction)', async () => {
      const logged: unknown[] = [];
      const capture = (...args: unknown[]) => {
        logged.push(args);
      };
      const spies = [
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(capture),
        jest.spyOn(Logger.prototype, 'log').mockImplementation(capture),
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
        jest.spyOn(Logger.prototype, 'error').mockImplementation(capture),
        jest.spyOn(console, 'log').mockImplementation(capture),
        jest.spyOn(console, 'info').mockImplementation(capture),
        jest.spyOn(console, 'warn').mockImplementation(capture),
        jest.spyOn(console, 'error').mockImplementation(capture),
        jest.spyOn(console, 'debug').mockImplementation(capture),
      ];

      try {
        const { adapter, ctx, server } = setup();
        const bad = { ...ctx, apiKey: INVALID_KEY };

        await adapter.listModels(ctx);
        await adapter.verifyKey(ctx);
        await adapter.verifyKey(bad);
        await adapter.responses.create({ model: MODEL, input: PROMPT }, ctx);
        await caught(() => adapter.responses.create({ model: MODEL, input: PROMPT }, bad));
        await collect(adapter.responses.stream({ model: MODEL, input: PROMPT }, ctx));
        await caught(() => collect(adapter.responses.stream({ model: MODEL, input: PROMPT }, bad)));

        server.queue({ kind: 'error', status: 500, type: 'api_error', message: `oops ${VALID_KEY}` });
        await caught(() => adapter.responses.create({ model: MODEL, input: PROMPT }, ctx));

        // The debug line was actually emitted — the test is not vacuous.
        expect(logged.length).toBeGreaterThanOrEqual(8);
        expect(JSON.stringify(logged)).toContain('messages.create');

        const serialised = JSON.stringify(logged);

        expect(serialised).not.toContain(VALID_KEY);
        expect(serialised).not.toContain(INVALID_KEY);
        expect(serialised).not.toContain(PROMPT);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    it('never serialises the key into a thrown AiError', async () => {
      const { adapter, ctx } = setup();
      const err = await caught(() => adapter.responses.create({ model: MODEL, input: 'x' }, { ...ctx, apiKey: INVALID_KEY }));

      expect(err.code).toBe('AI_KEY_INVALID');
      expect(JSON.stringify(err)).not.toContain(INVALID_KEY);
      expect(err.message).not.toContain(INVALID_KEY);
    });
  });
});
