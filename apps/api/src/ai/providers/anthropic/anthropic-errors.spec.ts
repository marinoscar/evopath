import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AnthropicError,
} from '@anthropic-ai/sdk';

import { AiError } from '../../core/ai-error';
import { RateLimitError } from '../../../jobs/rate-limit.error';
import { anthropicErrorCode, classifyAnthropicErrorType, mapAnthropicError } from './anthropic-errors';

function apiError(status: number | undefined, type: string, message = 'provider text', headers: Record<string, string> = {}) {
  return APIError.generate(
    status,
    { type: 'error', error: { type, message } },
    message,
    new Headers({ 'request-id': 'req_err_1', ...headers }),
  );
}

describe('anthropic-errors', () => {
  it.each([
    [401, 'authentication_error', 'AI_KEY_INVALID'],
    [402, 'billing_error', 'AI_RATE_LIMITED'],
    [403, 'permission_error', 'AI_MODEL_NOT_REACHABLE'],
    [404, 'not_found_error', 'AI_MODEL_NOT_REACHABLE'],
    [400, 'invalid_request_error', 'AI_INVALID_REQUEST'],
    [409, 'invalid_request_error', 'AI_INVALID_REQUEST'],
    [413, 'request_too_large', 'AI_INVALID_REQUEST'],
    [422, 'invalid_request_error', 'AI_INVALID_REQUEST'],
    [429, 'rate_limit_error', 'AI_RATE_LIMITED'],
    [408, 'timeout_error', 'AI_PROVIDER_UNAVAILABLE'],
    [500, 'api_error', 'AI_PROVIDER_UNAVAILABLE'],
    [529, 'overloaded_error', 'AI_PROVIDER_UNAVAILABLE'],
  ])('maps HTTP %i (%s) to %s', (status, type, code) => {
    const err = mapAnthropicError(apiError(status, type));

    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe(code);
  });

  it.each([
    ['overloaded_error', 'AI_PROVIDER_UNAVAILABLE'],
    ['rate_limit_error', 'AI_RATE_LIMITED'],
    ['authentication_error', 'AI_KEY_INVALID'],
    ['invalid_request_error', 'AI_INVALID_REQUEST'],
    ['api_error', 'AI_PROVIDER_UNAVAILABLE'],
    ['something_new', 'AI_PROVIDER_UNAVAILABLE'],
  ])('classifies a status-less (mid-stream) %s error as %s', (type, code) => {
    // Constructed exactly as the SDK's stream raises an `event: error` frame.
    const midStream = new APIError(undefined, { type: 'error', error: { type } }, undefined, new Headers(), type as never);

    expect(anthropicErrorCode(midStream)).toBe(code);
    expect(classifyAnthropicErrorType(type)).toBe(code);
  });

  it('maps abort, connection failure, timeout and anything else to AI_PROVIDER_UNAVAILABLE', () => {
    expect(mapAnthropicError(new APIUserAbortError()).toJSON().details).toMatchObject({ aborted: true });
    expect(mapAnthropicError(new APIConnectionError({ message: 'x' })).toJSON().details).toMatchObject({ transport: 'connection' });
    expect(mapAnthropicError(new APIConnectionTimeoutError()).toJSON().details).toMatchObject({ transport: 'timeout' });
    expect(mapAnthropicError(new AnthropicError('Streaming is required')).code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(mapAnthropicError(new TypeError('fetch failed')).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });

  it('returns an AiError unchanged', () => {
    const original = new AiError('AI_CAPABILITY_UNSUPPORTED', 'no');

    expect(mapAnthropicError(original)).toBe(original);
  });

  it('carries only safe provider metadata, never the provider text', () => {
    const err = mapAnthropicError(apiError(400, 'invalid_request_error', 'bad key sk-ant-api03-SECRET'));

    expect(err.toJSON()).toEqual({
      code: 'AI_INVALID_REQUEST',
      message: 'Anthropic rejected the request as invalid.',
      details: {
        provider: 'anthropic',
        status: 400,
        providerType: 'invalid_request_error',
        providerRequestId: 'req_err_1',
        reason: 'AI_INVALID_REQUEST',
      },
    });
    expect(JSON.stringify(err)).not.toContain('SECRET');
  });

  describe('retry-after', () => {
    it('reads Retry-After on a 429 and converts to the queue rate-limit signal', () => {
      const err = mapAnthropicError(apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '12' }));

      expect(err.retryAfterMs).toBe(12_000);

      const signal = err.toRateLimitError();

      expect(signal).toBeInstanceOf(RateLimitError);
      expect(signal?.retryAfterMs).toBe(12_000);
    });

    it('reads Retry-After on a 529 overload too', () => {
      expect(mapAnthropicError(apiError(529, 'overloaded_error', 'x', { 'retry-after': '3' })).retryAfterMs).toBe(3000);
    });

    it('omits retryAfterMs when the provider named no delay, or garbage', () => {
      expect(mapAnthropicError(apiError(429, 'rate_limit_error')).retryAfterMs).toBeUndefined();
      expect(mapAnthropicError(apiError(429, 'rate_limit_error', 'x', { 'retry-after': 'soon' })).retryAfterMs).toBeUndefined();
    });
  });
});
