import { Controller, Get, Module, Param } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { context, SpanKind, trace } from '@opentelemetry/api';
// Transitive (sdk-node depends on it), imported on purpose: the hook reads the
// ACTIVE span, which needs a real async context manager to propagate through
// Fastify's request pipeline the way it does in production.
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';

import {
  ATTR_APP_REQUEST_BEARER,
  ATTR_APP_ROUTE_MATCHED,
  ATTR_HTTP_ROUTE,
  hasBearer,
  registerRequestSpanAttributes,
  requestSpanAttributesHook,
} from './request-span-attributes';

// =============================================================================
// Route and caller attributes on the server span (issue #258)
// =============================================================================
//
// Each request is injected INSIDE an active SERVER span, standing in for the
// one the http instrumentation opens around the server's `request` emit
// (inject bypasses the http module, so no instrumentation span exists here).
// What the hook must prove: Fastify has resolved the route by `onRequest`, the
// right attribute lands on the active span, and the bearer flag never carries
// token text.

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer('request-span-attributes.spec');
const contextManager = new AsyncLocalStorageContextManager();

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.secret-payload.signature';

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
});

afterAll(async () => {
  context.disable();
  await provider.shutdown();
});

beforeEach(() => exporter.reset());

/** Injects `opts` inside an active SERVER span and returns that span once ended. */
async function injectInServerSpan(
  inject: (opts: InjectOptions) => Promise<{ statusCode: number }>,
  opts: InjectOptions,
): Promise<{ span: ReadableSpan; statusCode: number }> {
  const statusCode = await tracer.startActiveSpan('GET', { kind: SpanKind.SERVER }, async (span) => {
    try {
      return (await inject(opts)).statusCode;
    } finally {
      span.end();
    }
  });
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  expect(spans[0].kind).toBe(SpanKind.SERVER);
  return { span: spans[0], statusCode };
}

describe('hasBearer', () => {
  it.each([
    [`Bearer ${TOKEN}`, true],
    [`bearer ${TOKEN}`, true],
    [`BEARER ${TOKEN}`, true],
    [[`Bearer ${TOKEN}`], true],
    ['Bearer ', false],
    ['Bearer', false],
    ['Basic dXNlcjpwYXNz', false],
    ['', false],
    [undefined, false],
  ])('%p → %p', (header, expected) => {
    expect(hasBearer(header as string | string[] | undefined)).toBe(expected);
  });
});

describe('requestSpanAttributesHook on a plain Fastify instance', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    expect(registerRequestSpanAttributes(app, true)).toBe(true);
    app.get('/api/gyms/:id', async () => ({ ok: true }));
    app.get('/api/health/info', async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(() => app.close());

  const inject = (opts: InjectOptions) => app.inject(opts);

  it('sets http.route to the matched pattern and no matched=false flag', async () => {
    const { span, statusCode } = await injectInServerSpan(inject, {
      method: 'GET',
      url: '/api/gyms/42',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(statusCode).toBe(200);
    expect(span.attributes[ATTR_HTTP_ROUTE]).toBe('/api/gyms/:id');
    expect(span.attributes).not.toHaveProperty(ATTR_APP_ROUTE_MATCHED);
    expect(span.attributes[ATTR_APP_REQUEST_BEARER]).toBe(true);
  });

  it('marks an unknown route app.route.matched=false and sets no http.route', async () => {
    const { span, statusCode } = await injectInServerSpan(inject, {
      method: 'GET',
      url: '/api/coach/messages',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(statusCode).toBe(404);
    expect(span.attributes[ATTR_APP_ROUTE_MATCHED]).toBe(false);
    expect(span.attributes).not.toHaveProperty(ATTR_HTTP_ROUTE);
    expect(span.attributes[ATTR_APP_REQUEST_BEARER]).toBe(true);
  });

  it('treats a known path with an unregistered method as unknown', async () => {
    const { span } = await injectInServerSpan(inject, { method: 'DELETE', url: '/api/health/info' });
    expect(span.attributes[ATTR_APP_ROUTE_MATCHED]).toBe(false);
  });

  it('flags an anonymous request bearer=false', async () => {
    const { span } = await injectInServerSpan(inject, { method: 'GET', url: '/wp-login.php' });
    expect(span.attributes[ATTR_APP_REQUEST_BEARER]).toBe(false);
    expect(span.attributes[ATTR_APP_ROUTE_MATCHED]).toBe(false);
  });

  it('flags a non-bearer Authorization header bearer=false', async () => {
    const { span } = await injectInServerSpan(inject, {
      method: 'GET',
      url: '/api/gyms/1',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(span.attributes[ATTR_APP_REQUEST_BEARER]).toBe(false);
  });

  it('never writes any part of the token onto the span', async () => {
    const { span } = await injectInServerSpan(inject, {
      method: 'GET',
      url: '/api/nope',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const serialized = JSON.stringify(span.attributes);
    expect(serialized).not.toContain('secret-payload');
    expect(serialized).not.toContain('eyJ');
    for (const value of Object.values(span.attributes)) {
      expect(['string', 'boolean']).toContain(typeof value);
    }
  });

  it('does nothing without an active span (OTel API without an SDK)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe('registerRequestSpanAttributes', () => {
  it('registers nothing when OTel is disabled', () => {
    const addHook = jest.fn();
    expect(registerRequestSpanAttributes({ addHook } as never, false)).toBe(false);
    expect(addHook).not.toHaveBeenCalled();
  });

  it('registers one onRequest hook when OTel is enabled', () => {
    const addHook = jest.fn();
    expect(registerRequestSpanAttributes({ addHook } as never, true)).toBe(true);
    expect(addHook).toHaveBeenCalledWith('onRequest', requestSpanAttributesHook);
  });

  it('leaves the active span alone when the hook runs with none', () => {
    const done = jest.fn();
    const spy = jest.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
    requestSpanAttributesHook({ is404: true, headers: {} } as never, {} as never, done);
    expect(done).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// The production shape: a Nest application on the Fastify adapter, global
// prefix `api`, the hook registered on the root instance before `init()`
// (where Nest registers its routes and its own not-found handler, the one that
// answered "Cannot GET /api/coach/messages" in the incident).

@Controller('gyms')
class GymsProbeController {
  @Get(':id')
  get(@Param('id') id: string) {
    return { id };
  }
}

@Module({ controllers: [GymsProbeController] })
class GymsProbeModule {}

describe('requestSpanAttributesHook on a Nest Fastify application', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GymsProbeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerRequestSpanAttributes(app.getHttpAdapter().getInstance(), true);
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(() => app.close());

  const inject = (opts: InjectOptions) => app.getHttpAdapter().getInstance().inject(opts);

  it('sets http.route to the prefixed Nest route pattern', async () => {
    const { span, statusCode } = await injectInServerSpan(inject, {
      method: 'GET',
      url: '/api/gyms/abc',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(statusCode).toBe(200);
    expect(span.attributes[ATTR_HTTP_ROUTE]).toBe('/api/gyms/:id');
    expect(span.attributes[ATTR_APP_REQUEST_BEARER]).toBe(true);
  });

  it("marks Nest's default 404 as an unknown route", async () => {
    const { span, statusCode } = await injectInServerSpan(inject, {
      method: 'GET',
      url: '/api/coach/messages',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(statusCode).toBe(404);
    expect(span.attributes[ATTR_APP_ROUTE_MATCHED]).toBe(false);
    expect(span.attributes).not.toHaveProperty(ATTR_HTTP_ROUTE);
  });
});
