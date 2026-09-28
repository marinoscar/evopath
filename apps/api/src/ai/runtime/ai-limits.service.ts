// =============================================================================
// AiLimitsService — per-user and per-model AI rate limits (issue #450, epic #421)
// =============================================================================
//
// The facade's gate right AFTER key resolution (`AiService.context`), so
// whose key pays (`keySource`) is known: `ai.limits.orgKey.*` counts only
// calls the ORG key pays for, and a user on their own key is never counted
// against it. Every limit is optional and ABSENT MEANS UNLIMITED; with no
// applicable limit configured this gate returns without a single query.
//
// WHAT COUNTS. One `ai_usage_events` row is one request — every inference
// round-trip the facade records (responses, each step of a tool loop,
// embeddings, and the queued media runs WHEN THEY EXECUTE; `startRun`,
// `generateImage`, `transcribe` and `speak` only enqueue, never pass this
// gate, and so are never counted twice). Only `keySource` `user`/`org`/`none`
// rows count: a catalog discovery sync (`admin_discovery`) is the deployment's
// own call, not any user's. A keyless call (`none`, #448) counts like a user's
// own-key call — against the per-user and per-model limits, never the org-key
// ones, since no org key pays for it. Failed and cancelled round-trips count too — they
// reached the provider. A call THIS gate refused records no row, so a user
// hammering a limit does not extend their own lock-out.
//
// TWO KINDS OF WINDOW
//
//  - Per minute (`perUser.requestsPerMinute`,
//    `perModel[…].requestsPerMinutePerUser`): a sliding 60-second window,
//    answered from TWO sources, and the larger count wins:
//      1. an in-process log of admitted calls per `userId` /
//         `userId:provider:model`, reserved SYNCHRONOUSLY before any await,
//         so a burst of concurrent calls in one replica cannot all slip past
//         the check before any of them has finished (and written its usage
//         row); and
//      2. a `COUNT(*)` over `ai_usage_events` for the same user (and model) in
//         the last 60 seconds — the `(user_id, created_at)` index — so several
//         API replicas agree on one budget.
//    ⚠ THE TRADE-OFF. There is no Redis (or any shared cache) in this
//    template, and adding one for this alone was rejected. The database count
//    LAGS BY IN-FLIGHT REQUESTS: a usage row is written when a round-trip
//    finishes, so calls still running on OTHER replicas are invisible to it.
//    The local log covers bursts within one replica exactly; across replicas
//    the limit is approximate by at most the number of calls in flight on the
//    others. That is the right precision for abuse protection, and the wrong
//    tool for billing (use `GET /api/admin/ai/usage` for that).
//
//  - Per UTC day (`perUser.requestsPerDay`, `orgKey.requestsPerDayPerUser`,
//    `orgKey.tokensPerDayPerUser`): `ai_usage_events` counts / sums since UTC
//    midnight — the same day boundary the usage report uses. Tokens are
//    `input_tokens + output_tokens` (reasoning tokens are part of output, and
//    cached input tokens part of input, in every provider's accounting).
//
// RETRY-AFTER. Exceeding a limit throws `AiError('AI_RATE_LIMITED')` (429)
// with `retryAfterMs` and `details.limit` naming the limit. For a minute
// window it is the time until enough of the counted calls have left the
// window for one more to fit; for a daily one, the time until the next UTC
// midnight. Never less than one second. A background run deferred by it
// (`toRateLimitError()`) is retried then, not failed.
// =============================================================================

import { Inject, Injectable, Optional } from '@nestjs/common';

import type { SystemAiLimitsValue } from '../../common/schemas/settings.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { AiConfigService } from '../config/ai-config.service';
import { AiError } from '../core/ai-error';
import type { AiKeySource } from '../keys/ai-key-resolver.service';

/** The sliding window of a per-minute limit. */
export const AI_LIMIT_MINUTE_MS = 60_000;

