import { AiError } from '../../../ai/core/ai-error';
import { RateLimitError } from '../../../jobs/rate-limit.error';
import { GOOD, NOW, USER, requestOf, setupNudge, type SetupOptions } from '../../../../test/coach/coach-nudge.fixtures';
import { COACH_PERSONAS, COACH_INTENSITIES } from '../../personas';
import type { CoachNudgeOutput } from '../nudge-schema';
import { KICKOFF_GUIDANCE } from '../nudge-prompt';
import { FALLBACK_TITLES } from '../static-fallback';
import { KICKOFF_MAX_DEFERRALS, type CoachNudgePayload } from './coach-nudge.handler';

// =============================================================================
// ai.coach.nudge, the kickoff path (E7.12; docs/specs/ai-coach.md §2.13):
// the implementation-intention ask, deferral (not drop) past the gates, one
// message per program, and the static fallback on any generation failure.
// NOW is 2026-10-01T10:00Z = 12:00 in Europe/Madrid (the fixture's zone).
// =============================================================================

const PROGRAM = '00000000-0000-4000-8000-0000000000f1';

const KICKOFF: CoachNudgePayload = {
  userId: USER,
  moment: 'kickoff',
  momentKey: `kickoff:${PROGRAM}`,
  trigger: 'program_activated',
  programId: PROGRAM,
};

const KICKOFF_ANSWER: CoachNudgeOutput = {
  ...GOOD,
  moment: 'kickoff',
  title: 'Your plan is live',
  body: 'Your plan starts with Legs tomorrow. When will you train, where, and what is your fallback if the day goes sideways?',
  pushTitle: 'Your plan is live',
  pushBody: 'Three quick questions to lock it in.',
  audioScript: 'Your plan starts with Legs tomorrow. When, where, and what is your fallback?',
  reason: 'Kickoff: ask for an implementation intention.',
};

const STATE = {
  pausedUntil: null,
  weeklyStreak: 0,
  streakPassesLeft: 1,
  usualWorkoutMinuteLocal: null,
  lastNudgeAt: null,
  nudgesToday: 0,
  nudgeDayLocal: null,
};

function setup(options: SetupOptions = {}) {
  return setupNudge({ answers: [KICKOFF_ANSWER], state: STATE, ...options });
}

function deferredJob(t: ReturnType<typeof setupNudge>) {
  expect(t.jobs.enqueue).toHaveBeenCalledTimes(1);
  return (t.jobs.enqueue.mock.calls[0] as unknown as [Record<string, any>])[0];
}

