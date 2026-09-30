import {
  AS_OF,
  EXERCISES,
  IDS,
  RANGE,
  loggedWorkouts,
  planned,
  plannedWorkouts,
  programWorkoutId,
  set,
  sets,
  threeDayPlanInput,
  workout,
} from '../../../test/fixtures/training/signals/three-day-plan.fixture';
import { e1rmKg } from '../../workouts/workout-records';
import {
  aggregateSignals,
  emptySignals,
  isHardSet,
  isLowDay,
  liftTrend,
  rpeTrend,
  slopePerWeek,
  weekStartOf,
  weekStartsBetween,
  type SignalsInput,
  type SignalsWorkout,
} from './aggregate-signals';
import { planSignalsSchema } from './plan-signals.contract';

// =============================================================================
// aggregateSignals (E5.9): every definition, table-driven where it is a rule
// =============================================================================

function run(overrides: Partial<SignalsInput> = {}) {
  const result = aggregateSignals(threeDayPlanInput(overrides));
  planSignalsSchema.parse(result);
  return result;
}

describe('aggregateSignals: the 3-day, 4-week fixture', () => {
  const signals = run();

  it('counts planned, completed, partial, missed and extra per week', () => {
    expect(
      signals.adherence.weeks.map(({ weekStart, planned, completed, partialSessions, missed, extra, partial }) => ({
        weekStart,
        planned,
        completed,
        partialSessions,
        missed,
        extra,
        partial,
      })),
    ).toEqual([
      { weekStart: '2026-08-31', planned: 3, completed: 3, partialSessions: 0, missed: 0, extra: 0, partial: false },
      { weekStart: '2026-09-07', planned: 3, completed: 2, partialSessions: 0, missed: 1, extra: 1, partial: false },
      { weekStart: '2026-09-14', planned: 3, completed: 2, partialSessions: 0, missed: 1, extra: 0, partial: false },
      { weekStart: '2026-09-21', planned: 3, completed: 3, partialSessions: 1, missed: 0, extra: 0, partial: false },
    ]);
    expect(signals.adherence.weeks.map((week) => week.adherencePct)).toEqual([100, 66.7, 66.7, 100]);
  });

  it('totals them', () => {
    expect(signals.adherence.totals).toEqual({ planned: 12, completed: 10, partialSessions: 1, missed: 2, extra: 1, adherencePct: 83.3 });
    expect(signals.weeksInRange).toBe(4);
    expect(signals.programId).toBe(IDS.program);
    expect(signals.planVersion).toBe(3);
  });

  it('gives every planned session its status, in date order', () => {
    expect(signals.sessions.map((session) => [session.plannedFor, session.status])).toEqual([
      ['2026-08-31', 'done'],
      ['2026-09-02', 'done'],
      ['2026-09-04', 'done'],
      ['2026-09-07', 'done'],
      ['2026-09-09', 'missed'],
      ['2026-09-11', 'done'],
      ['2026-09-14', 'done'],
      ['2026-09-16', 'done'],
      ['2026-09-18', 'missed'],
      ['2026-09-21', 'partial'],
      ['2026-09-23', 'done'],
      ['2026-09-25', 'done'],
    ]);
    const partial = signals.sessions.find((session) => session.status === 'partial')!;
    expect(partial).toMatchObject({ setsPlanned: 6, setsDone: 2, completionPct: 33.3, avgRpe: 9 });
    const missed = signals.sessions.find((session) => session.status === 'missed')!;
    expect(missed).toMatchObject({ workoutId: null, setsDone: 0, setsPlanned: 6, completionPct: null, avgRpe: null });
  });

  it('counts streaks from the most recent due session', () => {
    expect(signals.adherence.completedStreak).toBe(3);
    expect(signals.adherence.missedStreak).toBe(0);
  });

  it('counts every completed workout for frequency, linked or not', () => {
    expect(signals.frequency.perWeek.map((week) => week.sessions)).toEqual([3, 3, 2, 3]);
    expect(signals.frequency.avgPerWeek).toBe(2.75);
  });

  it('counts hard sets per primary muscle against the planned sets', () => {
    const byMuscle = Object.fromEntries(signals.volume.map((row) => [row.muscle, row]));
    expect(signals.volume.map((row) => row.muscle)).toEqual(['back', 'chest', 'core', 'glutes', 'hamstrings', 'quads']);
    // Warm-up and uncompleted sets never count.
    expect(byMuscle.quads.weeks.map((week) => [week.plannedSets, week.hardSets])).toEqual([
      [6, 6],
      [6, 6],
      [6, 3],
      [6, 5],
    ]);
    expect(byMuscle.quads.totalHardSets).toBe(20);
    expect(byMuscle.chest.tonnageKg).toBe(70 * 8 * 3 + 72.5 * 8 * 3 + 75 * 8 * 3);
    // Time-tracked: sets, no tonnage, nothing planned.
    expect(byMuscle.core).toMatchObject({ totalHardSets: 3, tonnageKg: null });
    expect(byMuscle.core.weeks.every((week) => week.plannedSets === 0)).toBe(true);
    // Bodyweight pull-ups add sets to back but no tonnage; the rows add both.
    expect(byMuscle.back.totalHardSets).toBe(9 + 9);
    expect(byMuscle.back.tonnageKg).toBe(60 * 10 * 3 + 62.5 * 10 * 3 + 62.5 * 10 * 3);
    // Secondary muscles are not counted: glutes come only from squat and deadlift primaries.
    expect(byMuscle.glutes.totalHardSets).toBe(20 + 9);
  });

  it('orders lifts by sessions, then name, with E4.4 e1RMs', () => {
    expect(signals.performance.map((lift) => [lift.slug, lift.sessions])).toEqual([
      ['back-squat', 7],
      ['barbell-row', 3],
      ['bench-press', 3],
      ['deadlift', 3],
      ['pull-up', 3],
    ]);
    const squat = signals.performance[0];
    expect(squat.best).toEqual({ weightKg: 112.5, reps: 5, e1rmKg: e1rmKg(112.5, 5) });
    expect(squat.lastTopSets).toEqual([
      { date: '2026-09-25', weightKg: 112.5, reps: 5, rpe: 9 },
      { date: '2026-09-21', weightKg: 112.5, reps: 5, rpe: 9 },
      { date: '2026-09-14', weightKg: 110, reps: 5, rpe: 8.5 },
    ]);
    expect(squat.trend).toBe('up');
    expect(squat.prInRange).toBe(true);
    const pullup = signals.performance.find((lift) => lift.slug === 'pull-up')!;
    expect(pullup.best).toEqual({ weightKg: null, reps: 9, e1rmKg: null });
    expect(pullup.trend).toBe('insufficient');
    expect(signals.performance.some((lift) => lift.slug === 'plank')).toBe(false);
  });

  it('sorts lifts with equal sessions by name', () => {
    const names = signals.performance.slice(1).map((lift) => lift.name);
    expect(names).toEqual([...names].sort());
  });

  it('summarises effort over completed working sets', () => {
    expect(signals.effort.setsAtRpe9Plus).toBe(16);
    expect(signals.effort.rpeTrend).toBe('rising');
    expect(signals.effort.avgRpe).toBeGreaterThan(7);
  });
});

