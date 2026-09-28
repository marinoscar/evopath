// =============================================================================
// AiLimitsService (issue #450) — each limit, over a fake clock
// =============================================================================
//
// The REAL limiter over the #432 harness's in-memory `ai_usage_events`, so a
// "row written by another replica" is literally a row in that table and the
// local burst log is the limiter's own. The clock is fake: every window and
// every `retryAfterMs` is an exact number.
// =============================================================================

import type { SystemAiLimitsValue } from '../../common/schemas/settings.schema';
import { AiError } from '../core/ai-error';
import {
  createAiRuntimeHarness,
  HARNESS_EMBEDDING_MODEL,
  HARNESS_MODEL,
  HARNESS_OTHER_USER,
  HARNESS_USER,
} from '../testing/ai-runtime-harness';
import {
  AI_LIMIT_MIN_RETRY_MS,
  type AiLimitCall,
  aiModelLimitKey,
  effectiveOutputTokensCap,
  modelLimits,
  utcMidnight,
} from './ai-limits.service';

/** 22:00:00 UTC — two hours before the next UTC midnight. */
const T0 = Date.UTC(2026, 8, 26, 22, 0, 0);

function setup(limits: SystemAiLimitsValue) {
  let now = T0;
  const h = createAiRuntimeHarness({ policy: { limits }, clock: () => now });

  return {
    h,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    /** A usage row as another replica (or an earlier call) left it. */
    row(fields: Record<string, unknown> & { at: number }) {
      const { at, ...rest } = fields;
      h.usageEvents.push({
        userId: HARNESS_USER,
        provider: 'openai',
        modelId: HARNESS_MODEL,
        operation: 'responses',
        keySource: 'user',
        status: 'succeeded',
        inputTokens: null,
        outputTokens: null,
        createdAt: new Date(at),
        ...rest,
      });
    },
    queries: () =>
      h.prisma.aiUsageEvent.count.mock.calls.length +
      h.prisma.aiUsageEvent.findMany.mock.calls.length +
      h.prisma.aiUsageEvent.aggregate.mock.calls.length,
  };
}

const userCall: AiLimitCall = { userId: HARNESS_USER, provider: 'openai', modelId: HARNESS_MODEL, keySource: 'user' };
const orgCall: AiLimitCall = { ...userCall, keySource: 'org' };
const keylessCall: AiLimitCall = { ...userCall, keySource: 'none' };

async function refusal(promise: Promise<unknown>): Promise<AiError> {
  const err = await promise.then(
    () => {
      throw new Error('expected AI_RATE_LIMITED, the call was admitted');
    },
    (e: unknown) => e,
  );

  expect(err).toBeInstanceOf(AiError);
  expect((err as AiError).code).toBe('AI_RATE_LIMITED');
  expect((err as AiError).getStatus()).toBe(429);

  return err as AiError;
}

const detailsOf = (err: AiError) => err.toJSON().details;

