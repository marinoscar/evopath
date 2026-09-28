// =============================================================================
// OpenAI SDK error -> AiError (issue #426, epic #419)
// =============================================================================
//
// The one place an OpenAI SDK failure becomes an `AiError`. Every other file
// in this adapter funnels its `catch` through `mapOpenAiError`, so a raw SDK
// exception never crosses the `AiProviderAdapter` boundary (the conformance
// kit asserts it) and the same provider condition cannot surface as two
// different codes from two call sites.
//
// ⚠ SECRETS. The SDK's own `message` can echo request details — an invalid
// key comes back as "Incorrect API key provided: sk-abc***…" — so it is NEVER
// copied into the `AiError`'s message or details. What does travel, in
// `details`, is only short machine-readable metadata the provider assigned:
// the HTTP status, OpenAI's error `code`/`type`/`param`, and its request id.
// The SDK error itself is kept as the (non-enumerable, never serialised)
// `cause`, for a debugger.
//
// The mapping is data-driven by SDK class first (the SDK already turns a
// status into a class), then refined by OpenAI's own `code` where one class
// covers two meanings (a 400 that is a content-policy refusal, a 404 that is
// an unknown model). The table in `openai-errors.spec.ts` pins every class.
// =============================================================================

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

import { AiError, AiErrorCode } from '../../core/ai-error';
import { parseRetryAfterMs } from '../../../jobs/rate-limit.error';

export const OPENAI_PROVIDER_ID = 'openai';

/**
 * Which member of the OpenAI wire family an error or a response belongs to
 * (#448). The OpenAI adapter, the Azure OpenAI adapter and the generic
 * OpenAI-compatible adapter all speak the same wire protocol through the same
 * SDK, so they share this file's mapping and the mappers beside it; the
 * family only changes the provider id stamped on `details` / `AiResponse
 * .provider` and the name in the generic, secret-free messages. Every
 * function taking one defaults to {@link OPENAI_FAMILY}, so the OpenAI
 * adapter's behaviour is exactly what it was before the extraction.
 */
export interface OpenAiFamily {
  /** The adapter's permanent provider id (`'openai'`, `'azure-openai'`, ...). */
  providerId: string;
  /** How the generic error messages name the provider (`'OpenAI'`). */
  label: string;
}

/** OpenAI itself. */
export const OPENAI_FAMILY: OpenAiFamily = Object.freeze({ providerId: OPENAI_PROVIDER_ID, label: 'OpenAI' });

/**
 * OpenAI error codes that mean "the provider refused this content", whatever
 * HTTP status (or none, mid-stream) carried them. `invalid_prompt` is what a
 * reasoning model answers when a prompt is flagged under the usage policy.
 */
const CONTENT_FILTER_CODES = new Set([
  'content_filter',
  'content_policy_violation',
  'image_content_policy_violation',
  'invalid_prompt',
  'bio_policy',
  'misalignment_policy_violation',
  // The images API's refusal (`/v1/images/*` answers 400 with this code).
  'moderation_blocked',
]);

/** Codes that name the model as the problem — the key cannot reach it. */
const MODEL_UNREACHABLE_CODES = new Set(['model_not_found', 'model_not_available']);

/** Codes a streamed (status-less) failure carries that are the caller's fault. */
const CALLER_FAULT_CODES = new Set([
  'invalid_image',
  'invalid_image_format',
  'invalid_base64_image',
  'invalid_image_url',
  'image_too_large',
  'image_too_small',
  'image_parse_error',
  'invalid_image_mode',
  'image_file_too_large',
  'unsupported_image_media_type',
  'empty_image_file',
  'failed_to_download_image',
  'image_file_not_found',
  'data_residency_mismatch',
  'context_length_exceeded',
]);

