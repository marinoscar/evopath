// =============================================================================
// Unit: workout records (E4.4) — PR rules, e1RM, working sets, best per type
// =============================================================================
//
// The formulas of `workout-records.ts` against the acceptance fixture (one
// exercise, all completed working sets, kg): Sep 1: 60x10, 60x10; Sep 8:
// 62.5x8, 62.5x8; Sep 15: 65x6. Plus the edge cases (warm-ups, uncompleted
// sets, ties, reps > 12, bodyweight, time exercises) and property-style
// checks: a warm-up never earns or feeds a PR, and the weight PR is monotonic
// in weight. The SQL that feeds these functions is checked against them in
// `workout-history.db.spec.ts`.
// =============================================================================

import {
  bestPerType,
  classifyAgainstBuckets,
  classifySequence,
  classifySet,
  e1rmKg,
  recordsOf,
  toWeightBuckets,
  toWorkingSet,
  tracksPrs,
  workingSets,
  type EarnedPr,
  type RecordSetInput,
  type WorkingSet,
} from '../../src/workouts/workout-records';

const set = (weightKg: number | null, reps: number | null, over: Partial<RecordSetInput> = {}): RecordSetInput => ({
  weightKg,
  reps,
  completed: true,
  isWarmup: false,
  ...over,
});

const ws = (weightKg: number, reps: number): WorkingSet => ({ weightKg, reps });

/** The acceptance fixture as working sets. */
const FIXTURE: WorkingSet[] = [ws(60, 10), ws(60, 10), ws(62.5, 8), ws(62.5, 8), ws(65, 6)];

const types = (prs: Array<{ type: string }>) => prs.map((pr) => pr.type).sort();

describe('e1rmKg (Epley)', () => {
  it('matches the fixture values, rounded to 0.1 kg', () => {
    expect(e1rmKg(60, 10)).toBe(80);
    expect(e1rmKg(62.5, 8)).toBe(79.2);
    expect(e1rmKg(65, 6)).toBe(78);
    expect(e1rmKg(65, 7)).toBe(80.2);
    expect(e1rmKg(67.5, 5)).toBe(78.8);
    expect(e1rmKg(60, 12)).toBe(84);
  });

  it('is the weight itself for a single', () => {
    expect(e1rmKg(100, 1)).toBe(100);
  });

  it('is null outside 1..12 reps, without weight, or at 0 kg', () => {
    expect(e1rmKg(60, 13)).toBeNull();
    expect(e1rmKg(60, 0)).toBeNull();
    expect(e1rmKg(null, 5)).toBeNull();
    expect(e1rmKg(60, null)).toBeNull();
    expect(e1rmKg(0, 10)).toBeNull();
  });
});

describe('workingSets / toWorkingSet', () => {
  it('keeps completed, non-warm-up sets with reps >= 1 and a weight', () => {
    expect(
      workingSets(
        [set(60, 10), set(60, 10, { isWarmup: true }), set(60, 10, { completed: false }), set(60, 0), set(60, null), set(null, 10)],
        'weight_reps',
      ),
    ).toEqual([ws(60, 10)]);
  });

  it('counts pain-flagged sets (the flag is not an input)', () => {
    expect(toWorkingSet(set(60, 10), 'weight_reps')).toEqual(ws(60, 10));
  });

  it('treats an unweighted bodyweight set as 0 kg', () => {
    expect(toWorkingSet(set(null, 12), 'bodyweight_reps')).toEqual(ws(0, 12));
    expect(toWorkingSet(set(10, 8), 'bodyweight_reps')).toEqual(ws(10, 8));
  });

  it('has no working sets for time and distance exercises', () => {
    expect(tracksPrs('time')).toBe(false);
    expect(tracksPrs('distance_time')).toBe(false);
    expect(workingSets([set(20, 10)], 'time')).toEqual([]);
    expect(workingSets([set(20, 10)], 'distance_time')).toEqual([]);
  });
});