/** The shortest `retryAfterMs` a limit answers with. */
export const AI_LIMIT_MIN_RETRY_MS = 1_000;

/** Injection token for the limiter's clock — tests pass a fake one. */
export const AI_LIMITS_CLOCK = Symbol('AI_LIMITS_CLOCK');

/** Milliseconds since the epoch, like `Date.now`. */
export type AiLimitsClock = () => number;

/** Past this many local keys, every stale entry is swept on the next call. */
const LOCAL_SWEEP_THRESHOLD = 10_000;

/** The `keySource` values that are a user's request — never `admin_discovery`. */
const COUNTED_KEY_SOURCES = ['user', 'org', 'none'];

/** The names a refusal's `details.limit` carries. Permanent strings. */
export type AiLimitName =
  | 'perUser.requestsPerMinute'
  | 'perUser.requestsPerDay'
  | 'orgKey.requestsPerDayPerUser'
  | 'orgKey.tokensPerDayPerUser'
  | 'perModel.requestsPerMinutePerUser';

/** One call about to be made, after its key was resolved. */
export interface AiLimitCall {
  userId: string;
  provider: string;
  modelId: string;
  keySource: AiKeySource;
}

/** A `perModel` entry's key: `<provider>:<modelId>`. */
export function aiModelLimitKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/** The `perModel` entry for one model, or `undefined`. */
export function modelLimits(
  limits: SystemAiLimitsValue | undefined,
  provider: string,
  modelId: string,
): { maxOutputTokens?: number; requestsPerMinutePerUser?: number } | undefined {
  const perModel = limits?.perModel;
  const key = aiModelLimitKey(provider, modelId);

  return perModel && Object.prototype.hasOwnProperty.call(perModel, key) ? perModel[key] : undefined;
}

/**
 * The output-token cap for a call to `provider`/`modelId`: the smaller of the
 * deployment-wide `defaults.maxOutputTokensCap` and the model's
 * `ai.limits.perModel[…].maxOutputTokens`, or `undefined` when neither is set.
 */
export function effectiveOutputTokensCap(
  deploymentCap: number | undefined,
  limits: SystemAiLimitsValue | undefined,
  provider: string,
  modelId: string,
): number | undefined {
  const caps = [deploymentCap, modelLimits(limits, provider, modelId)?.maxOutputTokens].filter(
    (value): value is number => value !== undefined,
  );

  return caps.length > 0 ? Math.min(...caps) : undefined;
}

/** A per-minute limit that applies to this call. */
interface MinuteWindow {
  name: AiLimitName;
  max: number;
  /** The local log's key. */
  key: string;
  /** Restrict the database count to this model. */
  model?: { provider: string; modelId: string };
}

/** A per-day limit that applies to this call. */
interface DayWindow {
  name: AiLimitName;
  max: number;
  /** Count only org-key calls. */
  orgOnly: boolean;
  /** Sum tokens instead of counting calls. */
  tokens: boolean;
}

@Injectable()
export class AiLimitsService {
  /** Admission times (ms), oldest first, per local key. */
  private readonly admitted = new Map<string, number[]>();

