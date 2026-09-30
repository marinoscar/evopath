import { ex, guardrailContextFixture, keysOf, planTree, repeatWeeks } from '../testing/plan-fixtures';
import { checkInjury, reduceSessionSets } from './injury';
import { effectiveLimits } from './limits';
import { applyDeloadTransform, checkRecovery } from './recovery';
import { normalizeTree, sessionSets, setsByMuscle } from './tree';
import { checkVolume } from './volume';

const codes = (violations: Array<{ severity: string; code: string }>) => violations.map((v) => `${v.severity}:${v.code}`);

describe('level limits', () => {
  it.each([
    ['beginner', false, { weeklySetsMin: 4, weeklySetsMax: 12, sessionSetsRepairAbove: 20, sessionSetsBlockAbove: 30, rpeCap: 8, setsPerExercise: 6, weeklyMuscleBlockAbove: 25 }],
    ['intermediate', false, { weeklySetsMin: 8, weeklySetsMax: 18, sessionSetsRepairAbove: 26, sessionSetsBlockAbove: 36, rpeCap: 9, setsPerExercise: 6, weeklyMuscleBlockAbove: 25 }],
    ['advanced', false, { weeklySetsMin: 10, weeklySetsMax: 22, sessionSetsRepairAbove: 30, sessionSetsBlockAbove: 40, rpeCap: 9, setsPerExercise: 6, weeklyMuscleBlockAbove: 25 }],
    ['intermediate', true, { weeklySetsMin: 8, weeklySetsMax: 13, sessionSetsRepairAbove: 19, sessionSetsBlockAbove: 27, rpeCap: 7, setsPerExercise: 4, weeklyMuscleBlockAbove: 18 }],
    ['advanced', true, { weeklySetsMin: 10, weeklySetsMax: 16, sessionSetsRepairAbove: 22, sessionSetsBlockAbove: 30, rpeCap: 7, setsPerExercise: 4, weeklyMuscleBlockAbove: 18 }],
  ] as const)('%s (conservative %s)', (level, conservative, expected) => {
    expect(effectiveLimits(level, conservative)).toEqual(expected);
  });
});

describe('G4 volume and intensity', () => {
  it('8 sets on every exercise are clamped to 6; RPE above the level cap and rest above 300 s are clamped', () => {
    const ctx = guardrailContextFixture({ intake: { experience: 'beginner' } });
    const tree = normalizeTree(
      planTree([{ workouts: [{ weekday: 1, exercises: [ex('goblet_squat', { sets: 8, targetRpe: 9.5 }), ex('push_up', { sets: 8, restSeconds: 400 })] }] }]),
    );

    const violations = checkVolume(tree, ctx);
    const [a, b] = tree.blocks[0].weeks[0].workouts[0].exercises;

    expect([a.targetSets, b.targetSets, a.targetRpe, b.restSeconds]).toEqual([6, 6, 8, 300]);
    expect(codes(violations)).toEqual(
      expect.arrayContaining(['repair:exercise_sets_clamped', 'repair:rpe_clamped', 'repair:rest_clamped']),
    );
  });

  it('40 sets in a session are trimmed to the level cap (accessories first)', () => {
    const ctx = guardrailContextFixture();
    const keys = ['barbell_back_squat', 'barbell_bench_press', 'barbell_row', 'romanian_deadlift', 'dumbbell_curl', 'triceps_pushdown', 'dumbbell_lateral_raise', 'plank'];
    const tree = normalizeTree(planTree([{ workouts: [{ weekday: 1, exercises: keys.map((k, i) => ex(k, { sets: 5, isPriority: i < 2 })) }] }]));

    const violations = checkVolume(tree, ctx);

    expect(sessionSets(tree.blocks[0].weeks[0].workouts[0])).toBeLessThanOrEqual(26);
    expect(codes(violations)).toContain('repair:session_sets_clamped');
    expect(codes(violations)).not.toContain('block:session_sets_excessive');
  });

  it('more workouts than days per week: the surplus goes from the end of the week; non-preferred days move', () => {
    const ctx = guardrailContextFixture({ intake: { daysPerWeek: 2, preferredWeekdays: [2, 4, 6] } });
    const day = (weekday: number, name: string) => ({ weekday, name, exercises: [ex('goblet_squat'), ex('push_up')] });
    const tree = normalizeTree(planTree([{ workouts: [day(1, 'A'), day(3, 'B'), day(5, 'C')] }]));

    const violations = checkVolume(tree, ctx);

    expect(tree.blocks[0].weeks[0].workouts.map((w) => [w.name, w.weekday])).toEqual([
      ['A', 2],
      ['B', 4],
    ]);
    expect(codes(violations)).toEqual(expect.arrayContaining(['repair:surplus_workout_removed', 'repair:weekday_moved']));
  });

  it('weekly sets per muscle above the range are clamped down; unrepairable above 25 blocks; below the range warns', () => {
    const ctx = guardrailContextFixture({ intake: { goal: { type: 'hypertrophy', description: '' } } });
    const chest = ['barbell_bench_press', 'dumbbell_bench_press', 'machine_chest_press', 'push_up', 'cable_fly'];
    const tree = normalizeTree(
      planTree([
        { workouts: [{ weekday: 1, exercises: chest.map((k) => ex(k, { sets: 5 })) }, { weekday: 4, exercises: chest.map((k) => ex(k, { sets: 5 })) }] },
      ]),
    );

    const violations = checkVolume(tree, ctx);

    expect(setsByMuscle(ctx, tree.blocks[0].weeks[0].workouts, ['full_body']).get('chest')).toBe(18);
    expect(codes(violations)).toContain('repair:muscle_volume_clamped');
    expect(codes(violations)).toContain('warn:muscle_volume_low'); // quads, lats, ... untrained

    const stuck = normalizeTree(
      planTree([
        {
          workouts: [1, 3, 5].map((weekday) => ({
            weekday,
            exercises: ['barbell_bench_press', 'dumbbell_bench_press', 'machine_chest_press', 'push_up', 'cable_fly'].map((k) => ex(k, { sets: 2, isPriority: true })),
          })),
        },
      ]),
    );
    expect(codes(checkVolume(stuck, ctx))).toContain('block:muscle_volume_excessive');
  });
});

