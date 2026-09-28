import {
  classifyRateLimit,
  type RateLimitClassification,
} from '../jobs/rate-limit.error';

// =============================================================================
// Email rate-limit classification (issue #456)
// =============================================================================
//
// `BaseEmailProvider.send` turns every thrown transport error into
// `{ success: false, error }`, and until #456 that was the whole story: a
// provider saying "slow down" and a provider saying "that mailbox does not
// exist" produced the same result. For a single notification that is fine —
// one failed delivery row either way. For a BROADCAST it is not: the fan-out
// kept sending into a provider that had already refused it, and every
// remaining recipient became a failed row that nothing would ever retry.
//
// This file is where a thrown transport error is asked the one extra question
// — "is this a throttle?" — so the result can carry `rateLimited: true` and
// the broadcast chunk can stop and defer (see `broadcast-chunk.handler.ts`).
//
// -----------------------------------------------------------------------------
// CONSERVATIVE BY DESIGN, AND WHY THE ASYMMETRY POINTS THAT WAY
// -----------------------------------------------------------------------------
//
// A FALSE POSITIVE is expensive here in a way it is not in the queue's own
// classifier: a broadcast chunk that reads a permanent failure (a rejected
// address, a revoked credential) as a throttle stops, defers, resumes, hits
// the same recipient again, and does that until the queue's separate
// `JOBS_RATELIMIT_MAX_HITS` budget runs out — stalling the whole broadcast
// behind one bad row. A FALSE NEGATIVE costs what #456 found: recipients
// written off during a throttle window. Both are bad; the first is worse,
// because it converts one recipient's problem into everybody's. So anything
// not POSITIVELY recognised is "not a rate limit".
//
// Specifically NOT recognised, on purpose:
//
//   - authentication failures (nodemailer `EAUTH`, SMTP 535, AWS
//     `UnrecognizedClientException` / 403) — a wrong password does not get
//     better by waiting;
//   - every SMTP 5xx — permanent by definition (RFC 5321 §4.2.1);
//   - SMTP 4xx WITHOUT throttle wording — greylisting (`450 4.2.0
//     Greylisted`) and a full mailbox (`452 4.2.2`) are about ONE recipient,
//     and treating them as a provider throttle would pause the entire
//     broadcast over one mailbox;
//   - the plain `Error`s the providers throw for missing configuration — they
//     carry no status, no code and no throttle name, so they fall straight
//     through every check below.
//
// -----------------------------------------------------------------------------
// WHAT IS RECOGNISED, PER TRANSPORT
// -----------------------------------------------------------------------------
//
// SES (AWS SDK v3, `@aws-sdk/client-sesv2`) — and any other HTTP-based
// provider a fork adds — goes through the queue's own `classifyRateLimit`,
// rather than a second list here that could drift from it, with ONE carve-out
// (SES's daily quota, which arrives under the same `Throttling` name — see
// `SES_DAILY_QUOTA_WORDING` for why it is not a deferral). That
// already reads `$metadata.httpStatusCode` 429 (the status SES v2 returns for
// `TooManyRequestsException`, its "Maximum sending rate exceeded" error),
// 503/529, the AWS throttle names (`Throttling`, `ThrottlingException`,
// `TooManyRequestsException`, …) on `name`/`code`/`__type`, and a
// `Retry-After` header in any of the containers SDKs use. One addition sits on
// top of it: the SES wording "Maximum sending rate exceeded" in the message,
// for the case where a wrapper has stripped the SDK error's `name` and
// metadata but kept its text. That phrase has no other meaning.
//
// SMTP (nodemailer) carries `responseCode` (a number parsed from the server's
// reply) and `response` (the reply line itself). A throttle is a 421, 450,
// 451, 452 or 454 WHOSE TEXT SAYS SO — see `SMTP_THROTTLE_WORDING`. The code alone
// is not enough, for the per-recipient reasons above.
// =============================================================================

/**
 * SMTP reply codes that CAN mean "you are sending too fast".
 *
 * All transient (4xx). 421 is "service not available, closing channel" —
 * Gmail's and Microsoft's usual rate-limit reply; 450/451/452 are the
 * per-message transient codes several relays reuse for per-sender limits
 * (`451 4.7.500 Server busy`, `452 4.3.1 Too many messages`); 454 is what
 * SES's own SMTP interface answers (`454 Throttling failure: Maximum sending
 * rate exceeded`) — relevant because the SMTP transport can be pointed at
 * `email-smtp.<region>.amazonaws.com`. Every one of them ALSO has
 * non-throttle uses (454 is also "temporary authentication failure"), which
 * is why a code in this set is only half the test.
 */
const SMTP_THROTTLE_CODES = new Set([421, 450, 451, 452, 454]);

