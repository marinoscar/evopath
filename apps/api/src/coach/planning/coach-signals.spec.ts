import type { PlanSignals, PlannedSessionSignal } from '../../programs/signals/plan-signals.contract';
import {
  advanceWeeklyStreak,
  consecutiveIgnoredOf,
  nextSessionOf,
  toCoachPlanningSignals,
  weeklyTargetOf,
  workoutEventOf,
} from './coach-signals';

let seq = 0;
function session(plannedFor: string, status: PlannedSessionSignal['status'], name = 'Session'): PlannedSessionSignal {
  seq += 1;
  return {
    programWorkoutId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    name,
    plannedFor,
    status,
    workoutId: null,
    setsPlanned: 10,
    setsDone: status === 'done' ? 10 : 0,
    completionPct: null,
    avgRpe: null,
  };
}

function signalsWith(overrides: Partial<PlanSignals> = {}): PlanSignals {
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

const EXTRAS = {
  today: '2026-09-30',
  lastCompletedWorkoutDate: '2026-09-28',
  lastActivityAt: null,
  lastProgressPhotoDate: null,
  safetyStop: false,
};

describe('toCoachPlanningSignals', () => {
  it('reads today\'s session, yesterday\'s miss, the streak and the safety flags from the signals', () => {
    const signals = signalsWith({
      sessions: [session('2026-09-29', 'missed'), session('2026-09-30', 'upcoming')],
      adherence: { ...signalsWith().adherence, missedStreak: 2 },
      pain: [{ exerciseId: '00000000-0000-4000-8000-000000000999', slug: 'squat', name: 'Squat', lastFlaggedOn: '2026-09-28', flaggedSessions28d: 2, consecutiveFlaggedSessions: 2 }],
      readiness: { days: 3, avg: null, lowDays: 1, lowStreak: 1 },
    });
    expect(toCoachPlanningSignals(signals, EXTRAS)).toMatchObject({
      missedStreak: 2,
      sessionToday: 'planned',
      loggedToday: false,
      missedYesterday: true,
      safety: { safetyStop: false, painStreak: true, lowReadinessStreak: false },
      event: null,
    });
  });

  it.each([
    [[], 'none'],
    [['done'], 'done'],
    [['partial'], 'done'],
    [['done', 'upcoming'], 'planned'],
    [['in_progress'], 'planned'],
  ] as const)('today with sessions %p is %s', (statuses, expected) => {
    const signals = signalsWith({ sessions: statuses.map((s) => session('2026-09-30', s)) });
    expect(toCoachPlanningSignals(signals, EXTRAS).sessionToday).toBe(expected);
  });

  it('a workout completed today is logged; a low-readiness streak of 2 days counts', () => {
    const view = toCoachPlanningSignals(signalsWith({ readiness: { days: 2, avg: null, lowDays: 2, lowStreak: 2 } }), {
      ...EXTRAS,
      lastCompletedWorkoutDate: '2026-09-30',
      safetyStop: true,
    });
    expect(view.loggedToday).toBe(true);
    expect(view.safety).toEqual({ safetyStop: true, painStreak: false, lowReadinessStreak: true });
  });
});

describe('workoutEventOf', () => {
  it('a workout after a miss in the last 7 days is a comeback', () => {
    const signals = signalsWith({ sessions: [session('2026-09-26', 'missed'), session('2026-09-30', 'done')] });
    expect(workoutEventOf(signals, '2026-09-30').comeback).toBe(true);
    const old = signalsWith({ sessions: [session('2026-09-20', 'missed'), session('2026-09-30', 'done')] });
    expect(workoutEventOf(old, '2026-09-30').comeback).toBe(false);
  });

  it('a PR whose latest top set is that day is a pr', () => {
    const lift = {
      exerciseId: '00000000-0000-4000-8000-000000000777',
      slug: 'bench',
      name: 'Bench',
      sessions: 4,
      best: { weightKg: 100, reps: 5, e1rmKg: 116 },
      lastTopSets: [{ date: '2026-09-30', weightKg: 100, reps: 5, rpe: null }],
      trend: 'up' as const,
      trendPct: 5,
      prInRange: true,
    };
    expect(workoutEventOf(signalsWith({ performance: [lift] }), '2026-09-30').pr).toBe(true);
    expect(workoutEventOf(signalsWith({ performance: [{ ...lift, prInRange: false }] }), '2026-09-30').pr).toBe(false);
    expect(workoutEventOf(signalsWith({ performance: [lift] }), '2026-10-01').pr).toBe(false);
  });

  it('the workout that reaches the week\'s planned count hits the target, once', () => {
    const hit = signalsWith({
      sessions: [session('2026-09-28', 'done'), session('2026-09-30', 'done')],
    });
    expect(workoutEventOf(hit, '2026-09-30').weeklyTargetHit).toBe(true);
    const notYet = signalsWith({
      sessions: [session('2026-09-28', 'done'), session('2026-09-30', 'done'), session('2026-10-02', 'upcoming')],
    });
    expect(workoutEventOf(notYet, '2026-09-30').weeklyTargetHit).toBe(false);
    const extra = signalsWith({ sessions: [session('2026-09-28', 'done'), session('2026-09-29', 'done')] });
    expect(workoutEventOf(extra, '2026-09-30').weeklyTargetHit).toBe(false);
  });
});

describe('weeklyTargetOf and nextSessionOf (the header)', () => {
  const signals = signalsWith({
    sessions: [
      session('2026-09-25', 'done'), // last week
      session('2026-09-28', 'done'),
      session('2026-09-29', 'missed'),
      session('2026-10-02', 'upcoming', 'Pull'),
      session('2026-10-05', 'upcoming', 'Legs'), // next week
    ],
  });

  it('counts the current ISO week only', () => {
    expect(weeklyTargetOf(signals, '2026-09-30')).toEqual({ planned: 3, done: 1 });
  });

  it('the next session is the first not done from today on', () => {
    expect(nextSessionOf(signals, '2026-09-30')).toMatchObject({ date: '2026-10-02', name: 'Pull' });
    expect(nextSessionOf(signals, '2026-10-03')).toMatchObject({ date: '2026-10-05', name: 'Legs' });
    expect(nextSessionOf(signals, '2026-10-06')).toBeNull();
  });
});

describe('consecutiveIgnoredOf', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const msg = (deliveredHoursAgo: number | null, opened = false) => ({
    deliveredAt: deliveredHoursAgo === null ? null : hoursAgo(deliveredHoursAgo),
    openedAt: opened ? hoursAgo(1) : null,
  });

  it('counts delivered, unopened messages older than 24 hours in a row, newest first', () => {
    expect(consecutiveIgnoredOf([msg(30), msg(50), msg(80)], null, now)).toBe(3);
    expect(consecutiveIgnoredOf([msg(30), msg(50, true), msg(80)], null, now)).toBe(1);
  });

  it('a message younger than 24 hours neither counts nor breaks the run; an undelivered one is skipped', () => {
    expect(consecutiveIgnoredOf([msg(2), msg(null), msg(30), msg(50)], null, now)).toBe(2);
  });

  it('stops at the last engagement (an open, a chat message, a workout)', () => {
    expect(consecutiveIgnoredOf([msg(30), msg(50), msg(80)], hoursAgo(60), now)).toBe(2);
  });
});

