import { randomUUID } from 'node:crypto';

import { planChangeOperationsSchema, PLAN_CHANGE_JSON_MAX_BYTES } from './plan-change.contract';
import { parseSnapshot, snapshotOf, treeFromSnapshot, PLAN_SNAPSHOT_SCHEMA_VERSION } from './plan-snapshot.contract';
import {
  emptyPlanTree,
  exerciseIdsOf,
  hasScheduledWorkout,
  planTreeSchema,
  stripIds,
  type PlanTreeInput,
} from './plan-tree.contract';

const EX = randomUUID();

function exercise(overrides: Record<string, unknown> = {}) {
  return { exerciseId: EX, position: 0, targetSets: 3, repMin: 8, repMax: 12, restSeconds: 90, ...overrides };
}

function workout(overrides: Record<string, unknown> = {}) {
  return { position: 0, weekday: 1, name: 'Upper', exercises: [exercise()], ...overrides };
}

function tree(overrides: { weeks?: unknown[]; blocks?: unknown[] } = {}): PlanTreeInput {
  return {
    blocks: (overrides.blocks ?? [
      { position: 0, name: 'Base', weeks: overrides.weeks ?? [{ weekNumber: 1, workouts: [workout()] }] },
    ]) as PlanTreeInput['blocks'],
  };
}

const messages = (input: unknown) => {
  const result = planTreeSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

describe('planTreeSchema', () => {
  it('accepts a minimal valid tree and fills defaults', () => {
    const parsed = planTreeSchema.parse(tree());
    const ex = parsed.blocks[0].weeks[0].workouts[0].exercises[0];
    expect(ex).toMatchObject({ isPriority: false, loadGuidance: 'choose_start', targetLoadKg: null, targetRpe: null, evidenceRefs: [] });
    expect(parsed.blocks[0].focus).toBeNull();
  });

  it('accepts the empty draft tree (one block, one empty week)', () => {
    expect(planTreeSchema.safeParse(emptyPlanTree()).success).toBe(true);
    expect(hasScheduledWorkout(planTreeSchema.parse(emptyPlanTree()))).toBe(false);
  });

  it.each([
    ['repMin above repMax', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise({ repMin: 12, repMax: 8 })] })] }] }), 'repMax'],
    ['repMax above 100', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise({ repMax: 101 })] })] }] }), 'repMax'],
    ['targetSets 0', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise({ targetSets: 0 })] })] }] }), 'targetSets'],
    ['targetSets 21', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise({ targetSets: 21 })] })] }] }), 'targetSets'],
    ['RPE off the 0.5 grid', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise({ targetRpe: 7.3 })] })] }] }), 'targetRpe'],
    ['RPE above 10', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise({ targetRpe: 10.5 })] })] }] }), 'targetRpe'],
    ['load above 1000 kg', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise({ targetLoadKg: 1000.5 })] })] }] }), 'targetLoadKg'],
    ['rest above 900 s', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise({ restSeconds: 901 })] })] }] }), 'restSeconds'],
    ['a 101-char name', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ name: 'x'.repeat(101) })] }] }), 'name'],
    ['a 301-char exercise rationale', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise({ rationale: 'x'.repeat(301) })] })] }] }), 'rationale'],
    ['weekday 8', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ weekday: 8 })] }] }), 'weekday'],
    ['a non-uuid exerciseId', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise({ exerciseId: 'bench' })] })] }] }), 'exerciseId'],
    ['an unknown field', tree({ weeks: [{ weekNumber: 1, workouts: [workout({ colour: 'red' })] }] }), ''],
  ])('rejects %s', (_label, input, field) => {
    const issues = messages(input);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.includes(field))).toBe(true);
  });

  it('rejects 8 workouts in a week and 21 exercises in a workout', () => {
    const eight = Array.from({ length: 8 }, (_, i) => workout({ position: i, weekday: null }));
    expect(messages(tree({ weeks: [{ weekNumber: 1, workouts: eight }] }))).not.toEqual([]);
    const many = Array.from({ length: 21 }, (_, i) => exercise({ position: i }));
    expect(messages(tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: many })] }] }))).not.toEqual([]);
  });

  it('rejects two workouts on the same weekday in one week', () => {
    const issues = messages(tree({ weeks: [{ weekNumber: 1, workouts: [workout(), workout({ position: 1, weekday: 1 })] }] }));
    expect(issues.join()).toMatch(/share weekday 1/);
    expect(issues.join()).toMatch(/workouts\.1\.weekday/);
  });

  it('allows several unscheduled workouts in one week', () => {
    expect(messages(tree({ weeks: [{ weekNumber: 1, workouts: [workout({ weekday: null }), workout({ position: 1, weekday: null })] }] }))).toEqual([]);
  });

  it('rejects duplicate positions within a parent', () => {
    expect(messages(tree({ weeks: [{ weekNumber: 1, workouts: [workout(), workout({ weekday: 2 })] }] })).join()).toMatch(/Duplicate workout position/);
    expect(
      messages(tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise(), exercise()] })] }] })).join(),
    ).toMatch(/Duplicate exercise position/);
    expect(
      messages({ blocks: [{ position: 0, name: 'A', weeks: [{ weekNumber: 1 }] }, { position: 0, name: 'B', weeks: [{ weekNumber: 2 }] }] }).join(),
    ).toMatch(/Duplicate block position/);
  });

  it('requires week numbers 1..n without gaps across blocks', () => {
    expect(messages({ blocks: [{ position: 0, name: 'A', weeks: [{ weekNumber: 1 }, { weekNumber: 3 }] }] }).join()).toMatch(/without gaps/);
    expect(
      messages({ blocks: [{ position: 0, name: 'A', weeks: [{ weekNumber: 1 }] }, { position: 1, name: 'B', weeks: [{ weekNumber: 2 }] }] }),
    ).toEqual([]);
    expect(messages({ blocks: [{ position: 0, name: 'A', weeks: [{ weekNumber: 2 }] }] }).join()).toMatch(/without gaps/);
  });

  it('caps the plan at 52 weeks', () => {
    const weeks = Array.from({ length: 53 }, (_, i) => ({ weekNumber: i + 1 }));
    expect(messages({ blocks: [{ position: 0, name: 'A', weeks }] })).not.toEqual([]);
    const fiftyTwo = Array.from({ length: 52 }, (_, i) => ({ weekNumber: i + 1 }));
    expect(messages({ blocks: [{ position: 0, name: 'A', weeks: fiftyTwo }] })).toEqual([]);
  });

  it('rejects a row id used twice', () => {
    const id = randomUUID();
    expect(
      messages(tree({ weeks: [{ weekNumber: 1, workouts: [workout({ id }), workout({ id, position: 1, weekday: 2 })] }] })).join(),
    ).toMatch(/unique/);
  });

  it('lists every prescribed exercise id once', () => {
    const other = randomUUID();
    const parsed = planTreeSchema.parse(
      tree({ weeks: [{ weekNumber: 1, workouts: [workout({ exercises: [exercise(), exercise({ position: 1, exerciseId: other }), exercise({ position: 2 })] })] }] }),
    );
    expect(exerciseIdsOf(parsed).sort()).toEqual([EX, other].sort());
  });

  it('stripIds removes every row id', () => {
    const parsed = planTreeSchema.parse(tree({ blocks: [{ id: randomUUID(), position: 0, name: 'A', weeks: [{ id: randomUUID(), weekNumber: 1, workouts: [workout({ id: randomUUID(), exercises: [exercise({ id: randomUUID() })] })] }] }] }));
    expect(JSON.stringify(stripIds(parsed))).not.toMatch(/"id"/);
  });
});