/**
 * Reply wording that marks one of the codes above as a throttle.
 *
 * Phrases, not bare words: "limit" alone matches "mailbox size limit", and
 * "exceeded" alone matches "quota exceeded" — both per-recipient. Each entry
 * here is wording that, in a 4xx reply, only ever means "back off":
 *
 *   - `rate limit`, `rate exceeded`, `sending rate`, `unusual rate` — the
 *     direct statement (Gmail's `4.7.28 ... unusual rate`, SES SMTP's
 *     `Maximum sending rate exceeded`);
 *   - `too many messages|connections|requests|sessions|commands` — per-sender
 *     and per-connection caps, NOT `too many recipients`, which is a
 *     per-message envelope limit this app cannot hit with one `to`;
 *   - `throttl…`, `slow down`, `server busy`, `try again later` — the
 *     generic "not now" phrasings Microsoft 365 and Postfix policy servers
 *     emit.
 *
 * `try again later` is also greylisting's wording, which is why
 * {@link SMTP_NOT_THROTTLE_WORDING} is checked first.
 */
const SMTP_THROTTLE_WORDING =
  /rate[\s-]?limit|rate\s+exceeded|sending\s+rate|unusual\s+rate|too\s+many\s+(?:messages|mails|emails|connections|requests|sessions|commands)|throttl|slow\s+down|server\s+busy|try\s+again\s+later/i;

/**
 * Wording that overrides the list above: a per-RECIPIENT transient condition,
 * never a provider throttle, however it is phrased.
 */
const SMTP_NOT_THROTTLE_WORDING = /greylist|graylist|mailbox\s+(?:full|busy)|over\s+quota|quota\s+exceeded/i;

/**
 * SES's DAILY quota, which it reports through the same `Throttling` error
 * name (and SMTP `454 Throttling failure:` prefix) as its per-second rate.
 *
 * Checked BEFORE everything else and answered "not a rate limit", which is the
 * one place this file overrides the shared classifier. Deliberate rather than
 * collateral: a 24-hour quota outlasts the queue's whole rate-limit budget
 * (`JOBS_RATELIMIT_MAX_HITS` deferrals capped at `JOBS_RATELIMIT_MAX_MS` each —
 * a couple of hours), so deferring on it would only postpone the same failure
 * while holding the broadcast in `sending`, and hide the real cause behind a
 * deferral count. It fails as an ordinary delivery, with the provider's own
 * wording on the row, where an operator can see it and raise the quota.
 */
const SES_DAILY_QUOTA_WORDING = /daily\s+(?:message|sending)\s+quota/i;

/** SES's own throttle wording, for an error that lost its `name`/metadata. */
const SES_THROTTLE_WORDING = /maximum\s+sending\s+rate\s+exceeded/i;

const NOT_RATE_LIMITED: RateLimitClassification = {
  rateLimited: false,
  retryAfterMs: null,
};

/**
 * Decides whether an error thrown by an email transport is the provider
 * throttling us.
 *
 * TOTAL AND NEVER THROWS, for the same reason `classifyRateLimit` is: it runs
 * inside `BaseEmailProvider.send`'s catch block, and an exception here would
 * break the never-throw contract that whole class exists to hold. Every
 * property read is inside the `try`; anything unexpected is "not a rate
 * limit".
 */
export function classifyEmailRateLimit(
  err: unknown,
  now: number = Date.now(),
): RateLimitClassification {
  if (err === null || typeof err !== 'object') {
    return NOT_RATE_LIMITED;
  }

  try {
    const candidate = err as Record<string, unknown>;
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    const response = typeof candidate.response === 'string' ? candidate.response : '';

    // A daily quota is not a throttle, whatever name it arrives under. See
    // SES_DAILY_QUOTA_WORDING.
    if (SES_DAILY_QUOTA_WORDING.test(message) || SES_DAILY_QUOTA_WORDING.test(response)) {
      return NOT_RATE_LIMITED;
    }

    // The HTTP / AWS SDK shapes — the queue's classifier, unchanged. It is
    // itself total and never throws.
    const shared = classifyRateLimit(err, now);

    if (shared.rateLimited) {
      return shared;
    }

    if (SES_THROTTLE_WORDING.test(message)) {
      return { rateLimited: true, retryAfterMs: null };
    }

    const responseCode = candidate.responseCode;

    if (typeof responseCode !== 'number' || !SMTP_THROTTLE_CODES.has(responseCode)) {
      return NOT_RATE_LIMITED;
    }

    // nodemailer puts the server's reply line on `response` and usually
    // repeats it inside `message`; read both, because which one a given
    // nodemailer code path fills is not something to depend on.
    const text = `${response}\n${message}`;

    if (SMTP_NOT_THROTTLE_WORDING.test(text) || !SMTP_THROTTLE_WORDING.test(text)) {
      return NOT_RATE_LIMITED;
    }

    // SMTP has no Retry-After; `null` means "no opinion", and the queue uses
    // its own backoff.
    return { rateLimited: true, retryAfterMs: null };
  } catch {
    return NOT_RATE_LIMITED;
  }
}
