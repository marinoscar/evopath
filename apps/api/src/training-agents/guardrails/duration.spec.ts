import { planTree, ex, guardrailContextFixture } from '../testing/plan-fixtures';
import { checkTime, estimateMinutes, exerciseSeconds, trimToFit } from './duration';
import { normalizeTree } from './tree';

/** Five exercises: two priority lifts, three accessories (about 34 minutes). */
function fiveExerciseDay() {
  return normalizeTree(
    planTree([
      {
        workouts: [
          {
            weekday: 1,
            exercises: [
              ex('barbell_back_squat', { isPriority: true, sets: 4, repMin: 3, repMax: 5, restSeconds: 120 }),
              ex('barbell_bench_press', { isPriority: true, sets: 3, repMin: 6, repMax: 8, restSeconds: 90 }),
              ex('dumbbell_row', { sets: 3, repMax: 12, restSeconds: 60 }),
              ex('dumbbell_curl', { sets: 3, repMax: 12, restSeconds: 60 }),
              ex('dumbbell_lateral_raise', { sets: 3, repMin: 12, repMax: 15, restSeconds: 60 }),
            ],
          },
        ],
      },
    ]),
  ).blocks[0].weeks[0].workouts[0];
}

describe('duration model', () => {
  it.each([
    // setup 60 + sets x clamp(repMax x 3, 20, 60) + (sets - 1) x rest
    [{ targetSets: 4, repMax: 5, restSeconds: 120, isPriority: true }, 60 + 4 * 20 + 3 * 120],
    [{ targetSets: 3, repMax: 12, restSeconds: 60, isPriority: false }, 60 + 3 * 36 + 2 * 60],
    [{ targetSets: 2, repMax: 30, restSeconds: 60, isPriority: false }, 60 + 2 * 60 + 60],
    [{ targetSets: 1, repMax: 10, restSeconds: 300, isPriority: false }, 60 + 30],
    // rest 0 counts as unset: 90 s priority, 60 s accessory
    [{ targetSets: 3, repMax: 10, restSeconds: 0, isPriority: true }, 60 + 90 + 2 * 90],
    [{ targetSets: 3, repMax: 10, restSeconds: 0, isPriority: false }, 60 + 90 + 2 * 60],
  ])('%j takes %i s', (exercise, seconds) => {
    expect(exerciseSeconds(exercise as never)).toBe(seconds);
  });

  it('adds a 5-minute warm-up and rounds up', () => {
    expect(estimateMinutes(fiveExerciseDay())).toBe(Math.ceil((300 + 500 + 312 + 288 + 288 + 315) / 60));
  });
});

describe('trim ladder (G3)', () => {
  it('a 5-exercise day on a 20-minute budget trims T1, T2, T3 and stops as soon as it fits', () => {
    const workout = fiveExerciseDay();
    const { steps, fits } = trimToFit(workout, 20 * 1.05);

    expect(fits).toBe(true);
    expect(steps.map((s) => s.step)).toEqual(['T1', 'T1', 'T1', 'T2', 'T2', 'T2', 'T3', 'T3', 'T3']);
    expect(workout.exercises.map((e) => [e.isPriority, e.targetSets])).toEqual([
      [true, 4],
      [true, 3],
    ]);
    expect(estimateMinutes(workout)).toBeLessThanOrEqual(21);
  });

  it('a 10-minute budget goes through T4 and T5 to T6, keeping one priority lift at 2 or more sets', () => {
    const workout = fiveExerciseDay();
    const { steps, fits } = trimToFit(workout, 10 * 1.05);

    expect(fits).toBe(true);
    expect([...new Set(steps.map((s) => s.step))]).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
    expect(workout.exercises).toHaveLength(1);
    expect(workout.exercises[0].isPriority).toBe(true);
    expect(workout.exercises[0].targetSets).toBeGreaterThanOrEqual(2);
  });

  it('a day that already fits is untouched', () => {
    const workout = fiveExerciseDay();
    expect(trimToFit(workout, 60)).toEqual({ steps: [], fits: true });
  });

  it('checkTime lists every trim as a repair, warns when it cannot fit, and sets estimatedMinutes', () => {
    const ctx = guardrailContextFixture({ intake: { minutesPerSession: 20 } });
    const tree = normalizeTree(planTree([{ workouts: [{ weekday: 1, exercises: fiveExerciseDay().exercises.map(() => ex('push_up')) }] }]));
    tree.blocks[0].weeks[0].workouts[0].exercises = fiveExerciseDay().exercises;

    const violations = checkTime(tree, ctx);

    expect(violations.map((v) => v.code)).toEqual(['trim_t1', 'trim_t1', 'trim_t1', 'trim_t2', 'trim_t2', 'trim_t2', 'trim_t3', 'trim_t3', 'trim_t3']);
    expect(violations.every((v) => v.rule === 'G3' && v.severity === 'repair')).toBe(true);
    expect(tree.blocks[0].weeks[0].workouts[0].estimatedMinutes).toBeLessThanOrEqual(21);

    const tight = guardrailContextFixture({ intake: { minutesPerSession: 20 } });
    const big = normalizeTree(
      planTree([{ workouts: [{ weekday: 1, exercises: [ex('barbell_back_squat', { isPriority: true, sets: 2, repMax: 20, restSeconds: 300 })] }] }]),
    );
    big.blocks[0].weeks[0].workouts[0].exercises[0].restSeconds = 900;
    expect(checkTime(big, { ...tight, minutesPerSession: 5 }).map((v) => [v.severity, v.code])).toEqual([
      ['repair', 'trim_t5'],
      ['warn', 'time_unfit'],
    ]);
  });
});
