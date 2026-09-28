// =============================================================================
// The terminal state machine (issue #261, epic #254)
// =============================================================================
//
// THE SINGLE CHOKEPOINT. Once a job stops running, EXACTLY ONE component
// decides what happens to the row, and this is it. Both executors funnel
// through the same two methods: the in-process worker (#262) after its
// handler returns or throws, and the node control plane (#268) when a remote
// node posts its result back.
//
// REJECTED: letting each executor write its own terminal state. It is the
// obvious shape — the worker knows it just failed, so it writes `failed` —
// and it is the drift this file exists to prevent. Two call sites means two
// answers to every one of these questions: does a 429 charge an attempt?
// does a give-up clear the lease? does the settled event fire on a retry?
// what is the backoff? Each answer would start identical and diverge on the
// first fix applied to one side, and the divergence would be invisible —
// nothing fails loudly when the node path forgets to un-charge an attempt; a
// long backfill just quietly starts failing permanently on rate limits while
// the same work run in-process succeeds. One chokepoint makes "the two
// executors agree" a property of the code rather than of two people's
// diligence.
//
// -----------------------------------------------------------------------------
// A NODE CANNOT THROW ACROSS HTTP, SO IT SENDS FLAGS — AND FLAGS ARE EQUAL
// -----------------------------------------------------------------------------
//
// A handler running in this process signals "the provider throttled me" by
// throwing `RateLimitError` (or by throwing an SDK error `classifyRateLimit`
// recognises). A remote node cannot: an exception does not survive a JSON
// response body. So it reports the same CONCLUSION as data —
// `{ rateLimited: true, retryAfterMs }` — and `completeFailed` gives those
// flags the IDENTICAL treatment, down to tripping this server's throttle gate
// so a node-reported 429 backs off sibling jobs running here too.
//
// The classification ORDER is fixed and deliberate:
//
//   1. A thrown `RateLimitError` — the most specific and least ambiguous
//      signal there is: a handler that looked at the response and said so.
//   2. `classifyRateLimit(error)` — the SDK error shapes nobody wrapped, and
//      this application's own typed errors that classify themselves by CODE
//      (`CLASSIFY_RATE_LIMIT`, issue #509 — an `AiError` 503 is a response
//      status, not a throttle). Ahead of the caller's flags because it reads
//      the actual error, while a flag is a claim about it.
//   3. The caller's `opts` flags — the node path, and any caller that knows
//      something the error object does not carry.
//   4. Otherwise: an ordinary failure.
//
// -----------------------------------------------------------------------------
// TWO BUDGETS, DELIBERATELY SEPARATE
// -----------------------------------------------------------------------------
//
// `attempts` (budget `JOBS_MAX_ATTEMPTS`, default 3) bounds BUGS: a job that
// keeps throwing should burn through it quickly and land in `failed` where a
// human sees it.
//
// `rateLimitHits` (budget `JOBS_RATELIMIT_MAX_HITS`, default 10) bounds
// WAITING: a provider throttling us is not the job failing, and the right
// response is minutes of backoff, not a permanent failure.
//
// REJECTED: one combined counter. A long backfill against a rate-limited
// provider would exhaust it during the first minute of throttling and fail
// permanently for a transient reason that was never its fault — the exact
// outcome the two-counter split exists to prevent. Two failure modes with
// different causes, different timescales and different correct responses need
// two budgets; the `Job` model's own block comment in `schema.prisma` and
// docs/specs/job-queue.md, "Attempts are charged at claim", record the same
// decision from their side.
//
// -----------------------------------------------------------------------------
// EVERY WRITE IS CONDITIONAL ON THE CLAIM (#477)
// -----------------------------------------------------------------------------
//
// Terminal, retry and rate-limit-deferral writes alike go through
// `safeTerminalUpdate`, which matches `heldClaimWhere(job)` — this id, still
// `running`, same `claim_token`, same `claimed_by_node_id` — rather than the
// id alone. Until #477 it matched the id alone, and an executor that stalled
// past its lease could come back from `process()` after the reaper had
// requeued its row and another executor had claimed it, and then: overwrite
// the new run's row with its stale conclusion, emit `job.settled` a second
// time for a job the reaper already settled (#468), or push a live claim back
// to `pending` under somebody else's feet.
//
// ZERO ROWS MATCHED IS `claim-lost`, A NORMAL OUTCOME. It means "this row is
// no longer yours to describe": nothing is written, nothing is emitted, nothing
// throws — the executor's conclusion is simply stale, and whoever holds the row
// now (or the reaper that took it) owns what happens next. The worker logs it
// and frees its slot; the node plane turns it into the same 409 a stale read
// would have produced.
//
// WHY NO LEASE CLAUSE (unlike renewal's `heldLeaseWhere`): the guard is
// IDENTITY, not LIVENESS. Every re-claim mints a new token and the reaper always
// moves `status` off `running`, so a `running` row with our token is still ours
// even if its lease has lapsed — and letting that settle land beats forcing the
// reaper to requeue work that already finished. See `heldClaimWhere`.
//
// NULL TOKENS: `claimToken: null` matches `claim_token IS NULL` (the same
// semantics `heldLeaseWhere` gives it) — a row claimed by pre-#361 code. And
// during a rolling deploy a replica still on pre-#477 code settles by id alone,
// exactly as renewal's own rolling-deploy caveat describes; the hole closes
// when the last old replica is gone.
// =============================================================================

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { computeBackoffMs, JOB_RANDOM } from './backoff.util';
import { JobClock, JOB_CLOCK, systemJobClock } from './job-clock';
import { emitJobSettled } from './job-settled.emit';
import { resolveMaxAttempts } from './job-execution-profile';
import { JobHandlerRegistry } from './job-handler.registry';
import { heldClaimWhere } from './job-lease.service';
import { ProviderThrottleService } from './provider-throttle.service';
import { classifyRateLimit, RateLimitError } from './rate-limit.error';

