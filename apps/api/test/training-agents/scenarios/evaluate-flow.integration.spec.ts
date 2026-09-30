import type { PlanTree } from '../../../src/programs/contracts/plan-tree.contract';
import { changeSetOf } from '../../../src/training-agents/evaluation/evaluate-state';
import { THIN_DATA_SUMMARY } from '../../../src/training-agents/evaluation/evaluate-state';
import { TrainingEvaluationScheduler } from '../../../src/training-agents/evaluation/training-evaluation.scheduler';
import { FORCED_REMOVAL_SUMMARY } from '../../../src/training-agents/guardrails/safety-stop';
import { rowsOf } from '../../../src/training-agents/testing/adaptation-fixtures';
import { evaluateScenario, evaluateScenarioPlan, scenarioPlanTree } from '../support/evaluate-scenario';
import { loadScenario } from '../support/scenario-script';

// =============================================================================
// The evaluate flow, one JSON scenario at a time (the same files the fake
// Responses server replays in the browser e2e), over the real evaluate graph
// nodes, the envelope, AgentCaller and AiService with the scripted fake
// provider, and an in-memory plan store behind the ports. The real
// transaction, the partial indexes and the job are proven by
// `training-flow.db.spec.ts`.
// =============================================================================

const URL_OR_MARKUP = /https?:\/\/|evil\.example|<[a-z]/i;

/** The exercise rows of weeks `weeks` for `key`: `[week, sets, load]`. */
function shape(tree: PlanTree, key: string, weeks: number[]): Array<[number, number, number | null]> {
  return rowsOf(tree, key)
    .filter((r) => weeks.includes(r.weekNumber))
    .map((r) => [r.weekNumber, r.exercise.targetSets, r.exercise.targetLoadKg]);
}

function untouchedBefore(tree: PlanTree, week: number): unknown {
  return tree.blocks.flatMap((b) => b.weeks.filter((w) => w.weekNumber < week));
}

describe('evaluate-flow scenarios: the scenario plan', () => {
  it('has the shape the fixtures name their refs against: weeks 5 to 7 open, weeks 4 and 8 deloads', () => {
    const tree = scenarioPlanTree();
    const weeks = tree.blocks[0].weeks;
    expect(weeks).toHaveLength(8);
    expect(weeks.filter((w) => w.isDeload).map((w) => w.weekNumber)).toEqual([4, 8]);
    expect(weeks[4].workouts).toHaveLength(3);
    expect(weeks[4].workouts[0].exercises).toHaveLength(5);
  });
});

