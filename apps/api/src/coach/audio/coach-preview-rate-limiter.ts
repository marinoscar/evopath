import { Injectable } from '@nestjs/common';

// =============================================================================
// Voice preview rate limit (E7.6, #246)
// =============================================================================
//
// A sliding window per user: at most `COACH_PREVIEW_LIMIT` previews in any
// `COACH_PREVIEW_WINDOW_MS`. The 11th call inside the window is refused with
// 429 `COACH_PREVIEW_RATE_LIMITED` BEFORE any provider call; `retryAfterMs`
// is when the oldest counted preview leaves the window.
//
// In-process memory, deliberately: the preview speaks only static registry
// lines, so the limit exists to keep it from being a free TTS loop, not to
// meter spend exactly (spend is metered by `ai.limits` and `ai_usage_events`
// like every other call). With several API replicas the effective limit is
// per replica; a restart forgets the window.
// =============================================================================

export const COACH_PREVIEW_LIMIT = 10;
export const COACH_PREVIEW_WINDOW_MS = 10 * 60_000;
/** Users tracked at once; the oldest entries are dropped beyond it. */
const MAX_TRACKED_USERS = 10_000;

export type CoachPreviewRateDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * A per-user sliding window: at most `limit` hits in any `windowMs`. Shared by
 * the voice preview and the on-demand message audio (#259), each with its own
 * instance and so its own bucket.
 */
export class CoachSlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Counts one hit for `userId` at `now` when allowed; refuses (and counts nothing) otherwise. */
  take(userId: string, now: number = Date.now()): CoachPreviewRateDecision {
    const windowStart = now - this.windowMs;
    const recent = (this.hits.get(userId) ?? []).filter((at) => at > windowStart);

    if (recent.length >= this.limit) {
      this.hits.set(userId, recent);
      return { allowed: false, retryAfterMs: Math.max(1, recent[0] + this.windowMs - now) };
    }

    recent.push(now);
    this.hits.delete(userId);
    this.hits.set(userId, recent);
    if (this.hits.size > MAX_TRACKED_USERS) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return { allowed: true };
  }

  /** Test seam. */
  reset(): void {
    this.hits.clear();
  }
}

@Injectable()
export class CoachPreviewRateLimiter extends CoachSlidingWindowLimiter {
  constructor() {
    super(COACH_PREVIEW_LIMIT, COACH_PREVIEW_WINDOW_MS);
  }
}
