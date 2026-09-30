import type { PlanChangeOperation } from '../../programs/contracts/plan-change.contract';
import { planTreeSchema } from '../../programs/contracts/plan-tree.contract';
import { LIB } from '../testing/context-fixtures';
import { adaptationTree, prescription, rowsOf } from '../testing/adaptation-fixtures';
import { type AcceptedOperation, applyOperations, deloadExercise, storedOperation, targetRowIds } from './apply-operations';
import { describeOperation } from './describe-operation';
import { fingerprintOf, suppressedFingerprints } from './fingerprints';

// =============================================================================
// applyOperations (per operation), describeOperation, fingerprints.
// =============================================================================

const tree = adaptationTree();
const week = (n: number) => tree.blocks[0].weeks[n - 1];
const squatRow = (n: number) => week(n).workouts[0].exercises[0];

function accepted(op: PlanChangeOperation, targets: Partial<AcceptedOperation['targets']>): AcceptedOperation {
  return {
    ...(op as object),
    fingerprint: 'fp',
    description: 'd',
    targets: { exerciseRowIds: [], workoutRowIds: [], weekNumbers: [], exerciseId: null, ...targets },
  } as AcceptedOperation;
}

describe('applyOperations', () => {
  it('set_prescription writes only the non-null fields, on the targeted rows only', () => {
    const op = accepted({ ...prescription('W4-1-1', { from: 4, to: 4 }, { sets: 4, targetLoadKg: 102.5 }) }, { exerciseRowIds: [squatRow(4).id!] });
    const { tree: out, missing } = applyOperations(tree, [op]);

    expect(missing).toEqual([]);
    const rows = rowsOf(out, 'barbell_back_squat');
    expect(rows.find((r) => r.weekNumber === 4)!.exercise).toMatchObject({ targetSets: 4, targetLoadKg: 102.5, repMin: 5, repMax: 8, loadGuidance: 'fixed' });
    expect(rows.find((r) => r.weekNumber === 3)!.exercise).toMatchObject({ targetSets: 3, targetLoadKg: 100 });
    // The input is untouched.
    expect(squatRow(4).targetSets).toBe(3);
  });

  it('set_prescription keeps repMin <= repMax', () => {
    const op = accepted({ ...prescription('W4-1-1', { from: 4, to: 4 }, { repMin: 10 }) }, { exerciseRowIds: [squatRow(4).id!] });
    const row = rowsOf(applyOperations(tree, [op]).tree, 'barbell_back_squat').find((r) => r.weekNumber === 4)!.exercise;
    expect([row.repMin, row.repMax]).toEqual([10, 10]);
  });

  it('swap_exercise replaces the exercise, keeps the prescription and resets the load', () => {
    const op = accepted(
      { op: 'swap_exercise', target: { exerciseRef: 'W4-1-1', weeks: { from: 4, to: 4 } }, withExerciseKey: 'leg_press', reason: 'r' },
      { exerciseRowIds: [squatRow(4).id!], exerciseId: LIB.leg_press.id },
    );
    const out = applyOperations(tree, [op]).tree.blocks[0].weeks[3].workouts[0].exercises[0];
    expect(out).toMatchObject({ exerciseId: LIB.leg_press.id, targetSets: 3, repMin: 5, repMax: 8, targetLoadKg: null, loadGuidance: 'choose_start', isPriority: true });
    expect(out.id).toBe(squatRow(4).id);
  });

  it('remove_exercise removes the targeted rows', () => {
    const op = accepted(
      { op: 'remove_exercise', target: { exerciseRef: 'W4-1-2', weeks: { from: 4, to: 5 } }, reason: 'r' },
      { exerciseRowIds: [week(4).workouts[0].exercises[1].id!, week(5).workouts[0].exercises[1].id!] },
    );
    const out = applyOperations(tree, [op]).tree;
    expect(rowsOf(out, 'barbell_bench_press').map((r) => r.weekNumber)).toEqual([1, 2, 3]);
  });

  it('add_exercise appends a new row at the end of each targeted workout', () => {
    const op = accepted(
      { op: 'add_exercise', workoutRef: 'W4-3', weeks: { from: 4, to: 4 }, exerciseKey: 'dumbbell_lateral_raise', sets: 2, repMin: 12, repMax: 15, targetRpe: 8, restSeconds: 60, reason: 'r' },
      { workoutRowIds: [week(4).workouts[2].id!], exerciseId: LIB.dumbbell_lateral_raise.id },
    );
    const out = applyOperations(tree, [op]).tree;
    const workout = out.blocks[0].weeks[3].workouts[2];
    expect(workout.exercises).toHaveLength(4);
    expect(workout.exercises[3]).toMatchObject({ exerciseId: LIB.dumbbell_lateral_raise.id, position: 3, targetSets: 2, isPriority: false, targetLoadKg: null });
    expect(workout.exercises[3].id).toBeUndefined();
    expect(planTreeSchema.safeParse(out).success).toBe(true);
  });

  it('set_weekday and drop_workout change the targeted workouts', () => {
    const move = accepted({ op: 'set_weekday', workoutRef: 'W4-3', weeks: { from: 4, to: 4 }, weekday: 6, reason: 'r' }, { workoutRowIds: [week(4).workouts[2].id!] });
    const drop = accepted({ op: 'drop_workout', workoutRef: 'W5-2', weeks: { from: 5, to: 5 }, reason: 'r' }, { workoutRowIds: [week(5).workouts[1].id!] });
    const out = applyOperations(tree, [move, drop]).tree;
    expect(out.blocks[0].weeks[3].workouts[2].weekday).toBe(6);
    expect(out.blocks[0].weeks[4].workouts.map((w) => w.weekday)).toEqual([1, 5]);
  });

  it('mark_deload marks the week and applies the documented transform to its targeted workouts', () => {
    const op = accepted({ op: 'mark_deload', weekNumber: 4, reason: 'r' }, { weekNumbers: [4], workoutRowIds: week(4).workouts.map((w) => w.id!) });
    const out = applyOperations(tree, [op]).tree.blocks[0].weeks[3];
    expect(out.isDeload).toBe(true);
    expect(out.workouts[0].exercises[0]).toMatchObject({ targetSets: 2, targetLoadKg: 90 });
    expect(out.workouts[0].exercises[2]).toMatchObject({ targetSets: 2, targetRpe: 5 });
  });

  it('deloadExercise keeps at least 2 sets and never lowers RPE below 1', () => {
    const e = { ...squatRow(4), targetSets: 2, targetLoadKg: null, targetRpe: 2 };
    deloadExercise(e);
    expect(e).toMatchObject({ targetSets: 2, targetRpe: 1 });
  });

  it('reports a target that no longer exists instead of guessing', () => {
    const op = accepted({ op: 'remove_exercise', target: { exerciseRef: 'W4-1-1', weeks: { from: 4, to: 4 } }, reason: 'r' }, { exerciseRowIds: ['00000000-0000-4000-8000-000000000000'] });
    expect(applyOperations(tree, [op]).missing).toEqual(['00000000-0000-4000-8000-000000000000']);
  });

  it('storedOperation strips the server-only targets; targetRowIds lists them', () => {
    const op = accepted({ op: 'drop_workout', workoutRef: 'W5-2', weeks: { from: 5, to: 5 }, reason: 'r' }, { workoutRowIds: ['w1'] });
    expect(storedOperation(op)).not.toHaveProperty('targets');
    expect(targetRowIds([op])).toEqual({ exercises: [], workouts: ['w1'] });
  });
});

