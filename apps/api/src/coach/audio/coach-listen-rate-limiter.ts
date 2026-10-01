import { Injectable } from '@nestjs/common';

import { CoachSlidingWindowLimiter } from './coach-preview-rate-limiter';

// =============================================================================
// On-demand message audio rate limit (#259)
// =============================================================================
//
// `POST /api/coach/messages/:id/audio` speaks a stored coach message on
// request. Only a request that would start a NEW speech run counts (ready
// audio and a run already pending are answered for free). At most
// `COACH_LISTEN_LIMIT` new runs per user in any `COACH_LISTEN_WINDOW_MS`; the
// next is 429 `COACH_AUDIO_RATE_LIMITED` before any provider call.
//
// Its own bucket, separate from the voice preview's. In-process memory like
// the preview limiter (see its header): per API replica, forgotten on restart;
// spend itself is metered by `ai.limits` and `ai_usage_events`.
// =============================================================================

export const COACH_LISTEN_LIMIT = 20;
export const COACH_LISTEN_WINDOW_MS = 10 * 60_000;

@Injectable()
export class CoachListenRateLimiter extends CoachSlidingWindowLimiter {
  constructor() {
    super(COACH_LISTEN_LIMIT, COACH_LISTEN_WINDOW_MS);
  }
}
