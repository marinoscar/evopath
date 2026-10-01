import { aggregateSignals, cardioCompletionRatio, type SignalsInput, type SignalsPlannedExercise, type SignalsSet, type SignalsWorkout } from './aggregate-signals';
import { planSignalsSchema } from './plan-signals.contract';

// =============================================================================
// aggregateSignals (#263): sessions with duration and distance prescriptions
// =============================================================================
//
// One plan week from Monday 2026-09-21; the planned workout is on Tuesday
// 2026-09-22. `asOf` is Monday 2026-09-28, so the day is over.
// =============================================================================

const PROGRAM = '10000000-0000-4000-8000-000000000001';
const WALK = '20000000-0000-4000-8000-000000000001';
const SQUAT = '20000000-0000-4000-8000-000000000002';
const SESSION = '30000000-0000-4000-8000-000000000001';
const DAY = '2026-09-22';

function input(exercises: SignalsPlannedExercise[], workouts: SignalsWorkout[] = []): SignalsInput {
  return {
    range: { from: '2026-09-21', to: '2026-09-27' },
    asOf: '2026-09-28',
    program: { id: PROGRAM, startDate: '2026-09-21', planVersion: 1 },
    planned: [{ programWorkoutId: SESSION, name: 'Walk day', weekNumber: 1, weekday: 2, position: 0, archived: false, exercises }],
    planChangedOn: null,
    truncated: false,
    workouts,
    exercises: [
      { id: WALK, slug: 'outdoor_walk', name: 'Outdoor walk', primaryMuscles: ['full_body'], trackingMode: 'distance_time' },
      { id: SQUAT, slug: 'back_squat', name: 'Back squat', primaryMuscles: ['quads'], trackingMode: 'weight_reps' },
    ],
    priorBuckets: {},
    pain: [],
    checkIns: [],
    weights: [],
    bodyFat: [],
  };
}

function set(extra: Partial<SignalsSet>): SignalsSet {
  return { weightKg: null, reps: null, durationSeconds: null, distanceMeters: null, rpe: null, isWarmup: false, completed: true, ...extra };
}

function logged(exercises: SignalsWorkout['exercises'], extra: Partial<SignalsWorkout> = {}): SignalsWorkout {
  return {
    id: '40000000-0000-4000-8000-000000000001',
    date: DAY,
    startedAt: `${DAY}T07:00:00.000Z`,
    status: 'completed',
    linked: true,
    programWorkoutId: SESSION,
    plannedSets: null,
    exercises,
    ...extra,
  };
}

const walk30: SignalsPlannedExercise = { exerciseId: WALK, targetSets: null, targetDurationSeconds: 1800, targetDistanceMeters: null };
const walkedFor = (...seconds: number[]) => [{ exerciseId: WALK, sets: seconds.map((durationSeconds) => set({ durationSeconds })) }];

function session(signalsInput: SignalsInput) {
  const signals = aggregateSignals(signalsInput);
  planSignalsSchema.parse(signals);
  expect(signals.sessions).toHaveLength(1);
  return { signals, session: signals.sessions[0] };
}