describe('AiLimitsService (#450)', () => {
  describe('unlimited when unset', () => {
    it('`{}` admits every call and makes no query at all', async () => {
      const t = setup({});

      for (let i = 0; i < 50; i += 1) await t.h.limits.enforce(userCall);

      expect(t.queries()).toBe(0);
    });

    it('empty sub-objects are still unlimited, with no query', async () => {
      const t = setup({ perUser: {}, orgKey: {}, perModel: { 'openai:fake-model': {} } });

      for (let i = 0; i < 5; i += 1) await t.h.limits.enforce(orgCall);

      expect(t.queries()).toBe(0);
    });

    it('a per-model limit for ANOTHER model costs this call nothing', async () => {
      const t = setup({ perModel: { 'openai:other-model': { requestsPerMinutePerUser: 1 } } });

      await t.h.limits.enforce(userCall);
      await t.h.limits.enforce(userCall);

      expect(t.queries()).toBe(0);
    });
  });

  describe('perUser.requestsPerMinute', () => {
    it('admits the limit, refuses the next, and names the limit', async () => {
      const t = setup({ perUser: { requestsPerMinute: 2 } });

      await t.h.limits.enforce(userCall);
      t.advance(10_000);
      await t.h.limits.enforce(userCall);
      t.advance(10_000);

      const err = await refusal(t.h.limits.enforce(userCall));

      // The oldest admission (T0) leaves the window at T0 + 60s; now is T0 + 20s.
      expect(err.retryAfterMs).toBe(40_000);
      expect(detailsOf(err)).toMatchObject({
        reason: 'AI_RATE_LIMITED',
        limit: 'perUser.requestsPerMinute',
        max: 2,
        window: 'minute',
        retryAfterMs: 40_000,
      });
    });

    it('the window slides: once the oldest call leaves it, one more fits', async () => {
      const t = setup({ perUser: { requestsPerMinute: 2 } });

      await t.h.limits.enforce(userCall);
      t.advance(10_000);
      await t.h.limits.enforce(userCall);
      t.advance(50_001);

      await expect(t.h.limits.enforce(userCall)).resolves.toBeUndefined();
      await refusal(t.h.limits.enforce(userCall));
    });

    it('counts calls other replicas made (rows in ai_usage_events), with retryAfterMs from the boundary row', async () => {
      const t = setup({ perUser: { requestsPerMinute: 3 } });

      t.row({ at: T0 - 50_000 });
      t.row({ at: T0 - 30_000 });
      t.row({ at: T0 - 5_000 });

      const err = await refusal(t.h.limits.enforce(userCall));

      // Three counted, max 3: the oldest (T0 - 50s) must leave — 10s from now.
      expect(err.retryAfterMs).toBe(10_000);
    });

    it('with more rows than the limit, waits for enough of them to leave', async () => {
      const t = setup({ perUser: { requestsPerMinute: 2 } });

      t.row({ at: T0 - 50_000 });
      t.row({ at: T0 - 40_000 });
      t.row({ at: T0 - 20_000 });
      t.row({ at: T0 - 10_000 });

      // Four counted, max 2: the third-oldest (T0 - 20s) must leave for one to fit.
      expect((await refusal(t.h.limits.enforce(userCall))).retryAfterMs).toBe(40_000);
    });

    it('does not count rows older than a minute, catalog discovery, or another user', async () => {
      const t = setup({ perUser: { requestsPerMinute: 1 } });

      t.row({ at: T0 - 60_001 });
      t.row({ at: T0 - 1_000, userId: null, keySource: 'admin_discovery', operation: 'catalog' });
      t.row({ at: T0 - 1_000, userId: HARNESS_OTHER_USER });

      await expect(t.h.limits.enforce(userCall)).resolves.toBeUndefined();
    });

    it('a row exactly a minute old has just left the window — the boundary retryAfterMs promises', async () => {
      const t = setup({ perUser: { requestsPerMinute: 1 } });

      t.row({ at: T0 - 60_000 });

      await expect(t.h.limits.enforce(userCall)).resolves.toBeUndefined();
    });

    it('is per user', async () => {
      const t = setup({ perUser: { requestsPerMinute: 1 } });

      await t.h.limits.enforce(userCall);

      await expect(t.h.limits.enforce({ ...userCall, userId: HARNESS_OTHER_USER })).resolves.toBeUndefined();
      await refusal(t.h.limits.enforce(userCall));
    });

    it('a concurrent burst in one replica cannot slip past before any row is written', async () => {
      const t = setup({ perUser: { requestsPerMinute: 3 } });

      const results = await Promise.allSettled(Array.from({ length: 6 }, () => t.h.limits.enforce(userCall)));

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
    });

    it('never answers less than a second', async () => {
      const t = setup({ perUser: { requestsPerMinute: 1 } });

      await t.h.limits.enforce(userCall);
      t.advance(59_999);

      expect((await refusal(t.h.limits.enforce(userCall))).retryAfterMs).toBe(AI_LIMIT_MIN_RETRY_MS);
    });

    it('a refused call is not counted — refusals do not extend the lock-out', async () => {
      const t = setup({ perUser: { requestsPerMinute: 1, requestsPerDay: 1 } });

      // Today's one call, outside the minute window: the DAY limit refuses.
      t.row({ at: T0 - 120_000 });
      expect(detailsOf(await refusal(t.h.limits.enforce(userCall))).limit).toBe('perUser.requestsPerDay');

      // Lift the daily limit: the refused call left nothing in the minute log.
      t.h.setPolicy({ limits: { perUser: { requestsPerMinute: 1 } } });

      await expect(t.h.limits.enforce(userCall)).resolves.toBeUndefined();
    });
  });

  describe('perUser.requestsPerDay', () => {
    it('counts today (UTC) only, and retries at the next UTC midnight', async () => {
      const t = setup({ perUser: { requestsPerDay: 2 } });

      t.row({ at: utcMidnight(T0) - 1 }); // yesterday
      t.row({ at: utcMidnight(T0) + 1_000 });
      await t.h.limits.enforce(userCall); // the second of today (the log does not count per day)
      t.row({ at: T0 }); // …once it recorded its row

      const err = await refusal(t.h.limits.enforce(userCall));

      expect(err.retryAfterMs).toBe(2 * 60 * 60 * 1000);
      expect(detailsOf(err)).toMatchObject({ limit: 'perUser.requestsPerDay', max: 2, window: 'day' });
    });

    it('counts calls whoever paid — the user\'s own key and the org key alike', async () => {
      const t = setup({ perUser: { requestsPerDay: 2 } });

      t.row({ at: T0 - 1_000, keySource: 'user' });
      t.row({ at: T0 - 1_000, keySource: 'org' });

      await refusal(t.h.limits.enforce(userCall));
    });

    it('counts keyless calls (keySource none, #448) like a user\'s own, and limits them too', async () => {
      const t = setup({ perUser: { requestsPerDay: 2 } });

      t.row({ at: T0 - 1_000, keySource: 'none' });
      await t.h.limits.enforce(keylessCall);
      t.row({ at: T0, keySource: 'none' });

      await refusal(t.h.limits.enforce(keylessCall));
    });
  });

  describe('orgKey limits', () => {
    it('requestsPerDayPerUser counts only org-key calls', async () => {
      const t = setup({ orgKey: { requestsPerDayPerUser: 2 } });

      t.row({ at: T0 - 1_000, keySource: 'user' });
      t.row({ at: T0 - 1_000, keySource: 'user' });
      t.row({ at: T0 - 1_000, keySource: 'org' });
      await t.h.limits.enforce(orgCall);
      t.row({ at: T0, keySource: 'org' });

      const err = await refusal(t.h.limits.enforce(orgCall));

      expect(err.retryAfterMs).toBe(2 * 60 * 60 * 1000);
      expect(detailsOf(err)).toMatchObject({
        limit: 'orgKey.requestsPerDayPerUser',
        max: 2,
        window: 'day',
        keySource: 'org',
      });
    });

    it('tokensPerDayPerUser sums input + output tokens of today\'s org-key calls', async () => {
      const t = setup({ orgKey: { tokensPerDayPerUser: 1_000 } });

      t.row({ at: T0 - 1_000, keySource: 'org', inputTokens: 300, outputTokens: 400 });
      t.row({ at: T0 - 1_000, keySource: 'user', inputTokens: 5_000, outputTokens: 5_000 });
      t.row({ at: utcMidnight(T0) - 1, keySource: 'org', inputTokens: 5_000, outputTokens: 5_000 });

      await t.h.limits.enforce(orgCall); // 700 of 1000

      t.row({ at: T0, keySource: 'org', inputTokens: 200, outputTokens: 100 });

      const err = await refusal(t.h.limits.enforce(orgCall)); // 1000 of 1000

      expect(detailsOf(err)).toMatchObject({ limit: 'orgKey.tokensPerDayPerUser', max: 1_000, window: 'day' });
      expect(err.retryAfterMs).toBe(2 * 60 * 60 * 1000);
    });

    it('never applies to a user on their own key — not even a query', async () => {
      const t = setup({ orgKey: { requestsPerDayPerUser: 1, tokensPerDayPerUser: 1 } });

      t.row({ at: T0 - 1_000, keySource: 'org', inputTokens: 999, outputTokens: 999 });
      t.row({ at: T0 - 1_000, keySource: 'org' });

      await expect(t.h.limits.enforce(userCall)).resolves.toBeUndefined();
      expect(t.queries()).toBe(0);
    });

    it('never applies to a keyless call (#448) — no org key pays for it', async () => {
      const t = setup({ orgKey: { requestsPerDayPerUser: 1, tokensPerDayPerUser: 1 } });

      t.row({ at: T0 - 1_000, keySource: 'org' });

      await expect(t.h.limits.enforce(keylessCall)).resolves.toBeUndefined();
      expect(t.queries()).toBe(0);
    });
  });

  describe('perModel.requestsPerMinutePerUser', () => {
    it('limits one model and leaves the others alone', async () => {
      const t = setup({ perModel: { [aiModelLimitKey('openai', HARNESS_MODEL)]: { requestsPerMinutePerUser: 1 } } });
      const other: AiLimitCall = { ...userCall, modelId: HARNESS_EMBEDDING_MODEL };

      await t.h.limits.enforce(userCall);
      await t.h.limits.enforce(other);
      await t.h.limits.enforce(other);

      const err = await refusal(t.h.limits.enforce(userCall));

      expect(err.retryAfterMs).toBe(60_000);
      expect(detailsOf(err)).toMatchObject({
        limit: 'perModel.requestsPerMinutePerUser',
        max: 1,
        window: 'minute',
        provider: 'openai',
        model: HARNESS_MODEL,
      });
    });

    it('counts only that model\'s rows in the database', async () => {
      const t = setup({ perModel: { 'openai:fake-model': { requestsPerMinutePerUser: 1 } } });

      t.row({ at: T0 - 1_000, modelId: HARNESS_EMBEDDING_MODEL });
      await t.h.limits.enforce(userCall);

      t.h.limits['admitted'].clear(); // as if another replica had admitted it
      t.row({ at: T0, modelId: HARNESS_MODEL });

      await refusal(t.h.limits.enforce(userCall));
    });
  });

  describe('helpers', () => {
    it('modelLimits finds an entry by `<provider>:<modelId>` only', () => {
      const limits: SystemAiLimitsValue = { perModel: { 'openai:gpt-x:2025': { maxOutputTokens: 10 } } };

      expect(modelLimits(limits, 'openai', 'gpt-x:2025')).toEqual({ maxOutputTokens: 10 });
      expect(modelLimits(limits, 'openai', 'gpt-x')).toBeUndefined();
      expect(modelLimits(limits, 'openai', 'toString')).toBeUndefined();
      expect(modelLimits(undefined, 'openai', 'gpt-x')).toBeUndefined();
    });

    it('effectiveOutputTokensCap is the smaller of the deployment and per-model caps', () => {
      const limits: SystemAiLimitsValue = { perModel: { 'openai:m': { maxOutputTokens: 100 } } };

      expect(effectiveOutputTokensCap(undefined, limits, 'openai', 'm')).toBe(100);
      expect(effectiveOutputTokensCap(50, limits, 'openai', 'm')).toBe(50);
      expect(effectiveOutputTokensCap(500, limits, 'openai', 'm')).toBe(100);
      expect(effectiveOutputTokensCap(500, limits, 'openai', 'other')).toBe(500);
      expect(effectiveOutputTokensCap(undefined, {}, 'openai', 'm')).toBeUndefined();
    });

    it('utcMidnight is the start of the UTC day', () => {
      expect(utcMidnight(T0)).toBe(Date.UTC(2026, 8, 26));
    });
  });
});