describe('describeOperation', () => {
  const keyOfRef = (ref: string) => (ref.startsWith('W4-1-1') ? 'barbell_back_squat' : undefined);

  it.each([
    [prescription('W4-1-1', { from: 4, to: 5 }, { sets: 4, targetLoadKg: 102.5 }), 'Weeks 4-5, barbell back squat: 4 sets, 102.5 kg'],
    [{ op: 'swap_exercise', target: { exerciseRef: 'W4-1-1', weeks: { from: 4, to: 4 } }, withExerciseKey: 'leg_press', reason: 'x' }, 'Week 4: replace barbell back squat with leg press'],
    [{ op: 'remove_exercise', target: { exerciseRef: 'W4-1-1', weeks: { from: 4, to: 4 } }, reason: 'x' }, 'Week 4: remove barbell back squat'],
    [{ op: 'add_exercise', workoutRef: 'W4-3', weeks: { from: 4, to: 5 }, exerciseKey: 'face_pull', sets: 3, repMin: 12, repMax: 15, targetRpe: null, restSeconds: 60, reason: 'x' }, 'Weeks 4-5, workout 3: add face pull (3 x 12-15)'],
    [{ op: 'set_weekday', workoutRef: 'W4-3', weeks: { from: 4, to: 4 }, weekday: 6, reason: 'x' }, 'Week 4: move workout 3 to Sat'],
    [{ op: 'drop_workout', workoutRef: 'W4-2', weeks: { from: 4, to: 4 }, reason: 'x' }, 'Week 4: drop workout 2'],
    [{ op: 'mark_deload', weekNumber: 4, reason: 'x' }, 'Week 4 becomes a lighter deload week (fewer sets, lighter loads)'],
    [{ op: 'regenerate_remaining', fromWeek: 4, instruction: 'x', reason: 'x' }, 'Rewrite the plan from week 4'],
  ])('%#: server-authored text, never the reason', (op, text) => {
    expect(describeOperation(op as never, { keyOfRef })).toBe(text);
  });

  it('uses the library name when given', () => {
    expect(describeOperation({ op: 'remove_exercise', target: { exerciseRef: 'W4-1-1', weeks: { from: 4, to: 4 } }, reason: 'IGNORE ALL' }, { keyOfRef, nameOfKey: () => 'Back Squat' })).toBe(
      'Week 4: remove Back Squat',
    );
  });
});