describe('aggregateSignals: planned versus done rules', () => {
  it('never counts an upcoming session as missed, and counts today only once done', () => {
    const signals = run({ asOf: '2026-09-16', range: RANGE });
    const byDate = Object.fromEntries(signals.sessions.map((session) => [session.plannedFor, session.status]));
    expect(byDate['2026-09-16']).toBe('done');
    expect(byDate['2026-09-18']).toBe('upcoming');
    expect(signals.sessions.filter((session) => session.plannedFor > '2026-09-16').every((session) => session.status !== 'missed')).toBe(true);
    // Remove the Wednesday workout: it is today, so it is upcoming and not due.
    const withoutToday = run({
      asOf: '2026-09-16',
      workouts: loggedWorkouts().filter((row) => row.date !== '2026-09-16' && row.date <= '2026-09-16'),
    });
    const today = withoutToday.sessions.find((session) => session.plannedFor === '2026-09-16')!;
    expect(today.status).toBe('upcoming');
    expect(withoutToday.adherence.totals.planned).toBe(7);
    expect(withoutToday.adherence.weeks[2].partial).toBe(true);
  });

  it('marks a linked in-progress workout in_progress, never missed', () => {
    const workouts = [
      ...loggedWorkouts(),
      planned('2026-09-26', 3, 5, [{ exerciseId: IDS.squat, sets: [set(110, 5, { completed: false })] }], { status: 'in_progress' }),
    ];
    const signals = run({ workouts });
    const friday = signals.sessions.find((session) => session.plannedFor === '2026-09-18')!;
    expect(friday.status).toBe('in_progress');
    expect(friday.workoutId).toBe(workouts[workouts.length - 1].id);
    expect(signals.adherence.totals).toMatchObject({ planned: 12, completed: 10, missed: 1 });
    // An in-progress workout is not a completed workout anywhere else either.
    expect(signals.frequency.perWeek[3].sessions).toBe(3);
  });

  it('credits a planned session done on another day to its planned week', () => {
    const workouts = [...loggedWorkouts(), planned('2026-09-10', 2, 3, [{ exerciseId: IDS.deadlift, sets: sets(3, 140, 5) }])];
    const signals = run({ workouts });
    expect(signals.adherence.weeks[1]).toMatchObject({ planned: 3, completed: 3, missed: 0 });
  });

  it('prefers a completed link over an in-progress one', () => {
    const extra = planned('2026-09-02', 1, 3, [], { status: 'in_progress' });
    const signals = run({ workouts: [...loggedWorkouts(), extra] });
    expect(signals.sessions[1].status).toBe('done');
    expect(signals.sessions[1].workoutId).not.toBe(extra.id);
  });

  it('falls back to the plan for setsPlanned without a snapshot', () => {
    const workouts = loggedWorkouts().map((row) => ({ ...row, plannedSets: null }));
    expect(run({ workouts }).sessions[0].setsPlanned).toBe(6);
  });

  it('counts past planned sessions whatever the program status (the input carries no status)', () => {
    // A paused or archived program is loaded the same way: its past sessions count.
    expect(run().adherence.totals.planned).toBe(12);
  });

  it('keeps an archived planned workout with history and drops one without', () => {
    const rows = plannedWorkouts().map((row) =>
      row.programWorkoutId === programWorkoutId(1, 1) || row.programWorkoutId === programWorkoutId(2, 3)
        ? { ...row, archived: true }
        : row,
    );
    const signals = run({ planned: rows });
    // Week 1 Monday is archived but linked: still planned and done.
    expect(signals.sessions[0]).toMatchObject({ plannedFor: '2026-08-31', status: 'done' });
    // Week 2 Wednesday was archived without history: no longer planned.
    expect(signals.sessions.some((session) => session.plannedFor === '2026-09-09')).toBe(false);
    expect(signals.adherence.totals).toMatchObject({ planned: 11, missed: 1 });
  });

  it('lets a linked archived workout replace the live one of the same week and weekday', () => {
    const replacement = {
      ...plannedWorkouts()[0],
      programWorkoutId: '30000000-0000-4000-8000-00000000ffff',
      name: 'Day A (rewritten)',
    };
    const rows = [
      ...plannedWorkouts().map((row) => (row.programWorkoutId === programWorkoutId(1, 1) ? { ...row, archived: true } : row)),
      replacement,
    ];
    const signals = run({ planned: rows });
    expect(signals.sessions.filter((session) => session.plannedFor === '2026-08-31')).toHaveLength(1);
    expect(signals.sessions[0].name).toBe('Day A');
  });

  it('ignores unscheduled workouts', () => {
    const rows = plannedWorkouts().map((row, index) => (index === 0 ? { ...row, weekday: null } : row));
    expect(run({ planned: rows }).adherence.totals.planned).toBe(11);
  });

  it('counts missed streaks from the most recent due session', () => {
    const workouts = loggedWorkouts().filter((row) => row.date < '2026-09-21');
    const signals = run({ workouts });
    expect(signals.adherence.missedStreak).toBe(4);
    expect(signals.adherence.completedStreak).toBe(0);
  });

  it('with no program: zeroed adherence, sessions empty, unlinked work is extra', () => {
    const workouts = loggedWorkouts().map((row) => ({ ...row, linked: false, programWorkoutId: null }));
    const signals = run({ program: null, planned: [], workouts });
    expect(signals.programId).toBeNull();
    expect(signals.planVersion).toBeNull();
    expect(signals.sessions).toEqual([]);
    expect(signals.adherence.totals).toEqual({ planned: 0, completed: 0, partialSessions: 0, missed: 0, extra: 11, adherencePct: null });
    expect(signals.adherence.weeks.every((week) => week.adherencePct === null)).toBe(true);
  });

  it('a program never started plans nothing', () => {
    const signals = run({ program: { id: IDS.program, startDate: null, planVersion: 1 } });
    expect(signals.sessions).toEqual([]);
    expect(signals.adherence.totals.extra).toBe(1);
  });

  it('a workout linked to another plan is neither extra nor completed here', () => {
    const other = workout('2026-09-19', [{ exerciseId: IDS.squat, sets: sets(3, 100, 5) }], {
      linked: true,
      programWorkoutId: '30000000-0000-4000-8000-00000000eeee',
    });
    const signals = run({ workouts: [...loggedWorkouts(), other] });
    expect(signals.adherence.totals).toMatchObject({ completed: 10, extra: 1 });
    expect(signals.frequency.perWeek[2].sessions).toBe(3);
  });

  it('reports planChangedOn only inside the range, and the truncation flag', () => {
    expect(run({ planChangedOn: '2026-09-10', truncated: true })).toMatchObject({ planChangedOn: '2026-09-10', truncated: true });
    expect(run({ planChangedOn: '2026-10-10' }).planChangedOn).toBeNull();
  });
});

