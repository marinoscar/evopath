import { randomUUID } from 'node:crypto';

import { STUB_AGENT_NODES } from '../testing/stub-agent-nodes';
import type { EvaluationSources } from '../evaluation/build-evaluator-context';
import { evaluateContextOf } from '../evaluation/evaluate-context';
import type { EvaluationPort } from '../graph/node-context';
import {
  PAIN_PATTERN_RATIONALE,
  PAIN_PATTERN_SUMMARY,
  SAFETY_TEXT_RATIONALE,
  SAFETY_TEXT_SUMMARY,
} from '../guardrails/safety-stop';
import { TrainingRunFailedError } from '../runtime/training-run-errors';
import { EVAL_AS_OF, evaluationSignals, evaluationSources, painRow } from '../testing/evaluation-fixtures';
import { createNodeContextHarness } from '../testing/node-context-harness';
import { runLoadSignals } from './load-signals.node';
import { runSafetyGate } from './safety-gate.node';

// =============================================================================
// The evaluate graph's deterministic nodes: `load_signals` and `safety_gate`.
// =============================================================================

const RED_FLAG = 'chest pain and dizzy CANARY_PAIN_NOTE';

function fakePort(sources: EvaluationSources | null, notes: string[] = []) {
  const log: string[] = [];
  const reviews: Array<Record<string, unknown>> = [];
  let paused = sources?.program.autonomyPausedReason ?? null;
  const port: EvaluationPort & { reviews: typeof reviews } = {
    reviews,
    loadSources: jest.fn(async () => sources),
    recentPainNotes: jest.fn(async () => notes),
    recordReview: jest.fn(async (input) => {
      log.push('recordReview');
      const changeLogId = randomUUID();
      reviews.push({ ...input, changeLogId });
      const didPause = !!input.pause && paused === null;
      if (didPause) paused = input.pause!;
      return { changeLogId, versionNumber: 3, paused: didPause };
    }),
    findRunReview: jest.fn(async (_userId, runId, actor) => {
      const found = reviews.find((r) => r.runId === runId && r.actor === actor);
      return found ? { changeLogId: found.changeLogId as string } : null;
    }),
    loadAdaptationFacts: jest.fn(async () => null),
    recordUnappliedChange: jest.fn(async () => ({ changeLogId: randomUUID() })),
    findRunUnapplied: jest.fn(async () => null),
    resolveProposal: jest.fn(async () => true),
  };
  const notifications = {
    notify: jest.fn((key: string) => {
      log.push(`notify:${key}`);
    }),
  };
  return { port, notifications, log };
}

function harness(sources: EvaluationSources | null, notes: string[] = []) {
  const fake = fakePort(sources, notes);
  const h = createNodeContextHarness({
    kind: 'evaluate',
    now: () => new Date(`${EVAL_AS_OF}T12:00:00.000Z`),
    ports: { evaluation: fake.port, notifications: fake.notifications },
  });
  return { h, ...fake };
}

async function loaded(sources: EvaluationSources, notes: string[] = []) {
  const t = harness(sources, notes);
  const update = await t.h.runNode(runLoadSignals, { programId: sources.program.id, input: { trigger: 'workout_finished' } });
  return { ...t, state: { programId: sources.program.id, context: update.context } };
}

describe('load_signals', () => {
  it('builds the evaluate context through the port and emits counts only', async () => {
    const sources = evaluationSources();
    const t = harness(sources);

    const update = await t.h.runNode(runLoadSignals, { programId: sources.program.id, input: { trigger: 'weekly', deep: true } });

    const context = evaluateContextOf(update);
    expect(context?.server.programId).toBe(sources.program.id);
    expect(context?.sent.run).toMatchObject({ trigger: 'weekly', deep: true });
    expect(t.port.loadSources).toHaveBeenCalledWith(t.h.context.userId, sources.program.id, expect.any(Date));
    const events = t.h.events.events.get(t.h.runId) ?? [];
    expect(events.find((e) => e.type === 'evaluation.signals')?.data).toEqual({
      sessions: 0,
      remainingWeeks: 2,
      changeableWorkouts: 2,
      historyEntries: 4,
      evidenceClaims: 3,
      missedStreak: 0,
    });
  });

  it('fails the run (not a crash) without the port or when the plan is gone', async () => {
    const noPort = createNodeContextHarness({ kind: 'evaluate' });
    await expect(noPort.runNode(runLoadSignals, { programId: randomUUID() })).rejects.toBeInstanceOf(TrainingRunFailedError);

    const gone = harness(null);
    await expect(gone.h.runNode(runLoadSignals, { programId: randomUUID() })).rejects.toMatchObject({
      code: 'TRAINING_PROGRAM_NOT_FOUND',
    });
    await expect(gone.h.runNode(runLoadSignals, { programId: null })).rejects.toMatchObject({ code: 'TRAINING_PROGRAM_NOT_FOUND' });
  });
});