describe('aggregateSignals: cardio prescriptions', () => {
  it.each([
    ['30 of 30 minutes', [1800], 'done', 100],
    ['18 of 30 minutes (60 percent)', [1080], 'done', 60],
    ['18 of 30 minutes over two sets', [600, 480], 'done', 60],
    ['10 of 30 minutes', [600], 'partial', 33.3],
    ['45 of 30 minutes (capped at 100)', [2700], 'done', 100],
  ])('a planned 30-minute walk with %s logged is %s', (_label, seconds, status, pct) => {
    const { session: s } = session(input([walk30], [logged(walkedFor(...seconds))]));
    expect(s.status).toBe(status);
    expect(s.completionPct).toBe(pct);
  });

  it('a planned walk with nothing logged on a past day is missed (what the coach reads)', () => {
    const { signals, session: s } = session(input([walk30]));
    expect(s).toMatchObject({ status: 'missed', workoutId: null, setsDone: 0, completionPct: null });
    expect(signals.adherence.totals).toMatchObject({ planned: 1, completed: 0, missed: 1 });
    expect(signals.adherence.missedStreak).toBe(1);
  });

  it('a planned walk later this week is upcoming', () => {
    const { session: s } = session({ ...input([walk30]), asOf: '2026-09-22' });
    expect(s.status).toBe('upcoming');
  });

  it('warm-up and uncompleted sets do not count toward the duration', () => {
    const { session: s } = session(
      input([walk30], [logged([{ exerciseId: WALK, sets: [set({ durationSeconds: 1200, isWarmup: true }), set({ durationSeconds: 900, completed: false }), set({ durationSeconds: 600 })] }])]),
    );
    expect(s.status).toBe('partial');
  });

  it('measures a distance target by logged meters', () => {
    const run5k: SignalsPlannedExercise = { exerciseId: WALK, targetSets: null, targetDurationSeconds: null, targetDistanceMeters: 5000 };
    expect(session(input([run5k], [logged([{ exerciseId: WALK, sets: [set({ distanceMeters: 3200, durationSeconds: 1500 })] }])])).session.status).toBe('done');
    expect(session(input([run5k], [logged([{ exerciseId: WALK, sets: [set({ distanceMeters: 2500 })] }])])).session.status).toBe('partial');
  });

  it('takes the better of the two ratios when both targets are set', () => {
    const both: SignalsPlannedExercise = { exerciseId: WALK, targetSets: null, targetDurationSeconds: 1800, targetDistanceMeters: 5000 };
    const workout = logged([{ exerciseId: WALK, sets: [set({ durationSeconds: 600, distanceMeters: 3500 })] }]);
    expect(cardioCompletionRatio(both, workout)).toBeCloseTo(0.7);
    expect(session(input([both], [workout])).session.status).toBe('done');
  });

  it('needs every planned exercise at 60 percent: rep exercises keep the sets rule', () => {
    const squat: SignalsPlannedExercise = { exerciseId: SQUAT, targetSets: 3 };
    const squatSets = (n: number) => ({ exerciseId: SQUAT, sets: Array.from({ length: n }, () => set({ weightKg: 100, reps: 5 })) });

    const allDone = session(input([squat, walk30], [logged([squatSets(3), ...walkedFor(1800)])])).session;
    expect(allDone).toMatchObject({ status: 'done', setsPlanned: 4, setsDone: 4, completionPct: 100 });

    const shortWalk = session(input([squat, walk30], [logged([squatSets(3), ...walkedFor(600)])])).session;
    expect(shortWalk.status).toBe('partial');

    const fewSets = session(input([squat, walk30], [logged([squatSets(1), ...walkedFor(1800)])])).session;
    expect(fewSets).toMatchObject({ status: 'partial', completionPct: 33.3 });
  });

  it('reads the targets from the session snapshot when there is one', () => {
    // The plan says 30 minutes now; the session was started against 15.
    const snapshot: SignalsPlannedExercise[] = [{ exerciseId: WALK, targetSets: null, targetDurationSeconds: 900, targetDistanceMeters: null }];
    const { session: s } = session(input([walk30], [logged(walkedFor(600), { plannedSets: 1, plannedExercises: snapshot })]));
    expect(s.status).toBe('done');
  });

  it('leaves a reps-only session on the historical sets rule', () => {
    const squat: SignalsPlannedExercise = { exerciseId: SQUAT, targetSets: 5 };
    const sets = (n: number) => [{ exerciseId: SQUAT, sets: Array.from({ length: n }, () => set({ weightKg: 100, reps: 5 })) }];
    expect(session(input([squat], [logged(sets(3))])).session).toMatchObject({ status: 'done', setsPlanned: 5, setsDone: 3, completionPct: 60 });
    expect(session(input([squat], [logged(sets(2))])).session).toMatchObject({ status: 'partial', completionPct: 40 });
  });
});
