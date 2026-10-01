import type { PlanSignals } from '../../programs/signals/plan-signals.contract';
import { coachEventEnabled, coachUserSettingsOf, CoachPlannerService, type CoachPlanContext } from './coach-planner.service';

// E7.4: one user's pass with a mocked Prisma: bookkeeping, enqueue, silence.

const USER = '00000000-0000-4000-8000-000000000001';
const WORKOUT = '00000000-0000-4000-8000-0000000000aa';
// Wednesday 2026-09-30 12:00 UTC.
const NOW = new Date('2026-09-30T12:00:00Z');
const DAY = 86_400_000;

const SYSTEM = {
  enabled: true,
  allowProfanePersonas: false,
  allowAudio: true,
  maxNudgesPerDayCeiling: 4,
  audioRetentionDays: 30,
  autoSilenceAfterIgnored: 3,
  inactiveStopDays: 7,
};

function planSignals(overrides: Partial<PlanSignals> = {}): PlanSignals {
  return {
    range: { from: '2026-08-10', to: '2026-10-07' },
    asOf: '2026-09-30',
    programId: null,
    planVersion: null,
    weeksInRange: 9,
    truncated: false,
    planChangedOn: null,
    adherence: {
      weeks: [],
      totals: { planned: 0, completed: 0, partialSessions: 0, missed: 0, extra: 0, adherencePct: null },
      missedStreak: 0,
      completedStreak: 0,
    },
    frequency: { avgPerWeek: null, perWeek: [] },
    sessions: [],
    volume: [],
    performance: [],
    effort: { avgRpe: null, setsAtRpe9Plus: 0, rpeTrend: 'insufficient' },
    pain: [],
    readiness: { days: 0, avg: null, lowDays: 0, lowStreak: 0 },
    body: { weightKg: { latest: null, changePerWeek: null, points: 0 }, bodyFatPct: null },
    ...overrides,
  };
}

interface Setup {
  state?: Record<string, unknown>;
  signals?: PlanSignals;
  messages?: Array<{ role: string; moment: string | null; createdAt: Date; deliveredAt: Date | null; openedAt: Date | null }>;
  lastWorkout?: { date: Date; startedAt: Date; endedAt: Date | null } | null;
  recentStarts?: Date[];
  enqueue?: 'enqueued' | 'handler_missing';
  finishedWorkout?: { date: Date } | null;
}

function setup(options: Setup = {}) {
  const state = {
    id: 'state-1',
    userId: USER,
    lastNudgeAt: null,
    nudgesToday: 0,
    nudgeDayLocal: null,
    consecutiveIgnored: 0,
    pausedUntil: null,
    silencedAt: null,
    lastSweepAt: null,
    usualWorkoutMinuteLocal: null,
    weeklyStreak: 0,
    streakPassesLeft: 0,
    lastWeeklyReviewWeek: null,
    createdAt: new Date(NOW.getTime() - 2 * DAY),
    updatedAt: NOW,
    ...options.state,
  };
  const prisma = {
    coachState: { upsert: jest.fn(async () => state), update: jest.fn(async () => state) },
    workout: {
      findMany: jest.fn(async () => (options.recentStarts ?? []).map((startedAt) => ({ startedAt }))),
      findFirst: jest.fn(async (args: { where: { id?: string } }) =>
        args.where.id ? (options.finishedWorkout === undefined ? { date: new Date('2026-09-30T00:00:00Z') } : options.finishedWorkout) : (options.lastWorkout ?? null),
      ),
    },
    coachMessage: { findMany: jest.fn(async () => options.messages ?? []) },
    progressPhoto: { findFirst: jest.fn(async () => null) },
    program: { findFirst: jest.fn(async () => null) },
    trainingPlanRun: { findFirst: jest.fn(async () => null) },
  };
  const signals = { forUser: jest.fn(async () => options.signals ?? planSignals()) };
  const enqueuer = {
    enqueueNudge: jest.fn(async () => (options.enqueue === 'handler_missing' ? { status: 'handler_missing' } : { status: 'enqueued', jobId: 'job-n' })),
    enqueueWeeklyReview: jest.fn(async () => ({ status: 'enqueued', jobId: 'job-r' })),
  };
  const metrics = { suppressed: jest.fn(), invalidTimeZone: jest.fn(), momentPlanned: jest.fn() };
  const service = new CoachPlannerService(prisma as never, signals as never, enqueuer as never, metrics as never);
  return { service, prisma, signals, enqueuer, metrics };
}

function ctx(overrides: Partial<CoachPlanContext> = {}): CoachPlanContext {
  return {
    now: NOW,
    trigger: 'sweep',
    timeZone: 'UTC',
    settingsValue: { coach: { enabled: true } },
    aiEnabled: true,
    system: SYSTEM,
    notificationPolicy: { browserEnabled: true, disabledEvents: [] },
    ...overrides,
  };
}