describe('evaluate-flow scenarios: autonomous', () => {
  it('evaluator-no-change: one evaluator call, a reviewed entry, no new version and no notification', async () => {
    const s = evaluateScenario('evaluator-no-change');

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'no_change', verdict: 'reviewed' });
    expect(s.calls().map((c) => c.request?.metadata?.agent)).toEqual(['evaluator']);
    expect(s.calls('evaluator')[0].request?.structuredOutput).toBeDefined();
    expect(s.store.version).toBe(4);
    expect(s.store.changeLog.at(-1)).toMatchObject({ kind: 'reviewed', actor: 'ai', runId: s.h.runId });
    expect(s.store.notifications).toEqual([]);
    expect(s.h.usage.find((u) => u.role === 'evaluator')?.usage).toMatchObject({ inputTokens: 5000, outputTokens: 600, reasoningTokens: 300 });
  });

  it('evaluator-autonomous: a one-step load nudge and an extra set land as one new version, notified after the write', async () => {
    const s = evaluateScenario('evaluator-autonomous');
    const before = structuredClone(s.store.tree);

    const result = await s.run();

    expect(result.interrupt).toBeNull();
    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'applied', versionNumber: 5 });
    expect(s.store.log).toEqual(['applyChange', 'notify:training.plan_adapted']);
    expect(s.calls().map((c) => c.request?.metadata?.agent)).toEqual(['evaluator']);

    // Weeks 5 and 6, the first workout only: bench load up one small step (never past the nudge), row a set heavier.
    const [w5, w6, w7] = [5, 6, 7].map((week) => shape(s.store.tree, 'dumbbell_bench_press', [week])[0]);
    for (const [, sets, load] of [w5, w6]) {
      expect(sets).toBe(3);
      expect(load).toBeGreaterThan(15);
      expect(load).toBeLessThanOrEqual(17.5);
    }
    expect(w7).toEqual([7, 3, 15]);
    expect(shape(s.store.tree, 'dumbbell_row', [5, 6, 7]).filter(([, sets]) => sets === 4).map(([week]) => week)).toEqual([5, 6]);
    expect(untouchedBefore(s.store.tree, 5)).toEqual(untouchedBefore(before, 5));

    const entry = s.store.changeLog.find((r) => r.toVersion === 5)!;
    expect(entry).toMatchObject({ kind: 'adapted', actor: 'ai', status: 'applied', fromVersion: 4, runId: s.h.runId });
    expect(entry.operations).toHaveLength(2);
    for (const op of entry.operations as Array<Record<string, unknown>>) expect(op).toMatchObject({ fingerprint: expect.any(String), description: expect.any(String) });
    // The previous version's tree is what a one-tap revert restores.
    expect(s.store.versions.find((v) => v.versionNumber === 4)?.tree).toEqual(before);
  });

  it('a change the person undid is not suggested again: the reverted entry suppresses the same change and the review records it', async () => {
    const first = evaluateScenario('evaluator-autonomous');
    await first.run();
    const applied = first.store.changeLog.find((r) => r.toVersion === 5)!;

    const s = evaluateScenario('evaluator-autonomous', {
      changeLog: [
        {
          createdAt: new Date('2026-09-22T10:00:00Z'),
          decidedAt: new Date('2026-09-23T10:00:00Z'),
          kind: 'adapted',
          actor: 'ai',
          status: 'reverted',
          summary: applied.summary,
          operations: applied.operations,
        },
      ],
    });
    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'no_change', verdict: 'reviewed' });
    expect(s.store.version).toBe(4);
    expect(changeSetOf(result.state)!.dropped.map((d) => d.rule)).toEqual(['E9', 'E9']);
  });

  it('evaluator-regenerate: rewriting the rest of the plan is never automatic; it is dropped with the fixed note', async () => {
    const s = evaluateScenario('evaluator-regenerate');

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'no_change', verdict: 'reviewed' });
    expect(changeSetOf(result.state)!.dropped.map((d) => `${d.rule}:${d.code}`)).toEqual(['E10:escalation_not_automatic']);
    expect(s.store.version).toBe(4);
    expect(s.store.notifications).toEqual([]);
    expect(s.store.changeLog.at(-1)?.summary).toContain('ask the planner');
  });

  it('evaluator-structural: a swap goes to the light critic (adaptation verdict), which approves, then the swap is applied', async () => {
    const s = evaluateScenario('evaluator-structural');

    const result = await s.run();

    expect(s.calls().map((c) => c.request?.metadata?.agent)).toEqual(['evaluator', 'critic']);
    expect(s.calls('critic')[0].request?.structuredOutput).toBeDefined();
    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'applied', versionNumber: 5 });
    expect(shape(s.store.tree, 'goblet_squat', [5, 6, 7, 8]).length).toBe(2);
    expect(rowsOf(s.store.tree, 'dumbbell_lunge').filter((r) => r.weekNumber === 5 || r.weekNumber === 6).length).toBe(4);
    expect(s.types()).toEqual(expect.arrayContaining(['adaptation.critique', 'adaptation.applied']));
  });
});

