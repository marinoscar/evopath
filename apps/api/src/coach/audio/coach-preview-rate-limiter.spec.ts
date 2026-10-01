import { COACH_PREVIEW_LIMIT, COACH_PREVIEW_WINDOW_MS, CoachPreviewRateLimiter } from './coach-preview-rate-limiter';

// =============================================================================
// Voice preview rate limit (E7.6, #246): sliding window, per user.
// =============================================================================

describe('CoachPreviewRateLimiter', () => {
  const T0 = 1_000_000;

  it(`allows ${COACH_PREVIEW_LIMIT} previews in the window and refuses the next with the time until a slot frees`, () => {
    const limiter = new CoachPreviewRateLimiter();
    for (let i = 0; i < COACH_PREVIEW_LIMIT; i += 1) expect(limiter.take('u1', T0 + i * 1000)).toEqual({ allowed: true });

    const refused = limiter.take('u1', T0 + 60_000);
    expect(refused).toEqual({ allowed: false, retryAfterMs: COACH_PREVIEW_WINDOW_MS - 60_000 });
  });

  it('a refused call is not counted, and the window slides', () => {
    const limiter = new CoachPreviewRateLimiter();
    for (let i = 0; i < COACH_PREVIEW_LIMIT; i += 1) limiter.take('u1', T0);
    expect(limiter.take('u1', T0 + 1).allowed).toBe(false);
    expect(limiter.take('u1', T0 + 2).allowed).toBe(false);
    expect(limiter.take('u1', T0 + COACH_PREVIEW_WINDOW_MS + 1)).toEqual({ allowed: true });
  });

  it('counts each user separately', () => {
    const limiter = new CoachPreviewRateLimiter();
    for (let i = 0; i < COACH_PREVIEW_LIMIT; i += 1) limiter.take('u1', T0);
    expect(limiter.take('u2', T0)).toEqual({ allowed: true });
  });
});