function messagesFor(label: string): Record<AiErrorCode, string> {
  return {
    AI_DISABLED: 'AI is disabled.',
    AI_PROVIDER_DISABLED: 'The AI provider is disabled.',
    AI_KEY_REQUIRED: 'An API key is required for this AI provider.',
    AI_KEY_INVALID: `The ${label} API key was rejected.`,
    AI_MODEL_NOT_ENABLED: 'The model is not enabled.',
    AI_MODEL_NOT_REACHABLE: `The ${label} model is not reachable with this API key.`,
    AI_CAPABILITY_UNSUPPORTED: `The request uses a capability ${label} does not support here.`,
    AI_TOOL_DISABLED: 'The requested tool is not enabled in this deployment.',
    AI_REALTIME_DISABLED: 'Realtime sessions are not enabled in this deployment.',
    AI_RATE_LIMITED: `${label} rate-limited the request.`,
    AI_PROVIDER_UNAVAILABLE: `${label} is unavailable or the request failed.`,
    AI_CONTENT_FILTERED: `${label} refused the request under its content policy.`,
    AI_INVALID_REQUEST: `${label} rejected the request as invalid.`,
    AI_STRUCTURED_OUTPUT_INVALID: 'The model output does not match the requested schema.',
    AI_STORAGE_UNAVAILABLE: 'Object storage is unavailable.',
  };
}

const MESSAGES_BY_LABEL = new Map<string, Record<AiErrorCode, string>>();

/** The generic, secret-free message this adapter family uses for `code`. */
export function openAiErrorMessage(code: AiErrorCode, family: OpenAiFamily = OPENAI_FAMILY): string {
  let messages = MESSAGES_BY_LABEL.get(family.label);

  if (!messages) {
    messages = messagesFor(family.label);
    MESSAGES_BY_LABEL.set(family.label, messages);
  }

  return messages[code];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Classifies an OpenAI error `code` that arrived without a usable HTTP status. */
export function classifyOpenAiErrorCode(code: string | null | undefined): AiErrorCode {
  if (!code) return 'AI_PROVIDER_UNAVAILABLE';
  if (CONTENT_FILTER_CODES.has(code)) return 'AI_CONTENT_FILTERED';
  if (MODEL_UNREACHABLE_CODES.has(code)) return 'AI_MODEL_NOT_REACHABLE';
  if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') return 'AI_RATE_LIMITED';
  if (code === 'invalid_api_key') return 'AI_KEY_INVALID';
  if (CALLER_FAULT_CODES.has(code)) return 'AI_INVALID_REQUEST';

  return 'AI_PROVIDER_UNAVAILABLE';
}

/**
 * The provider's requested back-off: OpenAI's own millisecond header first
 * (more precise), then the standard `Retry-After` (seconds or HTTP-date).
 */
export function retryAfterFromHeaders(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;

  const ms = headers.get('retry-after-ms');

  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) {
    return Math.ceil(Number(ms));
  }

  return parseRetryAfterMs(headers.get('retry-after')) ?? undefined;
}

