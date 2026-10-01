import { coachNow, type CoachNow } from './coach-time';
import {
  COACH_MOMENT_EVENT,
  COACH_MOMENT_PRIORITY,
  type CoachGoalSignal,
  type CoachMoment,
  type CoachPlanningSettings,
  type CoachPlanningSignals,
  type CoachPlanningState,
  goalAtRiskReason,
  goalMomentKey,
  planCoachMoments,
  type PlannedMoment,
  PUSHY_MOMENTS,
  topNudge,
} from './plan-coach-moments';

// =============================================================================
// planCoachMoments: the activity-goal moments (F9, #269)
// =============================================================================
//
// The week of Monday 2026-09-28 .. Sunday 2026-10-04. Wednesday is 09-30,
// Thursday 10-01, Friday 10-02, Saturday 10-03.
// =============================================================================

const GOAL_A = '00000000-0000-4000-8000-00000000000a';
const GOAL_B = '00000000-0000-4000-8000-00000000000b';
const WEEK = '2026-09-28';

function signalsOf(overrides: Partial<CoachPlanningSignals> = {}): CoachPlanningSignals {
  return {
    missedStreak: 0,
    sessionToday: 'none',
    loggedToday: false,
    missedYesterday: false,
    lastCompletedWorkoutDate: '2026-09-28',
    lastActivityAt: null,
    lastProgressPhotoDate: null,
    safety: { safetyStop: false, painStreak: false, lowReadinessStreak: false },
    event: null,
    ...overrides,
  };
}

function stateOf(overrides: Partial<CoachPlanningState> = {}): CoachPlanningState {
  return {
    lastNudgeAt: null,
    nudgesToday: 0,
    nudgeDayLocal: null,
    consecutiveIgnored: 0,
    pausedUntil: null,
    silencedAt: null,
    usualWorkoutMinuteLocal: null,
    lastWeeklyReviewWeek: null,
    momentsSentToday: [],
    ...overrides,
  };
}

function settingsOf(user: Partial<CoachPlanningSettings['user']> = {}): CoachPlanningSettings {
  return {
    aiEnabled: true,
    system: { enabled: true, maxNudgesPerDayCeiling: 4, autoSilenceAfterIgnored: 3, inactiveStopDays: 7 },
    user: {
      enabled: true,
      quietHours: { start: '21:30', end: '07:30' },
      maxNudgesPerDay: 2,
      photoCadence: 'off',
      preferredTime: null,
      ...user,
    },
    eventEnabled: {},
  };
}

function utcAt(time: string, date: string): CoachNow {
  return coachNow(new Date(`${date}T${time}:00Z`), 'UTC');
}

const DAYS_LEFT: Record<string, number> = {
  '2026-09-28': 7,
  '2026-09-29': 6,
  '2026-09-30': 5,
  '2026-10-01': 4,
  '2026-10-02': 3,
  '2026-10-03': 2,
  '2026-10-04': 1,
};

/** A week goal's signal as `progressForUser` would report it on `date`. */
function weekGoal(date: string, metric: CoachGoalSignal['metric'], done: number, target: number, goalId = GOAL_A): CoachGoalSignal {
  const daysLeft = DAYS_LEFT[date];
  return {
    goalId,
    metric,
    period: 'week',
    periodStart: WEEK,
    done,
    target,
    remaining: Math.max(0, target - done),
    daysLeft,
    elapsedFraction: (7 - daysLeft) / 7,
    hit: done >= target,
  };
}

function dayGoal(date: string, done: number, target: number, metric: CoachGoalSignal['metric'] = 'steps'): CoachGoalSignal {
  return {
    goalId: GOAL_A,
    metric,
    period: 'day',
    periodStart: date,
    done,
    target,
    remaining: Math.max(0, target - done),
    daysLeft: 1,
    elapsedFraction: 0,
    hit: done >= target,
  };
}

function find(plan: PlannedMoment[], moment: CoachMoment): PlannedMoment | undefined {
  return plan.find((m) => m.moment === moment);
}

