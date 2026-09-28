/**
 * Normalising every way an AI call can fail into one shape — issue #434,
 * epic #419.
 *
 * An AI failure reaches the browser by one of three roads, and they carry the
 * AI code in three different places:
 *
 * 1. A gated or failed JSON call (`POST /ai/responses`, `POST /ai/runs`, a
 *    pre-stream gate failure on `POST /ai/responses/stream`) throws an
 *    `ApiError`. Its top-level `code` is the GENERIC HTTP code the global
 *    exception filter assigns (`FORBIDDEN`, `BAD_REQUEST`, …); the AI code is
 *    in `details.reason`, with `details.retryAfterMs` beside it for a rate
 *    limit (docs/specs/ai-platform.md §2.23). Switching on `code` alone never
 *    sees `AI_KEY_REQUIRED`.
 * 2. A failure AFTER a stream started arrives as an `error` SSE frame whose
 *    payload carries `code` directly.
 * 3. A background run that settled `failed` carries `errorCode` on the run.
 *
 * Everything that renders an AI failure (`components/ai/AiErrorAlert.tsx`)
 * takes the {@link AiErrorInfo} this module produces, so the three roads end
 * at one mapping.
 */
import { ApiError } from './api';

export interface AiErrorInfo {
  /** The AI code (`AI_KEY_REQUIRED`, …), or `null` when the failure had none. */
  code: string | null;
  /** The server's (or the browser's) own message — shown under the mapped copy. */
  message: string;
  /** HTTP status, when the failure was an HTTP response. */
  status?: number;
  /** Back-off hint on `AI_RATE_LIMITED`, in milliseconds. */
  retryAfterMs?: number;
  /**
   * On an `AI_RATE_LIMITED` refused by one of this deployment's own limits
   * (#450): which one (`perUser.requestsPerMinute`, …), its value, and its
   * window. Absent when the PROVIDER throttled the call instead.
   */
  limit?: string;
  max?: number;
  window?: 'minute' | 'day';
}

type AiErrorDetails = Pick<AiErrorInfo, 'retryAfterMs' | 'limit' | 'max' | 'window'> & {
  reason?: string;
};

function readDetails(details: unknown): AiErrorDetails {
  if (!details || typeof details !== 'object') return {};
  const record = details as Record<string, unknown>;
  const out: AiErrorDetails = {};
  if (typeof record.reason === 'string') out.reason = record.reason;
  if (typeof record.retryAfterMs === 'number') out.retryAfterMs = record.retryAfterMs;
  if (typeof record.limit === 'string') out.limit = record.limit;
  if (typeof record.max === 'number') out.max = record.max;
  if (record.window === 'minute' || record.window === 'day') out.window = record.window;
  return out;
}

/**
 * The storage API's own "no usable object storage" reasons
 * (`storage-not-configured.error.ts`). An AI media call that uploads its
 * input first (#445) meets them before any AI route does; they mean exactly
 * what `AI_STORAGE_UNAVAILABLE` means, so they render as it.
 */
const STORAGE_UNAVAILABLE_REASONS = new Set(['storage_not_configured', 'storage_bucket_unknown']);

/** Any thrown value from an AI call → {@link AiErrorInfo}. */
export function toAiErrorInfo(err: unknown, fallback = 'Something went wrong'): AiErrorInfo {
  if (err instanceof ApiError) {
    const { reason: rawReason, ...rest } = readDetails(err.details);
    const reason =
      rawReason && STORAGE_UNAVAILABLE_REASONS.has(rawReason) ? 'AI_STORAGE_UNAVAILABLE' : rawReason;
    const code = reason ?? (err.code?.startsWith('AI_') ? err.code : null);
    return {
      code,
      message: err.message || fallback,
      status: err.status,
      ...rest,
    };
  }
  if (err instanceof Error) {
    return { code: null, message: err.message || fallback };
  }
  return { code: null, message: fallback };
}
