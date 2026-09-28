// =============================================================================
// Anthropic SDK error -> AiError (issue #446, epic #421)
// =============================================================================
//
// The one place an Anthropic SDK failure becomes an `AiError` — the exact
// counterpart of `openai-errors.ts`, and for the same reasons: every `catch`
// in this adapter funnels through `mapAnthropicError`, so a raw SDK exception
// never crosses the `AiProviderAdapter` boundary (the conformance kit asserts
// it) and one provider condition cannot surface as two codes.
//
// ⚠ SECRETS. The SDK's own `message` is never copied into the `AiError`: it
// is the provider's text, and a provider's text can echo request details.
// What travels in `details` is short machine-readable metadata only — the
// HTTP status, Anthropic's error `type` (`rate_limit_error`, ...) and its
// request id. The SDK error is kept as the non-enumerable `cause`.
//
// THE TABLE (pinned by `anthropic-errors.spec.ts`):
//
//   401 authentication_error         AI_KEY_INVALID
//   403 permission_error             AI_MODEL_NOT_REACHABLE  (the key may not use it)
//   404 not_found_error              AI_MODEL_NOT_REACHABLE  (Messages' only 404 is the model)
//   402 billing_error                AI_RATE_LIMITED         (OpenAI's `insufficient_quota` precedent)
//   429 rate_limit_error             AI_RATE_LIMITED, with `retry-after`
//   529 overloaded_error / 5xx / 408 AI_PROVIDER_UNAVAILABLE (with `retry-after` when named)
//   400/409/413/422                  AI_INVALID_REQUEST
//   abort (APIUserAbortError)        AI_PROVIDER_UNAVAILABLE, details.aborted — as OpenAI's
//   connection / timeout             AI_PROVIDER_UNAVAILABLE, details.transport
//
// A mid-stream `event: error` frame has no HTTP status; the SDK raises it as a
// status-less `APIError` whose `type` is the body's `error.type`, classified by
// the same table.
// =============================================================================

import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';

import { AiError, AiErrorCode } from '../../core/ai-error';
import { parseRetryAfterMs } from '../../../jobs/rate-limit.error';

export const ANTHROPIC_PROVIDER_ID = 'anthropic';

const MESSAGES: Record<AiErrorCode, string> = {
  AI_DISABLED: 'AI is disabled.',
  AI_PROVIDER_DISABLED: 'The AI provider is disabled.',
  AI_KEY_REQUIRED: 'An API key is required for this AI provider.',
  AI_KEY_INVALID: 'The Anthropic API key was rejected.',
  AI_MODEL_NOT_ENABLED: 'The model is not enabled.',
  AI_MODEL_NOT_REACHABLE: 'The Anthropic model is not reachable with this API key.',
  AI_CAPABILITY_UNSUPPORTED: 'The request uses a capability Anthropic does not support here.',
  AI_TOOL_DISABLED: 'The requested tool is not enabled in this deployment.',
  AI_REALTIME_DISABLED: 'Realtime sessions are not enabled in this deployment.',
  AI_RATE_LIMITED: 'Anthropic rate-limited the request.',
  AI_PROVIDER_UNAVAILABLE: 'Anthropic is unavailable or the request failed.',
  AI_CONTENT_FILTERED: 'Anthropic refused the request.',
  AI_INVALID_REQUEST: 'Anthropic rejected the request as invalid.',
  AI_STRUCTURED_OUTPUT_INVALID: 'The model output does not match the requested schema.',
  AI_STORAGE_UNAVAILABLE: 'Object storage is unavailable.',
};

/** The generic, secret-free message this adapter uses for `code`. */
export function anthropicErrorMessage(code: AiErrorCode): string {
  return MESSAGES[code];
}

/** Classifies an Anthropic error `type` (from a body or a stream `error` frame). */
export function classifyAnthropicErrorType(type: string | null | undefined): AiErrorCode {
  switch (type) {
    case 'authentication_error':
      return 'AI_KEY_INVALID';
    case 'permission_error':
    case 'not_found_error':
      return 'AI_MODEL_NOT_REACHABLE';
    case 'rate_limit_error':
    case 'billing_error':
      return 'AI_RATE_LIMITED';
    case 'invalid_request_error':
    case 'request_too_large':
      return 'AI_INVALID_REQUEST';
    default:
      // overloaded_error, api_error, timeout_error, anything unknown.
      return 'AI_PROVIDER_UNAVAILABLE';
  }
}

/** The provider's requested back-off, from the standard `retry-after` header. */
export function anthropicRetryAfter(headers: Headers | undefined): number | undefined {
  return parseRetryAfterMs(headers?.get('retry-after') ?? null) ?? undefined;
}

/** Which `AiErrorCode` an SDK error means. Pure — exported for the table spec. */
export function anthropicErrorCode(err: unknown): AiErrorCode {
  if (err instanceof AiError) return err.code;

  // Subclasses before their parents: both extend APIError.
  if (err instanceof APIUserAbortError) return 'AI_PROVIDER_UNAVAILABLE';
  if (err instanceof APIConnectionError) return 'AI_PROVIDER_UNAVAILABLE';

  if (err instanceof APIError) {
    const status = err.status;

    if (typeof status === 'number') {
      if (status === 401) return 'AI_KEY_INVALID';
      if (status === 402) return 'AI_RATE_LIMITED';
      if (status === 403 || status === 404) return 'AI_MODEL_NOT_REACHABLE';
      if (status === 429) return 'AI_RATE_LIMITED';
      if (status === 408 || status >= 500) return 'AI_PROVIDER_UNAVAILABLE';
      if (status >= 400) return 'AI_INVALID_REQUEST';
    }

    return classifyAnthropicErrorType(err.type);
  }

  // Any other SDK error (a malformed SSE frame, "streaming required", ...),
  // a fetch/socket failure, anything else.
  if (err instanceof AnthropicError) return 'AI_PROVIDER_UNAVAILABLE';

  return 'AI_PROVIDER_UNAVAILABLE';
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Turns anything an Anthropic call threw into an `AiError`. An `AiError` is
 * returned unchanged (the mapper's own `AI_CAPABILITY_UNSUPPORTED`, for one).
 */
export function mapAnthropicError(err: unknown): AiError {
  if (err instanceof AiError) return err;

  const code = anthropicErrorCode(err);
  const details: Record<string, unknown> = { provider: ANTHROPIC_PROVIDER_ID };
  let retryAfterMs: number | undefined;

  if (err instanceof APIUserAbortError) {
    details.aborted = true;
  } else if (err instanceof APIConnectionError) {
    details.transport = err instanceof APIConnectionTimeoutError ? 'timeout' : 'connection';
  } else if (err instanceof APIError) {
    if (typeof err.status === 'number') details.status = err.status;

    const providerType = stringOrUndefined(err.type);
    const providerRequestId = stringOrUndefined(err.requestID);

    if (providerType) details.providerType = providerType;
    if (providerRequestId) details.providerRequestId = providerRequestId;

    if (code === 'AI_RATE_LIMITED' || code === 'AI_PROVIDER_UNAVAILABLE') {
      retryAfterMs = anthropicRetryAfter(err.headers);
    }
  }

  return new AiError(code, anthropicErrorMessage(code), { cause: err, details, retryAfterMs });
}
