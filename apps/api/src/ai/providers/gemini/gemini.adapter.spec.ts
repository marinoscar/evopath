import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Span, SpanStatus, trace, Tracer, TracerProvider } from '@opentelemetry/api';
import { z } from 'zod';

import { AiError } from '../../core/ai-error';
import { replayOutput } from '../../core/conversation';
import { AiProviderRegistry } from '../../core/provider-registry';
import { AiCallContext, AiProviderAdapter } from '../../core/provider-adapter.interface';
import { defineTool } from '../../core/tools';
import type { AiResolvedStorageInput } from '../../core/types/file-inputs.types';
import { AiInputItem, AiStreamEvent } from '../../core/types/responses.types';
import { GeminiClientFactory } from './gemini-client.factory';
import { GEMINI_PROVIDER_CALL_SPAN, GeminiProviderAdapter } from './gemini.adapter';
import { GeminiProviderModule } from './gemini.module';
import { functionCallPart, responseFixture, streamChunksFor, textPart, thoughtPart } from './testing/gemini-fixtures';
import { GeminiMockServer, MockGeminiModel } from './testing/gemini-mock-transport';

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

const VALID_KEY = 'AIzaSy-VALID-abcdefghijklmnopqrstuv';
const INVALID_KEY = 'AIzaSy-REVOKED-qrstuvwxyz012345678';
const PROMPT = 'The secret launch code is 0000; tell nobody.';
const MODEL = 'gemini-2.5-flash';
const GEMINI_3 = 'gemini-3-pro-preview';

const DEFAULT_MODELS: Array<string | MockGeminiModel> = [
  MODEL,
  GEMINI_3,
  'gemini-2.0-flash',
  { id: 'gemini-embedding-001', kind: 'embedding', dimensions: 8 },
];

