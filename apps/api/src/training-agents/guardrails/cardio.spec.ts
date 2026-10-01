import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import type { TrainingIntakeInput } from '../contracts/training-intake.contract';
import { supportedBy } from '../context/build-planner-context';
import { FULL_GYM, LIB, inventoryOf } from '../testing/context-fixtures';
import { ex, guardrailContextFixture, keysOf, planTree, repeatWeeks, type WeekSpec } from '../testing/plan-fixtures';
import { checkCardio, weekCardioMinutes, weeklyCardioCapMinutes } from './cardio';
import { checkEquipment } from './equipment';
import { applyGuardrails } from './index';
import { normalizeTree } from './tree';
import type { GuardrailReport } from './types';

// Walking and jogging sessions (#265): G2 lets equipment-free cardio through,
// the cardio rule (G4) requires, places and bounds requested cardio, and the
// other rules treat requested cardio-only workouts as extra days.

const WALK_4X30 = { include: true, activity: 'walk', daysPerWeek: 4, minutesPerSession: 30 } as const;

const walk = (seconds = 1800) => ex('outdoor_walk', { sets: 1, targetDurationSeconds: seconds, restSeconds: 0, targetRpe: null });
const strength = (weekday: number) => ({
  weekday,
  exercises: [
    ex('goblet_squat', { sets: 3, isPriority: true }),
    ex('dumbbell_bench_press', { sets: 3, isPriority: true }),
    ex('dumbbell_row', { sets: 3 }),
  ],
});

/** Mon, Wed, Fri strength; walks on Tue, Thu, Sat, Sun. */
const STRENGTH_AND_WALKS: WeekSpec = {
  workouts: [strength(1), { weekday: 2, exercises: [walk()] }, strength(3), { weekday: 4, exercises: [walk()] }, strength(5), { weekday: 6, exercises: [walk()] }, { weekday: 7, exercises: [walk()] }],
};

function ctxWith(intake: Partial<TrainingIntakeInput>) {
  return guardrailContextFixture({ intake: { daysPerWeek: 3, minutesPerSession: 60, ...intake } });
}

const codes = (report: GuardrailReport) => report.violations.map((v) => `${v.rule}:${v.severity}:${v.code}`);
const durations = (tree: PlanTree) =>
  tree.blocks[0].weeks.map((w) => w.workouts.flatMap((o) => o.exercises.filter((e) => e.targetDurationSeconds !== null).map((e) => e.targetDurationSeconds)));

describe('G2 and equipment-free cardio', () => {
  it.each(['outdoor_walk', 'hike', 'outdoor_run'])('%s needs nothing: supported with no gym and with any gym', (key) => {
    expect(LIB[key].requirements).toEqual([]);
    expect(supportedBy(LIB[key], null)).toBe(true);
    expect(supportedBy(LIB[key], inventoryOf(FULL_GYM))).toBe(true);
  });

  it('no gym (bodyweight only) keeps outdoor walks and runs, and only swaps the treadmill', () => {
    const ctx = guardrailContextFixture({ intake: { gymId: null }, gym: null });
    const tree = normalizeTree(
      planTree([{ workouts: [{ weekday: 2, exercises: [walk(), ex('outdoor_run', { sets: 1, targetDurationSeconds: 1200, restSeconds: 0 }), ex('hike', { sets: 1, targetDurationSeconds: 3600, restSeconds: 0 })] }] }]),
    );

    expect(checkEquipment(tree, ctx)).toEqual([]);
    expect(keysOf(tree, ctx)).toEqual([[['outdoor_walk', 'outdoor_run', 'hike']]]);
  });
});

