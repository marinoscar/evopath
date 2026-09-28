import { classifyEmailRateLimit } from './email-rate-limit';

// =============================================================================
// classifyEmailRateLimit — tests (issue #456)
// =============================================================================
//
// Every positive case named in the file header's per-transport sections gets
// its own test, and every documented "specifically NOT recognised" case gets
// one too — the asymmetry (false positives are worse than false negatives) is
// the whole design, so both sides of it are pinned. The function is TOTAL and
// NEVER THROWS by contract; the last describe block is the proof of that,
// including a throwing getter.
// =============================================================================

describe('classifyEmailRateLimit', () => {
  const NOW = 1_700_000_000_000;

  // ==========================================================================
  // SES / HTTP-shaped throttles (via the shared classifyRateLimit + the one
  // SES-wording addition)
  // ==========================================================================

  describe('SES / HTTP-shaped positives', () => {
    it('recognises a 429 TooManyRequestsException', () => {
      const err = {
        name: 'TooManyRequestsException',
        $metadata: { httpStatusCode: 429 },
        message: 'Maximum sending rate exceeded.',
      };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: true,
        retryAfterMs: null,
      });
    });

    it('recognises a "Throttling" name even at HTTP 400', () => {
      const err = {
        name: 'Throttling',
        $metadata: { httpStatusCode: 400 },
        message: 'Rate exceeded',
      };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: true,
        retryAfterMs: null,
      });
    });

    it('recognises the SES wording alone, with no name or metadata surviving', () => {
      const err = { message: 'Maximum sending rate exceeded.' };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: true,
        retryAfterMs: null,
      });
    });

    it('extracts a Retry-After header into retryAfterMs', () => {
      const err = {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 429 },
        headers: { 'retry-after': '30' },
      };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: true,
        retryAfterMs: 30_000,
      });
    });

    it('recognises a bare 503 Service Unavailable as a throttle', () => {
      const err = { $metadata: { httpStatusCode: 503 } };

      expect(classifyEmailRateLimit(err, NOW).rateLimited).toBe(true);
    });
  });

  // ==========================================================================
  // SMTP positives
  // ==========================================================================

  describe('SMTP positives', () => {
    it.each([421, 450, 451, 452, 454])(
      'recognises SMTP %i with throttle wording',
      (responseCode) => {
        const err = {
          responseCode,
          response: `${responseCode} 4.7.0 rate limit exceeded, slow down`,
        };

        expect(classifyEmailRateLimit(err, NOW)).toEqual({
          rateLimited: true,
          retryAfterMs: null,
        });
      },
    );

    it('recognises SES\'s own SMTP throttle wording at 454', () => {
      const err = {
        responseCode: 454,
        response: '454 Throttling failure: Maximum sending rate exceeded.',
      };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: true,
        retryAfterMs: null,
      });
    });

    it('reads the wording from `message` when `response` does not carry it', () => {
      const err = {
        responseCode: 421,
        response: '421',
        message: '421 4.7.0 too many messages, try again later',
      };

      expect(classifyEmailRateLimit(err, NOW).rateLimited).toBe(true);
    });

    it('SMTP has no Retry-After: retryAfterMs is always null on a positive SMTP match', () => {
      const err = {
        responseCode: 421,
        response: '421 4.7.0 unusual rate detected',
      };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: true,
        retryAfterMs: null,
      });
    });
  });

  // ==========================================================================
  // Negatives: the daily quota carve-out (checked before everything else)
  // ==========================================================================

  describe('the SES daily quota is never a rate limit', () => {
    it('is not a rate limit via the SES/HTTP shape, even under the Throttling name', () => {
      const err = {
        name: 'Throttling',
        $metadata: { httpStatusCode: 400 },
        message: 'Daily message quota exceeded.',
      };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('is not a rate limit via SMTP 454, even with a throttle-coded reply', () => {
      const err = {
        responseCode: 454,
        response: '454 Throttling failure: Daily message quota exceeded.',
      };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('matches "daily sending quota" wording as well as "daily message quota"', () => {
      const err = { message: 'Daily sending quota exceeded for this account.' };

      expect(classifyEmailRateLimit(err, NOW).rateLimited).toBe(false);
    });
  });

  // ==========================================================================
  // Negatives: per-recipient SMTP conditions
  // ==========================================================================

  describe('per-recipient SMTP conditions are never a rate limit', () => {
    it('greylisting (450) is not a rate limit', () => {
      const err = { responseCode: 450, response: '450 4.2.0 Greylisted, try again later' };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('a full mailbox (452) is not a rate limit', () => {
      const err = { responseCode: 452, response: '452 4.2.2 Mailbox full' };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('a bare "421 Service not available" with no throttle wording is not a rate limit', () => {
      const err = { responseCode: 421, response: '421 Service not available, closing channel' };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('an over-quota mailbox is not a rate limit even if it also says "exceeded"', () => {
      const err = { responseCode: 452, response: '452 4.2.2 over quota, exceeded' };

      expect(classifyEmailRateLimit(err, NOW).rateLimited).toBe(false);
    });
  });

  // ==========================================================================
  // Negatives: permanent failures and configuration errors
  // ==========================================================================

  describe('permanent failures and configuration errors are never a rate limit', () => {
    it('a 5xx SMTP code that happens to mention "rate limit" is still not recognised (5xx is not in the code set)', () => {
      const err = { responseCode: 550, response: '550 5.7.1 rate limit policy violation' };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('an SMTP auth failure (535 / EAUTH) is not a rate limit', () => {
      const err = { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 authentication failed' };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('a connection-level ETIMEDOUT is not a rate limit', () => {
      const err = { code: 'ETIMEDOUT', message: 'Connection timed out' };

      expect(classifyEmailRateLimit(err, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('a plain Error with no status, code or throttle wording is not a rate limit', () => {
      expect(classifyEmailRateLimit(new Error('No SMTP host is configured.'), NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });
  });

  // ==========================================================================
  // Total and never throws
  // ==========================================================================

  describe('total and never throws', () => {
    it('returns not-rate-limited for null', () => {
      expect(classifyEmailRateLimit(null, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('returns not-rate-limited for a string', () => {
      expect(classifyEmailRateLimit('rate limit exceeded', NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('returns not-rate-limited for a number', () => {
      expect(classifyEmailRateLimit(429, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('never throws when a property access explodes (a throwing getter)', () => {
      const evil = {
        get message() {
          throw new Error('boom from a getter');
        },
        responseCode: 421,
      };

      expect(() => classifyEmailRateLimit(evil, NOW)).not.toThrow();
      expect(classifyEmailRateLimit(evil, NOW)).toEqual({
        rateLimited: false,
        retryAfterMs: null,
      });
    });

    it('defaults `now` to Date.now() when omitted', () => {
      // Only exercised for the signature contract; the Retry-After parsing
      // itself is `parseRetryAfterMs`'s own responsibility and is not
      // re-tested here.
      expect(() => classifyEmailRateLimit({ message: 'ok' })).not.toThrow();
    });
  });
});