describe('aggregateSignals: partial weeks', () => {
  it('marks weeks that straddle the range edges and leaves them out of the average', () => {
    const signals = run({ range: { from: '2026-09-02', to: '2026-09-24' } });
    expect(signals.adherence.weeks.map((week) => [week.weekStart, week.partial])).toEqual([
      ['2026-08-31', true],
      ['2026-09-07', false],
      ['2026-09-14', false],
      ['2026-09-21', true],
    ]);
    expect(signals.frequency.avgPerWeek).toBe(2.5);
    // Sessions outside the range are not planned.
    expect(signals.sessions[0].plannedFor).toBe('2026-09-02');
    expect(signals.sessions[signals.sessions.length - 1].plannedFor).toBe('2026-09-23');
  });

  it('marks the week containing asOf as partial', () => {
    const signals = run({ asOf: '2026-09-27' });
    expect(signals.adherence.weeks[3].partial).toBe(true);
    expect(signals.frequency.avgPerWeek).toBe(round2((3 + 3 + 2) / 3));
  });

  it('has null averages when every week is partial', () => {
    const signals = run({ range: { from: '2026-09-22', to: '2026-09-24' } });
    expect(signals.frequency.avgPerWeek).toBeNull();
  });
});

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

describe('isHardSet', () => {
  it.each([
    ['completed working set', set(100, 5), 'weight_reps', true],
    ['warm-up', set(60, 5, { isWarmup: true }), 'weight_reps', false],
    ['not completed', set(100, 5, { completed: false }), 'weight_reps', false],
    ['zero reps', set(100, 0), 'weight_reps', false],
    ['no reps', set(100, null), 'weight_reps', false],
    ['bodyweight with reps', set(null, 8), 'bodyweight_reps', true],
    ['time with a duration', set(null, null, { durationSeconds: 45 }), 'time', true],
    ['time without a duration', set(null, null), 'time', false],
    ['distance only', set(null, null, { distanceMeters: 400 }), 'distance_time', true],
    ['NaN reps', set(100, Number.NaN), 'weight_reps', false],
  ])('%s', (_label, value, mode, expected) => {
    expect(isHardSet(value, mode)).toBe(expected);
  });
});