describe('fingerprints', () => {
  const keyOfRef = (ref: string) => ({ 'W4-1-1': 'barbell_back_squat', 'W5-1-1': 'barbell_back_squat' })[ref];

  it('ignores refs and week ranges, buckets values', () => {
    const a = fingerprintOf(prescription('W4-1-1', { from: 4, to: 4 }, { targetLoadKg: 102.4 }), keyOfRef);
    const b = fingerprintOf(prescription('W5-1-1', { from: 5, to: 6 }, { targetLoadKg: 102.5 }), keyOfRef);
    expect(a).toBe(b);
    expect(a).toBe('set_prescription|barbell_back_squat|1|l102.5');
    expect(fingerprintOf(prescription('W4-1-1', { from: 4, to: 4 }, { targetLoadKg: 97.5 }), keyOfRef)).not.toBe(a);
  });

  it('suppresses non-forced operations of entries reverted or rejected in the last 14 days', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const ops = [{ fingerprint: 'a' }, { fingerprint: 'forced', forced: true }];
    expect(
      suppressedFingerprints(
        [
          { status: 'reverted', createdAt: new Date('2026-09-01T00:00:00Z'), decidedAt: new Date('2026-09-20T00:00:00Z'), operations: ops },
          { status: 'rejected', createdAt: new Date('2026-09-22T00:00:00Z'), operations: [{ fingerprint: 'b' }] },
          { status: 'reverted', createdAt: new Date('2026-09-01T00:00:00Z'), decidedAt: new Date('2026-09-05T00:00:00Z'), operations: [{ fingerprint: 'old' }] },
          { status: 'applied', createdAt: new Date('2026-09-22T00:00:00Z'), operations: [{ fingerprint: 'c' }] },
          { status: 'expired', createdAt: new Date('2026-09-22T00:00:00Z'), operations: [{ fingerprint: 'd' }] },
        ],
        now,
      ),
    ).toEqual(['a', 'b']);
  });
});