describe('G6 injury and pain', () => {
  it('an avoid-list exercise is substituted within its pattern; a pain-flagged one too; no substitute removes it', () => {
    const ctx = guardrailContextFixture({ intake: { avoidExerciseKeys: ['barbell_back_squat', 'plank'] } });
    const pained = { ...ctx, painFlagKeys: new Set(['barbell_bench_press']) };
    const tree = normalizeTree(
      planTree([{ workouts: [{ weekday: 1, exercises: [ex('barbell_back_squat', { isPriority: true }), ex('barbell_bench_press'), ex('plank')] }] }]),
    );

    const violations = checkInjury(tree, pained);

    expect(keysOf(tree, ctx)).toEqual([[['goblet_squat', 'dumbbell_bench_press']]]);
    expect(codes(violations)).toEqual(['repair:avoided_substituted', 'repair:pain_substituted', 'repair:avoided_removed']);
  });

  it('conservative mode caps RPE at 7, sets per exercise at 4 and session sets at 22', () => {
    const ctx = guardrailContextFixture({ intake: { limitations: [{ area: 'other', description: '' }] } });
    expect(ctx.conservative).toBe(true);
    const keys = ['goblet_squat', 'push_up', 'dumbbell_row', 'dumbbell_curl', 'triceps_pushdown', 'dumbbell_lateral_raise', 'glute_bridge'];
    const tree = normalizeTree(planTree([{ workouts: [{ weekday: 1, exercises: keys.map((k) => ex(k, { sets: 6, targetRpe: 9 })) }] }]));

    const violations = checkInjury(tree, ctx);
    const workout = tree.blocks[0].weeks[0].workouts[0];

    expect(workout.exercises.every((e) => e.targetRpe! <= 7 && e.targetSets <= 4)).toBe(true);
    expect(sessionSets(workout)).toBeLessThanOrEqual(22);
    expect(codes(violations)).toEqual(expect.arrayContaining(['repair:conservative_rpe', 'repair:conservative_sets', 'repair:conservative_session_sets']));
  });

  it('a knee limitation warns once per higher-risk exercise (squat, lunge, impact)', () => {
    const ctx = guardrailContextFixture({ intake: { limitations: [{ area: 'knee', description: '' }] } });
    const week = { workouts: [{ weekday: 1, exercises: [ex('goblet_squat'), ex('walking_lunge'), ex('push_up')] }] };
    const tree = normalizeTree(planTree(repeatWeeks(3, week)));

    const warnings = checkInjury(tree, ctx).filter((v) => v.code === 'limitation_risk');

    expect(warnings.map((v) => v.path)).toEqual(['week 1 > Mon (Day 1) > goblet_squat', 'week 1 > Mon (Day 1) > walking_lunge']);
  });

  it('reduceSessionSets trims accessories first, then drops them, then priority sets, floor 2', () => {
    const tree = normalizeTree(planTree([{ workouts: [{ weekday: 1, exercises: [ex('goblet_squat', { sets: 6, isPriority: true }), ex('push_up', { sets: 6 }), ex('plank', { sets: 6 })] }] }]));
    const workout = tree.blocks[0].weeks[0].workouts[0];

    const done = reduceSessionSets(workout, 9);
    expect(workout.exercises.map((e) => e.targetSets)).toEqual([6, 2]);
    expect(done.filter((d) => d.startsWith('drop:'))).toHaveLength(1);
    expect(sessionSets(workout)).toBeLessThanOrEqual(9);
    expect(workout.exercises[0]).toMatchObject({ isPriority: true });
  });
});

