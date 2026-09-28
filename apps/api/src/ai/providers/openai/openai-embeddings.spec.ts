// The OpenAI embeddings port (issue #440): the adapter against the mocked
// transport (the real SDK builds the request and parses the reply), plus the
// mapper's pure edge cases.

import { Logger } from '@nestjs/common';
import { Span, SpanStatus, trace, Tracer } from '@opentelemetry/api';

import { AiError } from '../../core/ai-error';
import { AiProviderRegistry } from '../../core/provider-registry';
import type { AiCallContext } from '../../core/provider-adapter.interface';
import { OpenAiClientFactory } from './openai-client.factory';
import {
  fromOpenAiEmbeddingResponse,
  openAiEmbeddingSupportsDimensions,
  toOpenAiEmbeddingRequest,
} from './openai-embeddings.mapper';
import { AI_PROVIDER_CALL_SPAN, OpenAiProviderAdapter } from './openai.adapter';
import { mockEmbeddingsBody, OpenAiMockServer } from './testing/openai-mock-transport';

const VALID_KEY = 'sk-proj-EMBED-valid-abcdefghijkl';
const INVALID_KEY = 'sk-proj-EMBED-revoked-mnopqrstu';
const TEXT = 'Confidential: the merger closes on Friday.';

// ---- a minimal recording tracer --------------------------------------------------

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: SpanStatus;
  ended: boolean;
}

const spans: RecordedSpan[] = [];

const recordingTracer = {
  startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) => {
    const record: RecordedSpan = { name, attributes: { ...(options?.attributes ?? {}) }, ended: false };

    spans.push(record);

    const span = {
      setAttribute: (key: string, value: unknown) => {
        record.attributes[key] = value;
        return span;
      },
      setStatus: (status: SpanStatus) => {
        record.status = status;
        return span;
      },
      end: () => {
        record.ended = true;
      },
    };

    return span as unknown as Span;
  },
} as unknown as Tracer;

beforeAll(() => {
  trace.setGlobalTracerProvider({ getTracer: () => recordingTracer });
});

afterAll(() => {
  trace.disable();
});

beforeEach(() => {
  spans.length = 0;
});