function outcomeOf(plan: PlannedMoment[], moment: CoachMoment): string {
  const planned = find(plan, moment);
  if (!planned) return 'not_triggered';
  return planned.suppressedBy ?? 'eligible';
}

function sweep(goals: CoachGoalSignal[], now: CoachNow, state = stateOf(), settings = settingsOf()): PlannedMoment[] {
  return planCoachMoments(signalsOf({ goals }), state, settings, now);
}

describe('goal moments: vocabulary', () => {
  it('rank goal_at_risk with streak_at_risk and goal_hit with weekly_target_hit', () => {
    expect(COACH_MOMENT_PRIORITY.goal_at_risk).toBe(COACH_MOMENT_PRIORITY.streak_at_risk);
    expect(COACH_MOMENT_PRIORITY.goal_at_risk).toBeGreaterThan(COACH_MOMENT_PRIORITY.missed_twice);
    expect(COACH_MOMENT_PRIORITY.goal_hit).toBe(COACH_MOMENT_PRIORITY.weekly_target_hit);
  });

  it('goal_at_risk is a nudge (and pushy); goal_hit a celebration', () => {
    expect(COACH_MOMENT_EVENT.goal_at_risk).toBe('coach.nudge');
    expect(COACH_MOMENT_EVENT.goal_hit).toBe('coach.celebration');
    expect(PUSHY_MOMENTS.has('goal_at_risk')).toBe(true);
    expect(PUSHY_MOMENTS.has('goal_hit')).toBe(false);
  });

  it('the dedup key is per moment, goal and period', () => {
    expect(goalMomentKey('goal_at_risk', GOAL_A, WEEK)).toBe(`goal_at_risk:${GOAL_A}:${WEEK}`);
    expect(goalMomentKey('goal_hit', GOAL_A, WEEK).length).toBeLessThanOrEqual(80);
  });
});

describe('goal_at_risk: sessions (week)', () => {
  it.each([
    // [label, date, done, target, expected]
    ['Friday 1/4: remaining 3 == 3 days left, Thursday or later', '2026-10-02', 1, 4, 'sessions_last_chance'],
    ['Wednesday 2/4: remaining 2 < 5 days left', '2026-09-30', 2, 4, null],
    ['Thursday 2/4: remaining 2 < 4 days left', '2026-10-01', 2, 4, null],
    ['Thursday 0/4: remaining 4 == 4 days left', '2026-10-01', 0, 4, 'sessions_last_chance'],
    ['Wednesday 0/5: remaining 5 == 5 days left, but before Thursday', '2026-09-30', 0, 5, null],
    ['Wednesday 0/6: remaining 6 > 5 days left', '2026-09-30', 0, 6, 'sessions_out_of_reach'],
    ['Saturday 1/4: remaining 3 > 2 days left', '2026-10-03', 1, 4, 'sessions_out_of_reach'],
    ['Saturday 4/4: hit', '2026-10-03', 4, 4, null],
  ])('%s', (_label, date, done, target, expected) => {
    expect(goalAtRiskReason(weekGoal(date, 'sessions', done, target), stateOf(), null, utcAt('12:00', date))).toBe(expected);
  });

  it('waits for the morning anchor (09:00, else preferredTime)', () => {
    const goal = weekGoal('2026-10-02', 'sessions', 1, 4);
    expect(goalAtRiskReason(goal, stateOf(), null, utcAt('08:59', '2026-10-02'))).toBeNull();
    expect(goalAtRiskReason(goal, stateOf(), null, utcAt('09:00', '2026-10-02'))).toBe('sessions_last_chance');
    expect(goalAtRiskReason(goal, stateOf(), '07:45', utcAt('08:00', '2026-10-02'))).toBe('sessions_last_chance');
  });
});