describe('cardio sessions (#265)', () => {
  it('3 strength days plus 4 requested walks ship whole: no surplus removed, no move, no rest-day warning, no trim', () => {
    const ctx = ctxWith({ cardio: WALK_4X30, preferredWeekdays: [1, 3, 5] });
    const { tree, report } = applyGuardrails(planTree(repeatWeeks(4, STRENGTH_AND_WALKS)), ctx);

    expect(report.status).not.toBe('blocked');
    const found = codes(report).join(' ');
    for (const code of ['surplus_workout_removed', 'weekday_moved', 'weekday_not_preferred', 'no_rest_day', 'trim_', 'time_unfit', 'cardio_']) {
      expect(found).not.toContain(code);
    }
    for (const week of tree.blocks[0].weeks) {
      expect(week.workouts.map((w) => w.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(weekCardioMinutes(ctx, week)).toBe(120);
    }
    expect(durations(tree)[0]).toEqual([1800, 1800, 1800, 1800]);
  });

  it('without a cardio request the same week keeps its old budget: workouts beyond daysPerWeek are removed', () => {
    const { report } = applyGuardrails(planTree([STRENGTH_AND_WALKS]), ctxWith({}));
    expect(codes(report)).toContain('G4:repair:surplus_workout_removed');
  });

  it('requested but absent: blocks, so the planner revises', () => {
    const ctx = ctxWith({ cardio: { include: true, activity: 'walk' } });
    const { report } = applyGuardrails(planTree(repeatWeeks(2, { workouts: [strength(1), strength(3), strength(5)] })), ctx);

    expect(report.status).toBe('blocked');
    const block = report.violations.find((v) => v.code === 'cardio_missing')!;
    expect(block).toMatchObject({ rule: 'G4', severity: 'block', path: 'plan' });
    expect(block.message).toContain('walking sessions');
  });

  it('not requested: no cardio is fine', () => {
    const { report } = applyGuardrails(planTree([{ workouts: [strength(1), strength(3), strength(5)] }]), ctxWith({ goal: { type: 'fat_loss' } }));
    expect(codes(report).join(' ')).not.toContain('cardio_');
  });

  it('a walk inside a strength workout moves to a free weekday', () => {
    const ctx = ctxWith({ cardio: WALK_4X30 });
    const tree = normalizeTree(planTree([{ workouts: [{ ...strength(1), exercises: [...strength(1).exercises, walk()] }, strength(3), strength(5)] }]));

    const violations = checkCardio(tree, ctx);

    expect(violations.map((v) => v.code)).toEqual(['cardio_moved_to_free_day']);
    expect(violations[0].message).toBe('Moved outdoor_walk from the Mon workout to Tue, a day without a strength workout.');
    const week = tree.blocks[0].weeks[0];
    expect(week.workouts.map((w) => w.weekday)).toEqual([1, 2, 3, 5]);
    expect(keysOf(tree, ctx)[0][1]).toEqual(['outdoor_walk']);
    expect(keysOf(tree, ctx)[0][0]).toEqual(['goblet_squat', 'dumbbell_bench_press', 'dumbbell_row']);
  });

  it('every weekday taken: the walk stays with the strength workout (doubling up), and G3 gives it its own minutes', () => {
    const ctx = ctxWith({ cardio: WALK_4X30, daysPerWeek: 7, minutesPerSession: 30 });
    const days = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ weekday: d, exercises: [ex('push_up', { sets: 2 }), ex('bodyweight_squat', { sets: 2 })] }));
    days[0].exercises.push(walk());

    const { tree, report } = applyGuardrails(planTree([{ workouts: days }]), ctx);

    expect(codes(report).join(' ')).not.toContain('cardio_moved');
    expect(codes(report).join(' ')).not.toMatch(/trim_|time_unfit/);
    expect(keysOf(tree, ctx)[0][0]).toContain('outdoor_walk');
  });

  it('weekly minutes above days x minutes x 1.25 are scaled down to fit (cardio_minutes_bounded), and a rerun changes nothing', () => {
    const ctx = ctxWith({ cardio: WALK_4X30 });
    expect(weeklyCardioCapMinutes(ctx.cardio)).toBe(150);
    const heavy: WeekSpec = JSON.parse(JSON.stringify(STRENGTH_AND_WALKS).replace(/1800/g, '2700'));

    const first = applyGuardrails(planTree(repeatWeeks(2, heavy)), ctx);

    const bounded = first.report.violations.filter((v) => v.code === 'cardio_minutes_bounded');
    expect(bounded.map((v) => v.path)).toEqual(['week 1', 'week 2']);
    expect(bounded[0]).toMatchObject({ rule: 'G4', severity: 'repair' });
    expect(bounded[0].message).toBe('Weekly cardio of about 180 minutes lowered to 148: you asked for 4 sessions of 30 minutes (at most 150 minutes a week).');
    for (const week of first.tree.blocks[0].weeks) expect(weekCardioMinutes(ctx, week)).toBeLessThanOrEqual(150);
    expect(durations(first.tree)[0]).toEqual([2220, 2220, 2220, 2220]);

    const second = applyGuardrails(first.tree, ctx);
    expect(second.tree).toEqual(first.tree);
    expect(second.report.violations.map((v) => v.code)).not.toContain('cardio_minutes_bounded');
  });

  it('distance-only walks are bounded by their distance', () => {
    const ctx = ctxWith({ cardio: { include: true, activity: 'walk', daysPerWeek: 1, minutesPerSession: 20 } });
    const tree = normalizeTree(
      planTree([{ workouts: [strength(1), { weekday: 2, exercises: [ex('outdoor_walk', { sets: 1, targetDurationSeconds: null, targetDistanceMeters: 5000, restSeconds: 0 })] }] }]),
    );

    expect(checkCardio(tree, ctx).map((v) => v.code)).toEqual(['cardio_minutes_bounded']);
    // Cap 25 minutes: 5000 m at 0.48 s/m is 40 minutes, scaled by 25/40.
    expect(tree.blocks[0].weeks[0].workouts[1].exercises[0].targetDistanceMeters).toBe(3125);
  });

  it('weekly minutes jumping more than 20% over the previous non-deload week warn', () => {
    const ctx = ctxWith({ cardio: { include: true, activity: 'walk' } });
    const week = (seconds: number, deload = false): WeekSpec => ({ deload, workouts: [strength(1), { weekday: 2, exercises: [walk(seconds)] }] });
    const tree = normalizeTree(planTree([week(1800), week(1980), week(600, true), week(2700)]));

    const warns = checkCardio(tree, ctx).filter((v) => v.code === 'cardio_minutes_jump');

    expect(warns.map((v) => [v.path, v.severity])).toEqual([['week 4', 'warn']]);
    expect(warns[0].message).toContain('from about 33 to 45 minutes');
  });

  it('a cardio-only workout is timed against the cardio session length, not the strength minutes', () => {
    const ctx = ctxWith({ cardio: { include: true, activity: 'walk', daysPerWeek: 2, minutesPerSession: 60 }, minutesPerSession: 30 });
    const { report } = applyGuardrails(planTree([{ workouts: [strength(1), { weekday: 3, exercises: [walk(3600)] }] }]), ctx);

    expect(codes(report).join(' ')).not.toMatch(/time_unfit|trim_/);
  });
});
