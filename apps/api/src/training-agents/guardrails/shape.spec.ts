import { checkSchema, checkShape } from './shape';
import { normalizeTree } from './tree';
import { ex, guardrailContextFixture, keysOf, planTree } from '../testing/plan-fixtures';

const ctx = guardrailContextFixture();

describe('G1 shape', () => {
  it.each([
    [
      'an unknown exercise is dropped',
      [{ workouts: [{ weekday: 1, exercises: [ex('goblet_squat'), ex('push_up'), ex('telekinesis_press')] }] }],
      [[['goblet_squat', 'push_up']]],
      [['repair', 'unknown_exercise']],
    ],
    [
      'a workout left with one exercise after drops blocks',
      [{ workouts: [{ weekday: 1, exercises: [ex('goblet_squat'), ex('made_up')] }] }],
      [[['goblet_squat']]],
      [['repair', 'unknown_exercise'], ['block', 'workout_too_small']],
    ],
    [
      'a workout emptied by drops is removed, and a week left empty blocks',
      [{ workouts: [{ weekday: 1, exercises: [ex('made_up')] }] }],
      [[]],
      [['repair', 'unknown_exercise'], ['repair', 'empty_workout_dropped'], ['block', 'empty_week']],
    ],
    [
      'a model-authored single-exercise workout is kept (only drops make it small)',
      [{ workouts: [{ weekday: 1, exercises: [ex('treadmill_run')] }] }],
      [[['treadmill_run']]],
      [],
    ],
  ])('%s', (_label, weeks, expectedKeys, expected) => {
    const tree = normalizeTree(planTree(weeks));
    const violations = checkShape(tree, ctx);

    expect(keysOf(tree, ctx)).toEqual(expectedKeys);
    expect(violations.map((v) => [v.severity, v.code])).toEqual(expected);
    expect(violations.every((v) => v.rule === 'G1')).toBe(true);
  });

  it('duplicate weekdays move to a free day, preferred days first', () => {
    const preferring = guardrailContextFixture({ intake: { daysPerWeek: 2, preferredWeekdays: [1, 4] } });
    const tree = normalizeTree(
      planTree([
        {
          workouts: [
            { weekday: 1, name: 'A', exercises: [ex('goblet_squat'), ex('push_up')] },
            { weekday: 1, name: 'B', exercises: [ex('dumbbell_row'), ex('plank')] },
          ],
        },
      ]),
    );

    const violations = checkShape(tree, preferring);

    expect(tree.blocks[0].weeks[0].workouts.map((w) => [w.name, w.weekday])).toEqual([
      ['A', 1],
      ['B', 4],
    ]);
    expect(violations).toEqual([expect.objectContaining({ severity: 'repair', code: 'duplicate_weekday' })]);
  });

  it('week numbers are renumbered to run without gaps; numbers come into schema bounds', () => {
    const tree = planTree([
      { workouts: [{ weekday: 1, exercises: [ex('goblet_squat', { repMin: 12, repMax: 6, targetRpe: 11, restSeconds: 5 }), ex('push_up')] }] },
      { workouts: [{ weekday: 1, exercises: [ex('goblet_squat'), ex('push_up')] }] },
    ]);
    tree.blocks[0].weeks[1].weekNumber = 5;
    const copy = normalizeTree(tree);

    const codes = checkShape(copy, ctx).map((v) => v.code);

    expect(copy.blocks[0].weeks.map((w) => w.weekNumber)).toEqual([1, 2]);
    expect(codes).toEqual(expect.arrayContaining(['week_renumbered', 'rep_range_swapped', 'rpe_bounded', 'rest_bounded']));
    const first = copy.blocks[0].weeks[0].workouts[0].exercises[0];
    expect([first.repMin, first.repMax, first.targetRpe, first.restSeconds]).toEqual([6, 12, 10, 30]);
    expect(checkSchema(copy)).toEqual([]);
  });

  describe('prescription shape against the tracking mode', () => {
    const cardio = { targetSets: null, repMin: null, repMax: null };
    const run = (exercises: ReturnType<typeof ex>[]) => {
      const tree = normalizeTree(planTree([{ workouts: [{ weekday: 1, exercises: [ex('goblet_squat'), ...exercises] }] }]));
      return { tree, found: checkShape(tree, ctx).map((v) => [v.severity, v.code]) };
    };

    it.each([
      ['a duration on a time exercise', ex('plank', { ...cardio, targetDurationSeconds: 180 })],
      ['a duration on a distance_time exercise', ex('treadmill_run', { ...cardio, targetDurationSeconds: 1800 })],
      ['a distance on a distance_time exercise', ex('treadmill_run', { ...cardio, targetDurationSeconds: null, targetDistanceMeters: 5000 })],
      ['sets and reps on a weight_reps exercise', ex('barbell_bench_press')],
    ])('accepts %s', (_label, exercise) => {
      const { tree, found } = run([exercise]);
      expect(found).toEqual([]);
      expect(checkSchema(tree)).toEqual([]);
    });

    it.each([
      ['reps on a time exercise', ex('plank', { repMin: 8, repMax: 12, targetDurationSeconds: null })],
      ['reps on a distance_time exercise', ex('treadmill_run', { repMin: 8, repMax: 12, targetDurationSeconds: null })],
      ['a distance on a time exercise', ex('plank', { ...cardio, targetDurationSeconds: null, targetDistanceMeters: 500 })],
      ['a duration on a weight_reps exercise', ex('barbell_bench_press', { ...cardio, targetDurationSeconds: 600 })],
    ])('blocks %s', (_label, exercise) => {
      expect(run([exercise]).found).toEqual([['block', 'prescription_shape_mismatch']]);
    });

    it('blocks an exercise with no prescription at all', () => {
      expect(run([ex('push_up', { ...cardio })]).found).toEqual([['block', 'prescription_missing']]);
    });

    it('keeps the shape the tracking mode takes when both are given', () => {
      const both = run([ex('treadmill_run', { targetSets: 1, repMin: 8, repMax: 12, targetDurationSeconds: 1200 }), ex('push_up', { targetDurationSeconds: 300 })]);
      expect(both.found).toEqual([
        ['repair', 'prescription_reps_cleared'],
        ['repair', 'prescription_targets_cleared'],
      ]);
      const [, run1, pushUp] = both.tree.blocks[0].weeks[0].workouts[0].exercises;
      expect([run1.repMin, run1.repMax, run1.targetDurationSeconds]).toEqual([null, null, 1200]);
      expect([pushUp.repMin, pushUp.targetDurationSeconds]).toEqual([8, null]);
      expect(checkSchema(both.tree)).toEqual([]);
    });

    it('brings cardio targets into the plan bounds and leaves their rest alone', () => {
      const { tree, found } = run([ex('treadmill_run', { ...cardio, targetDurationSeconds: 40000, targetDistanceMeters: 50.555, restSeconds: 0 })]);
      expect(found).toEqual([
        ['repair', 'duration_bounded'],
        ['repair', 'distance_bounded'],
      ]);
      const walk = tree.blocks[0].weeks[0].workouts[0].exercises[1];
      expect([walk.targetDurationSeconds, walk.targetDistanceMeters, walk.restSeconds]).toEqual([36000, 100, 0]);
    });
  });

  it('checkSchema blocks what the strict plan schema refuses', () => {
    const tree = planTree([{ workouts: [{ weekday: 1, exercises: [ex('goblet_squat', { targetSets: 99 })] }] }]);
    expect(checkSchema(tree)).toEqual([expect.objectContaining({ rule: 'G1', severity: 'block', code: 'invalid_plan' })]);
  });
});