describe('evaluate-flow scenarios: ask first across a restart', () => {
  async function proposed() {
    const first = evaluateScenario('evaluator-autonomous', { autonomy: 'ask_first' });
    const paused = await first.run();
    return { first, paused };
  }

  /** A new harness (a restarted process) on the same checkpoint, run id and plan. */
  function restarted(p: Awaited<ReturnType<typeof proposed>>) {
    return evaluateScenario('evaluator-autonomous', {}, { plan: p.first.plan, checkpointer: p.first.checkpointer, runId: p.first.h.runId });
  }

  it('pauses with a proposed row and a proposal notification; the plan is untouched', async () => {
    const { first, paused } = await proposed();

    expect(paused.interrupt).toMatchObject({ kind: 'approval' });
    expect(first.store.version).toBe(4);
    expect(first.store.changeLog.at(-1)).toMatchObject({ kind: 'adapted', status: 'proposed', fromVersion: 4, toVersion: null });
    expect(first.store.log).toEqual(['record:proposed', 'notify:training.plan_proposal']);
  });

  it('approve after a restart applies the same proposal row, with no second provider call', async () => {
    const p = await proposed();
    const rowId = p.first.store.changeLog.at(-1)!.id;
    const second = restarted(p);

    const done = await second.resume('approve');

    expect(done.state.outcome).toMatchObject({ status: 'completed', verdict: 'applied', versionNumber: 5, changeLogId: rowId });
    expect(p.first.store.changeLog.find((r) => r.id === rowId)).toMatchObject({ status: 'applied', toVersion: 5 });
    expect(second.calls()).toHaveLength(0);
    expect(p.first.store.log.slice(-2)).toEqual(['applyChange', 'notify:training.plan_adapted']);
  });

  it('reject after a restart records rejected and leaves the plan alone', async () => {
    const p = await proposed();

    const done = await restarted(p).resume('reject');

    expect(done.state.outcome).toMatchObject({ status: 'no_change', verdict: 'rejected_by_owner' });
    expect(p.first.store.version).toBe(4);
    expect(p.first.store.changeLog.at(-1)).toMatchObject({ status: 'rejected', decidedAt: expect.any(Date) });
    expect(p.first.store.notifications.map((n) => n.eventKey)).toEqual(['training.plan_proposal']);
  });
});

describe('evaluate-flow scenarios: envelope clamps on hostile output', () => {
  it('evaluator-hostile: nothing out of bounds lands, the past is untouched, and no link or markup reaches the plan or the change log', async () => {
    const s = evaluateScenario('evaluator-hostile', { painSessionsInARow: 1 });
    const before = structuredClone(s.store.tree);

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'no_change', verdict: 'reviewed' });
    expect(s.store.version).toBe(4);
    expect(s.store.tree).toEqual(before);
    expect(s.store.notifications).toEqual([]);

    const set = changeSetOf(result.state)!;
    expect(set.accepted).toEqual([]);
    const codes = [...set.clamped, ...set.dropped].map((f) => `${f.rule}:${f.code}`);
    expect(codes).toEqual(
      expect.arrayContaining(['E1:locked', 'E3:increase_blocked_pain', 'REF:unknown_ref', 'REF:unknown_exercise', 'REF:invented_claim', 'E4:volume']),
    );

    // The entry's only link is a verified source it cites; the model's own text carries none.
    const entry = s.store.changeLog.at(-1)!;
    expect(JSON.stringify({ summary: entry.summary, rationale: entry.rationale, operations: entry.operations })).not.toMatch(URL_OR_MARKUP);
    for (const citation of entry.citations as Array<{ url: string }>) expect(citation.url).toMatch(/acsm\.org|pubmed|nsca/);
    expect(entry.operations).toEqual([]);
  });

  it('evaluator-hostile: a change the person undid is dropped by E9 even when it is otherwise in bounds', async () => {
    const s = evaluateScenario('evaluator-hostile', {
      changeLog: [
        {
          createdAt: new Date('2026-09-22T10:00:00Z'),
          decidedAt: new Date('2026-09-23T10:00:00Z'),
          kind: 'adapted',
          actor: 'ai',
          status: 'reverted',
          summary: 'One more row set',
          operations: [{ op: 'set_prescription', fingerprint: 'set_prescription|dumbbell_row|1|s5' }],
        },
      ],
    });

    const result = await s.run();

    expect(changeSetOf(result.state)!.dropped.map((d) => `${d.rule}:${d.code}`)).toContain('E9:suppressed');
    expect(s.store.version).toBe(4);
  });
});