function setup(models: Array<string | MockGeminiModel> = DEFAULT_MODELS) {
  const server = new GeminiMockServer({
    validKeys: [VALID_KEY],
    models,
    respond: (_body, model) => ({
      kind: 'response',
      response: responseFixture({ model, parts: [textPart('Hello from the mock!')] }),
    }),
  });
  const registry = new AiProviderRegistry();
  const adapter = new GeminiProviderAdapter(registry, new GeminiClientFactory({ fetch: server.fetch }));
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

describe('GeminiProviderAdapter', () => {
  describe('registration and ports', () => {
    it('self-registers when the module initialises', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [GeminiProviderModule] }).compile();

      await moduleRef.init();

      const registry = moduleRef.get(AiProviderRegistry);

      expect(registry.ids()).toContain('gemini');
      expect(registry.get('gemini')).toBeInstanceOf(GeminiProviderAdapter);

      await moduleRef.close();
    });

    it('carries responses and embeddings, is stateless, runs no hosted tools, and takes files inline', () => {
      const { adapter: concrete, registry } = setup();
      const adapter: AiProviderAdapter = concrete;

      registry.register(adapter);

      expect(adapter.id).toBe('gemini');
      expect(adapter.displayName).toBe('Google Gemini');
      expect(adapter.responses).toBeDefined();
      expect(adapter.embeddings).toBeDefined();
      expect(adapter.images).toBeUndefined();
      expect(adapter.audio).toBeUndefined();
      expect(adapter.realtime).toBeUndefined();
      expect(adapter.supportsPreviousResponseId).toBe(false);
      expect(adapter.supportsHostedTools).toBe(false);
      expect(adapter.fileInputStrategy).toEqual({ image: 'inline', file: 'inline' });
      expect(registry.supports('gemini', 'embeddings')).toBe(true);
      expect(registry.supports('gemini', 'hosted_tools')).toBe(false);
      expect(registry.supports('gemini', 'image_generation')).toBe(false);
    });

    it('classifyModel delegates to the classifier, with the listing metadata', () => {
      const { adapter } = setup();

      expect(adapter.classifyModel('gemini-2.5-flash')?.capabilities).toContain('reasoning');
      expect(adapter.classifyModel('gemini-2.5-flash', { outputTokenLimit: 1234 })?.maxOutputTokens).toBe(1234);
      expect(adapter.classifyModel('imagen-4.0-generate-001')).toBeNull();
    });
  });

  describe('listModels / verifyKey', () => {
    it('lists every page of models, without the models/ prefix, with their metadata', async () => {
      const ids = Array.from({ length: 1003 }, (_, i) => `gemini-2.5-flash-${i}`);
      const { adapter, ctx, server } = setup([...ids, { id: 'gemini-embedding-001', kind: 'embedding' }]);
      const models = await adapter.listModels(ctx);

      expect(models).toHaveLength(1004);
      expect(models[0]).toEqual({
        id: 'gemini-2.5-flash-0',
        ownedBy: 'google',
        metadata: {
          displayName: 'gemini-2.5-flash-0',
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
          supportedActions: ['generateContent', 'countTokens', 'createCachedContent', 'batchGenerateContent'],
          thinking: true,
        },
      });
      expect(models[1003].metadata?.supportedActions).toContain('embedContent');
      expect(server.requests.filter((r) => r.path === '/v1beta/models')).toHaveLength(2);
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
      const adapter = new GeminiProviderAdapter(
        registry,
        new GeminiClientFactory({ fetch: async () => Promise.reject(new TypeError('fetch failed')) }),
      );

      await expect(adapter.verifyKey({ apiKey: VALID_KEY, requestId: 'r' })).resolves.toMatchObject({
        ok: false,
        code: 'AI_PROVIDER_UNAVAILABLE',
      });
    });
  });

  describe('responses.create', () => {
    it('sends the mapped body with the key header', async () => {
      const { adapter, ctx, server } = setup();
      const res = await adapter.responses!.create(
        { model: MODEL, input: 'hi', instructions: 'Be brief.', maxOutputTokens: 50, reasoning: { effort: 'low' } },
        ctx,
      );

      expect(res).toMatchObject({ provider: 'gemini', outputText: 'Hello from the mock!', finishReason: 'stop' });

      const [request] = server.generateRequests;

      expect(request.path).toBe(`/v1beta/models/${MODEL}:generateContent`);
      expect(request.apiKey).toBe(VALID_KEY);
      expect(request.body).toEqual({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction: { parts: [{ text: 'Be brief.' }] },
        generationConfig: { maxOutputTokens: 50, thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 } },
      });
    });

    it('rejects an unsupported request before any network call', async () => {
      const { adapter, ctx, server } = setup();
      const err = await caught(() =>
        adapter.responses!.create({ model: 'gemini-2.0-flash', input: 'x', reasoning: { effort: 'high' } }, ctx),
      );

      expect(err.code).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(server.requests).toHaveLength(0);
    });

    it('refuses previousResponseId before any network call — Gemini stores nothing', async () => {
      const { adapter, ctx, server } = setup();
      const err = await caught(() => adapter.responses!.create({ model: MODEL, input: 'x', previousResponseId: 'r1' }, ctx));

      expect(err.code).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(server.requests).toHaveLength(0);
    });

    it('maps an unknown model to AI_MODEL_NOT_REACHABLE and a 429 to AI_RATE_LIMITED with its delay', async () => {
      const { adapter, ctx, server } = setup();

      expect((await caught(() => adapter.responses!.create({ model: 'gemini-2.5-pro', input: 'x' }, ctx))).code).toBe(
        'AI_MODEL_NOT_REACHABLE',
      );

      server.queue({
        kind: 'error',
        status: 429,
        grpcStatus: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }],
      });

      const limited = await caught(() => adapter.responses!.create({ model: MODEL, input: 'x' }, ctx));

      expect(limited.code).toBe('AI_RATE_LIMITED');
      expect(limited.retryAfterMs).toBe(12_000);
    });

    it('honours an already-aborted signal', async () => {
      const { adapter, ctx } = setup();
      const controller = new AbortController();

      controller.abort();

      const err = await caught(() => adapter.responses!.create({ model: MODEL, input: 'x' }, { ...ctx, signal: controller.signal }));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ aborted: true });
    });

    it('replays a Gemini 3 function-call turn with its thought signature, which the stateless API requires', async () => {
      const { adapter, ctx, server } = setup();

      server.queue({
        kind: 'response',
        response: responseFixture({
          model: GEMINI_3,
          parts: [
            thoughtPart('I need the tool.'),
            functionCallPart('get_weather', { city: 'Paris' }, { id: 'fc_9', thoughtSignature: 'SIG_REQUIRED' }),
          ],
        }),
      });

      const question: AiInputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'weather?' }] }];
      const first = await adapter.responses!.create(
        { model: GEMINI_3, input: question, tools: [weather.tool], reasoning: { summary: 'auto' } },
        ctx,
      );

      expect(first.finishReason).toBe('tool_calls');
      expect(first.output.find((i) => i.type === 'reasoning')).toMatchObject({ summary: ['I need the tool.'] });
      expect(JSON.stringify(first)).not.toContain('SIG_REQUIRED');

      const output: AiInputItem = { type: 'function_call_output', callId: 'fc_9', output: '{"tempC":21}' };

      // Without the replayed reasoning item, the real API (and the mock) refuses the turn.
      const withoutSignature = replayOutput(first.output).filter((item) => item.type !== 'reasoning');

      expect(
        (await caught(() => adapter.responses!.create({ model: GEMINI_3, input: [...question, ...withoutSignature, output], tools: [weather.tool] }, ctx)))
          .code,
      ).toBe('AI_INVALID_REQUEST');

      const second = await adapter.responses!.create(
        { model: GEMINI_3, input: [...question, ...replayOutput(first.output), output], tools: [weather.tool] },
        ctx,
      );

      expect(second.outputText).toBe('Hello from the mock!');

      const sent = server.generateRequests[server.generateRequests.length - 1].body as {
        contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      };

      expect(sent.contents[1].parts).toContainEqual({
        functionCall: { name: 'get_weather', args: { city: 'Paris' }, id: 'fc_9' },
        thoughtSignature: 'SIG_REQUIRED',
      });
      expect(sent.contents[2]).toEqual({
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { tempC: 21 }, id: 'fc_9' } }],
      });
    });

    it('delivers storage inputs inline, as base64', async () => {
      const { adapter, ctx, server } = setup();
      const bytes = Buffer.from('%PDF-1.7 tiny');
      const pdf: AiResolvedStorageInput = {
        storageObjectId: 'obj-pdf',
        modality: 'file',
        mimeType: 'application/pdf',
        filename: 'report.pdf',
        strategy: 'inline',
        read: async () => ({ data: bytes, mimeType: 'application/pdf' }),
      };

      await adapter.responses!.create(
        {
          model: MODEL,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'text', text: 'summarise' },
                { type: 'file', storageObjectId: 'obj-pdf' },
              ],
            },
          ],
        },
        { ...ctx, storageInputs: new Map([['obj-pdf', pdf]]) },
      );

      const body = server.generateRequests[0].body as { contents: Array<{ parts: unknown[] }> };

      expect(body.contents[0].parts).toEqual([
        { text: 'summarise' },
        { inlineData: { mimeType: 'application/pdf', data: bytes.toString('base64') } },
      ]);
    });

    it('refuses a storage input the runtime did not resolve, or prepared for another strategy', async () => {
      const { adapter, ctx, server } = setup();
      const input: AiInputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'image', storageObjectId: 'obj-1' }] }];

      expect((await caught(() => adapter.responses!.create({ model: MODEL, input }, ctx))).code).toBe('AI_INVALID_REQUEST');

      const presigned: AiResolvedStorageInput = {
        storageObjectId: 'obj-1',
        modality: 'image',
        mimeType: 'image/png',
        filename: 'a.png',
        strategy: 'presigned_url',
        url: 'https://bucket.example.com/a.png?sig=1',
      };

      expect(
        (await caught(() => adapter.responses!.create({ model: MODEL, input }, { ...ctx, storageInputs: new Map([['obj-1', presigned]]) })))
          .code,
      ).toBe('AI_INVALID_REQUEST');
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('responses.stream', () => {
    it('streams over alt=sse and yields deltas that equal the final text', async () => {
      const { adapter, ctx, server } = setup();
      const events = await collect(adapter.responses!.stream({ model: MODEL, input: 'hi' }, ctx));

      expect(server.generateRequests[0].path).toBe(`/v1beta/models/${MODEL}:streamGenerateContent`);
      expect(server.generateRequests[0].query.get('alt')).toBe('sse');
      expect(events[0].type).toBe('response.created');

      const last = events[events.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>;
      const deltas = events.filter((e) => e.type === 'output_text.delta').map((e) => (e as { delta: string }).delta);

      expect(last.type).toBe('response.completed');
      expect(deltas.join('')).toBe(last.response.outputText);
      expect(last.response.outputText).toBe('Hello from the mock!');
    });

    it('throws AI_KEY_INVALID before the stream starts', async () => {
      const { adapter, ctx } = setup();
      const err = await caught(() => collect(adapter.responses!.stream({ model: MODEL, input: 'hi' }, { ...ctx, apiKey: INVALID_KEY })));

      expect(err.code).toBe('AI_KEY_INVALID');
    });

    it('ends with one error event when Gemini sends an error object mid-stream', async () => {
      const { adapter, ctx, server } = setup();
      const [firstChunk] = streamChunksFor(responseFixture({ model: MODEL, parts: [textPart('partial answer')] }));

      server.queue({
        kind: 'raw',
        chunks: [
          `data: ${JSON.stringify(firstChunk)}\r\n\r\n`,
          JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `quota ${VALID_KEY}` } }),
        ],
      });

      const events = await collect(adapter.responses!.stream({ model: MODEL, input: 'hi' }, ctx));

      expect(events[0].type).toBe('response.created');
      expect(events[events.length - 1]).toEqual({
        type: 'error',
        code: 'AI_RATE_LIMITED',
        message: 'Gemini rate-limited the request.',
      });
      expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(VALID_KEY);
    });

    it('ends with an error event when the stream closes without a finish reason', async () => {
      const { adapter, ctx, server } = setup();
      const chunks = streamChunksFor(responseFixture({ model: MODEL, parts: [textPart('cut off')] }));

      server.queue({ kind: 'sse', frames: chunks.slice(0, -1) });

      const events = await collect(adapter.responses!.stream({ model: MODEL, input: 'hi' }, ctx));

      expect(events.map((e) => e.type)).toContain('response.created');
      expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'AI_PROVIDER_UNAVAILABLE' });
      expect(events.some((e) => e.type === 'response.completed')).toBe(false);
    });

    it('throws when the stream closes before anything arrived', async () => {
      const { adapter, ctx, server } = setup();

      server.queue({ kind: 'sse', frames: [] });

      expect((await caught(() => collect(adapter.responses!.stream({ model: MODEL, input: 'hi' }, ctx)))).code).toBe(
        'AI_PROVIDER_UNAVAILABLE',
      );
    });

    it('closes the HTTP stream when the consumer stops early', async () => {
      const { adapter, ctx, server } = setup();
      const [firstChunk] = streamChunksFor(responseFixture({ model: MODEL, parts: [textPart('never ending')] }));

      server.queue({ kind: 'sse', hang: true, frames: [firstChunk] });

      for await (const event of adapter.responses!.stream({ model: MODEL, input: 'hi' }, ctx)) {
        expect(event.type).toBe('response.created');
        break;
      }

      expect(server.generateRequests[0].signal?.aborted).toBe(true);
    });
  });

  describe('embeddings', () => {
    it('embeds one content per input over batchEmbedContents, honouring dimensions', async () => {
      const { adapter, ctx, server } = setup();
      const res = await adapter.embeddings!.embed({ model: 'gemini-embedding-001', input: ['a', 'b'], dimensions: 4 }, ctx);

      expect(res).toMatchObject({ provider: 'gemini', model: 'gemini-embedding-001', dimensions: 4, usage: {} });
      expect(res.vectors).toHaveLength(2);

      const [request] = server.requests;

      expect(request.path).toBe('/v1beta/models/gemini-embedding-001:batchEmbedContents');
      expect(request.body).toEqual({
        requests: [
          { model: 'models/gemini-embedding-001', content: { role: 'user', parts: [{ text: 'a' }] }, outputDimensionality: 4 },
          { model: 'models/gemini-embedding-001', content: { role: 'user', parts: [{ text: 'b' }] }, outputDimensionality: 4 },
        ],
      });
    });

    it('refuses a generative model before any network call', async () => {
      const { adapter, ctx, server } = setup();

      expect((await caught(() => adapter.embeddings!.embed({ model: MODEL, input: 'a' }, ctx))).code).toBe(
        'AI_CAPABILITY_UNSUPPORTED',
      );
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('observability', () => {
    it('wraps each call in an ai.provider.call span with safe attributes only', async () => {
      const { adapter, ctx } = setup();

      await adapter.responses!.create({ model: MODEL, input: PROMPT }, ctx);
      await collect(adapter.responses!.stream({ model: MODEL, input: PROMPT }, ctx));
      await adapter.embeddings!.embed({ model: 'gemini-embedding-001', input: PROMPT }, ctx);
      await adapter.verifyKey({ ...ctx, apiKey: INVALID_KEY });

      expect(spans.map((s) => [s.name, s.attributes['ai.operation'], s.attributes['ai.status']])).toEqual([
        [GEMINI_PROVIDER_CALL_SPAN, 'generate_content', 'ok'],
        [GEMINI_PROVIDER_CALL_SPAN, 'generate_content.stream', 'ok'],
        [GEMINI_PROVIDER_CALL_SPAN, 'embed_content', 'ok'],
        [GEMINI_PROVIDER_CALL_SPAN, 'verify_key', 'AI_KEY_INVALID'],
      ]);
      expect(spans.every((s) => s.ended)).toBe(true);
      expect(spans[0].attributes).toEqual({
        'ai.provider': 'gemini',
        'ai.model': MODEL,
        'ai.operation': 'generate_content',
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
        await adapter.responses!.create({ model: MODEL, input: PROMPT }, ctx);
        await caught(() => adapter.responses!.create({ model: MODEL, input: PROMPT }, bad));
        await collect(adapter.responses!.stream({ model: MODEL, input: PROMPT }, ctx));
        await caught(() => collect(adapter.responses!.stream({ model: MODEL, input: PROMPT }, bad)));

        server.queue({ kind: 'error', status: 500, grpcStatus: 'INTERNAL', message: `oops ${VALID_KEY}` });
        await caught(() => adapter.responses!.create({ model: MODEL, input: PROMPT }, ctx));

        // The debug line was actually emitted — the test is not vacuous.
        expect(logged.length).toBeGreaterThanOrEqual(8);
        expect(JSON.stringify(logged)).toContain('generate_content');

        const serialised = JSON.stringify(logged);

        expect(serialised).not.toContain(VALID_KEY);
        expect(serialised).not.toContain(INVALID_KEY);
        expect(serialised).not.toContain(PROMPT);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    it('never serialises the key into a thrown AiError, though the provider echoed it', async () => {
      const { adapter, ctx } = setup();
      const err = await caught(() => adapter.responses!.create({ model: MODEL, input: 'x' }, { ...ctx, apiKey: INVALID_KEY }));

      expect(err.code).toBe('AI_KEY_INVALID');
      expect(JSON.stringify(err)).not.toContain(INVALID_KEY);
      expect(err.message).not.toContain(INVALID_KEY);
    });
  });
});