describe('plan snapshots', () => {
  const header = { name: 'P', goal: 'strength', notes: null, rationale: 'Why', autonomy: 'autonomous', gymId: null };

  it('round-trips a tree with its row ids preserved', () => {
    const ids = { block: randomUUID(), week: randomUUID(), workout: randomUUID(), exercise: randomUUID() };
    const parsed = planTreeSchema.parse({
      blocks: [{ id: ids.block, position: 0, name: 'A', weeks: [{ id: ids.week, weekNumber: 1, workouts: [workout({ id: ids.workout, exercises: [exercise({ id: ids.exercise, targetLoadKg: 62.5 })] })] }] }],
    });
    const stored = JSON.parse(JSON.stringify(snapshotOf({ ...header, extra: 'ignored' } as never, parsed)));
    const result = parseSnapshot(stored);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.schemaVersion).toBe(PLAN_SNAPSHOT_SCHEMA_VERSION);
    expect(result.snapshot.program).toEqual(header);
    const restored = treeFromSnapshot(result.snapshot);
    expect(restored).toEqual(parsed);
    expect(restored.blocks[0].weeks[0].workouts[0].exercises[0].id).toBe(ids.exercise);
  });

  it('refuses a snapshot from a newer schema version without throwing', () => {
    expect(parseSnapshot({ schemaVersion: 2, program: header, tree: {} })).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_SCHEMA_VERSION',
      schemaVersion: 2,
    });
    expect(parseSnapshot(null)).toMatchObject({ ok: false, reason: 'UNSUPPORTED_SCHEMA_VERSION' });
  });

  it('reports a damaged snapshot as invalid', () => {
    expect(parseSnapshot({ schemaVersion: 1, program: header, tree: { blocks: 'no' } })).toMatchObject({ ok: false, reason: 'INVALID_SNAPSHOT' });
  });
});

describe('plan change payloads', () => {
  it('accepts arrays of objects and refuses anything over 64 KB', () => {
    expect(planChangeOperationsSchema.safeParse([{ op: 'swap' }]).success).toBe(true);
    expect(planChangeOperationsSchema.safeParse(['swap']).success).toBe(false);
    const big = [{ blob: 'x'.repeat(PLAN_CHANGE_JSON_MAX_BYTES) }];
    expect(planChangeOperationsSchema.safeParse(big).success).toBe(false);
  });
});