describe('evaluate-flow scenarios: pain', () => {
  it('evaluator-pain-response: two flagged sessions force the removal everywhere it is still open, and the evaluator cannot push another lift', async () => {
    const s = evaluateScenario('evaluator-pain-response', { painSessionsInARow: 2 });

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'applied', versionNumber: 5 });
    // Week 3's Monday and Wednesday are locked; everything after is open.
    expect(rowsOf(s.store.tree, 'dumbbell_bench_press').map((r) => r.weekNumber)).toEqual([1, 1, 1, 2, 2, 2, 3, 3]);
    expect(s.store.changeLog.find((r) => r.toVersion === 5)?.summary).toBe(FORCED_REMOVAL_SUMMARY);
    const set = changeSetOf(result.state)!;
    expect(set.accepted.every((op) => (op as { forced?: boolean }).forced === true)).toBe(true);
    expect([...set.clamped, ...set.dropped].map((f) => `${f.rule}:${f.code}`)).toEqual(
      expect.arrayContaining(['SAFETY:superseded_by_safety', 'E3:increase_blocked_needs_recovery']),
    );
    expect(shape(s.store.tree, 'dumbbell_row', [5, 6, 7]).every(([, sets]) => sets === 3)).toBe(true);
    expect(s.store.log).toEqual(['applyChange', 'notify:training.plan_adapted']);
    expect(s.store.changeLog.at(-1)?.rationale).toContain('qualified professional');
  });

  it('evaluator-pain-response: pain on three sessions in a row pauses automation with a safety-stop notification; only the forced removals land', async () => {
    const s = evaluateScenario('evaluator-pain-response', { painSessionsInARow: 3 });

    const result = await s.run();

    expect(result.state.outcome).toMatchObject({ status: 'completed', verdict: 'applied' });
    expect(s.store.pausedReason).toBe('pain_pattern');
    expect(s.store.log).toEqual(['recordReview', 'notify:training.plan_safety_stop', 'applyChange', 'notify:training.plan_adapted']);
    expect(changeSetOf(result.state)!.accepted.every((op) => (op as { forced?: boolean }).forced === true)).toBe(true);
  });

  it('an urgent symptom in a pain note: a safety stop before the evaluator, zero provider calls, nothing changes', async () => {
    const s = evaluateScenario('evaluator-autonomous', { painNotes: ['chest pain and dizzy after the bench press'] });

    const result = await s.run();

    expect(s.calls()).toHaveLength(0);
    expect(result.state.outcome).toMatchObject({ status: 'safety_stop' });
    expect(s.store.version).toBe(4);
    expect(s.store.pausedReason).toBe('safety_text');
    expect(s.store.notifications.map((n) => n.eventKey)).toEqual(['training.plan_safety_stop']);
  });

  it('thin data: no completed session means no provider call and a reviewed entry', async () => {
    const s = evaluateScenario('evaluator-autonomous', { noHistory: true });

    const result = await s.run();

    expect(s.calls()).toHaveLength(0);
    expect(result.state.outcome).toMatchObject({ status: 'no_change', verdict: 'reviewed' });
    expect(s.store.changeLog.at(-1)).toMatchObject({ kind: 'reviewed', summary: THIN_DATA_SUMMARY });
  });
});

describe('evaluate-flow scenarios: AI off', () => {
  it('the scheduler reads the kill switch first: nothing is created, no run is queued, the evaluator is never resolved', async () => {
    const create = jest.fn();
    const resolver = { resolveForRun: jest.fn() };
    const prisma = {
      program: { findFirst: jest.fn(async () => ({ id: 'p1', autonomyPausedAt: null })), updateMany: jest.fn() },
      trainingPlanRun: { findFirst: jest.fn(async () => null), count: jest.fn(async () => 0) },
      programChangeLog: { count: jest.fn(async () => 0) },
    };
    const scheduler = new TrainingEvaluationScheduler(
      prisma as never,
      { isEnabled: jest.fn(async () => false) } as never,
      resolver as never,
      { create } as never,
    );

    const outcome = await scheduler.requestEvaluation('u1', 'workout_finished');

    expect(outcome).toMatchObject({ status: 'skipped' });
    expect(create).not.toHaveBeenCalled();
    expect(resolver.resolveForRun).not.toHaveBeenCalled();
    expect(prisma.program.updateMany).not.toHaveBeenCalled();
  });
});

describe('evaluate-flow scenarios: fixtures and plan agree', () => {
  it('every scenario names only evaluator outputs the spec exercises', () => {
    const names = ['evaluator-no-change', 'evaluator-autonomous', 'evaluator-structural', 'evaluator-hostile', 'evaluator-pain-response', 'evaluator-regenerate'];
    for (const name of names) expect(loadScenario(name).calls.evaluator.length).toBeGreaterThan(0);
    expect(evaluateScenarioPlan().store.version).toBe(4);
  });
});