describe('goal_at_risk: volume pace (week)', () => {
  // Thursday: 3 of 7 days fully elapsed; 150 minutes -> threshold 0.7 * 150 * 3/7 = 45.
  it.each([
    ['44 of 150 minutes on Thursday is behind 70% of pace', 44, 'behind_pace'],
    ['45 of 150 minutes on Thursday is on 70% of pace', 45, null],
    ['150 of 150 minutes is hit', 150, null],
  ])('%s', (_label, done, expected) => {
    expect(goalAtRiskReason(weekGoal('2026-10-01', 'minutes', done, 150), stateOf(), null, utcAt('12:00', '2026-10-01'))).toBe(expected);
  });

  it('Monday is never behind pace (nothing has elapsed)', () => {
    expect(goalAtRiskReason(weekGoal('2026-09-28', 'steps', 0, 50_000), stateOf(), null, utcAt('12:00', '2026-09-28'))).toBeNull();
  });

  it('applies to steps and distance alike', () => {
    // Saturday: 5/7 elapsed; 20 km -> threshold 0.7 * 20000 * 5/7 = 10000.
    const date = '2026-10-03';
    expect(goalAtRiskReason(weekGoal(date, 'distance_m', 9_999, 20_000), stateOf(), null, utcAt('12:00', date))).toBe('behind_pace');
    expect(goalAtRiskReason(weekGoal(date, 'steps', 10_000, 20_000), stateOf(), null, utcAt('12:00', date))).toBeNull();
  });
});

describe('goal_at_risk: day goals (the evening window)', () => {
  const date = '2026-09-30';
  it('is not evaluated before the streak_at_risk anchor (17:00 by default)', () => {
    expect(goalAtRiskReason(dayGoal(date, 0, 10_000), stateOf(), null, utcAt('16:59', date))).toBeNull();
  });

  it('from the anchor, behind 70% of the day already gone', () => {
    // 17:00: 1020/1440 of the day; threshold 0.7 * 10000 * 0.708 = 4958.
    expect(goalAtRiskReason(dayGoal(date, 4_000, 10_000), stateOf(), null, utcAt('17:00', date))).toBe('day_behind_pace');
    expect(goalAtRiskReason(dayGoal(date, 6_000, 10_000), stateOf(), null, utcAt('17:00', date))).toBeNull();
    expect(goalAtRiskReason(dayGoal(date, 10_000, 10_000), stateOf(), null, utcAt('20:00', date))).toBeNull();
  });

  it('follows the usual workout time like streak_at_risk', () => {
    const state = stateOf({ usualWorkoutMinuteLocal: 12 * 60 });
    expect(goalAtRiskReason(dayGoal(date, 0, 30, 'minutes'), state, null, utcAt('11:29', date))).toBeNull();
    expect(goalAtRiskReason(dayGoal(date, 0, 30, 'minutes'), state, null, utcAt('11:30', date))).toBe('day_behind_pace');
  });
});