describe('G5 recovery', () => {
  const legs = (weekday: number, name: string) => ({ weekday, name, exercises: [ex('barbell_back_squat', { sets: 4 }), ex('leg_press', { sets: 3 })] });
  const upper = (weekday: number, name: string) => ({ weekday, name, exercises: [ex('barbell_bench_press'), ex('barbell_row')] });

  it('the same muscle hard on consecutive days: the later workout moves to a free allowed day', () => {
    const ctx = guardrailContextFixture();
    const tree = normalizeTree(planTree([{ workouts: [legs(1, 'Legs A'), legs(2, 'Legs B'), upper(4, 'Upper')] }]));

    const violations = checkRecovery(tree, ctx);

    expect(tree.blocks[0].weeks[0].workouts.map((w) => [w.name, w.weekday])).toEqual([
      ['Legs A', 1],
      ['Legs B', 3],
      ['Upper', 4],
    ]);
    expect(codes(violations)).toEqual(['repair:consecutive_days_moved']);
  });

  it('no allowed free day fixes it: a warning', () => {
    const ctx = guardrailContextFixture({ intake: { daysPerWeek: 2, preferredWeekdays: [1, 2] } });
    const tree = normalizeTree(planTree([{ workouts: [legs(1, 'A'), legs(2, 'B')] }]));
    expect(codes(checkRecovery(tree, ctx))).toEqual(['warn:consecutive_days']);
  });

  it('seven workouts in a week: no rest day warns', () => {
    const ctx = guardrailContextFixture({ intake: { daysPerWeek: 7 } });
    const tree = normalizeTree(planTree([{ workouts: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ weekday: d, exercises: [ex('push_up', { sets: 2 }), ex('plank', { sets: 2 })] })) }]));
    expect(codes(checkRecovery(tree, ctx))).toContain('warn:no_rest_day');
  });

  it.each([
    [4, []],
    [6, [6]],
    [8, [6]],
    [12, [6, 12]],
    [24, [6, 12, 18, 24]],
  ])('a %i-week plan without deloads gets deload weeks %j', (weeks, deloads) => {
    const ctx = guardrailContextFixture();
    const tree = normalizeTree(planTree(repeatWeeks(weeks, { workouts: [upper(1, 'U')] })));

    checkRecovery(tree, ctx);

    expect(tree.blocks[0].weeks.filter((w) => w.isDeload).map((w) => w.weekNumber)).toEqual(deloads);
  });

  it('a planned deload resets the count', () => {
    const ctx = guardrailContextFixture();
    const weeks = repeatWeeks(8, { workouts: [upper(1, 'U')] });
    weeks[3].deload = true;
    const tree = normalizeTree(planTree(weeks));
    expect(checkRecovery(tree, ctx)).toEqual([]);
  });

  it('the deload transform: sets x 0.6 (min 2), load x 0.9, else RPE minus 2', () => {
    const tree = normalizeTree(
      planTree([
        { workouts: [{ weekday: 1, exercises: [ex('barbell_back_squat', { sets: 5, targetLoadKg: 101 }), ex('push_up', { sets: 3, targetRpe: 8 }), ex('plank', { sets: 2 })] }] },
      ]),
    );
    applyDeloadTransform(tree.blocks[0].weeks[0]);
    expect(tree.blocks[0].weeks[0].workouts[0].exercises.map((e) => [e.targetSets, e.targetLoadKg, e.targetRpe])).toEqual([
      [3, 90.5, 7],
      [2, null, 6],
      [2, null, 5],
    ]);
  });
});
