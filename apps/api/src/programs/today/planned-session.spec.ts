import { plannedSnapshotOf, prefilledSets, suggestedLoadKg, topSetOf, type PlannedExerciseInput } from './planned-session';

function planned(overrides: Partial<PlannedExerciseInput> = {}): PlannedExerciseInput {
  return {
    exerciseId: 'ex',
    slug: 'bench',
    trackingMode: 'weight_reps',
    targetSets: 3,
    repMin: 6,
    repMax: 10,
    targetDurationSeconds: null,
    targetDistanceMeters: null,
    targetRpe: 8,
    targetLoadKg: 60,
    loadGuidance: 'fixed',
    isPriority: true,
    ...overrides,
  };
}

const last = (weightKg: number, reps = 8) => ({ performedOn: '2026-09-25', topSet: { weightKg, reps } });

describe('suggestedLoadKg', () => {
  it.each([
    ['fixed uses the target load', planned(), last(50), 60],
    ['fixed without a target falls back to the last top set', planned({ targetLoadKg: null }), last(50), 50],
    ['fixed without either is none', planned({ targetLoadKg: null }), null, null],
    ['from_history uses the last top set', planned({ loadGuidance: 'from_history', targetLoadKg: null }), last(52.5), 52.5],
    ['from_history without history is none', planned({ loadGuidance: 'from_history' }), null, null],
    ['choose_start is none even with history', planned({ loadGuidance: 'choose_start', targetLoadKg: null }), last(50), null],
    ['a last time without a top set is none', planned({ loadGuidance: 'from_history' }), { performedOn: '2026-09-25', topSet: null }, null],
  ])('%s', (_label, exercise, lastTime, expected) => {
    expect(suggestedLoadKg(exercise, lastTime)).toBe(expected);
  });
});

describe('prefilledSets', () => {
  it('prefills targetSets uncompleted sets with repMin and the suggested load', () => {
    expect(prefilledSets(planned(), null)).toEqual([
      { setNumber: 1, weightKg: 60, reps: 6 },
      { setNumber: 2, weightKg: 60, reps: 6 },
      { setNumber: 3, weightKg: 60, reps: 6 },
    ]);
  });

  it('leaves the weight empty for bodyweight exercises', () => {
    expect(prefilledSets(planned({ trackingMode: 'bodyweight_reps', targetSets: 1 }), null)).toEqual([
      { setNumber: 1, weightKg: null, reps: 6 },
    ]);
  });

  it('leaves weight and reps empty for timed exercises', () => {
    expect(prefilledSets(planned({ trackingMode: 'time', targetSets: 2 }), null)).toEqual([
      { setNumber: 1, weightKg: null, reps: null },
      { setNumber: 2, weightKg: null, reps: null },
    ]);
  });

  it('starts a cardio prescription without rep targets: one empty set, no load', () => {
    const walk = planned({
      slug: 'outdoor_walk',
      trackingMode: 'distance_time',
      targetSets: null,
      repMin: null,
      repMax: null,
      targetDurationSeconds: 1800,
      targetLoadKg: null,
      loadGuidance: 'choose_start',
    });
    expect(prefilledSets(walk, last(50))).toEqual([{ setNumber: 1, weightKg: null, reps: null }]);
    expect(prefilledSets({ ...walk, targetSets: 3, targetDurationSeconds: 300 }, null)).toHaveLength(3);
  });
});

describe('plannedSnapshotOf', () => {
  it('records a cardio prescription with its targets', () => {
    const walk = planned({ slug: 'outdoor_walk', trackingMode: 'distance_time', targetSets: null, repMin: null, repMax: null, targetDistanceMeters: 5000 });
    expect(plannedSnapshotOf([walk])[0]).toMatchObject({ sets: null, repMin: null, repMax: null, targetDurationSeconds: null, targetDistanceMeters: 5000 });
  });

  it('records the prescription with sets named as planned', () => {
    expect(plannedSnapshotOf([planned()])).toEqual([
      {
        exerciseId: 'ex',
        slug: 'bench',
        sets: 3,
        repMin: 6,
        repMax: 10,
        targetDurationSeconds: null,
        targetDistanceMeters: null,
        targetRpe: 8,
        targetLoadKg: 60,
        loadGuidance: 'fixed',
        isPriority: true,
      },
    ]);
  });
});

describe('topSetOf', () => {
  const set = (weightKg: number | null, reps: number | null, extra: Partial<{ completed: boolean; isWarmup: boolean }> = {}) => ({
    weightKg,
    reps,
    completed: true,
    isWarmup: false,
    ...extra,
  });

  it('picks the heaviest completed working set, then the most reps', () => {
    expect(topSetOf([set(40, 10), set(50, 5), set(50, 6), set(70, 3, { isWarmup: true }), set(80, 1, { completed: false })])).toEqual({
      weightKg: 50,
      reps: 6,
    });
  });

  it('reads a missing weight as 0 and skips sets without reps', () => {
    expect(topSetOf([set(null, 12), set(20, null)])).toEqual({ weightKg: 0, reps: 12 });
  });

  it('is null without a usable set', () => {
    expect(topSetOf([])).toBeNull();
  });
});
