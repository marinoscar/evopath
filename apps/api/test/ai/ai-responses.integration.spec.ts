// =============================================================================
// AI responses over HTTP + SSE Integration (issue #433, epic #419)
// =============================================================================
//
//   POST /api/ai/responses          one response (JSON)
//   POST /api/ai/responses/stream   one response (text/event-stream)
//
//   * `ai:use` on both, `AiEnabledGuard` on the class: 403 AI_DISABLED
//     while AI is off, before any provider call.
//   * The same fake script yields the same final text either way.
//   * SSE frames are `event: <type>\ndata: <json>\n\n`, ordered, starting
//     with `response.created` and ending with `response.completed`.
//   * A refusal BEFORE the first frame is a normal JSON error (status +
//     details.reason); a failure AFTER streaming began is an `error` frame.
//   * Closing the connection aborts the provider call.
//   * ⚠ NO KEY in any response body or SSE frame (serialise-and-search).
//
// The runtime is the #432 harness (real AiService over FakeAiProvider), see
// `ai-http.helper.ts`.
// =============================================================================

import http from 'node:http';

import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { AiEnabledGuard } from '../../src/ai/config/ai-enabled.guard';
import { AiError } from '../../src/ai/core/ai-error';
import type { AiStreamEvent } from '../../src/ai/core/types/responses.types';
import { AiResponsesController } from '../../src/ai/http/ai-responses.controller';
import {
  HARNESS_MODEL,
  HARNESS_ORG_KEY,
  HARNESS_OTHER_USER,
  HARNESS_USER,
  HARNESS_USER_KEY,
} from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser, TestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, AiHttpTestApp, createAiHttpTestApp, parseSse } from './ai-http.helper';

const RESPONSES = '/api/ai/responses';
const STREAM = '/api/ai/responses/stream';