describe('liftTrend', () => {
  it.each([
    ['no sessions', [], 'insufficient', null],
    ['one session', [100], 'insufficient', null],
    ['two sessions', [100, 120], 'insufficient', null],
    ['three rising (overlapping pairs)', [100, 103, 106], 'up', 3],
    ['exactly +2 percent is flat', [100, 100, 102, 102], 'flat', 2],
    ['just over +2 percent', [100, 100, 102.1, 102.1], 'up', 2.1],
    ['exactly -2 percent is flat', [100, 100, 98, 98], 'flat', -2],
    ['just under -2 percent', [100, 100, 97.9, 97.9], 'down', -2.1],
    ['only the last four count', [50, 50, 100, 100, 100, 100], 'flat', 0],
    ['zeros and NaN are ignored', [0, Number.NaN, 100, 100], 'insufficient', null],
  ])('%s', (_label, values, trend, trendPct) => {
    expect(liftTrend(values as number[])).toEqual({ trend, trendPct });
  });
});

describe('rpeTrend', () => {
  it.each([
    ['under 4 sessions', [7, 8, 9], 'insufficient'],
    ['rising', [7, 7, 8, 8], 'rising'],
    ['exactly +0.5 is flat', [7, 7, 7.5, 7.5], 'flat'],
    ['falling', [9, 9, 8, 8], 'falling'],
    ['odd count drops the middle', [7, 7, 10, 8, 8], 'rising'],
    ['flat', [8, 8, 8, 8], 'flat'],
  ])('%s', (_label, values, expected) => {
    expect(rpeTrend(values as number[])).toBe(expected);
  });
});

