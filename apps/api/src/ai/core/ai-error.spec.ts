import { ArgumentsHost, HttpException } from '@nestjs/common';

import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { CLASSIFY_RATE_LIMIT, classifyRateLimit, RateLimitError } from '../../jobs/rate-limit.error';
import { AI_ERROR_CODES, AI_ERROR_STATUS, AiError, isAiErrorCode } from './ai-error';

const SECRET = 'sk-test-SENTINEL-DO-NOT-LEAK-1234567890';

function runThroughFilter(exception: unknown) {
  const response = {
    code: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url: '/api/ai/test', method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;

  new HttpExceptionFilter().catch(exception, host);

  return {
    status: response.code.mock.calls[0][0],
    body: response.send.mock.calls[0][0],
    headers: Object.fromEntries(response.header.mock.calls as Array<[string, string]>),
  };
}

describe('AiError', () => {
  it.each(AI_ERROR_CODES)('%s carries the status declared in AI_ERROR_STATUS', (code) => {
    const err = new AiError(code, 'boom');

    expect(err).toBeInstanceOf(HttpException);
    expect(err).toBeInstanceOf(AiError);
    expect(err.getStatus()).toBe(AI_ERROR_STATUS[code]);
    expect(err.code).toBe(code);
    expect(err.message).toBe('boom');
  });

  it('builds the { code, message, details.reason } body', () => {
    const err = new AiError('AI_KEY_REQUIRED', 'Add a key', { details: { provider: 'openai' } });

    expect(err.getResponse()).toEqual({
      code: 'AI_KEY_REQUIRED',
      message: 'Add a key',
      details: { provider: 'openai', reason: 'AI_KEY_REQUIRED' },
    });
  });

  it('never lets caller details override reason', () => {
    const err = new AiError('AI_DISABLED', 'off', { details: { reason: 'SOMETHING_ELSE' } });

    expect((err.getResponse() as { details: { reason: string } }).details.reason).toBe('AI_DISABLED');
  });

  it('puts retryAfterMs on the error and in details', () => {
    const err = new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1500 });

    expect(err.retryAfterMs).toBe(1500);
    expect(err.toJSON().details).toEqual({ reason: 'AI_RATE_LIMITED', retryAfterMs: 1500 });
  });

  describe('through the global HttpExceptionFilter', () => {
    it('serialises as { statusCode, code, message, details.reason }', () => {
      const { status, body } = runThroughFilter(
        new AiError('AI_MODEL_NOT_ENABLED', 'Model gpt-x is not enabled', {
          details: { model: 'gpt-x' },
        }),
      );

      expect(status).toBe(403);
      expect(body).toMatchObject({
        statusCode: 403,
        // The envelope's `code` is the published, status-derived enum; the AI
        // code travels in details.reason (see ai-error.ts header).
        code: 'FORBIDDEN',
        message: 'Model gpt-x is not enabled',
        details: { reason: 'AI_MODEL_NOT_ENABLED', model: 'gpt-x' },
      });
    });

    it('keeps retryAfterMs for a 429', () => {
      const { status, body, headers } = runThroughFilter(
        new AiError('AI_RATE_LIMITED', 'Rate limited', { retryAfterMs: 2000 }),
      );

      expect(status).toBe(429);
      expect(body.code).toBe('TOO_MANY_REQUESTS');
      expect(body.details).toEqual({ reason: 'AI_RATE_LIMITED', retryAfterMs: 2000 });      // #450: and says so in the standard header, in whole seconds.
      expect(headers).toEqual({ 'Retry-After': '2' });
    });

    it('rounds Retry-After UP to whole seconds, never below one', () => {
      expect(
        runThroughFilter(new AiError('AI_RATE_LIMITED', 'Rate limited', { retryAfterMs: 1_001 })).headers,
      ).toEqual({ 'Retry-After': '2' });
      expect(
        runThroughFilter(new AiError('AI_RATE_LIMITED', 'Rate limited', { retryAfterMs: 10 })).headers,
      ).toEqual({ 'Retry-After': '1' });
    });

    it('sends no Retry-After when the 429 does not know when to retry', () => {
      expect(runThroughFilter(new AiError('AI_RATE_LIMITED', 'Rate limited')).headers).toEqual({});
    });

    it('does not leak a key held by the cause', () => {
      const cause = Object.assign(new Error(`Incorrect API key provided: ${SECRET}`), {
        headers: { authorization: `Bearer ${SECRET}` },
      });
      const { body } = runThroughFilter(
        new AiError('AI_KEY_INVALID', 'The API key was rejected.', { cause }),
      );

      expect(JSON.stringify(body)).not.toContain(SECRET);
    });
  });

  describe('secret hygiene', () => {
    it('JSON.stringify never includes a key passed via cause', () => {
      const cause = Object.assign(new Error(`401 Incorrect API key provided: ${SECRET}`), {
        request: { headers: { Authorization: `Bearer ${SECRET}` } },
        apiKey: SECRET,
      });
      const err = new AiError('AI_KEY_INVALID', 'The API key was rejected.', { cause });

      expect(JSON.stringify(err)).not.toContain(SECRET);
      expect(JSON.stringify({ err })).not.toContain(SECRET);
      expect(JSON.stringify(err.getResponse())).not.toContain(SECRET);
    });

    it('keeps the cause reachable for debugging, but non-enumerable', () => {
      const cause = new Error('underlying');
      const err = new AiError('AI_PROVIDER_UNAVAILABLE', 'down', { cause });

      expect(err.cause).toBe(cause);
      expect(Object.keys(err)).not.toContain('cause');
      // HttpException's own `options` (where it would copy the cause) stays empty.
      expect((err as unknown as { options?: unknown }).options).toBeUndefined();
    });

    it('wrap() uses a generic message, not the SDK message', () => {
      const err = AiError.wrap(new Error(`bad key ${SECRET}`));

      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(err.message).not.toContain(SECRET);
      expect(JSON.stringify(err)).not.toContain(SECRET);
    });
  });

  describe('wrap / isAiError', () => {
    it('returns an existing AiError unchanged', () => {
      const original = new AiError('AI_CONTENT_FILTERED', 'filtered');

      expect(AiError.wrap(original)).toBe(original);
    });

    it('wraps anything else with the given code', () => {
      const err = AiError.wrap('nope', 'AI_INVALID_REQUEST', 'Bad request');

      expect(AiError.isAiError(err)).toBe(true);
      expect(err.code).toBe('AI_INVALID_REQUEST');
      expect(err.message).toBe('Bad request');
      expect(AiError.isAiError(new Error('x'))).toBe(false);
    });
  });

  describe('toRateLimitError', () => {
    it('converts AI_RATE_LIMITED into the queue RateLimitError, keeping retryAfterMs', () => {
      const rl = new AiError('AI_RATE_LIMITED', 'slow', { retryAfterMs: 30_000 }).toRateLimitError();

      expect(rl).toBeInstanceOf(RateLimitError);
      expect(rl?.retryAfterMs).toBe(30_000);
      expect(classifyRateLimit(rl)).toEqual({ rateLimited: true, retryAfterMs: 30_000 });
    });

    it('returns null for every other code', () => {
      for (const code of AI_ERROR_CODES.filter((c) => c !== 'AI_RATE_LIMITED')) {
        expect(new AiError(code, 'x').toRateLimitError()).toBeNull();
      }
    });
  });

  // Issue #509: the queue reads an AiError by its CODE, never by the HTTP
  // response status the code maps to — or every 503 AiError (storage not
  // configured, provider unavailable) is deferred as a provider throttle.
  describe('classifyRateLimit (CLASSIFY_RATE_LIMIT)', () => {
    it.each(AI_ERROR_CODES)('%s is a rate limit only when it is AI_RATE_LIMITED', (code) => {
      expect(classifyRateLimit(new AiError(code, 'x'))).toEqual({
        rateLimited: code === 'AI_RATE_LIMITED',
        retryAfterMs: null,
      });
    });

    it('carries AI_RATE_LIMITED retryAfterMs', () => {
      expect(classifyRateLimit(new AiError('AI_RATE_LIMITED', 'slow', { retryAfterMs: 12_000 }))).toEqual({
        rateLimited: true,
        retryAfterMs: 12_000,
      });
    });

    it.each(['AI_STORAGE_UNAVAILABLE', 'AI_PROVIDER_UNAVAILABLE'] as const)(
      '%s (a 503) is NOT a rate limit, even carrying a retryAfterMs',
      (code) => {
        const err = new AiError(code, 'unavailable', { retryAfterMs: 5_000 });

        expect(err.getStatus()).toBe(503);
        expect(classifyRateLimit(err)).toEqual({ rateLimited: false, retryAfterMs: null });
      },
    );

    it('agrees with toRateLimitError() for every code', () => {
      for (const code of AI_ERROR_CODES) {
        const err = new AiError(code, 'x', { retryAfterMs: 1_000 });

        expect(classifyRateLimit(err).rateLimited).toBe(err.toRateLimitError() !== null);
      }
    });

    it('is a non-enumerable prototype method that never reaches a serialised body', () => {
      const err = new AiError('AI_STORAGE_UNAVAILABLE', 'no storage', { retryAfterMs: 1_000 });

      expect(Object.getOwnPropertySymbols(err)).not.toContain(CLASSIFY_RATE_LIMIT);
      expect(Object.getOwnPropertyDescriptor(AiError.prototype, CLASSIFY_RATE_LIMIT)?.enumerable).toBe(false);
      expect(err.toJSON()).toEqual({
        code: 'AI_STORAGE_UNAVAILABLE',
        message: 'no storage',
        details: { reason: 'AI_STORAGE_UNAVAILABLE', retryAfterMs: 1_000 },
      });
      expect(Object.getOwnPropertySymbols(err.toJSON())).toEqual([]);
      expect(JSON.stringify(err)).not.toContain('classifyRateLimit');

      const { status, body } = runThroughFilter(err);

      expect(status).toBe(503);
      expect(Object.getOwnPropertySymbols(body)).toEqual([]);
      expect(body.details).toEqual({ reason: 'AI_STORAGE_UNAVAILABLE', retryAfterMs: 1_000 });
    });
  });

  it('isAiErrorCode recognises only declared codes', () => {
    expect(isAiErrorCode('AI_DISABLED')).toBe(true);
    expect(isAiErrorCode('toString')).toBe(false);
    expect(isAiErrorCode(42)).toBe(false);
  });
});
