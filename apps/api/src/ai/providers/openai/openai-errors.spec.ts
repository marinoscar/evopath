import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  OAuthError,
  OpenAIError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from 'openai';
import { ContentFilterFinishReasonError, LengthFinishReasonError } from 'openai/core/error';

import { AiError, AiErrorCode, isAiErrorCode } from '../../core/ai-error';
import { RateLimitError as QueueRateLimitError } from '../../../jobs/rate-limit.error';
import {
  classifyOpenAiErrorCode,
  mapOpenAiError,
  mapOpenAiResponseFailure,
  openAiErrorCode,
  retryAfterFromHeaders,
} from './openai-errors';

const LEAKY_KEY = 'sk-proj-THIS-IS-SECRET-1234567890';

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({ 'x-request-id': 'req_abc123', ...extra });
}

/** An SDK error body the way OpenAI sends it, echoing a (masked) key in the message. */
function body(code?: string, param?: string, type = 'invalid_request_error') {
  return {
    message: `Incorrect API key provided: ${LEAKY_KEY}. Something went wrong.`,
    type,
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
  };
}

describe('openai-errors', () => {
  // One row per SDK error class (plus the code-refined variants). Each maps
  // to exactly one AiErrorCode — the acceptance criterion of #426.
  const table: Array<[string, () => unknown, AiErrorCode]> = [
    ['APIUserAbortError', () => new APIUserAbortError(), 'AI_PROVIDER_UNAVAILABLE'],
    ['APIConnectionError', () => new APIConnectionError({ message: 'socket hang up' }), 'AI_PROVIDER_UNAVAILABLE'],
    ['APIConnectionTimeoutError', () => new APIConnectionTimeoutError(), 'AI_PROVIDER_UNAVAILABLE'],
    ['AuthenticationError (401)', () => new AuthenticationError(401, body('invalid_api_key'), undefined, headers()), 'AI_KEY_INVALID'],
    ['OAuthError', () => new OAuthError(401, body(), headers()), 'AI_KEY_INVALID'],
    ['PermissionDeniedError (403)', () => new PermissionDeniedError(403, body(), undefined, headers()), 'AI_MODEL_NOT_REACHABLE'],
    ['NotFoundError (404, param model)', () => new NotFoundError(404, body(undefined, 'model'), undefined, headers()), 'AI_MODEL_NOT_REACHABLE'],
    ['NotFoundError (404, model_not_found)', () => new NotFoundError(404, body('model_not_found'), undefined, headers()), 'AI_MODEL_NOT_REACHABLE'],
    ['NotFoundError (404, other resource)', () => new NotFoundError(404, body(undefined, 'previous_response_id'), undefined, headers()), 'AI_INVALID_REQUEST'],
    ['ConflictError (409)', () => new ConflictError(409, body(), undefined, headers()), 'AI_INVALID_REQUEST'],
    ['UnprocessableEntityError (422)', () => new UnprocessableEntityError(422, body(), undefined, headers()), 'AI_INVALID_REQUEST'],
    ['RateLimitError (429)', () => new RateLimitError(429, body('rate_limit_exceeded'), undefined, headers()), 'AI_RATE_LIMITED'],
    ['BadRequestError (400)', () => new BadRequestError(400, body('invalid_value'), undefined, headers()), 'AI_INVALID_REQUEST'],
    ['BadRequestError (400, content policy)', () => new BadRequestError(400, body('content_policy_violation'), undefined, headers()), 'AI_CONTENT_FILTERED'],
    ['BadRequestError (400, model_not_found)', () => new BadRequestError(400, body('model_not_found'), undefined, headers()), 'AI_MODEL_NOT_REACHABLE'],
    ['InternalServerError (500)', () => new InternalServerError(500, body(), undefined, headers()), 'AI_PROVIDER_UNAVAILABLE'],
    ['InternalServerError (503)', () => new InternalServerError(503, body(), undefined, headers()), 'AI_PROVIDER_UNAVAILABLE'],
    ['APIError (408)', () => new APIError(408, body(), undefined, headers()), 'AI_PROVIDER_UNAVAILABLE'],
    ['APIError (418)', () => new APIError(418, body(), undefined, headers()), 'AI_INVALID_REQUEST'],
    ['APIError (stream, no status, server_error)', () => new APIError(undefined, body('server_error'), undefined, undefined), 'AI_PROVIDER_UNAVAILABLE'],
    ['APIError (stream, no status, rate_limit_exceeded)', () => new APIError(undefined, body('rate_limit_exceeded'), undefined, undefined), 'AI_RATE_LIMITED'],
    ['ContentFilterFinishReasonError', () => new ContentFilterFinishReasonError(), 'AI_CONTENT_FILTERED'],
    ['LengthFinishReasonError', () => new LengthFinishReasonError(), 'AI_INVALID_REQUEST'],
    ['OpenAIError', () => new OpenAIError('boom'), 'AI_PROVIDER_UNAVAILABLE'],
    ['TypeError (fetch failed)', () => new TypeError('fetch failed'), 'AI_PROVIDER_UNAVAILABLE'],
    ['SyntaxError (malformed SSE)', () => new SyntaxError('malformed server-sent event JSON'), 'AI_PROVIDER_UNAVAILABLE'],
    ['a thrown string', () => 'nope', 'AI_PROVIDER_UNAVAILABLE'],
  ];

  it.each(table)('%s maps to one AiErrorCode', (_name, make, expected) => {
    const err = make();

    expect(openAiErrorCode(err)).toBe(expected);

    const mapped = mapOpenAiError(err);

    expect(mapped).toBeInstanceOf(AiError);
    expect(mapped.code).toBe(expected);
    expect(mapped.getStatus()).toBe(new AiError(expected, 'x').getStatus());
    expect(mapped.cause).toBe(err);
  });

  it.each(table)('%s never echoes the provider message or key', (_name, make) => {
    const mapped = mapOpenAiError(make());
    const serialised = JSON.stringify(mapped);

    expect(serialised).not.toContain(LEAKY_KEY);
    expect(serialised).not.toContain('Incorrect API key');
    expect(mapped.message).not.toContain(LEAKY_KEY);
  });

  it('returns an AiError unchanged', () => {
    const original = new AiError('AI_CAPABILITY_UNSUPPORTED', 'no');

    expect(mapOpenAiError(original)).toBe(original);
  });

  it('carries only safe provider metadata in details', () => {
    const mapped = mapOpenAiError(
      new NotFoundError(404, body('model_not_found', 'model'), undefined, headers()),
    );

    expect(mapped.toJSON().details).toEqual({
      reason: 'AI_MODEL_NOT_REACHABLE',
      provider: 'openai',
      status: 404,
      providerCode: 'model_not_found',
      providerType: 'invalid_request_error',
      param: 'model',
      providerRequestId: 'req_abc123',
    });
  });

  it('marks an aborted call and a timed-out one', () => {
    expect(mapOpenAiError(new APIUserAbortError()).toJSON().details).toMatchObject({ aborted: true });
    expect(mapOpenAiError(new APIConnectionTimeoutError()).toJSON().details).toMatchObject({ transport: 'timeout' });
    expect(mapOpenAiError(new APIConnectionError({})).toJSON().details).toMatchObject({ transport: 'connection' });
  });

  describe('rate limits', () => {
    it('reads retry-after-ms first', () => {
      const err = new RateLimitError(429, body(), undefined, headers({ 'retry-after-ms': '1500', 'retry-after': '9' }));
      const mapped = mapOpenAiError(err);

      expect(mapped.retryAfterMs).toBe(1500);
      expect(mapped.toJSON().details.retryAfterMs).toBe(1500);
    });

    it('falls back to Retry-After seconds via parseRetryAfterMs', () => {
      const mapped = mapOpenAiError(new RateLimitError(429, body(), undefined, headers({ 'retry-after': '20' })));

      expect(mapped.retryAfterMs).toBe(20_000);
    });

    it('omits retryAfterMs when the provider named no delay', () => {
      const mapped = mapOpenAiError(new RateLimitError(429, body(), undefined, headers()));

      expect(mapped.retryAfterMs).toBeUndefined();
    });

    it('converts to the queue rate-limit signal', () => {
      const mapped = mapOpenAiError(new RateLimitError(429, body(), undefined, headers({ 'retry-after': '3' })));
      const signal = mapped.toRateLimitError();

      expect(signal).toBeInstanceOf(QueueRateLimitError);
      expect(signal?.retryAfterMs).toBe(3000);
    });

    it('retryAfterFromHeaders ignores garbage', () => {
      expect(retryAfterFromHeaders(undefined)).toBeUndefined();
      expect(retryAfterFromHeaders(new Headers({ 'retry-after-ms': 'soon' }))).toBeUndefined();
    });
  });

  describe('classifyOpenAiErrorCode', () => {
    it.each([
      [null, 'AI_PROVIDER_UNAVAILABLE'],
      ['server_error', 'AI_PROVIDER_UNAVAILABLE'],
      ['rate_limit_exceeded', 'AI_RATE_LIMITED'],
      ['invalid_prompt', 'AI_CONTENT_FILTERED'],
      ['image_content_policy_violation', 'AI_CONTENT_FILTERED'],
      ['invalid_image_url', 'AI_INVALID_REQUEST'],
      ['model_not_found', 'AI_MODEL_NOT_REACHABLE'],
      ['invalid_api_key', 'AI_KEY_INVALID'],
      ['something_new', 'AI_PROVIDER_UNAVAILABLE'],
    ])('%s -> %s', (code, expected) => {
      const result = classifyOpenAiErrorCode(code);

      expect(result).toBe(expected);
      expect(isAiErrorCode(result)).toBe(true);
    });
  });

  it('mapOpenAiResponseFailure classifies a failed response body', () => {
    const err = mapOpenAiResponseFailure({ code: 'rate_limit_exceeded' }, 'req_1');

    expect(err.code).toBe('AI_RATE_LIMITED');
    expect(err.toJSON().details).toMatchObject({ providerCode: 'rate_limit_exceeded', providerRequestId: 'req_1' });
    expect(mapOpenAiResponseFailure(null).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });
});