describe('slopePerWeek', () => {
  it.each([
    ['under 3 points', [{ date: '2026-09-01', value: 80 }, { date: '2026-09-08', value: 81 }], null],
    ['all on one day', [{ date: '2026-09-01', value: 80 }, { date: '2026-09-01', value: 81 }, { date: '2026-09-01', value: 82 }], null],
    ['half a kilo a week', [{ date: '2026-09-01', value: 80 }, { date: '2026-09-08', value: 80.5 }, { date: '2026-09-15', value: 81 }], 0.5],
    ['losing', [{ date: '2026-09-15', value: 79 }, { date: '2026-09-01', value: 80 }, { date: '2026-09-08', value: 79.5 }], -0.5],
  ])('%s', (_label, points, expected) => {
    expect(slopePerWeek(points)).toBe(expected);
  });
});

describe('isLowDay', () => {
  const base = { date: '2026-09-28', energy: 3, sleepQuality: 3, soreness: 3, stress: 3 };
  it.each([
    ['all middle', {}, false],
    ['energy 2', { energy: 2 }, true],
    ['sleep 1', { sleepQuality: 1 }, true],
    ['soreness 4 (higher is worse)', { soreness: 4 }, true],
    ['stress 5', { stress: 5 }, true],
    ['energy 5 is fine', { energy: 5 }, false],
    ['soreness 1 is fine', { soreness: 1 }, false],
    ['missing scores are not low', { energy: null, sleepQuality: null, soreness: null, stress: null }, false],
  ])('%s', (_label, patch, expected) => {
    expect(isLowDay({ ...base, ...patch })).toBe(expected);
  });
});

describe('aggregateSignals: pain', () => {
  const session = (exerciseId: string, date: string, flagged: boolean, workoutId = `w-${date}`) => ({
    exerciseId,
    workoutId,
    date,
    startedAt: `${date}T10:00:00.000Z`,
    flagged,
  });

  it('counts flagged sessions in the last 28 days and the current run', () => {
    const signals = run({
      pain: [
        session(IDS.squat, '2026-08-20', true), // outside 28 days
        session(IDS.squat, '2026-09-04', true),
        session(IDS.squat, '2026-09-11', false),
        session(IDS.squat, '2026-09-21', true),
        session(IDS.squat, '2026-09-25', true),
        session(IDS.bench, '2026-09-07', false),
        session(IDS.row, '2026-09-16', true),
        session(IDS.row, '2026-09-23', false),
      ],
    });
    expect(signals.pain).toEqual([
      {
        exerciseId: IDS.squat,
        slug: 'back-squat',
        name: 'Back squat',
        lastFlaggedOn: '2026-09-25',
        flaggedSessions28d: 3,
        consecutiveFlaggedSessions: 2,
      },
      {
        exerciseId: IDS.row,
        slug: 'barbell-row',
        name: 'Barbell row',
        lastFlaggedOn: '2026-09-16',
        flaggedSessions28d: 1,
        consecutiveFlaggedSessions: 0,
      },
    ]);
  });

  it('merges two entries of one exercise in one workout', () => {
    const signals = run({
      pain: [session(IDS.squat, '2026-09-25', false, 'w1'), session(IDS.squat, '2026-09-25', true, 'w1')],
    });
    expect(signals.pain[0]).toMatchObject({ flaggedSessions28d: 1, consecutiveFlaggedSessions: 1 });
  });

  it('never exports note text', () => {
    const signals = run({
      pain: [{ ...session(IDS.squat, '2026-09-25', true), painNote: 'left knee, sharp' } as any],
      checkIns: [{ date: AS_OF, energy: 1, sleepQuality: 3, soreness: 3, stress: 3, note: 'bad night' } as any],
    });
    const json = JSON.stringify(signals);
    expect(json).not.toContain('left knee');
    expect(json).not.toContain('bad night');
    expect(json).not.toMatch(/note/i);
  });
});