/**
 * What a caller may say about a failure that the thrown value does not carry
 * on its own. Used by the node control plane, which has an HTTP body rather
 * than an exception.
 */
export interface CompleteFailedOptions {
  /** "This was a provider rate limit" — treated exactly as a thrown `RateLimitError`. */
  rateLimited?: boolean;

  /** A provider-requested delay, in milliseconds. A FLOOR on the backoff, not an override. */
  retryAfterMs?: number;

  /**
   * "This job can never succeed, so do not spend attempts discovering that."
   *
   * SHORT-CIRCUITS EVERYTHING BELOW — ahead of the rate-limit classification,
   * not after it — because it is a statement about the job being UNRUNNABLE,
   * and neither a retry nor a deferral can change an unrunnable job into a
   * runnable one. A 429 is a "not now"; this is a "not ever".
   *
   * The caller that has this knowledge is the executor, not this service: the
   * in-process worker (#262) sets it when a claimed row names a type no
   * handler in this process registers, and the node control plane (#268) will
   * set it for a node reporting an input it can never accept. Retrying either
   * one re-enters the same process with the same registry, or ships the same
   * input to the same fleet, and reaches the same conclusion two minutes
   * later having burnt the budget to learn nothing.
   *
   * It is a FLAG INTO THE CHOKEPOINT rather than a licence for the caller to
   * write its own terminal row — the whole argument in this file's header
   * applies unchanged: the two executors must reach the same conclusion by
   * running the same code, including this one.
   */
  permanent?: boolean;
}

/**
 * What the terminal path actually did. Returned so a worker can log it and a
 * test can assert the branch without reverse-engineering it from the written
 * row.
 *
 * `write-failed` is the `safeTerminalUpdate` give-up: the row was NOT
 * written, and it is still `running` for the lease reaper (#263) to pick up.
 *
 * `claim-lost` (#477) means the row was NOT written because it is no longer
 * held by the claim that is settling it — reaped, re-claimed, or already
 * settled. Nothing was emitted. Not an error: the caller's conclusion is
 * stale and belongs to nobody. The node plane maps it to a 409.
 */
export type JobSettleOutcome =
  | 'succeeded'
  | 'failed'
  | 'retry-scheduled'
  | 'rate-limit-deferred'
  | 'write-failed'
  | 'claim-lost';

/**
 * What `safeTerminalUpdate` did — the three things a guarded write can end as.
 *
 * `written` carries the POST-UPDATE row (the settled event must describe what
 * is actually stored, not what we meant to store). `claim-lost` carries the
 * row as it stands now when it could be re-read, purely for the log line.
 */
type TerminalWrite =
  | { kind: 'written'; row: Job }
  | { kind: 'claim-lost'; current: Job | null }
  | { kind: 'write-failed' };