/** Which `AiErrorCode` an SDK `APIError` means. Pure — exported for the table spec. */
export function openAiErrorCode(err: unknown): AiErrorCode {
  if (err instanceof AiError) return err.code;

  // Order matters: subclasses before their parents.
  if (err instanceof APIUserAbortError) return 'AI_PROVIDER_UNAVAILABLE';
  if (err instanceof APIConnectionError) return 'AI_PROVIDER_UNAVAILABLE';
  if (err instanceof OAuthError) return 'AI_KEY_INVALID';
  if (err instanceof AuthenticationError) return 'AI_KEY_INVALID';

  if (err instanceof APIError) {
    const code = err.code ?? undefined;

    if (code && MODEL_UNREACHABLE_CODES.has(code)) return 'AI_MODEL_NOT_REACHABLE';
    if (code && CONTENT_FILTER_CODES.has(code)) return 'AI_CONTENT_FILTERED';
  }

  if (err instanceof PermissionDeniedError) return 'AI_MODEL_NOT_REACHABLE';
  if (err instanceof NotFoundError) {
    return err.param === 'model' ? 'AI_MODEL_NOT_REACHABLE' : 'AI_INVALID_REQUEST';
  }
  if (err instanceof RateLimitError) return 'AI_RATE_LIMITED';
  if (err instanceof BadRequestError) return 'AI_INVALID_REQUEST';
  if (err instanceof UnprocessableEntityError) return 'AI_INVALID_REQUEST';
  if (err instanceof ConflictError) return 'AI_INVALID_REQUEST';
  if (err instanceof InternalServerError) return 'AI_PROVIDER_UNAVAILABLE';

  if (err instanceof APIError) {
    // A status the SDK has no class for, or none at all (a mid-stream
    // `error` event, which the SDK raises as a status-less APIError).
    if (typeof err.status === 'number') {
      if (err.status === 401) return 'AI_KEY_INVALID';
      if (err.status === 429) return 'AI_RATE_LIMITED';
      if (err.status >= 500 || err.status === 408) return 'AI_PROVIDER_UNAVAILABLE';
      if (err.status >= 400) return 'AI_INVALID_REQUEST';
    }

    return classifyOpenAiErrorCode(err.code);
  }

  if (err instanceof ContentFilterFinishReasonError) return 'AI_CONTENT_FILTERED';
  if (err instanceof LengthFinishReasonError) return 'AI_INVALID_REQUEST';
  if (err instanceof OpenAIError) return 'AI_PROVIDER_UNAVAILABLE';

  // A fetch/socket failure, a malformed SSE frame, anything else.
  return 'AI_PROVIDER_UNAVAILABLE';
}

/**
 * Turns anything an OpenAI call threw into an `AiError`. An `AiError` is
 * returned unchanged (the mapper's own `AI_CAPABILITY_UNSUPPORTED`, for one).
 */
export function mapOpenAiError(err: unknown, family: OpenAiFamily = OPENAI_FAMILY): AiError {
  if (err instanceof AiError) return err;

  const code = openAiErrorCode(err);
  const details: Record<string, unknown> = { provider: family.providerId };
  let retryAfterMs: number | undefined;

  if (err instanceof APIUserAbortError) {
    details.aborted = true;
  } else if (err instanceof APIConnectionError) {
    details.transport = err instanceof APIConnectionTimeoutError ? 'timeout' : 'connection';
  } else if (err instanceof APIError) {
    if (typeof err.status === 'number') details.status = err.status;

    const providerCode = stringOrUndefined(err.code);
    const providerType = stringOrUndefined(err.type);
    const param = stringOrUndefined(err.param);
    const providerRequestId = stringOrUndefined(err.requestID);

    if (providerCode) details.providerCode = providerCode;
    if (providerType) details.providerType = providerType;
    if (param) details.param = param;
    if (providerRequestId) details.providerRequestId = providerRequestId;

    if (code === 'AI_RATE_LIMITED') {
      retryAfterMs = retryAfterFromHeaders(err.headers);
    }
  }

  return new AiError(code, openAiErrorMessage(code, family), { cause: err, details, retryAfterMs });
}

/**
 * The `AiError` for a response OpenAI returned with `status: 'failed'` (or a
 * `response.failed` stream event): the failure is in the body, not an HTTP
 * status, so only its `code` can be classified.
 */
export function mapOpenAiResponseFailure(
  error: { code?: string | null } | null | undefined,
  providerRequestId?: string,
  family: OpenAiFamily = OPENAI_FAMILY,
): AiError {
  const code = classifyOpenAiErrorCode(error?.code ?? undefined);
  const details: Record<string, unknown> = { provider: family.providerId };
  const providerCode = stringOrUndefined(error?.code);

  if (providerCode) details.providerCode = providerCode;
  if (providerRequestId) details.providerRequestId = providerRequestId;

  return new AiError(code, openAiErrorMessage(code, family), { details });
}