describe('aggregateSignals: readiness', () => {
  const checkIn = (date: string, energy: number | null, sleepQuality: number | null, soreness: number | null, stress: number | null) => ({
    date,
    energy,
    sleepQuality,
    soreness,
    stress,
  });

  it('averages the last 7 days and counts low days and the current low streak', () => {
    const signals = run({
      checkIns: [
        checkIn('2026-09-20', 1, 1, 5, 5), // outside the 7 days
        checkIn('2026-09-22', 4, 4, 2, 2),
        checkIn('2026-09-24', 2, 3, 3, 3),
        checkIn('2026-09-26', 4, 4, 2, 2),
        checkIn('2026-09-27', 3, 3, 4, 2),
        checkIn('2026-09-28', 3, 2, 3, 3),
      ],
    });
    expect(signals.readiness).toEqual({
      days: 5,
      avg: { energy: 3.2, sleepQuality: 3.2, soreness: 2.8, stress: 2.4 },
      lowDays: 3,
      lowStreak: 2,
    });
  });

  it('starts the streak on the day before asOf when asOf has no check-in', () => {
    const signals = run({ checkIns: [checkIn('2026-09-26', 1, 3, 3, 3), checkIn('2026-09-27', 1, 3, 3, 3)] });
    expect(signals.readiness.lowStreak).toBe(2);
  });

  it('a missing day breaks the streak', () => {
    const signals = run({ checkIns: [checkIn('2026-09-25', 1, 3, 3, 3), checkIn('2026-09-27', 1, 3, 3, 3)] });
    expect(signals.readiness.lowStreak).toBe(1);
  });

  it('averages only the scores that were given', () => {
    const signals = run({ checkIns: [checkIn('2026-09-28', 4, null, null, null)] });
    expect(signals.readiness.avg).toEqual({ energy: 4, sleepQuality: null, soreness: null, stress: null });
  });

  it('is empty without check-ins', () => {
    expect(run().readiness).toEqual({ days: 0, avg: null, lowDays: 0, lowStreak: 0 });
  });
});

describe('aggregateSignals: body', () => {
  it('reports the latest weight and the 8-week slope', () => {
    const signals = run({
      weights: [
        { date: '2026-07-01', value: 90 }, // outside 8 weeks
        { date: '2026-08-10', value: 82 },
        { date: '2026-08-24', value: 81 },
        { date: '2026-09-07', value: 80 },
        { date: '2026-09-21', value: 79 },
      ],
      bodyFat: [{ date: '2026-09-21', value: 18.44 }],
    });
    expect(signals.body).toEqual({
      weightKg: { latest: 79, changePerWeek: -0.5, points: 4 },
      bodyFatPct: { latest: 18.4, points: 1 },
    });
  });

  it('has no slope under 3 points and no body fat when never measured', () => {
    const signals = run({ weights: [{ date: '2026-09-21', value: 79 }] });
    expect(signals.body).toEqual({ weightKg: { latest: 79, changePerWeek: null, points: 1 }, bodyFatPct: null });
  });
});

describe('aggregateSignals: PRs in range', () => {
  it('is false when the history before the range is stronger', () => {
    const signals = run({
      priorBuckets: { [IDS.squat]: [{ weightKg: 200, maxReps: 10, maxRepsForE1rm: 10 }] },
    });
    expect(signals.performance.find((lift) => lift.slug === 'back-squat')!.prInRange).toBe(false);
  });

  it('a first-time set alone is not a PR', () => {
    const workouts: SignalsWorkout[] = [workout('2026-09-25', [{ exerciseId: IDS.bench, sets: sets(1, 70, 8) }])];
    const signals = run({ workouts });
    expect(signals.performance[0]).toMatchObject({ slug: 'bench-press', prInRange: false, sessions: 1 });
  });
});