/** The data shape a terminal write carries: plain column values only. */
type TerminalWriteData = Prisma.JobUncheckedUpdateManyInput;

/**
 * Does `row` already hold every value `data` would write?
 *
 * Used ONLY on the ambiguous path of `safeTerminalUpdate`: the first attempt
 * threw (so it may or may not have committed) and the guarded retry matched
 * nothing. If the row now carries exactly what we tried to write, the first
 * attempt committed and the write is ours; anything else means somebody else
 * moved the row.
 *
 * Why a coincidental match by another writer is not a practical concern: every
 * terminal payload carries a timestamp from this call's clock
 * (`finishedAt`, or `scheduledFor` with jitter), which no other writer
 * reproduces to the millisecond.
 *
 * ⚠ THROWS (via `assertPlainTerminalData`) on any value that is not a plain
 * scalar, `Date` or `null`. The comparison is only meaningful for absolute
 * values; a Prisma operator such as `{ increment: 1 }` has no "equals the row"
 * reading at all, and a comparison that silently answered `false` for it would
 * turn every ambiguous commit into a false `claim-lost`. The un-charge comment
 * in `deferForRateLimit` explains why no payload here uses operators; this
 * makes a future one fail loudly.
 */
export function rowMatchesWrite(row: Job, data: TerminalWriteData): boolean {
  assertPlainTerminalData(data);

  return Object.entries(data).every(([key, expected]) => {
    // Prisma ignores an `undefined` field, so it wrote nothing to compare.
    if (expected === undefined) return true;

    const actual = (row as Record<string, unknown>)[key];

    if (expected instanceof Date) {
      return actual instanceof Date && actual.getTime() === expected.getTime();
    }

    return actual === expected;
  });
}

/**
 * The runtime half of `rowMatchesWrite`'s contract: every field a terminal
 * write carries is a plain scalar, a `Date`, `null` or `undefined` — never a
 * Prisma operator object. Also run on EVERY write, not only on the rare
 * ambiguous path, so a payload that breaks the rule fails in the first unit
 * test that exercises it rather than in production on a recycled connection.
 */
function assertPlainTerminalData(data: TerminalWriteData): void {
  for (const [key, value] of Object.entries(data)) {
    if (
      value === null ||
      value === undefined ||
      value instanceof Date ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      continue;
    }

    throw new Error(
      `Terminal write field "${key}" is not a plain scalar, Date or null. Terminal ` +
        `writes must be absolute values: they may be applied twice, and an ambiguous ` +
        `commit is verified by comparing the row against them.`
    );
  }
}

/**
 * How long `safeTerminalUpdate` waits before its single retry.
 *
 * Short on purpose. It is covering a BLIP — a connection recycled under us, a
 * failover that has already completed, a momentary pool exhaustion — not an
 * outage. A long wait here would hold the worker slot for the exact duration
 * of a problem this method has already decided it cannot solve.
 */
const TERMINAL_WRITE_RETRY_DELAY_MS = 250;

/**
 * Cap on what goes into `Job.lastError`.
 *
 * The column is unbounded TEXT and some SDKs throw errors whose message
 * embeds an entire response body. The admin job list renders this string, and
 * a megabyte of provider XML in a list cell helps nobody; the first two
 * thousand characters have always contained the actionable part.
 */
const MAX_LAST_ERROR_LENGTH = 2000;

/** Whatever was thrown, rendered as something a human can read in a job list. */
function toErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message || error.name
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? String(error);
            } catch {
              // A circular or getter-throwing object. `String()` still works.
              return String(error);
            }
          })();

  const message = raw.length > 0 ? raw : 'Unknown error';

  return message.length > MAX_LAST_ERROR_LENGTH
    ? `${message.slice(0, MAX_LAST_ERROR_LENGTH)}…`
    : message;
}

@Injectable()
export class JobTerminalService {
  private readonly logger = new Logger(JobTerminalService.name);

  private readonly clock: JobClock;