describe('safety_gate', () => {
  it('passes a clean run through: no write, no notification, nothing forced', async () => {
    const t = await loaded(evaluationSources(), ['a bit sore after squats']);

    const update = await t.h.runNode(runSafetyGate, t.state);

    expect(update.outcome).toBeUndefined();
    expect(evaluateContextOf(update)?.safety).toEqual({
      text: { level: 'conservative', reasons: expect.any(Array) },
      painPattern: { triggered: false, exerciseKeys: [], exercisesFlagged14d: 0 },
      forced: [],
      recover: false,
      paused: false,
      changeLogId: null,
    });
    expect(t.port.recordReview).not.toHaveBeenCalled();
    expect(t.notifications.notify).not.toHaveBeenCalled();
    expect(t.port.recentPainNotes).toHaveBeenCalledWith(t.h.context.userId, '2026-09-11', EVAL_AS_OF);
  });

  it('(a) a red-flag pain note stops the run: system review, pause, mandatory notification after the write; the note is kept nowhere', async () => {
    const t = await loaded(evaluationSources(), ['fine', RED_FLAG]);

    const update = await t.h.runNode(runSafetyGate, t.state);

    const changeLogId = t.port.reviews[0].changeLogId;
    expect(update.outcome).toEqual({
      status: 'safety_stop',
      code: 'TRAINING_SAFETY_STOP',
      programId: t.state.programId,
      changeLogId,
      verdict: 'safety_text',
    });
    expect(t.port.recordReview).toHaveBeenCalledWith({
      userId: t.h.context.userId,
      programId: t.state.programId,
      actor: 'system',
      summary: SAFETY_TEXT_SUMMARY,
      rationale: SAFETY_TEXT_RATIONALE,
      runId: t.h.runId,
      pause: 'safety_text',
    });
    expect(t.log).toEqual(['recordReview', 'notify:training.plan_safety_stop']);
    expect(t.notifications.notify).toHaveBeenCalledWith('training.plan_safety_stop', t.h.context.userId, {
      programId: t.state.programId,
      reason: 'safety_text',
      changeLogId,
    });
    expect(evaluateContextOf(update)?.safety?.text.level).toBe('blocked');
    // The note's words appear in no state, event or write.
    const everything = JSON.stringify([update, t.h.events.events.get(t.h.runId), t.port.reviews]);
    expect(everything).not.toContain('CANARY_PAIN_NOTE');
    expect(everything).not.toContain('dizzy');
  });

  it('(a) on a resumed run the entry is found, not written or notified twice', async () => {
    const t = await loaded(evaluationSources(), [RED_FLAG]);

    await t.h.runNode(runSafetyGate, t.state);
    const again = await t.h.runNode(runSafetyGate, t.state);

    expect(t.port.recordReview).toHaveBeenCalledTimes(1);
    expect(t.notifications.notify).toHaveBeenCalledTimes(1);
    expect(again.outcome).toMatchObject({ status: 'safety_stop', changeLogId: t.port.reviews[0].changeLogId });
  });

  it('(b) three flagged sessions in a row pause automation with the professional-advice message; the run continues read-only', async () => {
    const sources = evaluationSources({
      signals: evaluationSignals((s) => {
        s.pain = [painRow('squat', { consecutiveFlaggedSessions: 3, flaggedSessions28d: 3 })];
      }),
    });
    const t = await loaded(sources);

    const update = await t.h.runNode(runSafetyGate, t.state);

    expect(update.outcome).toBeUndefined();
    expect(t.port.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'system', summary: PAIN_PATTERN_SUMMARY, rationale: PAIN_PATTERN_RATIONALE, pause: 'pain_pattern' }),
    );
    expect(t.notifications.notify).toHaveBeenCalledWith('training.plan_safety_stop', t.h.context.userId, expect.objectContaining({ reason: 'pain_pattern' }));
    const context = evaluateContextOf(update)!;
    expect(context.safety).toMatchObject({ painPattern: { triggered: true, exerciseKeys: ['back_squat'] }, paused: true });
    expect(context.sent.run.paused).toBe(true);
    // (c) applies too: the squat's unlocked future occurrences are removed.
    expect(context.sent.profile.alreadyDecided.map((op) => op.target.exerciseRef)).toEqual(['W4-1-1']);
  });

  it('(b) pain on three different exercises within 14 days also pauses', async () => {
    const sources = evaluationSources({
      signals: evaluationSignals((s) => {
        s.pain = [painRow('squat', { lastFlaggedOn: '2026-09-12' }), painRow('bench', { lastFlaggedOn: '2026-09-17' }), painRow('row', { lastFlaggedOn: '2026-09-24' })];
      }),
    });
    const t = await loaded(sources);

    const update = await t.h.runNode(runSafetyGate, t.state);

    expect(evaluateContextOf(update)?.safety?.painPattern).toEqual({
      triggered: true,
      exerciseKeys: ['back_squat', 'barbell_row', 'bench_press'],
      exercisesFlagged14d: 3,
    });
    expect(t.port.recordReview).toHaveBeenCalledTimes(1);
  });

  it('(b) an already paused plan is not paused or notified again', async () => {
    const sources = evaluationSources({
      signals: evaluationSignals((s) => {
        s.pain = [painRow('squat', { consecutiveFlaggedSessions: 4 })];
      }),
    });
    sources.program.autonomyPausedReason = 'pain_pattern';
    const t = await loaded(sources);

    const update = await t.h.runNode(runSafetyGate, t.state);

    expect(t.port.recordReview).not.toHaveBeenCalled();
    expect(t.notifications.notify).not.toHaveBeenCalled();
    expect(evaluateContextOf(update)?.safety?.paused).toBe(true);
  });

  it('(c) two flagged sessions in a row force the removal of the exercise\'s unlocked occurrences, shown as already decided', async () => {
    const sources = evaluationSources({
      signals: evaluationSignals((s) => {
        s.pain = [painRow('press', { consecutiveFlaggedSessions: 2 })];
      }),
    });
    const t = await loaded(sources);

    const update = await t.h.runNode(runSafetyGate, t.state);

    const context = evaluateContextOf(update)!;
    // W3-2 (today) is locked; only week 4's Thursday press is removed.
    expect(context.safety?.forced).toEqual([
      {
        op: 'remove_exercise',
        target: { exerciseRef: 'W4-2-2', weeks: { from: 4, to: 4 } },
        reason: expect.any(String),
        forced: true,
      },
    ]);
    expect(context.sent.profile.alreadyDecided).toEqual(context.safety?.forced);
    expect(context.safety?.paused).toBe(false);
    expect(t.port.recordReview).not.toHaveBeenCalled();
  });

  it('(d) five low-readiness days in a row mark the run recover', async () => {
    const sources = evaluationSources({
      signals: evaluationSignals((s) => {
        s.readiness.lowStreak = 5;
      }),
    });
    const t = await loaded(sources);

    const update = await t.h.runNode(runSafetyGate, t.state);

    expect(evaluateContextOf(update)?.sent.run.recover).toBe(true);
    expect(evaluateContextOf(update)?.safety?.recover).toBe(true);
  });

  it('fails the run without a context or the port', async () => {
    const t = harness(evaluationSources());
    await expect(t.h.runNode(runSafetyGate, { context: null })).rejects.toBeInstanceOf(TrainingRunFailedError);
  });
});