describe('CoachNudgeHandler: kickoff (E7.12)', () => {
  it('asks when, where and the fallback plan, naming the first planned session from the signals', async () => {
    const t = setup();
    const outcome = await t.handler.run('job-1', KICKOFF, NOW);

    expect(outcome).toEqual({ status: 'persisted', messageId: 'msg-1', source: 'model' });
    const { instructions, text } = requestOf(t.respondStructured, 0);
    expect(instructions).toContain(KICKOFF_GUIDANCE);
    expect(instructions).toMatch(/WHEN/);
    expect(instructions).toMatch(/WHERE/);
    expect(instructions).toMatch(/FALLBACK/);
    expect(text).toContain('"nextSession":{"name":"Legs","when":"tomorrow"}');
    expect(text).toContain('"momentReason":"program_activated"');
    expect(text).toContain('"trigger":"program_activated"');
  });

  it('persists a `kickoff` card with the program id and the three questions, then enqueues delivery', async () => {
    const t = setup();
    await t.handler.run('job-1', KICKOFF, NOW);

    const data = t.prisma.coachMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ kind: 'kickoff', moment: 'kickoff', provider: 'openai', body: KICKOFF_ANSWER.body });
    expect(data.data).toMatchObject({
      momentKey: `kickoff:${PROGRAM}`,
      trigger: 'program_activated',
      programId: PROGRAM,
      questions: ['when', 'where', 'fallback'],
      fallback: false,
    });
    expect(t.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'coach.message.deliver', subjectId: 'msg-1' }));
  });

  it('an invented number in the kickoff fails the guard like any nudge (numbers come from the plan and signals)', async () => {
    const invented = { ...KICKOFF_ANSWER, body: 'Your 12-week plan starts tomorrow. When, where, and your fallback?' };
    const t = setup({ answers: [invented, KICKOFF_ANSWER] });
    await t.handler.run('job-1', KICKOFF, NOW);
    expect(requestOf(t.respondStructured, 1).text).toContain('invented_number');
  });

  describe('gates defer the kickoff instead of dropping it', () => {
    it('inside quiet hours: re-queued for the end of the window, no model call, no message', async () => {
      // 23:00 in Madrid; quiet 21:30 -> 07:30 local (05:30Z next day).
      const late = new Date('2026-10-01T21:00:00Z');
      const t = setup();
      const outcome = await t.handler.run('job-1', KICKOFF, late);

      expect(outcome).toEqual({ status: 'deferred', reason: 'quiet_hours', until: new Date('2026-10-02T05:30:00Z') });
      expect(t.respondStructured).not.toHaveBeenCalled();
      expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
      expect(deferredJob(t)).toEqual({
        type: 'ai.coach.nudge',
        reason: 'backfill',
        subjectType: 'program',
        subjectId: PROGRAM,
        payload: { ...KICKOFF, deferrals: 1 },
        scheduledFor: new Date('2026-10-02T05:30:00Z'),
        skipDedup: true,
      });
    });

    it('daily cap reached: re-queued for the next local morning anchor', async () => {
      const t = setup({ state: { ...STATE, nudgesToday: 2, nudgeDayLocal: new Date('2026-10-01T00:00:00Z') } });
      const outcome = await t.handler.run('job-1', KICKOFF, NOW);
      // Next local day 09:00 Madrid = 07:00Z.
      expect(outcome).toEqual({ status: 'deferred', reason: 'daily_cap', until: new Date('2026-10-02T07:00:00Z') });
      expect(deferredJob(t).scheduledFor).toEqual(new Date('2026-10-02T07:00:00Z'));
    });

    it("yesterday's count does not hold today's kickoff", async () => {
      const t = setup({ state: { ...STATE, nudgesToday: 2, nudgeDayLocal: new Date('2026-09-30T00:00:00Z') } });
      await expect(t.handler.run('job-1', KICKOFF, NOW)).resolves.toMatchObject({ status: 'persisted' });
    });

    it('spacing: re-queued for three hours after the last nudge', async () => {
      const t = setup({ state: { ...STATE, lastNudgeAt: new Date('2026-10-01T09:00:00Z') } });
      const outcome = await t.handler.run('job-1', KICKOFF, NOW);
      expect(outcome).toEqual({ status: 'deferred', reason: 'spacing', until: new Date('2026-10-01T12:00:00Z') });
    });

    it('a pause defers it to the end of the pause (a plain nudge is suppressed instead)', async () => {
      const until = new Date('2026-10-04T00:00:00Z');
      const t = setup({ state: { ...STATE, pausedUntil: until } });
      await expect(t.handler.run('job-1', KICKOFF, NOW)).resolves.toEqual({ status: 'deferred', reason: 'paused', until });
    });

    it('carries the deferral count and gives up after the limit', async () => {
      const late = new Date('2026-10-01T21:00:00Z');
      const t = setup();
      await t.handler.run('job-1', { ...KICKOFF, deferrals: 3 }, late);
      expect(deferredJob(t).payload.deferrals).toBe(4);

      const capped = setup();
      const outcome = await capped.handler.run('job-1', { ...KICKOFF, deferrals: KICKOFF_MAX_DEFERRALS }, late);
      expect(outcome).toEqual({ status: 'suppressed', reason: 'deferral_limit' });
      expect(capped.jobs.enqueue).not.toHaveBeenCalled();
    });

    it.each([
      ['AI is off', { ai: false }],
      ['the system coach is off', { system: { enabled: false } }],
      ['the user disabled the coach', { coach: { enabled: false } }],
    ])('%s: no kickoff, no deferral', async (_label, options) => {
      const t = setup(options as SetupOptions);
      await expect(t.handler.run('job-1', KICKOFF, NOW)).resolves.toEqual({ status: 'suppressed', reason: 'coach_off' });
      expect(t.jobs.enqueue).not.toHaveBeenCalled();
      expect(t.respondStructured).not.toHaveBeenCalled();
    });
  });

  describe('one kickoff per program', () => {
    it('a kickoff already delivered for this program is not sent again (re-activation, version bump)', async () => {
      const late = new Date('2026-10-01T21:00:00Z');
      const t = setup({ existing: { id: 'msg-old', deliveredAt: NOW } });
      await expect(t.handler.run('job-2', KICKOFF, late)).resolves.toEqual({ status: 'suppressed', reason: 'already_sent' });
      expect(t.jobs.enqueue).not.toHaveBeenCalled();
      expect(t.prisma.coachMessage.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER, role: 'coach', data: { path: ['momentKey'], equals: `kickoff:${PROGRAM}` } } }),
      );
    });

    it('re-checks the momentKey right before writing (a concurrent kickoff job won the race)', async () => {
      const t = setup();
      t.prisma.coachMessage.findFirst
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce({ id: 'msg-other', deliveredAt: null } as never);
      await expect(t.handler.run('job-1', KICKOFF, NOW)).resolves.toEqual({ status: 'suppressed', reason: 'already_sent' });
      expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
    });
  });

  describe('a failed generation still delivers the static persona kickoff line', () => {
    const expectStatic = (t: ReturnType<typeof setupNudge>) => {
      const data = t.prisma.coachMessage.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ kind: 'kickoff', provider: 'static', model: null, title: FALLBACK_TITLES.kickoff });
      expect(data.body).toContain('when will you train, where');
      expect(data.data).toMatchObject({ fallback: true, programId: PROGRAM, questions: ['when', 'where', 'fallback'] });
      expect(t.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'coach.message.deliver' }));
      expect(t.metrics.coachNudgeFallbackUsed).toHaveBeenCalledWith('kickoff');
    };

    it('no runnable coach.decision model', async () => {
      const t = setup({ resolution: { state: 'no_key', model: null } });
      await expect(t.handler.run('job-1', KICKOFF, NOW)).resolves.toMatchObject({ status: 'persisted', source: 'static' });
      expect(t.respondStructured).not.toHaveBeenCalled();
      expectStatic(t);
    });

    it.each([
      ['a terminal AI error', new AiError('AI_DISABLED', 'off')],
      ['a transient provider error', new AiError('AI_PROVIDER_UNAVAILABLE', 'boom')],
      ['an unexpected error', new Error('kaput')],
    ])('%s', async (_label, error) => {
      const t = setup({ answers: [error] });
      await expect(t.handler.run('job-1', KICKOFF, NOW)).resolves.toMatchObject({ status: 'persisted', source: 'static' });
      expectStatic(t);
    });

    it('the model declining (a kickoff is not skippable)', async () => {
      const t = setup({ answers: [{ ...KICKOFF_ANSWER, send: false, title: '', body: '' }] });
      await expect(t.handler.run('job-1', KICKOFF, NOW)).resolves.toMatchObject({ status: 'persisted', source: 'static' });
      expectStatic(t);
    });

    it('two guard rejections', async () => {
      const invented = { ...KICKOFF_ANSWER, body: 'Your 12-week plan starts tomorrow.' };
      const t = setup({ answers: [invented, invented] });
      await expect(t.handler.run('job-1', KICKOFF, NOW)).resolves.toMatchObject({ status: 'persisted', source: 'static' });
      expectStatic(t);
    });

    it('a provider throttle still defers the job (RateLimitError), it is not a failure', async () => {
      const t = setup({ answers: [new AiError('AI_RATE_LIMITED', 'slow down')] });
      await expect(t.handler.run('job-1', KICKOFF, NOW)).rejects.toBeInstanceOf(RateLimitError);
      expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
    });
  });

  it('every persona has a non-empty static kickoff line at every intensity', () => {
    for (const persona of COACH_PERSONAS) {
      for (const level of COACH_INTENSITIES) {
        expect(persona.sampleLines.kickoff[level].trim().length).toBeGreaterThan(0);
      }
    }
    expect(FALLBACK_TITLES.kickoff).toBeTruthy();
  });

  it('the plain nudge path is unchanged: a pause still suppresses a non-kickoff moment', async () => {
    const t = setupNudge({ state: { ...STATE, pausedUntil: new Date('2026-10-04T00:00:00Z') } });
    const outcome = await t.handler.run('job-1', { ...KICKOFF, moment: 'missed_twice', momentKey: 'missed_twice:2026-10-01' }, NOW);
    expect(outcome).toEqual({ status: 'suppressed', reason: 'paused' });
  });
});