describe('goal_at_risk in the plan', () => {
  const friday = utcAt('12:00', '2026-10-02');

  it('is an eligible nudge carrying the goal and its per-period momentKey', () => {
    const plan = sweep([weekGoal('2026-10-02', 'sessions', 1, 4)], friday);
    const top = topNudge(plan);
    expect(top).toMatchObject({
      moment: 'goal_at_risk',
      reason: 'sessions_last_chance',
      goalId: GOAL_A,
      momentKey: `goal_at_risk:${GOAL_A}:${WEEK}`,
      eventKey: 'coach.nudge',
    });
  });

  it('once per goal per period: a sent key is already_sent, every later sweep of the week', () => {
    const goals = [weekGoal('2026-10-02', 'sessions', 1, 4)];
    const sent = stateOf({ goalMomentKeysSent: [`goal_at_risk:${GOAL_A}:${WEEK}`] });
    expect(outcomeOf(sweep(goals, friday, sent), 'goal_at_risk')).toBe('already_sent');
    expect(outcomeOf(sweep([weekGoal('2026-10-03', 'sessions', 1, 4)], utcAt('12:00', '2026-10-03'), sent), 'goal_at_risk')).toBe('already_sent');
  });

  it('a new period is a new key', () => {
    const nextWeek = { ...weekGoal('2026-10-02', 'sessions', 1, 4), periodStart: '2026-10-05' };
    const sent = stateOf({ goalMomentKeysSent: [`goal_at_risk:${GOAL_A}:${WEEK}`] });
    expect(outcomeOf(sweep([nextWeek], friday, sent), 'goal_at_risk')).toBe('eligible');
  });

  it('with several at-risk goals the first unsent one is the candidate', () => {
    const goals = [weekGoal('2026-10-02', 'sessions', 1, 4, GOAL_A), weekGoal('2026-10-02', 'sessions', 0, 3, GOAL_B)];
    const sent = stateOf({ goalMomentKeysSent: [`goal_at_risk:${GOAL_A}:${WEEK}`] });
    expect(topNudge(sweep(goals, friday, sent))).toMatchObject({ moment: 'goal_at_risk', goalId: GOAL_B });
  });

  it('at most one goal_at_risk per local day (the per-day gate still holds)', () => {
    const goals = [weekGoal('2026-10-02', 'sessions', 0, 3, GOAL_B)];
    const state = stateOf({ momentsSentToday: ['goal_at_risk'], goalMomentKeysSent: [`goal_at_risk:${GOAL_A}:${WEEK}`] });
    expect(outcomeOf(sweep(goals, friday, state), 'goal_at_risk')).toBe('already_sent');
  });

  it('shares the daily cap with the plan moments', () => {
    const goals = [weekGoal('2026-10-02', 'sessions', 1, 4)];
    const capped = stateOf({ nudgesToday: 2, nudgeDayLocal: '2026-10-02' });
    expect(outcomeOf(sweep(goals, friday, capped), 'goal_at_risk')).toBe('daily_cap');

    // A user with a plan AND three goals: one nudge per pass, the cap counts them all.
    const many = [
      weekGoal('2026-10-02', 'sessions', 1, 4, GOAL_A),
      weekGoal('2026-10-02', 'sessions', 0, 3, GOAL_B),
      weekGoal('2026-10-02', 'minutes', 0, 150, '00000000-0000-4000-8000-00000000000c'),
    ];
    const plan = planCoachMoments(signalsOf({ missedStreak: 2, goals: many }), stateOf(), settingsOf(), friday);
    expect(plan.filter((m) => m.lane === 'nudge' && m.suppressedBy === null).map((m) => m.moment)).toEqual([
      'missed_twice',
      'goal_at_risk',
    ]);
    expect(topNudge(plan)?.moment).toBe('missed_twice');

    const atCap = planCoachMoments(
      signalsOf({ missedStreak: 2, goals: many }),
      stateOf({ nudgesToday: 2, nudgeDayLocal: '2026-10-02' }),
      settingsOf(),
      friday,
    );
    expect(topNudge(atCap)).toBeNull();
    expect(atCap.map((m) => m.suppressedBy)).toEqual(['daily_cap', 'daily_cap']);
  });

  it('obeys quiet hours, spacing and the pause', () => {
    const goals = [weekGoal('2026-10-02', 'sessions', 1, 4)];
    expect(outcomeOf(sweep(goals, utcAt('22:00', '2026-10-02')), 'goal_at_risk')).toBe('quiet_hours');
    expect(outcomeOf(sweep(goals, friday, stateOf({ lastNudgeAt: new Date('2026-10-02T10:00:00Z') })), 'goal_at_risk')).toBe('spacing');
    expect(outcomeOf(sweep(goals, friday, stateOf({ pausedUntil: new Date('2026-10-03T00:00:00Z') })), 'goal_at_risk')).toBe('paused');
  });

  it('back_off replaces it: after the ignored run only the back-off message is planned', () => {
    const plan = sweep([weekGoal('2026-10-02', 'sessions', 1, 4)], friday, stateOf({ consecutiveIgnored: 3 }));
    expect(plan.map((m) => m.moment)).toEqual(['back_off']);
  });

  it('a silenced coach sends no goal moment', () => {
    const plan = sweep([weekGoal('2026-10-02', 'sessions', 1, 4)], friday, stateOf({ silencedAt: new Date('2026-10-01T12:00:00Z') }));
    expect(outcomeOf(plan, 'goal_at_risk')).toBe('silenced');
  });

  it('the safety register removes it (pushy)', () => {
    const plan = planCoachMoments(
      signalsOf({ goals: [weekGoal('2026-10-02', 'sessions', 1, 4)], safety: { safetyStop: false, painStreak: true, lowReadinessStreak: false } }),
      stateOf(),
      settingsOf(),
      friday,
    );
    expect(outcomeOf(plan, 'goal_at_risk')).toBe('safety_supportive_only');
  });

  it('an event pass never plans it', () => {
    const plan = planCoachMoments(
      signalsOf({ goals: [weekGoal('2026-10-02', 'sessions', 1, 4)], event: { comeback: false, pr: false, weeklyTargetHit: false } }),
      stateOf(),
      settingsOf(),
      friday,
    );
    expect(outcomeOf(plan, 'goal_at_risk')).toBe('not_triggered');
  });
});

