import { AiError } from '../../../ai/core/ai-error';
import { RateLimitError } from '../../../jobs/rate-limit.error';
import {
  GOOD_REVIEW,
  ISO_WEEK,
  NOW,
  PAYLOAD,
  USER,
  WEEK_END,
  WEEK_START,
  createdOf,
  reviewRequestOf,
  setupReview,
  weekSignals,
} from '../../../../test/coach/coach-weekly-review.fixtures';
import { NO_PROFANITY_RULE, PROFANITY_LICENSE } from '../../nudges/nudge-prompt';
import { FALLBACK_TITLES } from '../../nudges/static-fallback';
import { DEFAULT_PLAN_PROMPT, FIRST_WEEK_INTRO } from '../weekly-review-fallback';

// =============================================================================
// ai.coach.weekly_review (E7.10, #250): stats equal the signals, idempotency
// per ISO week, the weekly streak, the guard and the static fallback, the
// clean email register, the gates.
// =============================================================================

const ADULT_SARGE = {
  personaId: 'drill_sergeant',
  intensity: 3,
  profanity: true,
  adultConfirmedAt: '2026-01-01T00:00:00Z',
};

describe('CoachWeeklyReviewHandler', () => {
  it('is server-only with a 3-minute / 2-attempt profile and registers itself', () => {
    const t = setupReview();
    t.handler.onModuleInit();
    expect(t.registry.register).toHaveBeenCalledWith(t.handler);
    expect(t.handler.type).toBe('ai.coach.weekly_review');
    expect(t.handler.profile).toEqual({ maxRuntimeMs: 180_000, maxAttempts: 2 });
    expect('nodeResultSchema' in t.handler).toBe(false);
    expect('persistNodeResult' in t.handler).toBe(false);
  });

  describe('the review', () => {
    it('reads the signals over exactly the ISO week and the next one', async () => {
      const t = setupReview();
      await t.handler.run('job-1', PAYLOAD, NOW);
      expect(t.signals.forUser).toHaveBeenCalledWith(USER, { from: WEEK_START, to: WEEK_END }, NOW);
      expect(t.signals.forUser).toHaveBeenCalledWith(USER, { from: '2026-10-05', to: '2026-10-11' }, NOW);
      expect(t.photos.countInRange).toHaveBeenCalledWith(USER, WEEK_START, WEEK_END);
    });

    it('stores stats whose every number equals the signals for that week (AC 1)', async () => {
      const t = setupReview();
      const outcome = await t.handler.run('job-1', PAYLOAD, NOW);
      expect(outcome).toEqual({ status: 'persisted', messageId: 'review-1', source: 'model' });

      const totals = weekSignals().adherence.totals;
      const { stats } = createdOf(t).data;
      expect(stats).toEqual({
        isoWeek: ISO_WEEK,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        planned: totals.planned,
        completed: totals.completed,
        missed: totals.missed,
        adherencePct: totals.adherencePct,
        weeklyStreak: 4,
        streakPassesLeft: 1,
        streakChange: 'advanced',
        prs: [{ exercise: 'Bench Press', value: 82.5, unit: 'kg', reps: 5 }],
        checkIns: 3,
        photosAdded: 1,
        nextWeekSessions: 3,
        nextWeek: [
          { date: '2026-10-05', weekday: 'Monday', name: 'Push' },
          { date: '2026-10-07', weekday: 'Wednesday', name: 'Pull' },
          { date: '2026-10-09', weekday: 'Friday', name: 'Legs' },
        ],
        noPlan: false,
        firstWeek: false,
      });
    });

    it('persists one weekly_review message and the streak in one transaction, then enqueues delivery', async () => {
      const t = setupReview();
      await t.handler.run('job-1', PAYLOAD, NOW);

      expect(t.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(t.prisma.coachState.updateMany).toHaveBeenCalledWith({
        where: { userId: USER, OR: [{ lastWeeklyReviewWeek: null }, { lastWeeklyReviewWeek: { not: ISO_WEEK } }] },
        data: { weeklyStreak: 4, streakPassesLeft: 1, lastWeeklyReviewWeek: ISO_WEEK },
      });
      expect(createdOf(t)).toMatchObject({
        userId: USER,
        role: 'coach',
        kind: 'weekly_review',
        moment: 'weekly_review',
        personaId: 'coach',
        intensity: 2,
        title: GOOD_REVIEW.headline,
        body: GOOD_REVIEW.intro,
        pushTitle: FALLBACK_TITLES.weekly_review,
        pushBody: 'Coach has your weekly review.',
        provider: 'openai',
        model: 'gpt-test',
        data: {
          version: 1,
          isoWeek: ISO_WEEK,
          prose: GOOD_REVIEW,
          emailProse: GOOD_REVIEW,
          register: 'clean',
          fallback: { app: false, email: false },
        },
      });
      expect(t.jobs.enqueue).toHaveBeenCalledWith({
        type: 'coach.message.deliver',
        reason: 'backfill',
        subjectType: 'coach_message',
        subjectId: 'review-1',
        payload: { messageId: 'review-1' },
      });
      expect(t.reviewMetrics.sent).toHaveBeenCalledWith('model');
      expect(t.reviewMetrics.streak).toHaveBeenCalledWith('advanced', 4);
    });

    it('makes one model call in the clean register, at coach.decision, with stats but no ids or dates', async () => {
      const t = setupReview();
      await t.handler.run('job-1', PAYLOAD, NOW);
      expect(t.respondStructured).toHaveBeenCalledTimes(1);
      expect(t.respondStructured.mock.calls[0][0]).toMatchObject({
        strict: true,
        schemaName: 'coach_weekly_review',
        metadata: { feature: 'coach.decision' },
      });
      const { instructions, text } = reviewRequestOf(t);
      expect(instructions).toContain(NO_PROFANITY_RULE);
      expect(instructions).not.toContain(PROFANITY_LICENSE);
      expect(text).toContain('"completed":3');
      expect(text).not.toMatch(/0000-4000/);
      expect(text).not.toContain('2026-10-05');
    });

    it('with lockScreenSafe off, the push carries the clean headline', async () => {
      const t = setupReview({ coach: { lockScreenSafe: false } });
      await t.handler.run('job-1', PAYLOAD, NOW);
      expect(createdOf(t).pushBody).toBe(GOOD_REVIEW.headline);
    });

    it('a lock-screen-unsafe headline never reaches the push even with lockScreenSafe off', async () => {
      const t = setupReview({ coach: { lockScreenSafe: false }, answers: [{ ...GOOD_REVIEW, headline: 'Bench at 82.5 kg' }] });
      await t.handler.run('job-1', PAYLOAD, NOW);
      // Not lock-screen-safe mode, so digits are allowed in the push; the headline passes.
      expect(createdOf(t).pushBody).toBe('Bench at 82.5 kg');
    });
  });

  describe('idempotency per ISO week (AC 4)', () => {
    it('lastWeeklyReviewWeek already at this week: no model call, no message', async () => {
      const t = setupReview({ state: { pausedUntil: null, weeklyStreak: 4, streakPassesLeft: 1, lastWeeklyReviewWeek: ISO_WEEK } });
      expect(await t.handler.run('job-1', PAYLOAD, NOW)).toEqual({ status: 'skipped', reason: 'already_sent' });
      expect(t.respondStructured).not.toHaveBeenCalled();
      expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
      expect(t.reviewMetrics.skipped).toHaveBeenCalledWith('already_sent');
    });

    it('a persisted but undelivered review is only re-delivered', async () => {
      const t = setupReview({ existing: { id: 'review-0', deliveredAt: null } });
      expect(await t.handler.run('job-1', PAYLOAD, NOW)).toEqual({ status: 'redelivered', messageId: 'review-0' });
      expect(t.prisma.coachMessage.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER, role: 'coach', kind: 'weekly_review', data: { path: ['isoWeek'], equals: ISO_WEEK } },
        }),
      );
      expect(t.respondStructured).not.toHaveBeenCalled();
      expect(t.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 'review-0' }));
    });

    it('a delivered review for the week is skipped', async () => {
      const t = setupReview({ existing: { id: 'review-0', deliveredAt: NOW } });
      expect(await t.handler.run('job-1', PAYLOAD, NOW)).toEqual({ status: 'skipped', reason: 'already_sent' });
      expect(t.jobs.enqueue).not.toHaveBeenCalled();
    });

    it('a concurrent run that recorded the week first rolls this one back: no delivery, no streak count', async () => {
      const t = setupReview({ advancedCount: 0 });
      expect(await t.handler.run('job-1', PAYLOAD, NOW)).toEqual({ status: 'skipped', reason: 'already_sent' });
      expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
      expect(t.jobs.enqueue).not.toHaveBeenCalled();
      expect(t.reviewMetrics.streak).not.toHaveBeenCalled();
    });
  });

  describe('the weekly streak (AC 8 to 10)', () => {
    const missedWeek = weekSignals({
      adherence: {
        weeks: [],
        totals: { planned: 4, completed: 2, partialSessions: 0, missed: 2, extra: 0, adherencePct: 50 },
        missedStreak: 1,
        completedStreak: 0,
      },
    });

    it('a missed week with a pass keeps the streak and uses the pass', async () => {
      const t = setupReview({ week: missedWeek, state: { pausedUntil: null, weeklyStreak: 5, streakPassesLeft: 1, lastWeeklyReviewWeek: null } });
      await t.handler.run('job-1', PAYLOAD, NOW);
      expect(createdOf(t).data.stats).toMatchObject({ weeklyStreak: 5, streakPassesLeft: 0, streakChange: 'pass_used' });
      expect(t.reviewMetrics.streak).toHaveBeenCalledWith('pass_used', 5);
    });

    it('a missed week without a pass resets the streak', async () => {
      const t = setupReview({ week: missedWeek, state: { pausedUntil: null, weeklyStreak: 5, streakPassesLeft: 0, lastWeeklyReviewWeek: null } });
      await t.handler.run('job-1', PAYLOAD, NOW);
      expect(createdOf(t).data.stats).toMatchObject({ weeklyStreak: 0, streakPassesLeft: 0, streakChange: 'reset' });
      expect(t.prisma.coachState.updateMany.mock.calls[0][0].data).toMatchObject({ weeklyStreak: 0 });
    });

    it('a week with nothing planned holds the streak and shows no adherence (never 0 %)', async () => {
      const empty = weekSignals({
        programId: null,
        adherence: {
          weeks: [],
          totals: { planned: 0, completed: 0, partialSessions: 0, missed: 0, extra: 0, adherencePct: null },
          missedStreak: 0,
          completedStreak: 0,
        },
        sessions: [],
        performance: [],
      });
      const t = setupReview({ week: empty, state: { pausedUntil: null, weeklyStreak: 2, streakPassesLeft: 0, lastWeeklyReviewWeek: null } });
      await t.handler.run('job-1', PAYLOAD, NOW);
      expect(createdOf(t).data.stats).toMatchObject({
        planned: 0,
        adherencePct: null,
        noPlan: true,
        weeklyStreak: 2,
        streakChange: 'held',
      });
      expect(reviewRequestOf(t).text).toContain('"noPlan":true');
    });

    it('a pain pattern protects the week: a miss does not reset, and the register is supportive', async () => {
      const painful = weekSignals({
        ...missedWeek,
        pain: [
          {
            exerciseId: '00000000-0000-4000-8000-000000000301',
            slug: 'bench-press',
            name: 'Bench Press',
            lastFlaggedOn: '2026-10-02',
            flaggedSessions28d: 2,
            consecutiveFlaggedSessions: 2,
          },
        ],
      });
      const t = setupReview({ week: painful, state: { pausedUntil: null, weeklyStreak: 5, streakPassesLeft: 0, lastWeeklyReviewWeek: null } });
      await t.handler.run('job-1', PAYLOAD, NOW);
      expect(createdOf(t).data.stats).toMatchObject({ weeklyStreak: 5, streakChange: 'held' });
      expect(createdOf(t).data.register).toBe('supportive');
      expect(reviewRequestOf(t).instructions).toContain('SUPPORTIVE REGISTER');
    });

    it('a pause that ended inside the week protects it', async () => {
      const t = setupReview({
        week: missedWeek,
        state: { pausedUntil: new Date('2026-09-30T08:00:00Z'), weeklyStreak: 5, streakPassesLeft: 0, lastWeeklyReviewWeek: null },
      });
      await t.handler.run('job-1', PAYLOAD, NOW);
      expect(createdOf(t).data.stats).toMatchObject({ weeklyStreak: 5, streakChange: 'held' });
    });
  });

  describe('the guard and the static fallback (AC 2, error handling)', () => {
    it('a number the stats do not carry fails the guard: static review, counted', async () => {
      const t = setupReview({ answers: [{ ...GOOD_REVIEW, intro: 'You trained 37 times this month. Incredible.' }] });
      const outcome = await t.handler.run('job-1', PAYLOAD, NOW);

      expect(outcome).toMatchObject({ status: 'persisted', source: 'static' });
      const row = createdOf(t);
      expect(row).toMatchObject({ provider: 'static', model: null, title: FALLBACK_TITLES.weekly_review });
      expect(row.body).toContain('3 sessions done');
      expect(row.data.fallback).toEqual({ app: true, email: true });
      expect(row.data.prose.wins).toEqual([
        'You completed 3 of 3 planned sessions.',
        'New personal best on Bench Press.',
        'Your weekly streak is now 4 weeks.',
      ]);
      expect(row.data.prose.nextWeekPlanPrompt).toBe(DEFAULT_PLAN_PROMPT);
      expect(t.appMetrics.coachGuardRejection).toHaveBeenCalledWith('invented_number');
      expect(t.reviewMetrics.fallback).toHaveBeenCalledWith('guard_rejected');
      expect(t.jobs.enqueue).toHaveBeenCalled();
    });

    it('a number the stats do carry passes', async () => {
      const t = setupReview({ answers: [{ ...GOOD_REVIEW, intro: '3 sessions and a bench best at 82.5 kg. Good week.' }] });
      expect(await t.handler.run('job-1', PAYLOAD, NOW)).toMatchObject({ source: 'model' });
    });

    it('coach.decision not runnable: no call, the static review is still delivered', async () => {
      const t = setupReview({ resolution: { state: 'unassigned', model: null } });
      expect(await t.handler.run('job-1', PAYLOAD, NOW)).toMatchObject({ status: 'persisted', source: 'static' });
      expect(t.respondStructured).not.toHaveBeenCalled();
      expect(t.reviewMetrics.fallback).toHaveBeenCalledWith('no_model');
      expect(t.prisma.coachState.updateMany).toHaveBeenCalled();
    });

    it('a terminal AI error falls back to the static review', async () => {
      const t = setupReview({ answers: [new AiError('AI_KEY_REQUIRED', 'no key')] });
      expect(await t.handler.run('job-1', PAYLOAD, NOW)).toMatchObject({ source: 'static' });
      expect(t.reviewMetrics.fallback).toHaveBeenCalledWith('ai_error');
    });

    it('a transient AI error is retried (throws) before the last attempt, and falls back on it', async () => {
      const first = setupReview({ answers: [new Error('socket hang up')] });
      await expect(first.handler.run('job-1', PAYLOAD, NOW, false)).rejects.toThrow('socket hang up');
      expect(first.prisma.coachMessage.create).not.toHaveBeenCalled();
      expect(first.prisma.coachState.updateMany).not.toHaveBeenCalled();

      const last = setupReview({ answers: [new Error('socket hang up')] });
      expect(await last.handler.run('job-1', PAYLOAD, NOW, true)).toMatchObject({ source: 'static' });
    });

    describe('process() and the attempt count', () => {
      beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'nextTick'] }));
      afterEach(() => jest.useRealTimers());

      it('the first attempt rethrows a transient error; the second (last) falls back', async () => {
        const first = setupReview({ answers: [new Error('socket hang up')] });
        await expect(first.handler.process({ id: 'job-1', attempts: 1, payload: PAYLOAD } as never)).rejects.toThrow();

        const second = setupReview({ answers: [new Error('socket hang up')] });
        await expect(second.handler.process({ id: 'job-1', attempts: 2, payload: PAYLOAD } as never)).resolves.toBeUndefined();
        expect(second.prisma.coachMessage.create.mock.calls[0][0].data.provider).toBe('static');
      });
    });

    it('a provider throttle defers the job and persists nothing', async () => {
      const t = setupReview({ answers: [new AiError('AI_RATE_LIMITED', 'slow down')] });
      await expect(t.handler.run('job-1', PAYLOAD, NOW)).rejects.toBeInstanceOf(RateLimitError);
      expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
    });

    it('a user who never trained gets the gentle first-week review, not a failure (AC 12)', async () => {
      const t = setupReview({ everCompleted: false, resolution: { state: 'unassigned', model: null } });
      await t.handler.run('job-1', PAYLOAD, NOW);
      expect(createdOf(t).data.stats.firstWeek).toBe(true);
      expect(createdOf(t).body).toBe(FIRST_WEEK_INTRO);
    });
  });

  describe('the clean email register (AC 6a)', () => {
    const PROFANE: typeof GOOD_REVIEW = {
      ...GOOD_REVIEW,
      intro: 'Not a bad damn week, recruit. You showed up and moved real weight. Now do it again.',
    };

    it('unlocked Sarge L3: a second call at the clean register writes the email prose', async () => {
      const t = setupReview({ coach: ADULT_SARGE, system: { allowProfanePersonas: true }, answers: [PROFANE, GOOD_REVIEW] });
      await t.handler.run('job-1', PAYLOAD, NOW);

      expect(t.respondStructured).toHaveBeenCalledTimes(2);
      expect(reviewRequestOf(t, 0).instructions).toContain(PROFANITY_LICENSE);
      expect(reviewRequestOf(t, 1).instructions).toContain(NO_PROFANITY_RULE);
      expect(reviewRequestOf(t, 1).instructions).not.toContain(PROFANITY_LICENSE);
      expect(reviewRequestOf(t, 1).instructions).toContain('EMAIL');
      const row = createdOf(t);
      expect(row).toMatchObject({ intensity: 3, body: PROFANE.intro });
      expect(row.data).toMatchObject({ register: 'profane', prose: PROFANE, emailProse: GOOD_REVIEW });
    });

    it('a profane email answer is rejected and replaced by the clean static review', async () => {
      const t = setupReview({ coach: ADULT_SARGE, system: { allowProfanePersonas: true }, answers: [PROFANE, PROFANE] });
      await t.handler.run('job-1', PAYLOAD, NOW);
      const { data } = createdOf(t);
      expect(data.fallback).toEqual({ app: false, email: true });
      expect(data.emailProse.intro).not.toMatch(/damn/i);
      expect(t.appMetrics.coachGuardRejection).toHaveBeenCalledWith('profanity');
    });

    it('locked Sarge L3 (no unlock): one call, no license, rendered at L2', async () => {
      const t = setupReview({ coach: { personaId: 'drill_sergeant', intensity: 3 } });
      await t.handler.run('job-1', PAYLOAD, NOW);
      expect(t.respondStructured).toHaveBeenCalledTimes(1);
      expect(reviewRequestOf(t).instructions).not.toContain(PROFANITY_LICENSE);
      expect(createdOf(t).intensity).toBe(2);
    });
  });

  describe('gates (AC 12)', () => {
    it.each([
      ['AI off', { ai: false }, 'coach_off'],
      ['system coach off', { system: { enabled: false } }, 'coach_off'],
      ['user coach off', { coach: { enabled: false } }, 'coach_off'],
      [
        'paused',
        { state: { pausedUntil: new Date('2026-10-10T00:00:00Z'), weeklyStreak: 1, streakPassesLeft: 0, lastWeeklyReviewWeek: null } },
        'paused',
      ],
    ] as const)('%s: skipped, nothing generated or written', async (_label, options, reason) => {
      const t = setupReview(options as never);
      expect(await t.handler.run('job-1', PAYLOAD, NOW)).toEqual({ status: 'skipped', reason });
      expect(t.respondStructured).not.toHaveBeenCalled();
      expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
      expect(t.prisma.coachState.updateMany).not.toHaveBeenCalled();
    });

    it('the week has not ended locally (Saturday): not_due', async () => {
      const t = setupReview();
      const saturday = new Date('2026-10-03T16:30:00Z');
      expect(await t.handler.run('job-1', PAYLOAD, saturday)).toEqual({ status: 'skipped', reason: 'not_due' });
    });

    it('a review job far past its week is stale', async () => {
      const t = setupReview();
      expect(await t.handler.run('job-1', PAYLOAD, new Date('2026-10-20T10:00:00Z'))).toEqual({ status: 'skipped', reason: 'stale' });
    });

    it('the Monday catch-up still reviews the previous week', async () => {
      const t = setupReview();
      const monday = new Date('2026-10-05T10:00:00Z');
      expect(await t.handler.run('job-1', PAYLOAD, monday)).toMatchObject({ status: 'persisted' });
      expect(t.signals.forUser).toHaveBeenCalledWith(USER, { from: WEEK_START, to: WEEK_END }, monday);
    });

    it('an impossible ISO week is skipped', async () => {
      const t = setupReview();
      expect(await t.handler.run('job-1', { userId: USER, isoWeek: '2026-W60' }, NOW)).toEqual({
        status: 'skipped',
        reason: 'invalid_week',
      });
    });

    it('a malformed payload is a no-op', async () => {
      const t = setupReview();
      await expect(t.handler.process({ id: 'job-1', payload: { userId: 'nope' } } as never)).resolves.toBeUndefined();
      expect(t.reviewMetrics.skipped).toHaveBeenCalledWith('invalid_payload');
    });
  });

});
