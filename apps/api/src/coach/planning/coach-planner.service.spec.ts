import type { GoalProgressData } from '../../activity/goal-progress.service';
import { evaluateGoal } from '../../activity/goal-progress';
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
  /** `ProgressPhotoSummaryService.summarize(...).lastLocalDate`; null (no photos) by default. */
  lastPhotoLocalDate?: string | null;
  /** `GoalProgressService.progressForUser`; [] by default, an Error to make the read fail. */
  goals?: GoalProgressData[] | Error;
  /** `momentKey`s of goal messages already sent. */
  goalKeysSent?: string[];
  /** The newest manual activity entry's `createdAt`. */
  lastCheckInAt?: Date | null;
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
    coachMessage: {
      findMany: jest.fn(async (args: { where: { moment?: unknown } }) =>
        args.where.moment ? (options.goalKeysSent ?? []).map((momentKey) => ({ data: { momentKey } })) : (options.messages ?? []),
      ),
    },
    activityEntry: { findFirst: jest.fn(async () => (options.lastCheckInAt ? { createdAt: options.lastCheckInAt } : null)) },
    program: { findFirst: jest.fn(async () => null) },
    trainingPlanRun: { findFirst: jest.fn(async () => null) },
  };
  const signals = { forUser: jest.fn(async () => options.signals ?? planSignals()) };
  const enqueuer = {
    enqueueNudge: jest.fn(async () => (options.enqueue === 'handler_missing' ? { status: 'handler_missing' } : { status: 'enqueued', jobId: 'job-n' })),
    enqueueWeeklyReview: jest.fn(async () => ({ status: 'enqueued', jobId: 'job-r' })),
  };
  const metrics = { suppressed: jest.fn(), invalidTimeZone: jest.fn(), momentPlanned: jest.fn() };
  const lastLocalDate = options.lastPhotoLocalDate ?? null;
  const photoSummary = {
    summarize: jest.fn(async () => ({
      count: lastLocalDate ? 1 : 0,
      lastLocalDate,
      byPose: { front: lastLocalDate ? 1 : 0, side: 0, back: 0, other: 0 },
    })),
  };
  const goals = {
    progressForUser: jest.fn(async () => {
      if (options.goals instanceof Error) throw options.goals;
      return options.goals ?? [];
    }),
  };
  const service = new CoachPlannerService(
    prisma as never,
    signals as never,
    enqueuer as never,
    metrics as never,
    photoSummary as never,
    goals as never,
  );
  return { service, prisma, signals, enqueuer, metrics, photoSummary, goals };
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

  describe('photo cadence (reads ProgressPhotoSummaryService, never prisma.progressPhoto)', () => {
    const MORNING = new Date('2026-09-30T10:00:00Z');
    const photoCtx = () =>
      ctx({ now: MORNING, settingsValue: { coach: { enabled: true, photoCadence: 'weekly' } } });
    // The photo prompt rides a training day: a session planned for today.
    const TRAINING_DAY = planSignals({
      sessions: [
        { programWorkoutId: '00000000-0000-4000-8000-000000000102', name: 'B', plannedFor: '2026-09-30', status: 'upcoming', workoutId: null, setsPlanned: 5, setsDone: 0, completionPct: null, avgRpe: null },
      ],
    });

    it('reads the newest photo day through the summary service only', async () => {
      const t = setup({ signals: TRAINING_DAY, lastPhotoLocalDate: '2026-09-28' });
      await t.service.planUser(USER, photoCtx());
      expect(t.photoSummary.summarize).toHaveBeenCalledWith(USER);
      expect(t.prisma).not.toHaveProperty('progressPhoto');
    });

    it('does not prompt while the last photo is inside the cadence', async () => {
      const t = setup({ signals: TRAINING_DAY, lastPhotoLocalDate: '2026-09-28' });
      const outcome = await t.service.planUser(USER, photoCtx());
      expect(outcome.queued).not.toBe('photo_prompt');
    });

    it('prompts once the summary\'s lastLocalDate is a full cadence old', async () => {
      const t = setup({ signals: TRAINING_DAY, lastPhotoLocalDate: '2026-09-20' });
      const outcome = await t.service.planUser(USER, photoCtx());
      expect(outcome.queued).toBe('photo_prompt');
    });
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

// -----------------------------------------------------------------------------
// Activity goals (F9, #269)
// -----------------------------------------------------------------------------

const GOAL = '00000000-0000-4000-8000-00000000090a';
const WEEK = '2026-09-28';

interface EntrySpec {
  day: string;
  createdAt: Date;
  source?: 'manual' | 'workout';
  workoutId?: string | null;
  durationSeconds?: number | null;
}

let entrySeq = 0;
function entry(spec: EntrySpec) {
  entrySeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(entrySeq).padStart(12, '0')}`,
    occurredOn: spec.day,
    occurredAt: null,
    activityKind: 'walk' as const,
    completed: true,
    durationSeconds: spec.durationSeconds ?? null,
    steps: null,
    distanceMeters: null,
    source: spec.source ?? ('manual' as const),
    workoutId: spec.workoutId ?? null,
    provider: null,
    note: null,
    createdAt: spec.createdAt.toISOString(),
    updatedAt: spec.createdAt.toISOString(),
  };
}

/** A goal's progress on Wednesday 2026-09-30, counted by the real activity rules. */
function goalProgress(metric: 'sessions' | 'minutes', target: number, entries: ReturnType<typeof entry>[]): GoalProgressData {
  const goal = { id: GOAL, activityKind: 'walk' as const, metric, target, period: 'week' as const, startsOn: '2026-09-01' };
  const evaluation = evaluateGoal(goal, entries, '2026-09-30');
  return {
    goalId: GOAL,
    goal: {
      id: GOAL,
      title: 'Walk four times',
      activityKind: 'walk',
      customLabel: null,
      metric,
      target,
      period: 'week',
      status: 'active',
      startsOn: '2026-09-01',
      version: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    periodStart: evaluation.periodStart,
    periodEnd: evaluation.periodEnd,
    done: evaluation.done,
    target: evaluation.target,
    remaining: evaluation.remaining,
    daysLeft: evaluation.daysLeft,
    onTrack: evaluation.onTrack,
    hit: evaluation.hit,
    streakPeriods: evaluation.streakPeriods,
    elapsedFraction: evaluation.elapsedFraction,
    entries: evaluation.entries,
  };
}

const EARLIER = new Date(NOW.getTime() - DAY);
const JUST_NOW = new Date(NOW.getTime() - 1_000);
const RECORDED_SINCE = new Date(NOW.getTime() - 2_000);

describe('CoachPlannerService.planUser: activity goals', () => {
  it('sweep: a goal behind pace queues goal_at_risk with its per-period momentKey', async () => {
    // Wednesday: 2/7 of the week elapsed; 150 minutes -> threshold 30.
    const t = setup({ goals: [goalProgress('minutes', 150, [])] });

    const outcome = await t.service.planUser(USER, ctx());

    expect(t.goals.progressForUser).toHaveBeenCalledWith(USER, undefined, NOW);
    expect(outcome.queued).toBe('goal_at_risk');
    expect(t.enqueuer.enqueueNudge).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ moment: 'goal_at_risk', goalId: GOAL, momentKey: `goal_at_risk:${GOAL}:${WEEK}` }),
      expect.any(Array),
      '2026-09-30',
      'sweep',
    );
  });

  it('sweep: once per goal per period (the sent key is read back from the coach messages)', async () => {
    const t = setup({ goals: [goalProgress('minutes', 150, [])], goalKeysSent: [`goal_at_risk:${GOAL}:${WEEK}`] });

    const outcome = await t.service.planUser(USER, ctx());

    expect(outcome.queued).toBeNull();
    expect(t.metrics.suppressed).toHaveBeenCalledWith('already_sent', 'goal_at_risk');
  });

  it('sweep: the plan moment outranks the goal and only one nudge is queued', async () => {
    const t = setup({ signals: MISSED_TWICE, goals: [goalProgress('minutes', 150, [])] });
    const outcome = await t.service.planUser(USER, ctx());
    expect(outcome.queued).toBe('missed_twice');
    expect(t.enqueuer.enqueueNudge).toHaveBeenCalledTimes(1);
  });

  it('sweep: a failing goal read is logged and the plan moments still go out', async () => {
    const t = setup({ signals: MISSED_TWICE, goals: new Error('db down') });
    const outcome = await t.service.planUser(USER, ctx());
    expect(outcome.queued).toBe('missed_twice');
  });

  it('check-in: the one that reaches the target queues goal_hit', async () => {
    const entries = [1, 2, 3].map(() => entry({ day: '2026-09-29', createdAt: EARLIER }));
    entries.push(entry({ day: '2026-09-30', createdAt: JUST_NOW }));
    const t = setup({ goals: [goalProgress('sessions', 4, entries)] });

    const outcome = await t.service.planUser(USER, ctx({ trigger: 'activity_recorded', recordedSince: RECORDED_SINCE }));

    expect(outcome.queued).toBe('goal_hit');
    expect(t.enqueuer.enqueueNudge).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ moment: 'goal_hit', goalId: GOAL, momentKey: `goal_hit:${GOAL}:${WEEK}` }),
      expect.any(Array),
      '2026-09-30',
      'activity_recorded',
    );
  });

  it('check-in: a later check-in in an already-hit period queues nothing', async () => {
    const entries = [1, 2, 3, 4].map(() => entry({ day: '2026-09-29', createdAt: EARLIER }));
    entries.push(entry({ day: '2026-09-30', createdAt: JUST_NOW }));
    const t = setup({ goals: [goalProgress('sessions', 4, entries)] });

    const outcome = await t.service.planUser(USER, ctx({ trigger: 'activity_recorded', recordedSince: RECORDED_SINCE }));

    expect(outcome.queued).toBeNull();
    expect(t.enqueuer.enqueueNudge).not.toHaveBeenCalled();
  });

  it('check-in: a check-in short of the target queues nothing, and no clock-driven moment either', async () => {
    const t = setup({
      signals: MISSED_TWICE,
      goals: [goalProgress('sessions', 4, [entry({ day: '2026-09-30', createdAt: JUST_NOW })])],
    });
    const outcome = await t.service.planUser(USER, ctx({ trigger: 'activity_recorded', recordedSince: RECORDED_SINCE }));
    expect(outcome.queued).toBeNull();
  });

  it('check-in: a goal_hit already sent this period is not sent again', async () => {
    const entries = [1, 2, 3].map(() => entry({ day: '2026-09-29', createdAt: EARLIER }));
    entries.push(entry({ day: '2026-09-30', createdAt: JUST_NOW }));
    const t = setup({ goals: [goalProgress('sessions', 4, entries)], goalKeysSent: [`goal_hit:${GOAL}:${WEEK}`] });
    const outcome = await t.service.planUser(USER, ctx({ trigger: 'activity_recorded', recordedSince: RECORDED_SINCE }));
    expect(outcome.queued).toBeNull();
    expect(t.metrics.suppressed).toHaveBeenCalledWith('already_sent', 'goal_hit');
  });

  it('check-in: shares the daily cap with the plan moments', async () => {
    const entries = [1, 2, 3].map(() => entry({ day: '2026-09-29', createdAt: EARLIER }));
    entries.push(entry({ day: '2026-09-30', createdAt: JUST_NOW }));
    const t = setup({
      goals: [goalProgress('sessions', 4, entries)],
      state: { nudgesToday: 2, nudgeDayLocal: new Date('2026-09-30T00:00:00Z') },
    });
    const outcome = await t.service.planUser(USER, ctx({ trigger: 'activity_recorded', recordedSince: RECORDED_SINCE }));
    expect(outcome.queued).toBeNull();
    expect(t.metrics.suppressed).toHaveBeenCalledWith('daily_cap', 'goal_hit');
  });

  it('check-in: counts as engagement and clears the silence', async () => {
    const t = setup({
      state: { silencedAt: new Date(NOW.getTime() - 3 * DAY) },
      lastCheckInAt: JUST_NOW,
    });
    await t.service.planUser(USER, ctx({ trigger: 'activity_recorded', recordedSince: RECORDED_SINCE }));
    expect(updateData(t)).toMatchObject({ silencedAt: null });
  });

  it('finished workout: the workout whose derived entry reaches the target queues goal_hit', async () => {
    const entries = [1, 2, 3].map(() => entry({ day: '2026-09-29', createdAt: EARLIER }));
    entries.push(entry({ day: '2026-09-30', createdAt: EARLIER, source: 'workout', workoutId: WORKOUT }));
    const t = setup({ goals: [goalProgress('sessions', 4, entries)] });

    const outcome = await t.service.planUser(USER, ctx({ trigger: 'workout_finished', workoutId: WORKOUT }));

    expect(outcome.queued).toBe('goal_hit');
  });

  it('finished workout: another workout\'s entry crossing earlier is not this workout\'s goal_hit', async () => {
    const other = '00000000-0000-4000-8000-0000000000bb';
    const entries = [1, 2, 3].map(() => entry({ day: '2026-09-29', createdAt: EARLIER }));
    entries.push(entry({ day: '2026-09-30', createdAt: EARLIER, source: 'workout', workoutId: other }));
    const t = setup({ goals: [goalProgress('sessions', 4, entries)] });
    const outcome = await t.service.planUser(USER, ctx({ trigger: 'workout_finished', workoutId: WORKOUT }));
    expect(outcome.queued).toBeNull();
  });
});