const MISSED_TWICE = planSignals({ adherence: { ...planSignals().adherence, missedStreak: 2 } });

function updateData(t: ReturnType<typeof setup>): Record<string, unknown> {
  const calls = t.prisma.coachState.update.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
  return calls[calls.length - 1][0].data;
}

describe('CoachPlannerService.planUser', () => {
  it('creates the state lazily, reads the signals 7 days past today and enqueues the top moment', async () => {
    const t = setup({ signals: MISSED_TWICE });

    const outcome = await t.service.planUser(USER, ctx());

    expect(t.prisma.coachState.upsert).toHaveBeenCalledWith({ where: { userId: USER }, create: { userId: USER }, update: {} });
    expect(t.signals.forUser).toHaveBeenCalledWith(USER, { to: '2026-10-07' }, NOW);
    expect(outcome.queued).toBe('missed_twice');
    expect(t.enqueuer.enqueueNudge).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ moment: 'missed_twice' }),
      [expect.objectContaining({ moment: 'missed_twice' })],
      '2026-09-30',
      'sweep',
    );
  });

  it('bookkeeping: resets the day counter, stamps lastSweepAt and stores the 4-week median', async () => {
    const starts = [1, 2, 3, 4, 5].map((d) => new Date(NOW.getTime() - d * DAY - 3 * 3_600_000)); // 09:00 UTC
    const t = setup({
      state: { nudgesToday: 2, nudgeDayLocal: new Date('2026-09-29T00:00:00Z') },
      recentStarts: starts,
    });

    await t.service.planUser(USER, ctx());

    expect(updateData(t)).toMatchObject({
      nudgesToday: 0,
      nudgeDayLocal: new Date('2026-09-30T00:00:00Z'),
      lastSweepAt: NOW,
      usualWorkoutMinuteLocal: 9 * 60,
      consecutiveIgnored: 0,
      silencedAt: null,
    });
  });

  it('keeps the counter on the same local day and leaves lastSweepAt alone for an event pass', async () => {
    const t = setup({ state: { nudgesToday: 1, nudgeDayLocal: new Date('2026-09-30T00:00:00Z') } });
    await t.service.planUser(USER, ctx({ trigger: 'workout_finished', workoutId: WORKOUT }));
    const data = updateData(t);
    expect(data).not.toHaveProperty('nudgesToday');
    expect(data).not.toHaveProperty('lastSweepAt');
  });

  it('counts ignored messages; at the threshold it queues the back-off and sets silencedAt', async () => {
    const delivered = (hoursAgo: number) => ({
      role: 'coach',
      moment: 'missed_session',
      createdAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
      deliveredAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
      openedAt: null,
    });
    const t = setup({ signals: MISSED_TWICE, messages: [delivered(30), delivered(54), delivered(78)] });

    const outcome = await t.service.planUser(USER, ctx());

    expect(outcome.queued).toBe('back_off');
    expect(updateData(t)).toMatchObject({ consecutiveIgnored: 3, silencedAt: NOW });
  });

  it('a back-off whose handler is missing changes nothing: no silence, planned again next pass', async () => {
    const delivered = (hoursAgo: number) => ({
      role: 'coach',
      moment: 'missed_session',
      createdAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
      deliveredAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
      openedAt: null,
    });
    const t = setup({ messages: [delivered(30), delivered(54), delivered(78)], enqueue: 'handler_missing' });

    const outcome = await t.service.planUser(USER, ctx());

    expect(outcome.queued).toBeNull();
    expect(updateData(t)).toMatchObject({ silencedAt: null });
  });

  it('re-engagement after the silence (a logged workout) clears silencedAt and the ignored run', async () => {
    const silencedAt = new Date(NOW.getTime() - 3 * DAY);
    const t = setup({
      state: { silencedAt, consecutiveIgnored: 3 },
      lastWorkout: { date: new Date('2026-09-30T00:00:00Z'), startedAt: new Date(NOW.getTime() - 2 * 3_600_000), endedAt: new Date(NOW.getTime() - 3_600_000) },
      messages: [
        { role: 'coach', moment: 'back_off', createdAt: silencedAt, deliveredAt: silencedAt, openedAt: null },
      ],
    });

    await t.service.planUser(USER, ctx());

    expect(updateData(t)).toMatchObject({ silencedAt: null, consecutiveIgnored: 0 });
  });

  it('stays silenced without re-engagement', async () => {
    const silencedAt = new Date(NOW.getTime() - 3 * DAY);
    const t = setup({ signals: MISSED_TWICE, state: { silencedAt } });

    const outcome = await t.service.planUser(USER, ctx());

    expect(outcome.queued).toBeNull();
    expect(t.metrics.suppressed).toHaveBeenCalledWith('silenced', 'missed_twice');
    expect(updateData(t)).toMatchObject({ silencedAt });
  });

  it('win-back after 7 inactive days: queued once and silencedAt set', async () => {
    const t = setup({ state: { createdAt: new Date(NOW.getTime() - 30 * DAY) } });
    const outcome = await t.service.planUser(USER, ctx());
    expect(outcome.queued).toBe('win_back');
    expect(updateData(t)).toMatchObject({ silencedAt: NOW });
  });

  it('a moment already sent today (in the user\'s zone) is not queued again', async () => {
    const t = setup({
      signals: MISSED_TWICE,
      messages: [{ role: 'coach', moment: 'missed_twice', createdAt: new Date(NOW.getTime() - 4 * 3_600_000), deliveredAt: null, openedAt: null }],
    });
    const outcome = await t.service.planUser(USER, ctx());
    expect(outcome.queued).toBeNull();
    expect(t.metrics.suppressed).toHaveBeenCalledWith('already_sent', 'missed_twice');
  });

  it('counts an unknown zone and plans in UTC', async () => {
    const t = setup({ signals: MISSED_TWICE });
    await t.service.planUser(USER, ctx({ timeZone: 'Nowhere/Land' }));
    expect(t.metrics.invalidTimeZone).toHaveBeenCalledTimes(1);
    expect(t.enqueuer.enqueueNudge).toHaveBeenCalled();
  });

  it('queues the weekly review in its own lane on Sunday evening', async () => {
    const t = setup({ signals: MISSED_TWICE });
    const sunday = new Date('2026-10-04T18:30:00Z');
    await t.service.planUser(USER, ctx({ now: sunday }));
    expect(t.enqueuer.enqueueWeeklyReview).toHaveBeenCalledWith(USER, '2026-W40');
  });

  describe('after a finished workout', () => {
    it('plans a comeback when a planned session was missed this week, and nothing clock-driven', async () => {
      const signals = planSignals({
        adherence: { ...planSignals().adherence, missedStreak: 0 },
        sessions: [
          { programWorkoutId: '00000000-0000-4000-8000-000000000101', name: 'A', plannedFor: '2026-09-28', status: 'missed', workoutId: null, setsPlanned: 5, setsDone: 0, completionPct: null, avgRpe: null },
        ],
      });
      const t = setup({ signals });

      const outcome = await t.service.planUser(USER, ctx({ trigger: 'workout_finished', workoutId: WORKOUT }));

      expect(outcome.queued).toBe('comeback');
      expect(t.enqueuer.enqueueNudge).toHaveBeenCalledWith(USER, expect.objectContaining({ moment: 'comeback' }), expect.any(Array), '2026-09-30', 'workout_finished');
    });

    it('does not enqueue when a gate suppresses it (quiet hours)', async () => {
      const signals = planSignals({
        sessions: [
          { programWorkoutId: '00000000-0000-4000-8000-000000000101', name: 'A', plannedFor: '2026-09-28', status: 'missed', workoutId: null, setsPlanned: 5, setsDone: 0, completionPct: null, avgRpe: null },
        ],
      });
      const t = setup({ signals });
      await t.service.planUser(USER, ctx({ trigger: 'workout_finished', workoutId: WORKOUT, now: new Date('2026-09-30T22:30:00Z') }));
      expect(t.enqueuer.enqueueNudge).not.toHaveBeenCalled();
      expect(t.metrics.suppressed).toHaveBeenCalledWith('quiet_hours', 'comeback');
    });

    it('ignores a workout that is not the user\'s completed one', async () => {
      const t = setup({ finishedWorkout: null });
      const outcome = await t.service.planUser(USER, ctx({ trigger: 'workout_finished', workoutId: WORKOUT }));
      expect(outcome).toEqual({ queued: null, weeklyReviewQueued: false, suppressed: 0 });
      expect(t.prisma.coachState.upsert).not.toHaveBeenCalled();
    });
  });
});

describe('coachUserSettingsOf / coachEventEnabled', () => {
  it('applies the defaults, and treats a malformed namespace as absent (off)', () => {
    expect(coachUserSettingsOf(null).enabled).toBe(false);
    expect(coachUserSettingsOf({ coach: { enabled: true, maxNudgesPerDay: 3 } })).toMatchObject({ enabled: true, maxNudgesPerDay: 3 });
    expect(coachUserSettingsOf({ coach: { enabled: true, bogus: 1 } }).enabled).toBe(false);
  });

  it('treats coach events this build does not declare as on', () => {
    expect(coachEventEnabled({})).toEqual({
      'coach.nudge': true,
      'coach.celebration': true,
      'coach.photo_prompt': true,
      'coach.weekly_review': true,
    });
  });
});
