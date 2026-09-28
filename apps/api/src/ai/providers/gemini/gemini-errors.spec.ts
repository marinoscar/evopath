import { ApiError } from '@google/genai';

import { AiError } from '../../core/ai-error';
import {
  geminiErrorCode,
  mapGeminiError,
  parseGeminiErrorBody,
  parseGeminiRetryDelay,
} from './gemini-errors';

const SECRET = 'AIzaSy-SECRET-000000000000000000000';

function apiError(status: number, grpcStatus: string, details?: unknown[], message = `something about ${SECRET}`): ApiError {
  return new ApiError({
    status,
    message: JSON.stringify({ error: { code: status, status: grpcStatus, message, ...(details ? { details } : {}) } }),
  });
}

const KEY_INVALID_INFO = {
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason: 'API_KEY_INVALID',
  domain: 'googleapis.com',
};

const RETRY_37S = { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' };

describe('gemini errors', () => {
  describe('the table', () => {
    it.each([
      ['400 + API_KEY_INVALID', apiError(400, 'INVALID_ARGUMENT', [KEY_INVALID_INFO]), 'AI_KEY_INVALID'],
      ['401 UNAUTHENTICATED', apiError(401, 'UNAUTHENTICATED'), 'AI_KEY_INVALID'],
      ['403 PERMISSION_DENIED', apiError(403, 'PERMISSION_DENIED'), 'AI_KEY_INVALID'],
      ['404 NOT_FOUND', apiError(404, 'NOT_FOUND'), 'AI_MODEL_NOT_REACHABLE'],
      ['429 RESOURCE_EXHAUSTED', apiError(429, 'RESOURCE_EXHAUSTED', [RETRY_37S]), 'AI_RATE_LIMITED'],
      ['500 INTERNAL', apiError(500, 'INTERNAL'), 'AI_PROVIDER_UNAVAILABLE'],
      ['503 UNAVAILABLE', apiError(503, 'UNAVAILABLE'), 'AI_PROVIDER_UNAVAILABLE'],
      ['504 DEADLINE_EXCEEDED', apiError(504, 'DEADLINE_EXCEEDED'), 'AI_PROVIDER_UNAVAILABLE'],
      ['408', apiError(408, 'DEADLINE_EXCEEDED'), 'AI_PROVIDER_UNAVAILABLE'],
      ['499 CANCELLED', apiError(499, 'CANCELLED'), 'AI_PROVIDER_UNAVAILABLE'],
      ['400 INVALID_ARGUMENT', apiError(400, 'INVALID_ARGUMENT'), 'AI_INVALID_REQUEST'],
      ['400 FAILED_PRECONDITION', apiError(400, 'FAILED_PRECONDITION'), 'AI_INVALID_REQUEST'],
      ['413', apiError(413, 'INVALID_ARGUMENT'), 'AI_INVALID_REQUEST'],
    ])('%s -> %s', (_label, err, code) => {
      expect(geminiErrorCode(err)).toBe(code);
      expect(mapGeminiError(err).code).toBe(code);
    });

    it('reads a mid-stream error frame (`got status: ...` prefix)', () => {
      const err = new ApiError({
        status: 429,
        message: `got status: RESOURCE_EXHAUSTED. ${JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [RETRY_37S] } })}`,
      });

      const mapped = mapGeminiError(err);

      expect(mapped.code).toBe('AI_RATE_LIMITED');
      expect(mapped.retryAfterMs).toBe(37_000);
      expect(mapped.toJSON().details).toMatchObject({ providerStatus: 'RESOURCE_EXHAUSTED' });
    });

    it('carries the RetryInfo delay on a rate limit, as a rate-limit error for the queue', () => {
      const mapped = mapGeminiError(apiError(429, 'RESOURCE_EXHAUSTED', [RETRY_37S]));

      expect(mapped.retryAfterMs).toBe(37_000);
      expect(mapped.toRateLimitError()).not.toBeNull();
    });

    it('carries only machine-readable details, never the provider message', () => {
      const mapped = mapGeminiError(apiError(400, 'INVALID_ARGUMENT', [KEY_INVALID_INFO]));

      expect(mapped.toJSON().details).toEqual({
        reason: 'AI_KEY_INVALID',
        provider: 'gemini',
        status: 400,
        providerStatus: 'INVALID_ARGUMENT',
        providerReason: 'API_KEY_INVALID',
      });
      expect(JSON.stringify(mapped)).not.toContain(SECRET);
      expect(mapped.message).not.toContain(SECRET);
    });
  });

  describe('transport failures', () => {
    function abortError(): Error {
      const err = new Error('This operation was aborted');

      err.name = 'AbortError';

      return err;
    }

    it('an abort by the caller is AI_PROVIDER_UNAVAILABLE, details.aborted', () => {
      const controller = new AbortController();

      controller.abort();

      const mapped = mapGeminiError(abortError(), { signal: controller.signal });

      expect(mapped.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(mapped.toJSON().details).toMatchObject({ aborted: true });
    });

    it('an abort the caller did not ask for is the client timeout', () => {
      const mapped = mapGeminiError(abortError(), { signal: new AbortController().signal });

      expect(mapped.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(mapped.toJSON().details).toMatchObject({ transport: 'timeout' });
    });

    it('a fetch failure is a connection failure', () => {
      const mapped = mapGeminiError(new TypeError('fetch failed'));

      expect(mapped.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(mapped.toJSON().details).toMatchObject({ transport: 'connection' });
    });

    it('anything else is AI_PROVIDER_UNAVAILABLE', () => {
      expect(mapGeminiError(new Error('exception parsing stream chunk')).code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(mapGeminiError('a string').code).toBe('AI_PROVIDER_UNAVAILABLE');
    });

    it('returns an AiError unchanged', () => {
      const own = new AiError('AI_CAPABILITY_UNSUPPORTED', 'nope');

      expect(mapGeminiError(own)).toBe(own);
    });
  });

  describe('parsing', () => {
    it('parses retry delays', () => {
      expect(parseGeminiRetryDelay('37s')).toBe(37_000);
      expect(parseGeminiRetryDelay('1.5s')).toBe(1_500);
      expect(parseGeminiRetryDelay('0s')).toBeUndefined();
      expect(parseGeminiRetryDelay('soon')).toBeUndefined();
      expect(parseGeminiRetryDelay(37)).toBeUndefined();
    });

    it('never throws on a malformed body', () => {
      expect(parseGeminiErrorBody('not json')).toEqual({});
      expect(parseGeminiErrorBody('{ broken')).toEqual({});
      expect(parseGeminiErrorBody('{"error": "flat"}')).toEqual({});
      expect(parseGeminiErrorBody('{"error": {"status": "X", "details": [null, 3, {"@type": 5}]}}')).toEqual({ status: 'X' });
    });
  });
});