describe('the evaluate graph with the deterministic nodes', () => {
  it('a red-flag note ends the run at the gate with zero provider calls', async () => {
    const sources = evaluationSources();
    const t = harness(sources, [RED_FLAG]);
    const { load_signals: _l, safety_gate: _s, ...stubs } = STUB_AGENT_NODES;

    const result = await t.h.runGraph({ input: { programId: sources.program.id, input: {} }, nodes: stubs });

    const stages = (t.h.events.events.get(t.h.runId) ?? []).filter((e) => e.type === 'stage.started').map((e) => e.data.node);
    expect(stages).toEqual(['load_signals', 'safety_gate']);
    expect(result.state.outcome).toMatchObject({ status: 'safety_stop', code: 'TRAINING_SAFETY_STOP' });
    expect(t.h.runtime.fake.calls).toHaveLength(0);
  });

  it('without a stop, it goes on to evaluate', async () => {
    const sources = evaluationSources();
    const t = harness(sources, []);
    const { load_signals: _l, safety_gate: _s, ...stubs } = STUB_AGENT_NODES;

    await t.h.runGraph({ input: { programId: sources.program.id, input: {} }, nodes: stubs });

    const stages = (t.h.events.events.get(t.h.runId) ?? []).filter((e) => e.type === 'stage.started').map((e) => e.data.node);
    expect(stages.slice(0, 3)).toEqual(['load_signals', 'safety_gate', 'evaluate']);
  });
});
