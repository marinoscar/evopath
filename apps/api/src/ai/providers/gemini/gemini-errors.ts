// =============================================================================
// Google Gen AI SDK error -> AiError (issue #447, epic #421)
// =============================================================================
//
// The one place a Gemini failure becomes an `AiError` — the counterpart of
// `openai-errors.ts` and `anthropic-errors.ts`: every `catch` in this adapter
// funnels through `mapGeminiError`, so a raw SDK exception never crosses the
// `AiProviderAdapter` boundary (the conformance kit asserts it).
//
// WHAT THE SDK THROWS. `@google/genai` raises exactly one typed error,
// `ApiError { status, message }`, whose `message` is the JSON error body
// verbatim (`{"error":{"code":429,"status":"RESOURCE_EXHAUSTED",...}}`) — or,
// for an error frame inside a stream, `got status: <STATUS>. <json>`. The
// body is parsed here for three machine-readable facts only: Google's
// canonical `status` (`RESOURCE_EXHAUSTED`, ...), the `ErrorInfo.reason`
// (`API_KEY_INVALID`, ...) and the `RetryInfo.retryDelay` (`"37s"`).
// Everything else — a network failure, an abort, a malformed SSE chunk — is
// a plain `Error`/`TypeError`/`AbortError` from `fetch` or the SDK.
//
// ⚠ SECRETS. The SDK's `message` is never copied into the `AiError`: it is
// the provider's text, and the real API echoes request details in it. What
// travels in `details` is short machine-readable metadata only. The SDK error
// is kept as the non-enumerable `cause`.
//
// THE TABLE (pinned by `gemini-errors.spec.ts`):
//
//   400 INVALID_ARGUMENT, reason API_KEY_INVALID  AI_KEY_INVALID  (Gemini's
//                                                 answer to a bad key is a
//                                                 400, not a 401)
//   401 UNAUTHENTICATED                           AI_KEY_INVALID
//   403 PERMISSION_DENIED                         AI_KEY_INVALID  (the key may
//                                                 not call the API / project)
//   404 NOT_FOUND                                 AI_MODEL_NOT_REACHABLE
//   429 RESOURCE_EXHAUSTED                        AI_RATE_LIMITED, with
//                                                 `RetryInfo.retryDelay`
//   408 / 499 / 5xx (INTERNAL, UNAVAILABLE,       AI_PROVIDER_UNAVAILABLE (with
//     DEADLINE_EXCEEDED)                          the retry delay when named)
//   other 4xx (INVALID_ARGUMENT,                  AI_INVALID_REQUEST
//     FAILED_PRECONDITION, ...)
//   abort by the caller's signal                  AI_PROVIDER_UNAVAILABLE,
//                                                 details.aborted
//   abort by the client timeout                   AI_PROVIDER_UNAVAILABLE,
//                                                 details.transport 'timeout'
//   fetch failure (TypeError)                     AI_PROVIDER_UNAVAILABLE,
//                                                 details.transport 'connection'
//   anything else                                 AI_PROVIDER_UNAVAILABLE
// =============================================================================

import { ApiError } from '@google/genai';

import { AiError, AiErrorCode } from '../../core/ai-error';

export const GEMINI_PROVIDER_ID = 'gemini';

const MESSAGES: Record<AiErrorCode, string> = {
  AI_DISABLED: 'AI is disabled.',
  AI_PROVIDER_DISABLED: 'The AI provider is disabled.',
  AI_KEY_REQUIRED: 'An API key is required for this AI provider.',
  AI_KEY_INVALID: 'The Google Gemini API key was rejected.',
  AI_MODEL_NOT_ENABLED: 'The model is not enabled.',
  AI_MODEL_NOT_REACHABLE: 'The Gemini model is not reachable with this API key.',
  AI_CAPABILITY_UNSUPPORTED: 'The request uses a capability Gemini does not support here.',
  AI_TOOL_DISABLED: 'The requested tool is not enabled in this deployment.',
  AI_REALTIME_DISABLED: 'Realtime sessions are not enabled in this deployment.',
  AI_RATE_LIMITED: 'Gemini rate-limited the request.',
  AI_PROVIDER_UNAVAILABLE: 'Gemini is unavailable or the request failed.',
  AI_CONTENT_FILTERED: 'Gemini blocked the request or its response.',
  AI_INVALID_REQUEST: 'Gemini rejected the request as invalid.',
  AI_STRUCTURED_OUTPUT_INVALID: 'The model output does not match the requested schema.',
  AI_STORAGE_UNAVAILABLE: 'Object storage is unavailable.',
};