describe('classifySet against the fixture', () => {
  it('prior bests: max weight 65, best e1RM 80.0, max reps 10 at 60 kg', () => {
    expect(recordsOf(FIXTURE.map((s, i) => ({ ...s, date: `2026-09-0${i + 1}`, startedAt: new Date(0) })))).toMatchObject({
      maxWeightKg: { value: 65, reps: 6 },
      maxReps: { value: 10, weightKg: 60 },
      bestE1rmKg: { value: 80, weightKg: 60, reps: 10 },
    });
  });

  it('65x7 is a rep PR (6 at >= 65 kg) and an e1RM PR (80.2 > 80.0), not a weight PR', () => {
    const prs = classifySet(ws(65, 7), FIXTURE);
    expect(prs).toEqual([
      { type: 'reps', value: 7, previous: 6 },
      { type: 'e1rm', value: 80.2, previous: 80 },
    ]);
  });

  it('67.5x5 is a weight PR only (e1RM 78.8 < 80.0; no prior set at >= 67.5 kg)', () => {
    expect(classifySet(ws(67.5, 5), FIXTURE)).toEqual([{ type: 'weight', value: 67.5, previous: 65 }]);
  });

  it('60x12 is a rep PR (10 at >= 60 kg) and an e1RM PR (84.0), not a weight PR', () => {
    expect(classifySet(ws(60, 12), FIXTURE)).toEqual([
      { type: 'reps', value: 12, previous: 10 },
      { type: 'e1rm', value: 84, previous: 80 },
    ]);
  });

  it('the first ever set is first_time and nothing else', () => {
    expect(classifySet(ws(60, 10), [])).toEqual([{ type: 'first_time', value: 60, previous: null }]);
  });

  it('ties are not PRs', () => {
    expect(classifySet(ws(65, 6), FIXTURE)).toEqual([]);
    expect(classifySet(ws(60, 10), FIXTURE)).toEqual([]);
  });

  it('a rep PR counts prior sets 0.01 kg lighter as "at that weight"', () => {
    expect(classifySet(ws(65.005, 7), FIXTURE)).toEqual([
      { type: 'weight', value: 65.005, previous: 65 },
      { type: 'reps', value: 7, previous: 6 },
      { type: 'e1rm', value: 80.2, previous: 80 },
    ]);
  });

  it('reps > 12 earn no e1RM PR', () => {
    expect(types(classifySet(ws(60, 20), FIXTURE))).toEqual(['reps']);
  });

  it('no e1RM PR when no prior set has an e1RM (all above 12 reps)', () => {
    expect(classifySet(ws(40, 10), [ws(40, 15)])).toEqual([]);
  });

  it('editing the Sep 8 workout compares only with Sep 1', () => {
    // Prior for Sep 8 = Sep 1 only; 62.5x8 is a weight PR (62.5 > 60), not an e1RM PR (79.2 < 80).
    expect(classifySet(ws(62.5, 8), FIXTURE.slice(0, 2))).toEqual([{ type: 'weight', value: 62.5, previous: 60 }]);
  });
});

describe('bodyweight and time exercises', () => {
  it('an unweighted bodyweight set can earn a rep PR only', () => {
    const prior = workingSets([set(null, 10), set(null, 12)], 'bodyweight_reps');
    const current = toWorkingSet(set(null, 15), 'bodyweight_reps')!;
    expect(classifySet(current, prior)).toEqual([{ type: 'reps', value: 15, previous: 12 }]);
  });

  it('adding weight to a bodyweight exercise can be a weight PR', () => {
    const prior = workingSets([set(null, 10)], 'bodyweight_reps');
    expect(types(classifySet(ws(10, 8), prior))).toEqual(['weight']);
  });

  it('time exercises produce no PRs, not even first_time', () => {
    const result = classifySequence([{ key: 'a', set: set(null, null) }, { key: 'b', set: set(20, 10) }], 'time', []);
    expect([...result.values()]).toEqual([[], []]);
  });
});

