import { ArgumentsHost, HttpException } from '@nestjs/common';

import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { CLASSIFY_RATE_LIMIT, classifyRateLimit, RateLimitError } from '../../jobs/rate-limit.error';
import { AI_ERROR_CODES, AI_ERROR_STATUS, AiError, aiErrorLogDetails, isAiErrorCode } from './ai-error';

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

describe('aiErrorLogDetails (#301)', () => {
  it('renders only the whitelisted provider fields, in a fixed order', () => {
    const err = new AiError('AI_INVALID_REQUEST', 'rejected', {
      cause: new Error(`bad key ${SECRET}`),
      details: {
        providerRequestId: 'req_1',
        param: 'input[0].content[1]',
        provider: 'openai',
        url: 'https://example.test/x?sig=1',
        status: 400,
        providerType: 'invalid_request_error',
        providerCode: 'invalid_value',
        key: SECRET,
      },
    });

    expect(aiErrorLogDetails(err)).toBe(
      'status=400 providerCode="invalid_value" providerType="invalid_request_error" ' +
        'param="input[0].content[1]" providerRequestId="req_1" providerMessage="bad key [redacted]"',
    );
  });

  it('is empty for an error without provider details', () => {
    expect(aiErrorLogDetails(new AiError('AI_DISABLED', 'off'))).toBe('');
  });

  it('quotes and caps string values so a provider string cannot forge a log line', () => {
    const line = aiErrorLogDetails(
      new AiError('AI_INVALID_REQUEST', 'x', { details: { providerCode: `a\nFAKE ${'z'.repeat(500)}` } }),
    );

    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(160);
  });

  describe('providerMessage', () => {
    const invalid = (cause?: unknown) =>
      new AiError('AI_INVALID_REQUEST', 'rejected', { cause, details: { status: 400 } });

    it('appends the cause message for AI_INVALID_REQUEST', () => {
      const message = "400 Invalid file data: 'file_id'. Expected a file with an application/pdf MIME type.";

      expect(aiErrorLogDetails(invalid(new Error(message)))).toBe(
        `status=400 providerMessage=${JSON.stringify(message)}`,
      );
    });

    it('never puts the message into the public body', () => {
      const err = invalid(new Error('400 some provider text'));
      aiErrorLogDetails(err);

      expect(JSON.stringify(err.toJSON())).not.toContain('some provider text');
    });

    it('redacts key-like tokens, Bearer credentials and URLs', () => {
      const line = aiErrorLogDetails(
        invalid(
          new Error(
            `400 bad ${SECRET} rk-abcdef123 pk-live_ABCDEF sess-xyz*abc12 ` +
              'Authorization: Bearer abc.def.ghi see https://bucket.example.test/o?X-Amz-Signature=deadbeef and http://x.test/y',
          ),
        ),
      );

      expect(line).not.toContain(SECRET);
      expect(line).not.toMatch(/\b(sk|rk|pk|sess)-/);
      expect(line).not.toContain('abc.def.ghi');
      expect(line).not.toContain('X-Amz-Signature');
      expect(line).not.toContain('http');
      expect(line).toContain('[redacted]');
    });

    it('collapses newlines and runs of whitespace to single spaces', () => {
      expect(aiErrorLogDetails(invalid(new Error('400 first\n\n  second\tthird')))).toBe(
        'status=400 providerMessage="400 first second third"',
      );
    });

    it('caps the message at 300 characters', () => {
      expect(aiErrorLogDetails(invalid(new Error('x'.repeat(1000))))).toBe(
        `status=400 providerMessage="${'x'.repeat(300)}"`,
      );
    });

    it('is not included for AI_KEY_INVALID', () => {
      const err = new AiError('AI_KEY_INVALID', 'bad key', {
        cause: new Error('401 Incorrect API key provided: sk-pr****abcd'),
        details: { status: 401 },
      });

      expect(aiErrorLogDetails(err)).toBe('status=401');
    });

    it('adds nothing without a cause, or with a non-Error or empty-message cause', () => {
      expect(aiErrorLogDetails(invalid())).toBe('status=400');
      expect(aiErrorLogDetails(invalid('400 a string cause'))).toBe('status=400');
      expect(aiErrorLogDetails(invalid(new Error('')))).toBe('status=400');
    });
  });
});
