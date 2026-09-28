import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Span, SpanStatus, trace, Tracer, TracerProvider } from '@opentelemetry/api';

import { AiError } from '../../core/ai-error';
import { AiProviderRegistry } from '../../core/provider-registry';
import { AiCallContext, AiProviderAdapter } from '../../core/provider-adapter.interface';
import { AiStreamEvent } from '../../core/types/responses.types';
import { OpenAiClientFactory } from './openai-client.factory';
import { AI_PROVIDER_CALL_SPAN, OpenAiProviderAdapter } from './openai.adapter';
import { OpenAiProviderModule } from './openai.module';
import { messageItem, responseFixture } from './testing/openai-fixtures';
import { OpenAiMockServer } from './testing/openai-mock-transport';

// ---- a recording tracer (no SDK dependency) -----------------------------------

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: SpanStatus;
  ended: boolean;
  exceptions: unknown[];
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
    recordException: (exception: unknown) => {
      record.exceptions.push(exception);
    },
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
    const record: RecordedSpan = { name, attributes: { ...(options?.attributes ?? {}) }, ended: false, exceptions: [] };

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

const VALID_KEY = 'sk-proj-VALID-abcdefghijklmnop';
const INVALID_KEY = 'sk-proj-REVOKED-qrstuvwxyz0123';
const PROMPT = 'The secret launch code is 0000; tell nobody.';

