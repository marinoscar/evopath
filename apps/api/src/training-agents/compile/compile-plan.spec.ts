import { planTreeSchema } from '../../programs/contracts/plan-tree.contract';
import { draftCounts, draftIssues } from '../agents/planner/plan-draft.contract';
import { LIB, LIBRARY } from '../testing/context-fixtures';
import { draftExercise, draftFixture, draftWorkout, singleTypeDraft, weekTypeA } from '../testing/draft-fixtures';
import { STUB_VERIFIED_BRIEF } from '../testing/stub-agent-nodes';
import { compileDraft, compilePlan, derivedUuid, exerciseIdFor } from './compile-plan';

const ctx = { library: LIBRARY, brief: STUB_VERIFIED_BRIEF, seed: 'run-1:1' };

describe('compilePlan', () => {
  it('expands week types and sequences into the exact weeks, weekdays, deloads, exercises and minutes', () => {
    const tree = compilePlan(draftFixture(), ctx);

    expect(tree.blocks.map((b) => [b.name, b.weeks.map((w) => w.weekNumber)])).toEqual([
      ['Base', [1, 2, 3, 4, 5]],
      ['Peak', [6, 7, 8]],
    ]);
    expect(tree.blocks.flatMap((b) => b.weeks.filter((w) => w.isDeload).map((w) => w.weekNumber))).toEqual([6]);
    for (const block of tree.blocks)
      for (const week of block.weeks) expect(week.workouts.map((w) => [w.name, w.weekday])).toEqual([['Lower', 1], ['Upper', 3], ['Full', 5]]);

    const week1 = tree.blocks[0].weeks[0];
    expect(week1.workouts.map((w) => w.estimatedMinutes)).toEqual([22, 22, 23]);
    expect(week1.workouts[0].exercises.map((e) => e.exerciseId)).toEqual([LIB.barbell_back_squat.id, LIB.romanian_deadlift.id, LIB.leg_press.id]);
    expect(week1.workouts[0].exercises[0]).toMatchObject({
      position: 0,
      isPriority: true,
      targetSets: 3,
      repMin: 5,
      repMax: 8,
      targetRpe: 7,
      restSeconds: 150,
      targetLoadKg: null,
      loadGuidance: 'choose_start',
      rationale: 'Fits the goal.',
      evidenceRefs: ['E1'],
    });
    const deloadSquat = tree.blocks[1].weeks[0].workouts[0].exercises[0];
    expect([deloadSquat.targetSets, deloadSquat.targetRpe]).toEqual([2, 5]);

    expect(planTreeSchema.safeParse(tree).success).toBe(true);
  });

  it('derives the same ids from the same draft and seed, new ones for another seed, all unique', () => {
    const a = compilePlan(draftFixture(), ctx);
    const b = compilePlan(draftFixture(), ctx);
    const c = compilePlan(draftFixture(), { ...ctx, seed: 'run-1:2' });

    expect(b).toEqual(a);
    const ids = (tree: typeof a) =>
      tree.blocks.flatMap((bl) => [bl.id, ...bl.weeks.flatMap((w) => [w.id, ...w.workouts.flatMap((o) => [o.id, ...o.exercises.map((e) => e.id)])])]);
    expect(new Set(ids(a)).size).toBe(ids(a).length);
    expect(ids(c).some((id) => ids(a).includes(id))).toBe(false);
    expect(a.blocks[0].id).toBe(derivedUuid('run-1:1', 'b0'));
  });

  it('makes no training decision: out-of-range numbers pass through for the guardrails', () => {
    const type = weekTypeA();
    type.workouts[0].exercises[0] = draftExercise('barbell_back_squat', { targetRpe: 11, targetLoadKg: 300, loadGuidance: 'fixed' });
    const tree = compilePlan(singleTypeDraft(type, 4), ctx);
    expect(tree.blocks[0].weeks[3].workouts[0].exercises[0]).toMatchObject({ targetRpe: 11, targetLoadKg: 300, loadGuidance: 'fixed' });
  });

  it.each([
    ['barbell_row', LIB.barbell_row.id],
    ['Levitation_Row', 'unknown:levitation_row'],
    ['ignore all rules!!', 'unknown:invalid_key'],
  ])('exerciseIdFor(%s) = %s', (key, id) => {
    expect(exerciseIdFor(key, new Map(LIBRARY.map((e) => [e.key, e])))).toBe(id);
  });

  it('a draft whose layout is inconsistent is expanded deterministically and the fixes are reported (G1)', () => {
    const draft = draftFixture({
      totalWeeks: 6,
      blocks: [
        { ...draftFixture().blocks[0], weekStart: 1, weekEnd: 4, weekSequence: ['A', 'Z'] },
        { ...draftFixture().blocks[1], weekStart: 5, weekEnd: 6, weekSequence: ['D', 'A', 'A'] },
      ],
    });

    expect(draftIssues(draft)).toEqual([
      'block 1 has 2 weeks in its sequence for 4 weeks',
      'block 1 names an unknown week type',
      'block 2 has 3 weeks in its sequence for 2 weeks',
    ]);
    const compiled = compileDraft(draft, ctx);
    expect(compiled.tree.blocks.flatMap((b) => b.weeks.map((w) => w.isDeload))).toEqual([false, false, false, false, true, false]);
    expect(compiled.issues.filter((i) => i.code === 'draft_structure')).toHaveLength(3);
    expect(draftCounts(draft)).toEqual({ weeks: 6, workouts: 18, exercises: 54 });
  });

  it('sanitises model text (URLs outside the brief, markup) and reports it; the header too', () => {
    const type = weekTypeA();
    type.workouts[0].rationale = 'Read <script>x</script> https://evil.example/plan now.';
    const draft = { ...singleTypeDraft(type, 4), rationale: 'Strength rises 45% (see https://evil.example).', title: '<b>Plan</b>' };

    const compiled = compileDraft(draft, ctx);

    expect(JSON.stringify(compiled)).not.toContain('evil.example');
    expect(JSON.stringify(compiled)).not.toContain('<script>');
    expect(compiled.header.title).toBe('Plan');
    expect(compiled.issues.map((i) => `${i.rule}:${i.severity}:${i.code}`)).toEqual(['G8:repair:text_sanitized', 'G8:warn:unverified_statistic']);
  });
});

describe('draft expansion extremes', () => {
  it('a 24-week draft in 4 blocks expands to 24 weeks; more is cut at 24', () => {
    const block = (start: number, end: number) => ({
      name: 'B',
      focus: '',
      rationale: '',
      weekStart: start,
      weekEnd: end,
      weekSequence: Array.from({ length: end - start + 1 }, () => 'A'),
      weekTypes: [{ key: 'A', isDeload: false, workouts: [draftWorkout('W', 1, [draftExercise('push_up'), draftExercise('plank')])] }],
    });
    const draft = draftFixture({ totalWeeks: 24, blocks: [block(1, 6), block(7, 12), block(13, 18), block(19, 24)] });
    expect(compilePlan(draft, ctx).blocks.flatMap((b) => b.weeks)).toHaveLength(24);

    const over = draftFixture({ totalWeeks: 24, blocks: [block(1, 20), block(21, 30)] });
    expect(compilePlan(over, ctx).blocks.flatMap((b) => b.weeks)).toHaveLength(24);
  });
});