  private readonly rand: () => number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly throttle: ProviderThrottleService,
    private readonly events: EventEmitter2,
    // Injected for ONE question: what is this job type's attempt budget
    // (#346). The registry is the only place a `JobExecutionProfile` can come
    // from, and `resolveMaxAttempts` is the only reader of it — see
    // `retryOrFail`, and `JobStuckService`, which asks the same question about
    // a job whose executor never reported back.
    private readonly registry: JobHandlerRegistry,
    // Both OPTIONAL and unprovided in `JobsModule`: production always gets
    // the real clock and `Math.random`. See `job-clock.ts` and
    // `backoff.util.ts`.
    @Optional() @Inject(JOB_CLOCK) clock?: JobClock,
    @Optional() @Inject(JOB_RANDOM) rand?: () => number
  ) {
    this.clock = clock ?? systemJobClock;
    this.rand = rand ?? Math.random;
  }

  /**
   * Records a job that completed its work.
   *
   * Order matters: the throttle gate is told about the success FIRST, because
   * a success is direct evidence the provider's limit has lifted and sibling
   * slots may be sitting in `acquire()` waiting on a cooldown that is now
   * stale. Telling them before the (slower) database write shortens their
   * wait by however long the write takes.
   *
   * ⚠ `executor` IS DELIBERATELY NOT CLEARED. `succeeded` is terminal — the
   * row will never be claimed again — so there is no stale-ownership problem
   * to solve by nulling it, and WHICH SIDE RAN THE JOB is exactly the kind of
   * thing you want to still know later ("are node-executed jobs slower?",
   * "did this succeed before or after we moved this type to nodes?"). The
   * claim and the lease ARE cleared, because those two are live ownership
   * assertions and a terminal row must not appear to be held by anybody.
   *
   * ⚠ `claimToken` IS NOT COVERED BY THAT EXCEPTION and is cleared with the
   * rest (#361). `executor` survives because it is AUDIT — it says something
   * a human can read months later. A random uuid records nothing about what
   * ran, so keeping it would buy no history at all while leaving a terminal
   * row carrying a live ownership assertion. Its invariant is "non-null
   * exactly while the row is claimed"; a settled row is not claimed.
   */
  async completeSucceeded(job: Job): Promise<JobSettleOutcome> {
    this.throttle.recordSuccess(job.type);

    const result = await this.safeTerminalUpdate(job, {
      status: 'succeeded',
      finishedAt: new Date(this.clock.now()),
      scheduledFor: null,
      // Release the claim and the lease — see the note above about
      // `executor` NOT being in this list.
      claimedByNodeId: null,
      claimToken: null,
      leaseExpiresAt: null,
      // `lastError` is deliberately left alone: on a job that succeeded on
      // its third attempt, the message from attempt two is the only surviving
      // explanation of why it took three.
    });

    if (result.kind !== 'written') {
      return this.unwritten(job, result, 'success');
    }

    this.emitSettled(result.row);

    return 'succeeded';
  }

  /**
   * Records a job that stopped without completing, and decides what happens
   * to the row: deferred, retried, or permanently failed.
   *
   * See the file header for the classification order and for why a node's
   * `opts` flags are treated identically to a thrown `RateLimitError`.
   */
  async completeFailed(
    job: Job,
    error: unknown,
    opts?: CompleteFailedOptions
  ): Promise<JobSettleOutcome> {
    const now = new Date(this.clock.now());
    const message = toErrorMessage(error);

    if (opts?.permanent) {
      // BEFORE the classification below, deliberately. A caller that knows
      // the job is unrunnable knows something no amount of reading the error
      // object can discover, and an unrunnable job that happens to have
      // thrown a 429-shaped error must not be deferred for fifteen minutes
      // before failing anyway. See `CompleteFailedOptions.permanent`.
      return this.failPermanently(
        job,
        message,
        now,
        `Job ${job.id} (${job.type}) failed permanently and will not be retried: ${message}`
      );
    }

    // ---- Classification, in the fixed order documented in the header -----
    let rateLimited = false;
    let retryAfterMs: number | null = null;

    if (error instanceof RateLimitError) {
      // 1. The handler said so explicitly.
      rateLimited = true;
      retryAfterMs = error.retryAfterMs ?? null;
    } else {
      const classified = classifyRateLimit(error, now.getTime());

      if (classified.rateLimited) {
        // 2. The error object says so: its own `CLASSIFY_RATE_LIMIT` answer
        //    when it has one (an `AiError` — by code, never by status; #509),
        //    otherwise a 429/503/529 or an AWS throttle name.
        rateLimited = true;
        retryAfterMs = classified.retryAfterMs;
      } else if (opts?.rateLimited) {
        // 3. The caller says so — the node path, which has flags and no
        //    exception to inspect.
        rateLimited = true;
      }
    }

    // WHETHER it is a rate limit follows the order above; HOW LONG to wait is
    // taken from the first source that actually named a delay. A node
    // forwarding the provider's `Retry-After` should be believed even when
    // the error shape it also forwarded did not carry one.
    retryAfterMs = retryAfterMs ?? opts?.retryAfterMs ?? null;

    return rateLimited
      ? this.deferForRateLimit(job, message, retryAfterMs, now)
      : this.retryOrFail(job, message, now);
  }

  /**
   * The RATE-LIMIT branch: back off for minutes, do not charge an attempt,
   * and give up only against the separate `rateLimitHits` budget.
   */
  private async deferForRateLimit(
    job: Job,
    message: string,
    retryAfterMs: number | null,
    now: Date
  ): Promise<JobSettleOutcome> {
    const hits = job.rateLimitHits + 1;

    const delayMs = computeBackoffMs({
      // The RATE-LIMIT counter drives this backoff, not `attempts` — the
      // whole point is that these two escalate independently.
      attempt: hits,
      baseMs: this.configNumber('jobs.rateLimitBaseMs', 30_000),
      maxMs: this.configNumber('jobs.rateLimitMaxMs', 900_000),
      retryAfterMs,
      rand: this.rand,
    });

    // TRIP THE GATE BEFORE THE WRITE. Sibling slots are making calls to this
    // provider right now; every millisecond between learning about the 429
    // and telling them is a request that is going to be rejected. It is also
    // why the gate is tripped on the node-reported path identically: the
    // provider does not care which machine the request came from, so a node's
    // 429 is evidence about this server's calls too.
    this.throttle.trip(job.type, delayMs);

    if (hits > this.configNumber('jobs.rateLimitMaxHits', 10)) {
      // GIVE UP. Even a provider limit cannot hold a job forever — at ten
      // deferrals with a 15-minute ceiling this job has been waiting well
      // over an hour, and something is wrong that waiting will not fix.
      //
      // `attempts` is left exactly as it is here (rather than un-charged as
      // on the deferral path below): the row is terminal, so there is no
      // remaining budget to protect, and the surviving value — "one attempt
      // was started, and it was throttled eleven times" — is the truthful
      // description of what happened.
      const result = await this.safeTerminalUpdate(job, {
        status: 'failed',
        finishedAt: now,
        lastError: message,
        rateLimitHits: hits,
        rateLimitedAt: now,
        scheduledFor: null,
        claimedByNodeId: null,
        claimToken: null,
        leaseExpiresAt: null,
      });

      if (result.kind !== 'written') {
        return this.unwritten(job, result, 'rate-limit give-up');
      }

      this.logger.warn(
        `Job ${job.id} (${job.type}) permanently failed after ${hits} ` +
          `rate-limit deferrals: ${message}`
      );

      this.emitSettled(result.row);

      return 'failed';
    }

    const result = await this.safeTerminalUpdate(job, {
      // Back to `pending`, invisible to the claim query until `scheduledFor`.
      status: 'pending',
      scheduledFor: new Date(now.getTime() + delayMs),
      rateLimitHits: hits,
      rateLimitedAt: now,

      // ⚠ UN-CHARGE THE CLAIM-TIME INCREMENT — the single most important line
      // in this file.
      //
      // `attempts` is charged when a job is CLAIMED, not when it fails (see
      // docs/specs/job-queue.md, "Attempts are charged at claim": it means
      // "attempts started", which is the only thing observable from outside a
      // process that may be OOM-killed mid-run). That is right for failures and
      // wrong for deferrals: a job that was told "not now" never attempted the
      // work, and letting a provider outage spend a budget meant for a buggy
      // handler is how a long backfill fails permanently for a reason that was
      // never its fault. So the deferral explicitly gives the attempt back, and
      // the NET effect of claim-then-defer is zero.
      //
      // WRITTEN AS AN ABSOLUTE VALUE, NOT `{ decrement: 1 }`. This write can
      // be attempted twice — `safeTerminalUpdate` retries once, and its first
      // call can have committed before the connection dropped on the way
      // back. An absolute value is idempotent: applied twice it still says
      // `job.attempts - 1`, where a relative `decrement` applied twice would
      // subtract two, silently GRANTING the job an extra attempt it never
      // earned (and, repeated over a long throttled backfill, drive `attempts`
      // negative and make the budget unreachable).
      //
      // Since #477 that second application is ALSO guarded by
      // `heldClaimWhere`: if the first one committed, the row is already
      // `pending` with no token, so the retry matches nothing and
      // `safeTerminalUpdate` reads the row back and compares it against this
      // payload to decide whether the write was its own. The absolute value is
      // what makes that comparison possible at all — an operator has no
      // "equals the row" reading, and `assertPlainTerminalData` refuses one
      // outright. Clamped at 0 because a caller handing us a row with
      // `attempts: 0` (a hand-written test, a node replaying a stale body)
      // must not produce a negative count.
      attempts: Math.max(0, job.attempts - 1),

      lastError: message,
      // Release the claim: this job is going back in the queue and may be
      // picked up by a different worker, or a different machine entirely.
      claimedByNodeId: null,
      claimToken: null,
      leaseExpiresAt: null,
      finishedAt: null,
    });

    if (result.kind !== 'written') {
      return this.unwritten(job, result, 'rate-limit deferral');
    }

    this.logger.log(
      `Job ${job.id} (${job.type}) deferred ${delayMs}ms by a provider rate ` +
        `limit (hit ${hits}); attempts left at ${result.row.attempts}`
    );

    // NO EVENT. A deferred job is not settled — it has not finished, and it
    // is going to run. Emitting here is what would force every subscriber to
    // re-derive "is this actually over"; see `events/job-settled.event.ts`.

    return 'rate-limit-deferred';
  }

  /** The ORDINARY branch: retry against `attempts`, or fail permanently. */
  private async retryOrFail(job: Job, message: string, now: Date): Promise<JobSettleOutcome> {
    // PER TYPE, not the deployment-wide number (#346). A handler declaring
    // `maxAttempts: 1` is saying this work must never be retried
    // automatically, and this is the branch that has to honour it: with a
    // budget of 1 the comparison below is false on the first attempt, so the
    // job goes straight to `failPermanently` and no backoff is ever scheduled.
    // `JobStuckService` reads the same number through the same function for
    // the case where the executor died instead of reporting back.
    const maxAttempts = resolveMaxAttempts(this.config, this.registry.get(job.type));

    // `job.attempts` already INCLUDES the attempt that just failed (charged
    // at claim time), so `<` is the correct comparison: with a budget of 3,
    // attempts 1 and 2 retry and attempt 3 is the last one.
    if (job.attempts < maxAttempts) {
      const delayMs = computeBackoffMs({
        attempt: job.attempts,
        baseMs: this.configNumber('jobs.retryBaseMs', 2_000),
        maxMs: this.configNumber('jobs.retryMaxMs', 60_000),
        rand: this.rand,
      });

      const result = await this.safeTerminalUpdate(job, {
        status: 'pending',
        scheduledFor: new Date(now.getTime() + delayMs),
        lastError: message,
        claimedByNodeId: null,
        claimToken: null,
        leaseExpiresAt: null,
        finishedAt: null,
      });

      if (result.kind !== 'written') {
        return this.unwritten(job, result, 'retry');
      }

      this.logger.log(
        `Job ${job.id} (${job.type}) failed on attempt ` +
          `${job.attempts}/${maxAttempts}, retrying in ${delayMs}ms: ${message}`
      );

      // NO EVENT — an intermediate retry is not a settled job.
      return 'retry-scheduled';
    }

    return this.failPermanently(
      job,
      message,
      now,
      `Job ${job.id} (${job.type}) permanently failed after ` +
        `${job.attempts} attempt(s): ${message}`
    );
  }

  /**
   * Writes the terminal `failed` row and announces it.
   *
   * ONE implementation, reached from the two routes whose written row is
   * IDENTICAL: the attempt budget running out, and a caller declaring the job
   * unrunnable. `log` is the only thing that differs, because the row must
   * not — a `failed` job releases its claim and its lease and keeps its
   * `executor` whichever route it took, and a second copy of that object is a
   * second place to forget a field.
   *
   * The rate-limit give-up in `deferForRateLimit` deliberately does NOT come
   * through here: it writes `rateLimitHits` and `rateLimitedAt` as well, and
   * widening this method with two optional counters to absorb it would make
   * the shared thing less readable than the duplication it removed.
   */
  private async failPermanently(
    job: Job,
    message: string,
    now: Date,
    log: string
  ): Promise<JobSettleOutcome> {
    const result = await this.safeTerminalUpdate(job, {
      status: 'failed',
      finishedAt: now,
      lastError: message,
      scheduledFor: null,
      claimedByNodeId: null,
      claimToken: null,
      leaseExpiresAt: null,
      // `executor` kept, for the same reason as on success.
    });

    if (result.kind !== 'written') {
      return this.unwritten(job, result, 'permanent failure');
    }

    this.logger.warn(log);

    this.emitSettled(result.row);

    return 'failed';
  }

  /**
   * Writes the terminal row, retrying ONCE, and then LOGS AND SWALLOWS.
   *
   * ⚠ THE SWALLOW IS THE FEATURE. Every caller of this service is a worker
   * finishing a job and about to free its slot. If a database blip could
   * throw out of here, that exception would propagate into the worker's
   * finally-block-shaped cleanup and — depending on where it lands — either
   * crash the worker or leave the slot accounted for but never released. A
   * slot lost this way is lost for the life of the process, and losing all of
   * them silently reduces the queue's throughput to zero with nothing in the
   * logs but one stack trace from an hour ago.
   *
   * So the worst case here is deliberately BOUNDED AND RECOVERABLE: the slot
   * is freed, and the row is left `running` with an expired lease — which is
   * precisely the state the lease reaper (#263) exists to find and requeue.
   * The job is delayed by one lease interval; nothing is lost, and nothing
   * wedges.
   *
   * ONE retry, not zero and not many. Zero would fail the whole terminal
   * write on a single recycled connection, which is common enough to be
   * worth covering. Many, with waits between them, would hold the worker slot
   * open for the duration of an outage — the exact resource this method is
   * protecting.
   *
   * THE WRITE IS GUARDED BY `heldClaimWhere(job)` (#477) — see the file
   * header. A guarded write that matches nothing is `claim-lost`, and it is
   * FINAL: it is not retried, because "the row moved" is an answer, not a blip.
   *
   * ⚠ THE ONE RULE THE GUARD ADDS TO THE RETRY: the first attempt can COMMIT
   * AND THEN THROW (the connection drops on the way back). Its retry then
   * matches nothing — not because somebody else took the row, but because
   * our own first write already moved it off `running` and cleared the token.
   * Answering `claim-lost` there would drop the settled event for a settle
   * that genuinely happened. So:
   *
   *   (a) first attempt returns no row, without throwing ⇒ `claim-lost`, final.
   *   (b) first attempt throws, retry returns no row ⇒ re-read the row by id.
   *       If it already holds every value `data` writes (`rowMatchesWrite`),
   *       the first attempt committed and the write is OURS ⇒ `written`, with
   *       the re-read row (so a terminal branch still emits, exactly once).
   *       Otherwise ⇒ `claim-lost`. If the re-read itself throws we cannot
   *       tell which ⇒ `write-failed` (no emit, the conservative answer).
   *   (c) retry throws ⇒ `write-failed`.
   *
   * Returns a `TerminalWrite`; see its declaration.
   *
   * WHY `updateManyAndReturn`: it is one `UPDATE … WHERE … RETURNING *`, so the
   * ownership check and the write are one statement (the same reason
   * `heldLeaseWhere` lives in a `where` clause) and the row handed to the
   * settled event is the post-update row, with no second read to race.
   *
   * WHY `JobUncheckedUpdateManyInput` AND NOT A CHECKED INPUT. Every one of
   * this method's five call sites releases the node claim by writing
   * `claimedByNodeId: null` — a raw foreign-key scalar. Since #267 wired
   * `Job.claimedByNode` as a real relation, Prisma's *Checked* update input no
   * longer accepts that scalar; it accepts only the nested relation form
   * (`claimedByNode: { disconnect: true }`). The *Unchecked* variant is the
   * one Prisma provides precisely for callers that set foreign keys
   * themselves, which is what a terminal write is: it clears an ownership
   * column, it does not navigate a relation.
   */
  private async safeTerminalUpdate(job: Job, data: TerminalWriteData): Promise<TerminalWrite> {
    assertPlainTerminalData(data);

    const where = heldClaimWhere(job);

    try {
      const [row] = await this.prisma.job.updateManyAndReturn({ where, data });

      // (a) The statement ran and matched nothing: the row is not ours.
      return row
        ? { kind: 'written', row }
        : { kind: 'claim-lost', current: await this.peek(job.id) };
    } catch (firstError) {
      this.logger.warn(
        `Terminal write for job ${job.id} failed; retrying once in ` +
          `${TERMINAL_WRITE_RETRY_DELAY_MS}ms: ` +
          `${firstError instanceof Error ? firstError.message : String(firstError)}`
      );
    }

    await this.clock.sleep(TERMINAL_WRITE_RETRY_DELAY_MS);

    let retried: Job | undefined;

    try {
      [retried] = await this.prisma.job.updateManyAndReturn({ where, data });
    } catch (secondError) {
      // (c)
      this.logger.error(
        `Terminal write for job ${job.id} failed twice; leaving the row as ` +
          `it is for the lease reaper and freeing the worker slot: ` +
          `${secondError instanceof Error ? secondError.message : String(secondError)}`
      );

      return { kind: 'write-failed' };
    }

    if (retried) {
      return { kind: 'written', row: retried };
    }

    // (b) Ambiguous: did the throwing first attempt commit?
    let current: Job | null;

    try {
      current = await this.prisma.job.findUnique({ where: { id: job.id } });
    } catch (readError) {
      this.logger.error(
        `Terminal write for job ${job.id} may or may not have committed and the row ` +
          `could not be re-read to tell; treating it as unwritten: ` +
          `${readError instanceof Error ? readError.message : String(readError)}`
      );

      return { kind: 'write-failed' };
    }

    if (current && rowMatchesWrite(current, data)) {
      this.logger.warn(
        `Terminal write for job ${job.id} threw but had committed; the re-read row ` +
          `carries exactly the values written, so the write is this settle's own`
      );

      return { kind: 'written', row: current };
    }

    return { kind: 'claim-lost', current };
  }

  /**
   * Best-effort read of a row this settle has just LOST, for the log line
   * only. A failure to read it changes nothing — the outcome is already
   * decided — so it is swallowed into `null`.
   */
  private async peek(jobId: string): Promise<Job | null> {
    try {
      return await this.prisma.job.findUnique({ where: { id: jobId } });
    } catch {
      return null;
    }
  }

  /**
   * Maps a `TerminalWrite` that did NOT land to the outcome a caller returns,
   * logging `claim-lost` once, here, for all five call sites.
   *
   * `claim-lost` is a WARN, not an error: it means an executor came back with
   * a conclusion about a row that had already moved on (reaped, re-claimed,
   * settled). Nothing is emitted and nothing throws — see the file header.
   * `write-failed` was already logged by `safeTerminalUpdate`.
   */
  private unwritten(
    job: Job,
    result: Exclude<TerminalWrite, { kind: 'written' }>,
    branch: string
  ): JobSettleOutcome {
    if (result.kind === 'write-failed') {
      return 'write-failed';
    }

    const now = result.current
      ? `it is now "${result.current.status}", claimed by ` +
        `${result.current.claimedByNodeId ? `node ${result.current.claimedByNodeId}` : 'no node'}`
      : 'it could not be re-read (deleted, or the read failed)';

    this.logger.warn(
      `Job ${job.id} (${job.type}): discarded this executor's ${branch} write because the ` +
        `row is no longer held by its claim (reaped, re-claimed or already settled); ${now}`
    );

    return 'claim-lost';
  }

  /**
   * Announces a genuinely settled job. The listener-containment rule (a
   * listener is a bystander; it must not be able to affect the row or the
   * slot) lives in `emitJobSettled`, shared with the lease reaper (#468).
   */
  private emitSettled(job: Job): void {
    emitJobSettled(this.events, job, this.logger);
  }

  /**
   * A numeric setting with a defensive fallback.
   *
   * The fallback repeats `configuration.ts`'s default rather than trusting
   * it, because this service is also constructed directly in unit tests with
   * a stub `ConfigService`, and a missing key must degrade to the shipped
   * behaviour rather than to `NaN` — which would silently produce
   * `new Date(NaN)` and an unwritable `scheduled_for`.
   */
  private configNumber(key: string, fallback: number): number {
    const value = this.config.get<number>(key);

    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
}