/** The generic, secret-free message this adapter uses for `code`. */
export function geminiErrorMessage(code: AiErrorCode): string {
  return MESSAGES[code];
}

/** The machine-readable facts of a Google error body. */
export interface GeminiErrorBody {
  /** Google's canonical status (`RESOURCE_EXHAUSTED`, `INVALID_ARGUMENT`, ...). */
  status?: string;
  /** `google.rpc.ErrorInfo.reason` (`API_KEY_INVALID`, ...). */
  reason?: string;
  /** `google.rpc.RetryInfo.retryDelay`, in milliseconds. */
  retryAfterMs?: number;
}

/** `"37s"` / `"1.5s"` (a protobuf Duration in JSON) -> milliseconds. */
export function parseGeminiRetryDelay(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;

  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());

  if (!match) return undefined;

  const ms = Math.round(Number(match[1]) * 1000);

  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Parses what an `ApiError`'s message carries: the JSON error body, possibly
 * after a `got status: ...` prefix. Never throws; unknown shapes yield `{}`.
 */
export function parseGeminiErrorBody(message: string): GeminiErrorBody {
  const start = message.indexOf('{');

  if (start < 0) return {};

  let parsed: unknown;

  try {
    parsed = JSON.parse(message.slice(start));
  } catch {
    return {};
  }

  const error = (parsed as { error?: unknown } | null)?.error;

  if (!error || typeof error !== 'object') return {};

  const out: GeminiErrorBody = {};
  const { status, details } = error as { status?: unknown; details?: unknown };

  if (typeof status === 'string' && status.length > 0) out.status = status;

  if (Array.isArray(details)) {
    for (const detail of details as Array<Record<string, unknown> | null>) {
      if (!detail || typeof detail !== 'object') continue;

      const type = typeof detail['@type'] === 'string' ? (detail['@type'] as string) : '';

      if (type.endsWith('google.rpc.ErrorInfo') && typeof detail.reason === 'string') {
        out.reason = detail.reason;
      }

      if (type.endsWith('google.rpc.RetryInfo')) {
        const delay = parseGeminiRetryDelay(detail.retryDelay);

        if (delay !== undefined) out.retryAfterMs = delay;
      }
    }
  }

  return out;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Which `AiErrorCode` an SDK/HTTP failure means. Pure — exported for the table spec. */
export function geminiErrorCode(err: unknown): AiErrorCode {
  if (err instanceof AiError) return err.code;

  if (err instanceof ApiError) {
    const status = err.status;
    const body = parseGeminiErrorBody(err.message);

    if (body.reason === 'API_KEY_INVALID') return 'AI_KEY_INVALID';
    if (status === 401 || status === 403) return 'AI_KEY_INVALID';
    if (status === 404) return 'AI_MODEL_NOT_REACHABLE';
    if (status === 429) return 'AI_RATE_LIMITED';
    if (status === 408 || status === 499 || status >= 500) return 'AI_PROVIDER_UNAVAILABLE';
    if (status >= 400) return 'AI_INVALID_REQUEST';
  }

  // An abort, a fetch failure, a malformed SSE chunk, anything else.
  return 'AI_PROVIDER_UNAVAILABLE';
}

export interface MapGeminiErrorOptions {
  /** The caller's own signal: an abort it caused is `aborted`, any other abort a timeout. */
  signal?: AbortSignal;
}

/**
 * Turns anything a Gemini call threw into an `AiError`. An `AiError` is
 * returned unchanged (the mapper's own `AI_CAPABILITY_UNSUPPORTED`, for one).
 */
export function mapGeminiError(err: unknown, opts: MapGeminiErrorOptions = {}): AiError {
  if (err instanceof AiError) return err;

  const code = geminiErrorCode(err);
  const details: Record<string, unknown> = { provider: GEMINI_PROVIDER_ID };
  let retryAfterMs: number | undefined;

  if (err instanceof ApiError) {
    const body = parseGeminiErrorBody(err.message);

    details.status = err.status;
    if (body.status) details.providerStatus = body.status;
    if (body.reason) details.providerReason = body.reason;

    if (code === 'AI_RATE_LIMITED' || code === 'AI_PROVIDER_UNAVAILABLE') {
      retryAfterMs = body.retryAfterMs;
    }
  } else if (isAbortError(err)) {
    // The SDK aborts a request for exactly two reasons: the caller's signal,
    // or the client's own per-request timeout.
    if (opts.signal?.aborted) {
      details.aborted = true;
    } else {
      details.transport = 'timeout';
    }
  } else if (err instanceof TypeError) {
    details.transport = 'connection';
  }

  return new AiError(code, geminiErrorMessage(code), { cause: err, details, retryAfterMs });
}