describe('advanceWeeklyStreak (spec §2.11)', () => {
  it.each([
    // state, week, expected
    [{ weeklyStreak: 2, streakPassesLeft: 0 }, { completed: 3, target: 3, protectedWeek: false }, { weeklyStreak: 3, streakPassesLeft: 0 }],
    [{ weeklyStreak: 3, streakPassesLeft: 0 }, { completed: 3, target: 3, protectedWeek: false }, { weeklyStreak: 4, streakPassesLeft: 1 }],
    [{ weeklyStreak: 7, streakPassesLeft: 1 }, { completed: 4, target: 3, protectedWeek: false }, { weeklyStreak: 8, streakPassesLeft: 1 }],
    [{ weeklyStreak: 5, streakPassesLeft: 1 }, { completed: 1, target: 3, protectedWeek: false }, { weeklyStreak: 5, streakPassesLeft: 0 }],
    [{ weeklyStreak: 5, streakPassesLeft: 0 }, { completed: 1, target: 3, protectedWeek: false }, { weeklyStreak: 0, streakPassesLeft: 0 }],
    [{ weeklyStreak: 5, streakPassesLeft: 0 }, { completed: 0, target: 3, protectedWeek: true }, { weeklyStreak: 5, streakPassesLeft: 0 }],
    [{ weeklyStreak: 5, streakPassesLeft: 0 }, { completed: 0, target: 0, protectedWeek: false }, { weeklyStreak: 5, streakPassesLeft: 0 }],
  ])('%p after %p is %p', (state, week, expected) => {
    expect(advanceWeeklyStreak(state, week)).toEqual(expected);
  });
});