describe('classifySequence (earlier sets of the same workout are prior)', () => {
  it('flags only the first set as first_time and compares later sets with it', () => {
    const result = classifySequence(
      [
        { key: 1, set: set(60, 10) },
        { key: 2, set: set(62.5, 8) },
        { key: 3, set: set(62.5, 8) },
      ],
      'weight_reps',
      [],
    );
    expect(result.get(1)).toEqual([{ type: 'first_time', value: 60, previous: null }]);
    expect(result.get(2)).toEqual([{ type: 'weight', value: 62.5, previous: 60 }]);
    expect(result.get(3)).toEqual([]);
  });

  it('a warm-up 100x1 or an uncompleted set never earns a PR and is not prior', () => {
    const result = classifySequence(
      [
        { key: 'warm', set: set(100, 1, { isWarmup: true }) },
        { key: 'open', set: set(90, 5, { completed: false }) },
        { key: 'work', set: set(67.5, 5) },
      ],
      'weight_reps',
      toWeightBuckets(FIXTURE),
    );
    expect(result.get('warm')).toEqual([]);
    expect(result.get('open')).toEqual([]);
    expect(result.get('work')).toEqual([{ type: 'weight', value: 67.5, previous: 65 }]);
  });

  it('matches classifySet on the prefix for every set', () => {
    const sets = [ws(60, 10), ws(65, 7), ws(67.5, 5), ws(60, 12), ws(70, 1)];
    const result = classifySequence(
      sets.map((s, key) => ({ key, set: set(s.weightKg, s.reps) })),
      'weight_reps',
      toWeightBuckets(FIXTURE),
    );
    sets.forEach((s, index) => {
      expect(result.get(index)).toEqual(classifySet(s, [...FIXTURE, ...sets.slice(0, index)]));
    });
  });
});

describe('properties', () => {
  // A small deterministic pseudo-random generator keeps the checks reproducible.
  function* randomSets(seed: number, count: number): Generator<WorkingSet> {
    let state = seed;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    for (let i = 0; i < count; i += 1) {
      yield ws(Math.round(next() * 80) * 2.5, 1 + Math.floor(next() * 15));
    }
  }

  it('a warm-up never earns a PR, however heavy', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const prior = [...randomSets(seed, 10)];
      const result = classifySequence([{ key: 0, set: set(999, 1, { isWarmup: true }) }], 'weight_reps', toWeightBuckets(prior));
      expect(result.get(0)).toEqual([]);
    }
  });

  it('the weight PR is monotonic: if w is a weight PR, any heavier w2 is too', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const prior = [...randomSets(seed, 10)];
      for (const candidate of randomSets(seed + 100, 10)) {
        if (!types(classifySet(candidate, prior)).includes('weight')) continue;
        expect(types(classifySet(ws(candidate.weightKg + 2.5, candidate.reps), prior))).toContain('weight');
      }
    }
  });

  it('bucketed prior history answers exactly like the raw sets', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const prior = [...randomSets(seed, 12)];
      for (const candidate of randomSets(seed + 7, 12)) {
        expect(classifyAgainstBuckets(candidate, toWeightBuckets(prior))).toEqual(classifySet(candidate, prior));
      }
    }
  });
});

describe('bestPerType', () => {
  const earned = (exerciseId: string, setNumber: number, type: EarnedPr['pr']['type'], value: number, position = 0): EarnedPr => ({
    exerciseId,
    exerciseName: exerciseId.toUpperCase(),
    workoutExerciseId: `we-${exerciseId}-${position}`,
    setId: `${exerciseId}-${position}-${setNumber}`,
    setNumber,
    position,
    pr: { type, value, previous: 1 },
  });

  it('keeps the highest value per type per exercise, the earliest on a tie, in exercise then type order', () => {
    const result = bestPerType([
      earned('b', 1, 'weight', 50, 1),
      earned('a', 2, 'e1rm', 80.2),
      earned('a', 1, 'reps', 7),
      earned('a', 3, 'reps', 12),
      earned('a', 4, 'e1rm', 84),
      earned('a', 5, 'e1rm', 84),
    ]);
    expect(result.map((pr) => [pr.exerciseId, pr.type, pr.value, pr.setNumber])).toEqual([
      ['a', 'reps', 12, 3],
      ['a', 'e1rm', 84, 4],
      ['b', 'weight', 50, 1],
    ]);
  });

  it('is empty without PRs', () => {
    expect(bestPerType([])).toEqual([]);
  });
});