describe('goal_hit (event)', () => {
  const now = utcAt('12:00', '2026-09-30');
  const event = (goalHits: Array<{ goalId: string; periodStart: string }>) =>
    signalsOf({ event: { comeback: false, pr: false, weeklyTargetHit: false, goalHits } });

  it('is an eligible celebration with its per-period key', () => {
    const plan = planCoachMoments(event([{ goalId: GOAL_A, periodStart: WEEK }]), stateOf(), settingsOf(), now);
    expect(topNudge(plan)).toMatchObject({
      moment: 'goal_hit',
      reason: 'goal_reached',
      goalId: GOAL_A,
      momentKey: `goal_hit:${GOAL_A}:${WEEK}`,
      eventKey: 'coach.celebration',
    });
  });

  it('is not triggered without a crossing goal', () => {
    expect(outcomeOf(planCoachMoments(event([]), stateOf(), settingsOf(), now), 'goal_hit')).toBe('not_triggered');
  });

  it('once per goal per period', () => {
    const state = stateOf({ goalMomentKeysSent: [`goal_hit:${GOAL_A}:${WEEK}`] });
    expect(outcomeOf(planCoachMoments(event([{ goalId: GOAL_A, periodStart: WEEK }]), state, settingsOf(), now), 'goal_hit')).toBe(
      'already_sent',
    );
  });

  it('ranks with weekly_target_hit, after pr in candidate order, and only one is the nudge', () => {
    const plan = planCoachMoments(
      signalsOf({ event: { comeback: false, pr: true, weeklyTargetHit: true, goalHits: [{ goalId: GOAL_A, periodStart: WEEK }] } }),
      stateOf(),
      settingsOf(),
      now,
    );
    expect(plan.map((m) => m.moment)).toEqual(['pr', 'weekly_target_hit', 'goal_hit']);
    expect(topNudge(plan)?.moment).toBe('pr');
  });

  it('is supportive: the safety register lets it through, the switches and the cap do not', () => {
    const hits = [{ goalId: GOAL_A, periodStart: WEEK }];
    const unsafe = signalsOf({
      event: { comeback: false, pr: false, weeklyTargetHit: false, goalHits: hits },
      safety: { safetyStop: true, painStreak: false, lowReadinessStreak: false },
    });
    expect(outcomeOf(planCoachMoments(unsafe, stateOf(), settingsOf(), now), 'goal_hit')).toBe('eligible');
    expect(
      outcomeOf(planCoachMoments(event(hits), stateOf({ nudgesToday: 2, nudgeDayLocal: '2026-09-30' }), settingsOf(), now), 'goal_hit'),
    ).toBe('daily_cap');
    expect(
      outcomeOf(planCoachMoments(event(hits), stateOf({ silencedAt: new Date('2026-09-29T00:00:00Z') }), settingsOf(), now), 'goal_hit'),
    ).toBe('silenced');
    const off = { ...settingsOf(), eventEnabled: { 'coach.celebration': false } };
    expect(outcomeOf(planCoachMoments(event(hits), stateOf(), off, now), 'goal_hit')).toBe('pref_off');
  });
});