function setup() {
  const server = new OpenAiMockServer({
    validKeys: [VALID_KEY],
    respond: () => ({ kind: 'response', response: responseFixture({ output: [messageItem('Hello from the mock!')] }) }),
  });
  const registry = new AiProviderRegistry();
  const adapter = new OpenAiProviderAdapter(registry, new OpenAiClientFactory({ fetch: server.fetch }));
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

beforeEach(() => {
  spans.length = 0;
});

describe('OpenAiProviderAdapter', () => {
  describe('registration and ports', () => {
    it('self-registers when the module initialises', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [OpenAiProviderModule] }).compile();

      await moduleRef.init();

      const registry = moduleRef.get(AiProviderRegistry);

      expect(registry.ids()).toEqual(['openai']);
      expect(registry.get('openai')).toBeInstanceOf(OpenAiProviderAdapter);

      await moduleRef.close();
    });

    it('accepts a client factory override through DI', async () => {
      const server = new OpenAiMockServer({ validKeys: [VALID_KEY] });
      const moduleRef = await Test.createTestingModule({ imports: [OpenAiProviderModule] })
        .overrideProvider(OpenAiClientFactory)
        .useFactory({ factory: () => new OpenAiClientFactory({ fetch: server.fetch }) })
        .compile();

      await moduleRef.get(OpenAiProviderAdapter).listModels({ apiKey: VALID_KEY, requestId: 'r' });

      expect(server.requestsTo('/v1/models')).toHaveLength(1);
    });

    it('carries the responses, embeddings, images, audio and realtime ports', () => {
      const { adapter, registry } = setup();

      adapter.onModuleInit();

      const port: AiProviderAdapter = adapter;

      expect(port.responses).toBeDefined();
      expect(port.images).toBeDefined();
      expect(typeof port.audio?.transcribe).toBe('function');
      expect(typeof port.audio?.speech).toBe('function');
      expect(port.embeddings).toBeDefined();
      expect(typeof port.realtime?.createSession).toBe('function');
      expect(registry.supports('openai', 'responses')).toBe(true);
      expect(registry.supports('openai', 'image_generation')).toBe(true);
      expect(registry.supports('openai', 'image_edit')).toBe(true);
      expect(registry.supports('openai', 'audio_transcription')).toBe(true);
      expect(registry.supports('openai', 'audio_speech')).toBe(true);
      expect(registry.supports('openai', 'embeddings')).toBe(true);
      expect(registry.supports('openai', 'realtime')).toBe(true);
    });

    it('classifyModel delegates to the classifier table', () => {
      const { adapter } = setup();

      expect(adapter.classifyModel('gpt-4o')?.capabilities).toContain('vision_input');
      expect(adapter.classifyModel('mystery-model')).toBeNull();
    });
  });

  describe('listModels / verifyKey', () => {
    it('lists models with owner and creation time', async () => {
      const { adapter, ctx } = setup();
      const models = await adapter.listModels(ctx);

      expect(models[0]).toEqual({ id: 'gpt-4o', ownedBy: 'openai', createdAt: new Date(1_700_000_000_000) });
    });

    it('verifyKey answers ok, AI_KEY_INVALID, or the mapped code', async () => {
      const { adapter, ctx, server } = setup();

      await expect(adapter.verifyKey(ctx)).resolves.toEqual({ ok: true });
      await expect(adapter.verifyKey({ ...ctx, apiKey: INVALID_KEY })).resolves.toEqual({ ok: false, code: 'AI_KEY_INVALID' });
      await expect(adapter.verifyKey({ ...ctx, apiKey: '' })).resolves.toEqual({ ok: false, code: 'AI_KEY_INVALID' });

      expect(server.requestsTo('/v1/models').map((r) => r.apiKey)).toEqual([VALID_KEY, INVALID_KEY]);
    });

    it('verifyKey maps a network failure instead of throwing', async () => {
      const adapter = new OpenAiProviderAdapter(
        new AiProviderRegistry(),
        new OpenAiClientFactory({ fetch: () => Promise.reject(new TypeError('fetch failed')) }),
      );

      await expect(adapter.verifyKey({ apiKey: VALID_KEY, requestId: 'r' })).resolves.toMatchObject({
        ok: false,
        code: 'AI_PROVIDER_UNAVAILABLE',
      });
    });
  });

  describe('responses.create', () => {
    it('sends the mapped body and returns the providerRequestId', async () => {
      const { adapter, ctx, server } = setup();
      const response = await adapter.responses.create({ model: 'gpt-4o', input: PROMPT, maxOutputTokens: 32 }, ctx);

      expect(response.outputText).toBe('Hello from the mock!');
      expect(response.providerRequestId).toMatch(/^req_mock_/);

      const [sent] = server.requestsTo('/v1/responses');

      expect(sent.body).toEqual({ model: 'gpt-4o', input: PROMPT, max_output_tokens: 32, stream: false });
      expect(sent.apiKey).toBe(VALID_KEY);
    });

    it('makes exactly one HTTP attempt on a 5xx or 429 (maxRetries: 0)', async () => {
      const { adapter, ctx, server } = setup();

      server.enqueue({ kind: 'error', status: 500, error: { message: 'boom', type: 'server_error', code: null } });
      expect((await caught(() => adapter.responses.create({ model: 'gpt-4o', input: 'x' }, ctx))).code).toBe('AI_PROVIDER_UNAVAILABLE');

      server.enqueue({
        kind: 'error',
        status: 429,
        error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' },
        headers: { 'retry-after': '7' },
      });

      const limited = await caught(() => adapter.responses.create({ model: 'gpt-4o', input: 'x' }, ctx));

      expect(limited.code).toBe('AI_RATE_LIMITED');
      expect(limited.retryAfterMs).toBe(7000);
      expect(limited.toRateLimitError()?.retryAfterMs).toBe(7000);
      expect(server.requestsTo('/v1/responses')).toHaveLength(2);
    });

    it('rejects an unsupported request before any network call', async () => {
      const { adapter, ctx, server } = setup();
      const err = await caught(() =>
        adapter.responses.create({ model: 'gpt-4o', input: 'x', reasoning: { effort: 'high' } }, ctx),
      );

      expect(err.code).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(server.requests).toHaveLength(0);
    });

    it('maps a 404 model to AI_MODEL_NOT_REACHABLE', async () => {
      const { adapter, ctx, server } = setup();

      server.enqueue({
        kind: 'error',
        status: 404,
        error: { message: 'The model `gpt-7` does not exist', type: 'invalid_request_error', param: 'model', code: 'model_not_found' },
      });

      expect((await caught(() => adapter.responses.create({ model: 'gpt-7', input: 'x' }, ctx))).code).toBe('AI_MODEL_NOT_REACHABLE');
    });

    it('honours an already-aborted signal', async () => {
      const { adapter, ctx } = setup();
      const controller = new AbortController();

      controller.abort();

      const err = await caught(() => adapter.responses.create({ model: 'gpt-4o', input: 'x' }, { ...ctx, signal: controller.signal }));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ aborted: true });
    });
  });

  describe('responses.stream', () => {
    it('sends stream: true and yields deltas that equal the final text', async () => {
      const { adapter, ctx, server } = setup();
      const events = await collect(adapter.responses.stream({ model: 'gpt-4o', input: 'x' }, ctx));
      const completed = events[events.length - 1] as Extract<AiStreamEvent, { type: 'response.completed' }>;
      const deltas = events
        .filter((e): e is Extract<AiStreamEvent, { type: 'output_text.delta' }> => e.type === 'output_text.delta')
        .map((e) => e.delta)
        .join('');

      expect(server.requestsTo('/v1/responses')[0].body?.stream).toBe(true);
      expect(completed.type).toBe('response.completed');
      expect(deltas).toBe(completed.response.outputText);
      expect(completed.response.providerRequestId).toMatch(/^req_mock_/);
    });

    it('throws AI_KEY_INVALID before the stream starts', async () => {
      const { adapter, ctx } = setup();

      expect((await caught(() => collect(adapter.responses.stream({ model: 'gpt-4o', input: 'x' }, { ...ctx, apiKey: INVALID_KEY })))).code).toBe(
        'AI_KEY_INVALID',
      );
    });

    it('ends with one error event when the provider fails mid-stream', async () => {
      const { adapter, ctx, server } = setup();

      server.enqueue({
        kind: 'sse',
        frames: [
          { event: 'response.created', data: { type: 'response.created', response: responseFixture({ id: 'resp_mid' }), sequence_number: 0 } },
          { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Hel', item_id: 'm', output_index: 0, content_index: 0, sequence_number: 1 } },
          { event: 'error', data: { type: 'error', code: 'server_error', message: `upstream died ${VALID_KEY}`, param: null, sequence_number: 2 } },
        ],
      });

      const events = await collect(adapter.responses.stream({ model: 'gpt-4o', input: 'x' }, ctx));

      expect(events.map((e) => e.type)).toEqual(['response.created', 'output_text.delta', 'error']);
      expect(events[2]).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
      expect(JSON.stringify(events)).not.toContain(VALID_KEY);
    });

    it('ends with an error event when the stream closes without a terminal event', async () => {
      const { adapter, ctx, server } = setup();

      server.enqueue({
        kind: 'sse',
        frames: [{ event: 'response.created', data: { type: 'response.created', response: responseFixture({ id: 'resp_cut' }), sequence_number: 0 } }],
      });

      const events = await collect(adapter.responses.stream({ model: 'gpt-4o', input: 'x' }, ctx));

      expect(events.map((e) => e.type)).toEqual(['response.created', 'error']);
    });

    it('aborts the SDK stream when ctx.signal fires', async () => {
      const { adapter, ctx, server } = setup();
      const controller = new AbortController();

      server.enqueue({
        kind: 'sse',
        hang: true,
        frames: [{ event: 'response.created', data: { type: 'response.created', response: responseFixture({ id: 'resp_hang' }), sequence_number: 0 } }],
      });

      const seen: AiStreamEvent[] = [];
      const err = await caught(async () => {
        for await (const event of adapter.responses.stream({ model: 'gpt-4o', input: 'x' }, { ...ctx, signal: controller.signal })) {
          seen.push(event);
          controller.abort();
        }
      });

      expect(seen.map((e) => e.type)).toEqual(['response.created']);
      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ aborted: true });
      expect(server.requestsTo('/v1/responses')[0].signal?.aborted).toBe(true);
    });

    it('closes the HTTP stream when the consumer stops early', async () => {
      const { adapter, ctx, server } = setup();

      server.enqueue({
        kind: 'sse',
        hang: true,
        frames: [{ event: 'response.created', data: { type: 'response.created', response: responseFixture({ id: 'resp_brk' }), sequence_number: 0 } }],
      });

      for await (const event of adapter.responses.stream({ model: 'gpt-4o', input: 'x' }, ctx)) {
        expect(event.type).toBe('response.created');
        break;
      }

      expect(server.requestsTo('/v1/responses')[0].signal?.aborted).toBe(true);
    });
  });

  describe('observability', () => {
    it('wraps each call in an ai.provider.call span with safe attributes only', async () => {
      const { adapter, ctx } = setup();

      await adapter.responses.create({ model: 'gpt-4o', input: PROMPT }, ctx);
      await collect(adapter.responses.stream({ model: 'gpt-4o', input: PROMPT }, ctx));
      await adapter.verifyKey({ ...ctx, apiKey: INVALID_KEY });

      expect(spans.map((s) => [s.name, s.attributes['ai.operation'], s.attributes['ai.status']])).toEqual([
        [AI_PROVIDER_CALL_SPAN, 'responses.create', 'ok'],
        [AI_PROVIDER_CALL_SPAN, 'responses.stream', 'ok'],
        [AI_PROVIDER_CALL_SPAN, 'verify_key', 'AI_KEY_INVALID'],
      ]);
      expect(spans.every((s) => s.ended)).toBe(true);
      expect(spans[0].attributes).toEqual({
        'ai.provider': 'openai',
        'ai.model': 'gpt-4o',
        'ai.operation': 'responses.create',
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
        jest.spyOn(Logger.prototype, 'verbose').mockImplementation(capture),
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
        await adapter.responses.create({ model: 'gpt-4o', input: PROMPT }, ctx);
        await caught(() => adapter.responses.create({ model: 'gpt-4o', input: PROMPT }, bad));
        await collect(adapter.responses.stream({ model: 'gpt-4o', input: PROMPT }, ctx));
        await caught(() => collect(adapter.responses.stream({ model: 'gpt-4o', input: PROMPT }, bad)));

        server.enqueue({ kind: 'error', status: 500, error: { message: `oops ${VALID_KEY}`, type: 'server_error', code: null } });
        await caught(() => adapter.responses.create({ model: 'gpt-4o', input: PROMPT }, ctx));

        // The debug line was actually emitted — the test is not vacuous.
        expect(logged.length).toBeGreaterThanOrEqual(8);
        expect(JSON.stringify(logged)).toContain('responses.create');

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
      const err = await caught(() => adapter.responses.create({ model: 'gpt-4o', input: 'x' }, { ...ctx, apiKey: INVALID_KEY }));

      expect(err.code).toBe('AI_KEY_INVALID');
      expect(JSON.stringify(err)).not.toContain(INVALID_KEY);
      expect(err.message).not.toContain(INVALID_KEY);
    });
  });
});