describe('AI responses HTTP API Integration', () => {
  let t: AiHttpTestApp;
  let alice: TestUser; // HARNESS_USER — holds a key
  let bob: TestUser; // HARNESS_OTHER_USER — no key unless a test adds one
  let bodies: string[];

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    bodies = [];
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    bob = await createMockTestUser(t.context, { id: HARNESS_OTHER_USER, roleName: 'contributor' });
  });

  afterEach(() => {
    // ⚠ Acceptance criterion: no response or frame contains any key.
    for (const body of bodies) {
      for (const key of ALL_KEYS) {
        expect(body).not.toContain(key);
      }
    }
  });

  function server() {
    return t.context.app.getHttpServer();
  }

  function record(res: request.Response): request.Response {
    bodies.push(res.text ?? JSON.stringify(res.body));
    return res;
  }

  function post(path: string, user: TestUser | null, body: Record<string, unknown>) {
    const req = request(server()).post(path);
    if (user) req.set(authHeader(user.accessToken));
    if (path === STREAM) req.set('Accept', 'text/event-stream');
    return req.send(body);
  }

  const prompt = { model: HARNESS_MODEL, input: 'Say hello to the world' };

  /** Replaces the fake's stream with a hand-written one (mid-stream failures). */
  function scriptStream(events: () => AsyncGenerator<AiStreamEvent>) {
    const port = t.harness.fake.responses!;
    const original = port.stream;
    (port as { stream: typeof port.stream }).stream = (req, ctx) => {
      t.harness.fake.calls.push({ method: 'responses.stream', apiKey: ctx.apiKey, requestId: ctx.requestId, request: req });
      return events();
    };
    return () => {
      (port as { stream: typeof port.stream }).stream = original;
    };
  }

  // ==========================================================================
  // Guards
  // ==========================================================================

  describe('guards', () => {
    it.each([['respond'], ['stream']] as Array<[keyof AiResponsesController]>)(
      '%s requires exactly ai:use',
      (handler) => {
        expect(Reflect.getMetadata(PERMISSIONS_KEY, AiResponsesController.prototype[handler])).toEqual(['ai:use']);
      },
    );

    it('carries AiEnabledGuard on the controller', () => {
      expect(Reflect.getMetadata('__guards__', AiResponsesController)).toContain(AiEnabledGuard);
    });

    it.each([RESPONSES, STREAM])('POST %s: 401 without a token', async (path) => {
      await post(path, null, prompt).expect(401);
      expect(t.harness.fake.calls).toHaveLength(0);
    });

    it.each([RESPONSES, STREAM])('POST %s: 403 AI_DISABLED while AI is off (JSON)', async (path) => {
      t.harness.setPolicy({ enabled: false });

      const res = record(await post(path, alice, prompt).expect(403));

      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'AI_DISABLED' } });
      expect(t.harness.fake.calls).toHaveLength(0);
    });

    it.each([RESPONSES, STREAM])('POST %s: an inactive user is refused', async (path) => {
      const inactive = await createMockTestUser(t.context, { isActive: false });

      const res = await post(path, inactive, prompt);
      expect([401, 403]).toContain(res.status);
      expect(t.harness.fake.calls).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Validation
  // ==========================================================================

  describe('validation', () => {
    it.each([RESPONSES, STREAM])('POST %s: function tools are refused with 400', async (path) => {
      const res = record(
        await post(path, alice, { ...prompt, tools: [{ type: 'function', name: 'rm', parameters: {} }] }).expect(400),
      );
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(t.harness.fake.calls).toHaveLength(0);
    });

    it.each([RESPONSES, STREAM])('POST %s: an unreadable JSON Schema is 400 AI_INVALID_REQUEST', async (path) => {
      const res = record(
        await post(path, alice, {
          ...prompt,
          structuredOutput: { name: 'bad', jsonSchema: { $ref: 'https://evil.example/schema.json' } },
        }).expect(400),
      );
      expect(res.body.details.reason).toBe('AI_INVALID_REQUEST');
      expect(t.harness.fake.calls).toHaveLength(0);
    });

    it('rejects a body with no input', async () => {
      record(await post(RESPONSES, alice, { model: HARNESS_MODEL }).expect(400));
    });
  });

  // ==========================================================================
  // POST /api/ai/responses
  // ==========================================================================

  describe('POST /api/ai/responses', () => {
    it('returns the AiResponse in the data envelope, generated with the caller’s key', async () => {
      t.script([{ outputText: 'Hello, world!' }]);

      const res = record(await post(RESPONSES, alice, prompt).expect(200));

      expect(res.body.data).toMatchObject({
        provider: 'openai',
        model: HARNESS_MODEL,
        outputText: 'Hello, world!',
        output: [{ type: 'message', text: 'Hello, world!' }],
        finishReason: 'stop',
      });
      expect(t.harness.fake.apiKeys).toEqual([HARNESS_USER_KEY]);
      expect(t.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, status: 'succeeded', keySource: 'user' }),
      ]);
    });

    it('passes the request fields through to the provider', async () => {
      record(
        await post(RESPONSES, alice, {
          ...prompt,
          instructions: 'Be brief',
          temperature: 0.3,
          maxOutputTokens: 100,
          previousResponseId: 'resp_prev',
          metadata: { source: 'cli' },
        }).expect(200),
      );

      expect(t.harness.fake.calls[0].request).toMatchObject({
        model: HARNESS_MODEL,
        input: prompt.input,
        instructions: 'Be brief',
        temperature: 0.3,
        maxOutputTokens: 100,
        previousResponseId: 'resp_prev',
        metadata: { source: 'cli' },
      });
    });

    it('returns a validated `parsed` for structured output', async () => {
      t.script([{ outputText: '{"answer":"42"}' }]);

      const res = record(
        await post(RESPONSES, alice, {
          ...prompt,
          structuredOutput: {
            name: 'answer',
            strict: true,
            jsonSchema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        }).expect(200),
      );

      expect(res.body.data.parsed).toEqual({ answer: '42' });
    });

    it('answers structured output that does not match with 502 AI_STRUCTURED_OUTPUT_INVALID', async () => {
      t.script([{ outputText: '{"answer":42}' }]);

      const res = record(
        await post(RESPONSES, alice, {
          ...prompt,
          structuredOutput: {
            name: 'answer',
            jsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
          },
        }).expect(502),
      );

      expect(res.body.details.reason).toBe('AI_STRUCTURED_OUTPUT_INVALID');
    });

    it('403 AI_KEY_REQUIRED for a caller with no key under byok', async () => {
      const res = record(await post(RESPONSES, bob, prompt).expect(403));

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(t.harness.fake.calls).toHaveLength(0);
    });

    it('serves a keyless caller with the org key under fallback — without echoing it', async () => {
      t.harness.setPolicy({ keyPolicy: 'byok_with_org_fallback' });
      t.harness.setOrgKey(HARNESS_ORG_KEY);

      const res = record(await post(RESPONSES, bob, prompt).expect(200));

      expect(res.body.data.outputText).toContain('fake:');
      expect(t.harness.fake.apiKeys).toEqual([HARNESS_ORG_KEY]);
    });

    it('never spends another user’s key', async () => {
      t.harness.addUserKey(HARNESS_OTHER_USER, 'sk-other-user-key-never-leak-4242', [HARNESS_MODEL]);

      record(await post(RESPONSES, bob, prompt).expect(200));
      record(await post(RESPONSES, alice, prompt).expect(200));

      expect(t.harness.fake.calls.map((c) => c.apiKey)).toEqual([
        'sk-other-user-key-never-leak-4242',
        HARNESS_USER_KEY,
      ]);
    });

    it('maps a provider throttle to 429 with details.retryAfterMs', async () => {
      t.script(() => {
        throw new AiError('AI_RATE_LIMITED', 'Slow down.', { retryAfterMs: 1500 });
      });

      const res = record(await post(RESPONSES, alice, prompt).expect(429));

      expect(res.body.details).toMatchObject({ reason: 'AI_RATE_LIMITED', retryAfterMs: 1500 });
    });
  });

  // ==========================================================================
  // POST /api/ai/responses/stream
  // ==========================================================================

  describe('POST /api/ai/responses/stream', () => {
    it('streams ordered SSE frames ending with response.completed', async () => {
      t.script([{ outputText: 'Hello, streaming world!' }]);

      const res = record(await post(STREAM, alice, prompt).expect(200));

      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      expect(res.headers['cache-control']).toMatch(/no-cache/);
      expect(res.headers['x-accel-buffering']).toBe('no');

      const frames = parseSse(res.text).filter((f) => f.event);
      const types = frames.map((f) => f.event);

      expect(types[0]).toBe('response.created');
      expect(types[types.length - 1]).toBe('response.completed');
      expect(types.filter((type) => type === 'response.completed')).toHaveLength(1);
      expect(types).toContain('output_text.delta');

      // Each frame's `data` is the event, `type` repeated.
      for (const frame of frames) {
        expect(frame.data.type).toBe(frame.event);
      }

      const text = frames
        .filter((f) => f.event === 'output_text.delta')
        .map((f) => f.data.delta)
        .join('');
      expect(text).toBe('Hello, streaming world!');
      expect(frames[frames.length - 1].data.response.outputText).toBe('Hello, streaming world!');

      expect(t.harness.usageEvents).toEqual([expect.objectContaining({ status: 'succeeded', userId: HARNESS_USER })]);
    });

    it('yields the same final text as the non-streaming route for the same script', async () => {
      const script = { outputText: 'Identical either way.', usage: { inputTokens: 3, outputTokens: 4 } };

      t.script([{ ...script }]);
      const plain = record(await post(RESPONSES, alice, prompt).expect(200));

      t.script([{ ...script }]);
      const streamed = record(await post(STREAM, alice, prompt).expect(200));

      const completed = parseSse(streamed.text).find((f) => f.event === 'response.completed');
      expect(completed?.data.response.outputText).toBe(plain.body.data.outputText);
      expect(completed?.data.response.output).toEqual(plain.body.data.output);
    });

    it('answers a gate refusal before the first byte as JSON: 403 AI_KEY_REQUIRED', async () => {
      const res = record(await post(STREAM, bob, prompt).expect(403));

      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'AI_KEY_REQUIRED' } });
    });

    it('answers a model that is not enabled as JSON 403 AI_MODEL_NOT_ENABLED', async () => {
      const res = record(await post(STREAM, alice, { ...prompt, model: 'no-such-model' }).expect(403));

      expect(res.body.details.reason).toBe('AI_MODEL_NOT_ENABLED');
    });

    it('answers a provider refusal before streaming began as JSON (not a frame)', async () => {
      t.script(() => {
        throw new AiError('AI_RATE_LIMITED', 'Slow down.', { retryAfterMs: 900 });
      });

      const res = record(await post(STREAM, alice, prompt).expect(429));

      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.details.reason).toBe('AI_RATE_LIMITED');
      expect(res.text).not.toContain('event:');
    });

    it('sends a mid-stream provider failure as an `error` frame, then closes', async () => {
      const restore = scriptStream(async function* () {
        yield { type: 'response.created', id: 'resp_mid' };
        yield { type: 'output_text.delta', delta: 'Half an ans' };
        throw new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI provider request failed.');
      });

      try {
        const res = record(await post(STREAM, alice, prompt).expect(200));
        const frames = parseSse(res.text).filter((f) => f.event);

        expect(frames.map((f) => f.event)).toEqual(['response.created', 'output_text.delta', 'error']);
        expect(frames[2].data).toEqual({
          type: 'error',
          code: 'AI_PROVIDER_UNAVAILABLE',
          message: 'The AI provider request failed.',
        });
        expect(t.harness.usageEvents).toEqual([expect.objectContaining({ status: 'failed' })]);
      } finally {
        restore();
      }
    });

    it('relays an in-band `error` event the adapter emits after streaming began', async () => {
      const restore = scriptStream(async function* () {
        yield { type: 'response.created', id: 'resp_filtered' };
        yield { type: 'output_text.delta', delta: 'Some' };
        yield { type: 'error', code: 'AI_CONTENT_FILTERED', message: 'The response was filtered.' };
      });

      try {
        const res = record(await post(STREAM, alice, prompt).expect(200));
        const last = parseSse(res.text).filter((f) => f.event).pop();

        expect(last).toEqual({
          event: 'error',
          data: { type: 'error', code: 'AI_CONTENT_FILTERED', message: 'The response was filtered.' },
        });
      } finally {
        restore();
      }
    });

    it('aborts the provider call when the client disconnects mid-stream', async () => {
      t.setDelay(40);
      t.script([{ outputText: 'x'.repeat(400) }]); // 100 deltas × 40 ms: seconds of stream

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          `${t.baseUrl}${STREAM}`,
          {
            method: 'POST',
            headers: {
              ...authHeader(alice.accessToken),
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            res.once('data', (chunk: Buffer) => {
              bodies.push(chunk.toString('utf8'));
              // The first frame arrived: walk away.
              req.destroy();
              resolve();
            });
          },
        );
        req.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
        });
        req.end(JSON.stringify(prompt));
      });

      await waitFor(() => t.harness.usageEvents.length === 1);

      const [call] = t.harness.fake.callsTo('responses.stream');
      expect(call.aborted).toBe(true);
      expect(t.harness.usageEvents).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();

  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
