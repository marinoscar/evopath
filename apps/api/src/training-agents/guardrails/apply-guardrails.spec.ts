import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import { LIB } from '../testing/context-fixtures';
import { ex, guardrailContextFixture, planTree, repeatWeeks, type WeekSpec } from '../testing/plan-fixtures';
import { applyGuardrails, summarizeReport } from './index';
import type { GuardrailContext } from './types';

/** A messy 12-week plan: too many sets, an unknown key, an avoided lift, a fixed load without history, bad refs. */
function messyTree(): PlanTree {
  const week: WeekSpec = {
    workouts: [
      {
        weekday: 1,
        name: 'Lower',
        exercises: [
          ex('barbell_back_squat', { isPriority: true, sets: 6, repMin: 3, repMax: 5, restSeconds: 180, targetLoadKg: 140, loadGuidance: 'fixed', evidenceRefs: ['E1', 'E7'] }),
          ex('romanian_deadlift', { isPriority: true, sets: 5, targetRpe: 9.5 }),
          ex('leg_press', { sets: 6 }),
          ex('made_up_move'),
          ex('dumbbell_lunge', { sets: 6, repMax: 20 }),
          ex('plank', { sets: 5, rationale: 'Core by 40% (https://spam.example).' }),
        ],
      },
      {
        weekday: 1,
        name: 'Upper',
        exercises: [
          ex('barbell_bench_press', { isPriority: true, sets: 8 }),
          ex('barbell_row', { isPriority: true, sets: 8, targetLoadKg: 90, loadGuidance: 'fixed' }),
          ex('dumbbell_curl', { sets: 8 }),
          ex('triceps_pushdown', { sets: 8 }),
        ],
      },
      { weekday: 3, name: 'Full', exercises: [ex('goblet_squat'), ex('push_up'), ex('pull_up')] },
      { weekday: 6, name: 'Extra', exercises: [ex('treadmill_run'), ex('plank')] },
    ],
  };
  return planTree(repeatWeeks(12, week));
}

function context(): GuardrailContext {
  const ctx = guardrailContextFixture({ intake: { avoidExerciseKeys: ['romanian_deadlift'], daysPerWeek: 3, minutesPerSession: 60 } });
  return {
    ...ctx,
    history: new Map([
      [LIB.barbell_back_squat.id, { exerciseId: LIB.barbell_back_squat.id, key: 'barbell_back_squat', lastLoadKg: 120, lastDate: '2026-09-27', lastMinReps: 5, bestRecentLoadKg: 125, painFlagged: false }],
    ]),
  };
}

/** A shuffled copy: array order changes, positions do not. */
function shuffled(tree: PlanTree): PlanTree {
  const copy: PlanTree = JSON.parse(JSON.stringify(tree));
  for (const block of copy.blocks)
    for (const week of block.weeks) {
      week.workouts.reverse();
      for (const workout of week.workouts) workout.exercises.reverse();
    }
  return copy;
}

describe('applyGuardrails', () => {
  it('repairs the messy plan into a valid, bounded one and reports it as repaired', () => {
    const ctx = context();
    const { tree, report } = applyGuardrails(messyTree(), ctx);

    expect(report.status).toBe('repaired');
    expect(report.counts.block).toBe(0);
    const rules = new Set(report.violations.map((v) => v.rule));
    for (const rule of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G8', 'G9']) expect(rules).toContain(rule);

    for (const week of tree.blocks[0].weeks) {
      expect(week.workouts.length).toBeLessThanOrEqual(3);
      expect(new Set(week.workouts.map((w) => w.weekday)).size).toBe(week.workouts.length);
      for (const workout of week.workouts) {
        expect(workout.estimatedMinutes).toBeLessThanOrEqual(63);
        for (const e of workout.exercises) {
          const key = ctx.library.get(e.exerciseId)?.key;
          expect(key).toBeDefined();
          expect(key).not.toBe('romanian_deadlift');
          expect(e.targetSets).toBeLessThanOrEqual(6);
          expect(e.evidenceRefs.every((r) => r === 'E1')).toBe(true);
          if (key !== 'barbell_back_squat') expect(e.targetLoadKg).toBeNull();
        }
      }
    }
    // Deloads were added in weeks 6 and 12.
    expect(tree.blocks[0].weeks.filter((w) => w.isDeload).map((w) => w.weekNumber)).toEqual([6, 12]);
  });

  it('is deterministic, idempotent and independent of the input order of exercises and workouts', () => {
    const ctx = context();
    const first = applyGuardrails(messyTree(), ctx);
    const again = applyGuardrails(messyTree(), ctx);
    const reordered = applyGuardrails(shuffled(messyTree()), ctx);
    const twice = applyGuardrails(first.tree, ctx);

    expect(again).toEqual(first);
    expect(reordered.tree).toEqual(first.tree);
    expect(twice.tree).toEqual(first.tree);
    expect(twice.report.violations.filter((v) => v.severity === 'repair')).toEqual([]);
  });

  it('never mutates its input', () => {
    const input = messyTree();
    const before = JSON.stringify(input);
    applyGuardrails(input, context());
    expect(JSON.stringify(input)).toBe(before);
  });

  it('a clean plan reports clean', () => {
    const ctx = guardrailContextFixture({ intake: { durationWeeks: 4 } });
    const week: WeekSpec = {
      workouts: [
        { weekday: 1, name: 'A', exercises: [ex('goblet_squat', { isPriority: true, sets: 4 }), ex('dumbbell_bench_press', { sets: 4 }), ex('dumbbell_row', { sets: 4 })] },
        { weekday: 3, name: 'B', exercises: [ex('dumbbell_romanian_deadlift', { isPriority: true, sets: 4 }), ex('dumbbell_shoulder_press', { sets: 4 }), ex('lat_pulldown', { sets: 4 })] },
        { weekday: 5, name: 'C', exercises: [ex('leg_press', { isPriority: true, sets: 4 }), ex('machine_chest_press', { sets: 4 }), ex('seated_cable_row', { sets: 4 })] },
      ],
    };
    const { report } = applyGuardrails(planTree(repeatWeeks(4, week)), { ...ctx, goal: 'general' });

    expect(report).toEqual({ status: 'clean', violations: [], counts: { block: 0, repair: 0, warn: 0 } });
  });

  it('summarizeReport: blocked with any block, repaired with repairs or warnings, clean otherwise', () => {
    const v = (severity: 'block' | 'repair' | 'warn') => ({ rule: 'G1' as const, severity, code: 'x', path: 'p', message: 'm' });
    expect(summarizeReport([]).status).toBe('clean');
    expect(summarizeReport([v('warn')]).status).toBe('repaired');
    expect(summarizeReport([v('repair'), v('warn')]).status).toBe('repaired');
    expect(summarizeReport([v('repair'), v('block')])).toMatchObject({ status: 'blocked', counts: { block: 1, repair: 1, warn: 0 } });
  });
});
