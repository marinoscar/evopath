// =============================================================================
// AI error taxonomy (issue #424, epic #419)
// =============================================================================
//
// Every failure an AI caller can see is one of these codes. Adapters map their
// SDK's errors onto them (an SDK error never escapes an adapter), and the
// runtime gates (#431) raise them directly.
//
// The HTTP status is part of the code's definition rather than a choice made
// at each throw site, so the same condition cannot surface as a 400 from one
// endpoint and a 403 from another.
// =============================================================================

import { HttpException } from '@nestjs/common';

import {
  CLASSIFY_RATE_LIMIT,
  RateLimitError,
  type RateLimitClassification,
  type SelfClassifyingRateLimit,
} from '../../jobs/rate-limit.error';

export const AI_ERROR_STATUS = {
  AI_DISABLED: 403,
  AI_PROVIDER_DISABLED: 403,
  AI_KEY_REQUIRED: 403,
  AI_KEY_INVALID: 400,
  AI_MODEL_NOT_ENABLED: 403,
  AI_MODEL_NOT_REACHABLE: 403,
  AI_CAPABILITY_UNSUPPORTED: 400,
  /** A hosted tool type an administrator has not switched on, or an MCP host outside the allowlist (#442). */
  AI_TOOL_DISABLED: 403,
  /** Realtime voice sessions are switched off (`ai.defaults.allowRealtime`, #449). */
  AI_REALTIME_DISABLED: 403,
  AI_RATE_LIMITED: 429,
  AI_PROVIDER_UNAVAILABLE: 503,
  AI_CONTENT_FILTERED: 422,
  AI_INVALID_REQUEST: 400,
  AI_STRUCTURED_OUTPUT_INVALID: 502,
  // Object storage is not configured (or not usable) for an operation whose
  // inputs or outputs are storage objects — image generation (#437) and the
  // media stories after it. An administrator fixes it at
  // `/admin/settings/storage`; the request itself was fine.
  AI_STORAGE_UNAVAILABLE: 503,
} as const;

export type AiErrorCode = keyof typeof AI_ERROR_STATUS;

/** Every code, in declaration order. */
export const AI_ERROR_CODES = Object.keys(AI_ERROR_STATUS) as AiErrorCode[];

/** Type guard for a string that arrived from somewhere untyped. */
export function isAiErrorCode(value: unknown): value is AiErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AI_ERROR_STATUS, value);
}

// =============================================================================
// AiError
// =============================================================================
//
// WIRE SHAPE. The thrown body is `{ code, message, details: { reason, ... } }`
// and the global `HttpExceptionFilter` turns it into the standard envelope
// `{ statusCode, code, message, details, timestamp, path }`. The envelope's
// top-level `code` is ALWAYS status-derived (`FORBIDDEN`, `TOO_MANY_REQUESTS`,
// ...) — that is a published, closed enum (see `common/dto/error.dto.ts` and
// the filter's own comment) — so the AI-specific code travels in
// `details.reason`, exactly as `StorageNotConfiguredError` carries its reason.
// Clients switch on `details.reason`.
//
// ⚠ SECRETS. An adapter typically constructs this from a caught SDK error,
// and SDK errors can carry the request (headers included) or even echo a
// masked key in their message. So:
//
//   - `cause` is stored NON-ENUMERABLE and is never passed to
//     `HttpException`'s options (which would store it enumerably twice), so
//     `JSON.stringify(err)` and any structured logger that serialises own
//     enumerable properties never reach it;
//   - `toJSON()` returns only the public body;
//   - `wrap()` uses a generic message rather than copying the SDK's.
//
// Callers must still never put `AiCallContext.apiKey` into `message` or
// `details` themselves; `ai-error.spec.ts` pins the parts this class controls.
// =============================================================================

export interface AiErrorOptions {
  /** Provider-requested delay before retrying, when it named one. */
  retryAfterMs?: number;
  /** The underlying error. Kept for debugging, never serialised. */
  cause?: unknown;
  /** Extra machine-readable context. Must not contain secret material. */
  details?: Record<string, unknown>;
}

export interface AiErrorBody {
  code: AiErrorCode;
  message: string;
  details: Record<string, unknown> & { reason: AiErrorCode; retryAfterMs?: number };
}

export class AiError extends HttpException implements SelfClassifyingRateLimit {
  readonly code: AiErrorCode;
  readonly retryAfterMs?: number;
  declare readonly cause: unknown;

  constructor(code: AiErrorCode, message: string, opts: AiErrorOptions = {}) {
    const details: AiErrorBody['details'] = {
      ...(opts.details ?? {}),
      // `reason` is written LAST so a caller-supplied `details.reason` can
      // never make the body disagree with `code`.
      reason: code,
    };

    if (opts.retryAfterMs !== undefined) {
      details.retryAfterMs = opts.retryAfterMs;
    }

    const body: AiErrorBody = { code, message, details };

    // No `options` argument: HttpException would copy `cause` onto two
    // enumerable properties (`options.cause` and `cause`). See header.
    super(body, AI_ERROR_STATUS[code]);

    this.code = code;

    if (opts.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }

    Object.defineProperty(this, 'cause', {
      value: opts.cause,
      enumerable: false,
      writable: false,
      configurable: true,
    });

    // Keep `instanceof AiError` working however the class is downlevelled —
    // see the same line in `jobs/rate-limit.error.ts` for why it matters.
    Object.setPrototypeOf(this, AiError.prototype);
  }

  /** The public body, and nothing else — no `cause`, no stack. */
  toJSON(): AiErrorBody {
    return this.getResponse() as AiErrorBody;
  }

  /**
   * The queue's rate-limit signal for this error, or `null` when this error
   * is not a rate limit. A job handler does
   * `throw err.toRateLimitError() ?? err;` so a provider throttle defers the
   * job instead of charging an attempt.
   */
  toRateLimitError(): RateLimitError | null {
    if (this.code !== 'AI_RATE_LIMITED') {
      return null;
    }

    return new RateLimitError(this.message, this.retryAfterMs);
  }

  /**
   * How the job queue's `classifyRateLimit` reads this error (issue #509):
   * a rate limit iff the CODE says so — `AI_RATE_LIMITED`, the same rule as
   * `toRateLimitError()` — and never by `.status`. That status is the HTTP
   * response status this platform assigned to the code (503 for
   * `AI_STORAGE_UNAVAILABLE` and `AI_PROVIDER_UNAVAILABLE`), not a
   * provider's capacity signal, so without this a thrown `AiError` 503 was
   * deferred as a throttle instead of failing or charging an attempt.
   *
   * A symbol-keyed prototype method: non-enumerable, so it never reaches
   * `toJSON()`, the exception filter's body, or a structured log line.
   */
  [CLASSIFY_RATE_LIMIT](): RateLimitClassification {
    return this.code === 'AI_RATE_LIMITED'
      ? { rateLimited: true, retryAfterMs: this.retryAfterMs ?? null }
      : { rateLimited: false, retryAfterMs: null };
  }

  static isAiError(value: unknown): value is AiError {
    return value instanceof AiError;
  }

  /**
   * Returns `err` unchanged when it is already an `AiError`, otherwise a new
   * `AiError(code)` with `err` as its (non-serialised) cause. The message is
   * generic ON PURPOSE — an SDK's own message may echo request details.
   */
  static wrap(
    err: unknown,
    code: AiErrorCode = 'AI_PROVIDER_UNAVAILABLE',
    message = 'The AI provider request failed.',
  ): AiError {
    if (err instanceof AiError) {
      return err;
    }

    return new AiError(code, message, { cause: err });
  }
}