function setup() {
  const server = new OpenAiMockServer({ validKeys: [VALID_KEY] });
  const adapter = new OpenAiProviderAdapter(new AiProviderRegistry(), new OpenAiClientFactory({ fetch: server.fetch }));
  const ctx: AiCallContext = { apiKey: VALID_KEY, requestId: 'req-embed-1' };

  return { server, adapter, ctx };
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

describe('OpenAI embeddings port', () => {
  describe('embed', () => {
    it('POSTs /v1/embeddings with the key, the model, the input and encoding_format float', async () => {
      const { adapter, ctx, server } = setup();

      await adapter.embeddings.embed({ model: 'text-embedding-3-small', input: ['a', 'b'] }, ctx);

      const [req] = server.requestsTo('/v1/embeddings');

      expect(req.method).toBe('POST');
      expect(req.apiKey).toBe(VALID_KEY);
      expect(req.body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'], encoding_format: 'float' });
    });

    it('returns one plain number[] per input, in input order, with dimensions and usage', async () => {
      const { adapter, ctx } = setup();

      const result = await adapter.embeddings.embed(
        { model: 'text-embedding-3-small', input: ['first text', 'second text', 'third'] },
        ctx,
      );

      expect(result.provider).toBe('openai');
      expect(result.model).toBe('text-embedding-3-small');
      expect(result.vectors).toHaveLength(3);
      expect(result.dimensions).toBe(1536);
      expect(result.vectors.every((v) => Array.isArray(v) && v.length === 1536)).toBe(true);
      // Not a Float32Array: a vector must survive JSON as an array.
      expect(JSON.parse(JSON.stringify(result.vectors[0]))).toEqual(result.vectors[0]);
      expect(result.usage).toEqual({ inputTokens: 3 + 3 + 2 });
      expect(result.providerRequestId).toMatch(/^req_mock_/);
    });

    it('a single string input yields exactly one vector', async () => {
      const { adapter, ctx } = setup();

      const result = await adapter.embeddings.embed({ model: 'text-embedding-3-large', input: 'hello' }, ctx);

      expect(result.vectors).toHaveLength(1);
      expect(result.dimensions).toBe(3072);
    });

    it('honours dimensions on a text-embedding-3 model', async () => {
      const { adapter, ctx, server } = setup();

      const result = await adapter.embeddings.embed(
        { model: 'text-embedding-3-large', input: ['x', 'y'], dimensions: 256 },
        ctx,
      );

      expect(server.requestsTo('/v1/embeddings')[0].body).toMatchObject({ dimensions: 256 });
      expect(result.dimensions).toBe(256);
      expect(result.vectors.every((v) => v.length === 256)).toBe(true);
    });

    it('refuses dimensions for ada-002 without calling OpenAI (AI_INVALID_REQUEST)', async () => {
      const { adapter, ctx, server } = setup();

      const err = await caught(() =>
        adapter.embeddings.embed({ model: 'text-embedding-ada-002', input: 'x', dimensions: 256 }, ctx),
      );

      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(server.requestsTo('/v1/embeddings')).toHaveLength(0);
    });

    it('orders vectors by OpenAI index, not by arrival order', async () => {
      const { adapter, ctx, server } = setup();

      server.embedWith((body) => {
        const answer = mockEmbeddingsBody(body) as { data: unknown[] };

        return { kind: 'embeddings', body: { ...answer, data: [...answer.data].reverse() } };
      });

      const inOrder = await adapter.embeddings.embed({ model: 'text-embedding-3-small', input: ['one', 'two'] }, ctx);
      const one = await adapter.embeddings.embed({ model: 'text-embedding-3-small', input: 'one' }, ctx);

      expect(inOrder.vectors[0]).toEqual(one.vectors[0]);
    });

    it('a reply with the wrong number of vectors is AI_PROVIDER_UNAVAILABLE, never a short answer', async () => {
      const { adapter, ctx, server } = setup();

      server.embedWith((body) => {
        const answer = mockEmbeddingsBody(body) as { data: unknown[] };

        return { kind: 'embeddings', body: { ...answer, data: answer.data.slice(1) } };
      });

      const err = await caught(() =>
        adapter.embeddings.embed({ model: 'text-embedding-3-small', input: ['a', 'b', 'c'] }, ctx),
      );

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.toJSON().details).toMatchObject({ expected: 3, received: 2 });
    });

    it.each([
      [429, { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' }, 'AI_RATE_LIMITED'],
      [400, { message: 'Bad input', type: 'invalid_request_error', param: 'input', code: null }, 'AI_INVALID_REQUEST'],
      [500, { message: 'boom', type: 'server_error', code: null }, 'AI_PROVIDER_UNAVAILABLE'],
    ])('maps an HTTP %s to %s', async (status, error, code) => {
      const { adapter, ctx, server } = setup();

      server.embedWith(() => ({ kind: 'error', status, error }));

      const err = await caught(() => adapter.embeddings.embed({ model: 'text-embedding-3-small', input: 'x' }, ctx));

      expect(err.code).toBe(code);
    });

    it('a rejected key is AI_KEY_INVALID and the key never reaches the error', async () => {
      const { adapter, ctx } = setup();

      const err = await caught(() =>
        adapter.embeddings.embed({ model: 'text-embedding-3-small', input: 'x' }, { ...ctx, apiKey: INVALID_KEY }),
      );

      expect(err.code).toBe('AI_KEY_INVALID');
      expect(JSON.stringify(err)).not.toContain(INVALID_KEY);
      expect(err.message).not.toContain(INVALID_KEY);
    });

    it('aborts the HTTP request with ctx.signal', async () => {
      const { adapter, ctx, server } = setup();
      const controller = new AbortController();

      controller.abort();

      await caught(() =>
        adapter.embeddings.embed({ model: 'text-embedding-3-small', input: 'x' }, { ...ctx, signal: controller.signal }),
      );

      expect(server.requestsTo('/v1/embeddings').every((r) => r.signal?.aborted)).toBe(true);
    });
  });

  describe('observability', () => {
    it('one ai.provider.call span, operation embeddings.create, safe attributes only', async () => {
      const { adapter, ctx } = setup();

      await adapter.embeddings.embed({ model: 'text-embedding-3-small', input: TEXT }, ctx);

      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        name: AI_PROVIDER_CALL_SPAN,
        ended: true,
        attributes: {
          'ai.provider': 'openai',
          'ai.model': 'text-embedding-3-small',
          'ai.operation': 'embeddings.create',
          'ai.status': 'ok',
        },
      });
      expect(JSON.stringify(spans)).not.toContain(TEXT);
      expect(JSON.stringify(spans)).not.toContain(VALID_KEY);
    });

    it('never logs the key or the input text', async () => {
      const logged: unknown[] = [];
      const capture = (...args: unknown[]) => {
        logged.push(args);
      };
      const spies = [
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(capture),
        jest.spyOn(Logger.prototype, 'log').mockImplementation(capture),
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
        jest.spyOn(Logger.prototype, 'error').mockImplementation(capture),
      ];

      try {
        const { adapter, ctx } = setup();

        await adapter.embeddings.embed({ model: 'text-embedding-3-small', input: TEXT }, ctx);
        await caught(() =>
          adapter.embeddings.embed({ model: 'text-embedding-3-small', input: TEXT }, { ...ctx, apiKey: INVALID_KEY }),
        );

        const serialised = JSON.stringify(logged);

        expect(serialised).toContain('embeddings.create');
        expect(serialised).not.toContain(VALID_KEY);
        expect(serialised).not.toContain(INVALID_KEY);
        expect(serialised).not.toContain(TEXT);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });
  });

  describe('mapper', () => {
    it('knows which families accept dimensions', () => {
      expect(openAiEmbeddingSupportsDimensions('text-embedding-3-small')).toBe(true);
      expect(openAiEmbeddingSupportsDimensions('text-embedding-3-large')).toBe(true);
      expect(openAiEmbeddingSupportsDimensions('text-embedding-ada-002')).toBe(false);
    });

    it('lets providerOptions.openai add fields but never override the port’s own', () => {
      const body = toOpenAiEmbeddingRequest({
        model: 'text-embedding-3-small',
        input: 'x',
        providerOptions: { openai: { user: 'u-1', encoding_format: 'base64', model: 'other' } },
      });

      expect(body).toEqual({ user: 'u-1', model: 'text-embedding-3-small', input: 'x', encoding_format: 'float' });
    });

    it('rejects vectors of unequal length', () => {
      expect(() =>
        fromOpenAiEmbeddingResponse(
          {
            object: 'list',
            model: 'm',
            data: [
              { object: 'embedding', index: 0, embedding: [1, 2] },
              { object: 'embedding', index: 1, embedding: [1] },
            ],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          },
          { request: { model: 'm', input: ['a', 'b'] } },
        ),
      ).toThrow(AiError);
    });
  });
});