describe('aggregateSignals: degenerate input', () => {
  it('returns zeroed structures for an empty input', () => {
    const signals = emptySignals({ from: '2026-09-01', to: '2026-09-28' }, '2026-09-28');
    planSignalsSchema.parse(signals);
    expect(signals).toMatchObject({
      programId: null,
      sessions: [],
      volume: [],
      performance: [],
      pain: [],
      effort: { avgRpe: null, setsAtRpe9Plus: 0, rpeTrend: 'insufficient' },
      frequency: { avgPerWeek: 0 },
    });
    expect(signals.adherence.totals).toEqual({ planned: 0, completed: 0, partialSessions: 0, missed: 0, extra: 0, adherencePct: null });
  });

  it('rejects impossible dates', () => {
    expect(() => run({ asOf: '2026-02-30' })).toThrow(RangeError);
  });

  it('never produces NaN or Infinity (seeded fuzz)', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
    const weird = [0, -1, 1, 5, 12, 13, 1e9, Number.NaN, Number.POSITIVE_INFINITY, null, 0.0001];
    const days = ['2026-08-31', '2026-09-01', '2026-09-10', '2026-09-27', '2026-09-28', '2026-02-30', 'garbage'];

    for (let round = 0; round < 200; round += 1) {
      const workouts: SignalsWorkout[] = Array.from({ length: Math.floor(random() * 5) }, (_, index) =>
        workout(
          pick(days),
          Array.from({ length: Math.floor(random() * 3) }, () => ({
            exerciseId: pick(EXERCISES).id,
            sets: Array.from({ length: Math.floor(random() * 4) }, () => ({
              weightKg: pick(weird) as number | null,
              reps: pick(weird) as number | null,
              durationSeconds: pick(weird) as number | null,
              distanceMeters: pick(weird) as number | null,
              rpe: pick(weird) as number | null,
              isWarmup: random() < 0.2,
              completed: random() < 0.8,
            })),
          })),
          {
            status: random() < 0.8 ? 'completed' : 'in_progress',
            linked: random() < 0.5,
            programWorkoutId: random() < 0.5 ? programWorkoutId(1 + (index % 4), pick([1, 3, 5])) : null,
            plannedSets: pick(weird) as number | null,
          },
        ),
      );
      const signals = aggregateSignals(
        threeDayPlanInput({
          workouts,
          planned: random() < 0.5 ? plannedWorkouts() : [],
          weights: Array.from({ length: Math.floor(random() * 4) }, () => ({ date: pick(days), value: pick(weird) as number })),
          bodyFat: Array.from({ length: Math.floor(random() * 2) }, () => ({ date: pick(days), value: pick(weird) as number })),
          checkIns: Array.from({ length: Math.floor(random() * 4) }, () => ({
            date: pick(days),
            energy: pick(weird) as number | null,
            sleepQuality: pick(weird) as number | null,
            soreness: pick(weird) as number | null,
            stress: pick(weird) as number | null,
          })),
          priorBuckets: random() < 0.5 ? {} : { [IDS.squat]: [{ weightKg: pick([0, 100, 1e9]), maxReps: 5, maxRepsForE1rm: 5 }] },
        }),
      );
      assertFinite(signals, `round ${round}`);
      planSignalsSchema.parse(signals);
    }
  });
});

function assertFinite(value: unknown, path: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} is ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFinite(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertFinite(item, `${path}.${key}`);
  }
}

describe('week helpers', () => {
  it.each([
    ['2026-09-28', '2026-09-28'],
    ['2026-09-27', '2026-09-21'],
    ['2026-09-30', '2026-09-28'],
    ['2027-01-01', '2026-12-28'],
  ])('weekStartOf(%s) is %s', (date, monday) => {
    expect(weekStartOf(date)).toBe(monday);
  });

  it('lists every touched week', () => {
    expect(weekStartsBetween('2026-09-02', '2026-09-21')).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']);
    expect(weekStartsBetween('2026-09-21', '2026-09-02')).toEqual([]);
  });
});