  private readonly now: AiLimitsClock;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    @Optional() @Inject(AI_LIMITS_CLOCK) clock?: AiLimitsClock,
  ) {
    this.now = clock ?? (() => Date.now());
  }

  /**
   * Admits `call`, or throws `AiError('AI_RATE_LIMITED')` naming the first
   * limit it would exceed. Admission is recorded locally at once (see the file
   * header); a refused call records nothing.
   */
  async enforce(call: AiLimitCall): Promise<void> {
    const { limits } = await this.aiConfig.resolve();
    const minutes = this.minuteWindows(limits, call);
    const days = dayWindows(limits, call);

    // Nothing applies: no query, no bookkeeping.
    if (minutes.length === 0 && days.length === 0) return;

    const now = this.now();

    // 1. Local per-minute logs — check AND reserve before the first await.
    const reserved: MinuteWindow[] = [];

    for (const window of minutes) {
      const log = this.log(window.key, now);

      if (log.length >= window.max) {
        this.release(reserved, now);
        throw minuteLimitExceeded(window, call, retryFromOldest(log, window.max, now));
      }
    }

    for (const window of minutes) {
      this.log(window.key, now).push(now);
      reserved.push(window);
    }

    try {
      // 2. The database, so replicas agree (per-minute) and for daily totals.
      for (const window of minutes) {
        await this.checkMinuteInDatabase(window, call, now);
      }

      for (const window of days) {
        await this.checkDay(window, call, now);
      }
    } catch (err) {
      this.release(reserved, now);
      throw err;
    }
  }

  // ---- per-minute ----------------------------------------------------------------

  private minuteWindows(limits: SystemAiLimitsValue | undefined, call: AiLimitCall): MinuteWindow[] {
    const windows: MinuteWindow[] = [];
    const perUser = limits?.perUser?.requestsPerMinute;
    const perModel = modelLimits(limits, call.provider, call.modelId)?.requestsPerMinutePerUser;

    if (perUser !== undefined) {
      windows.push({ name: 'perUser.requestsPerMinute', max: perUser, key: call.userId });
    }

    if (perModel !== undefined) {
      windows.push({
        name: 'perModel.requestsPerMinutePerUser',
        max: perModel,
        key: `${call.userId}:${aiModelLimitKey(call.provider, call.modelId)}`,
        model: { provider: call.provider, modelId: call.modelId },
      });
    }

    return windows;
  }

  private async checkMinuteInDatabase(window: MinuteWindow, call: AiLimitCall, now: number): Promise<void> {
    const where = {
      userId: call.userId,
      keySource: { in: COUNTED_KEY_SOURCES },
      // Strictly after: a call exactly a minute old has just left the window,
      // the same boundary the local log and `retryAfterMs` use.
      createdAt: { gt: new Date(now - AI_LIMIT_MINUTE_MS) },
      ...(window.model ? { provider: window.model.provider, modelId: window.model.modelId } : {}),
    };
    const count = await this.prisma.aiUsageEvent.count({ where });

    if (count < window.max) return;

    // The call that must leave the window for one more to fit is the
    // (count - max + 1)-th oldest. Read only on the refusal path.
    const [boundary] = await this.prisma.aiUsageEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: count - window.max,
      take: 1,
      select: { createdAt: true },
    });
    // (The local log already passed, so the database is the binding count.)
    const retryAfterMs = boundary ? boundary.createdAt.getTime() + AI_LIMIT_MINUTE_MS - now : AI_LIMIT_MIN_RETRY_MS;

    throw minuteLimitExceeded(window, call, retryAfterMs);
  }

  /** The live admissions for `key` (pruned to the window), creating the log if needed. */
  private log(key: string, now: number): number[] {
    if (this.admitted.size > LOCAL_SWEEP_THRESHOLD) this.sweep(now);

    let log = this.admitted.get(key);

    if (!log) {
      log = [];
      this.admitted.set(key, log);
    }

    const cutoff = now - AI_LIMIT_MINUTE_MS;
    let stale = 0;

    while (stale < log.length && log[stale] <= cutoff) stale += 1;
    if (stale > 0) log.splice(0, stale);

    return log;
  }

  /** Undoes this call's reservations — it was refused, so it never happened. */
  private release(windows: MinuteWindow[], now: number): void {
    for (const window of windows) {
      const log = this.admitted.get(window.key);
      const at = log?.lastIndexOf(now) ?? -1;

      if (log && at !== -1) log.splice(at, 1);
      if (log && log.length === 0) this.admitted.delete(window.key);
    }
  }

  private sweep(now: number): void {
    const cutoff = now - AI_LIMIT_MINUTE_MS;

    for (const [key, log] of this.admitted) {
      if (log.length === 0 || log[log.length - 1] <= cutoff) this.admitted.delete(key);
    }
  }

  // ---- per-day ----------------------------------------------------------------------

  private async checkDay(window: DayWindow, call: AiLimitCall, now: number): Promise<void> {
    const where = {
      userId: call.userId,
      keySource: window.orgOnly ? 'org' : { in: COUNTED_KEY_SOURCES },
      createdAt: { gte: new Date(utcMidnight(now)) },
    };

    let used: number;

    if (window.tokens) {
      const sums = await this.prisma.aiUsageEvent.aggregate({
        where,
        _sum: { inputTokens: true, outputTokens: true },
      });

      used = (sums._sum.inputTokens ?? 0) + (sums._sum.outputTokens ?? 0);
    } else {
      used = await this.prisma.aiUsageEvent.count({ where });
    }

    if (used < window.max) return;

    throw new AiError(
      'AI_RATE_LIMITED',
      window.tokens
        ? `The daily organization-key token limit (${window.max}) has been reached; it resets at midnight UTC.`
        : `The daily AI request limit (${window.max}) has been reached; it resets at midnight UTC.`,
      {
        retryAfterMs: Math.max(AI_LIMIT_MIN_RETRY_MS, utcMidnight(now) + DAY_MS - now),
        details: {
          limit: window.name,
          max: window.max,
          window: 'day',
          ...(window.orgOnly ? { keySource: 'org' } : {}),
          provider: call.provider,
          model: call.modelId,
        },
      },
    );
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The daily limits that apply to this call. Org-key limits only when the org key pays. */
function dayWindows(limits: SystemAiLimitsValue | undefined, call: AiLimitCall): DayWindow[] {
  const windows: DayWindow[] = [];
  const perDay = limits?.perUser?.requestsPerDay;

  if (perDay !== undefined) {
    windows.push({ name: 'perUser.requestsPerDay', max: perDay, orgOnly: false, tokens: false });
  }

  if (call.keySource === 'org') {
    const requests = limits?.orgKey?.requestsPerDayPerUser;
    const tokens = limits?.orgKey?.tokensPerDayPerUser;

    if (requests !== undefined) {
      windows.push({ name: 'orgKey.requestsPerDayPerUser', max: requests, orgOnly: true, tokens: false });
    }

    if (tokens !== undefined) {
      windows.push({ name: 'orgKey.tokensPerDayPerUser', max: tokens, orgOnly: true, tokens: true });
    }
  }

  return windows;
}

/** Midnight UTC at the start of `now`'s day, in ms. */
export function utcMidnight(now: number): number {
  return now - (now % DAY_MS);
}

/**
 * How long until one more call fits a window holding `log` (admission times,
 * oldest first) with room for `max`: until the (length - max + 1)-th oldest
 * leaves it. At least `AI_LIMIT_MIN_RETRY_MS`.
 */
function retryFromOldest(log: number[], max: number, now: number): number {
  if (log.length < max) return AI_LIMIT_MIN_RETRY_MS;

  const boundary = log[log.length - max];

  return Math.max(AI_LIMIT_MIN_RETRY_MS, boundary + AI_LIMIT_MINUTE_MS - now);
}

function minuteLimitExceeded(window: MinuteWindow, call: AiLimitCall, retryAfterMs: number): AiError {
  return new AiError(
    'AI_RATE_LIMITED',
    window.model
      ? `Too many requests to model "${call.modelId}": at most ${window.max} per minute.`
      : `Too many AI requests: at most ${window.max} per minute.`,
    {
      retryAfterMs: Math.max(AI_LIMIT_MIN_RETRY_MS, Math.ceil(retryAfterMs)),
      details: {
        limit: window.name,
        max: window.max,
        window: 'minute',
        provider: call.provider,
        model: call.modelId,
      },
    },
  );
}
