import { CREATE_GRAPH_NODES, EVALUATE_GRAPH_NODES } from '../nodes';
import { createNodeContextHarness } from '../testing/node-context-harness';
import { STUB_AGENT_NODES, stubVerdict } from '../testing/stub-agent-nodes';
import {
  ROUTE_END,
  STRUCTURAL_OPERATIONS,
  TRAINING_RUN_WARNINGS,
  critiqueDecision,
  routeAfterApproval,
  routeAfterCritique,
  routeAfterDecide,
  routeAfterEnvelope,
  routeAfterPlan,
  routeAfterPrepare,
  routeAfterSafetyGate,
  shipsNow,
} from './routes';
import { initialRunState } from './run-state';
import { TRAINING_GRAPH_READY, graphForKind, isGraphReady } from './training-graphs';

const stages = (h: ReturnType<typeof createNodeContextHarness>) =>
  (h.events.events.get(h.runId) ?? []).filter((e) => e.type === 'stage.started').map((e) => e.data.node);

describe('training graphs on stub nodes', () => {
  it('every node of both graphs is implemented and both graphs are ready', () => {
    const implemented = [...Object.values(CREATE_GRAPH_NODES), ...Object.values(EVALUATE_GRAPH_NODES)]
      .filter((node) => node.implemented)
      .map((node) => node.name);
    expect(implemented).toEqual(Object.keys(STUB_AGENT_NODES));
    expect(Object.values(EVALUATE_GRAPH_NODES).filter((node) => !node.implemented)).toEqual([]);
    expect(TRAINING_GRAPH_READY).toEqual({ create: true, evaluate: true });
    expect(graphForKind('create')).toBe('create');
    expect(graphForKind('revise')).toBe('create');
    expect(graphForKind('evaluate')).toBe('evaluate');
    expect(isGraphReady('create')).toBe(true);
    expect(isGraphReady('revise')).toBe(true);
    expect(isGraphReady('evaluate')).toBe(true);
  });

  it('create: runs every node once in order, the stub critic approves, and finalize records the outcome', async () => {
    const h = createNodeContextHarness({ kind: 'create' });

    const result = await h.runGraph({ input: {}, nodes: STUB_AGENT_NODES });

    expect(result.interrupt).toBeNull();
    expect(stages(h)).toEqual(['prepare_context', 'research', 'plan', 'guardrails', 'critique', 'finalize']);
    expect(result.state.outcome).toEqual({ status: 'completed', verdict: 'approved' });
    expect(result.state.stage).toBe('finalize');
    expect(result.state.roundCounters).toEqual({ critique: 1 });
    // Stubs never call a model.
    expect(h.runtime.fake.calls).toHaveLength(0);
  });

  it('revise: skips research', async () => {
    const h = createNodeContextHarness({ kind: 'revise' });

    await h.runGraph({ input: {}, nodes: STUB_AGENT_NODES });

    expect(stages(h)).toEqual(['prepare_context', 'plan', 'guardrails', 'critique', 'finalize']);
  });

  it('create: a rejecting critic loops back to plan until the rounds are spent', async () => {
    const h = createNodeContextHarness({ kind: 'create' });

    const result = await h.runGraph({
      input: { maxCriticRounds: 3 },
      nodes: {
        ...STUB_AGENT_NODES,
        critique: async (state) => {
          const round = (state.roundCounters.critique ?? 0) + 1;
          return { verdicts: [{ approve: false, round }], roundCounters: { critique: round } };
        },
      },
    });

    expect(stages(h)).toEqual([
      'prepare_context',
      'research',
      'plan',
      'guardrails',
      'critique',
      'plan',
      'guardrails',
      'critique',
      'plan',
      'guardrails',
      'critique',
      'finalize',
    ]);
    expect(result.state.verdicts).toHaveLength(3);
    expect(result.state.outcome).toEqual({ status: 'completed', verdict: 'exhausted' });
  });

  it('evaluate: autonomous applies and notifies without pausing', async () => {
    const h = createNodeContextHarness({ kind: 'evaluate' });

    const result = await h.runGraph({ input: {}, nodes: STUB_AGENT_NODES });

    expect(result.interrupt).toBeNull();
    expect(stages(h)).toEqual(['load_signals', 'safety_gate', 'evaluate', 'envelope', 'decide', 'apply', 'notify']);
    expect(result.state.outcome).toEqual({ status: 'completed', verdict: 'applied' });
  });

  it('evaluate: a safety stop at the gate ends the run before evaluate', async () => {
    const h = createNodeContextHarness({ kind: 'evaluate' });

    const result = await h.runGraph({
      input: {},
      nodes: {
        ...STUB_AGENT_NODES,
        safety_gate: async () => ({ outcome: { status: 'safety_stop', code: 'TRAINING_SAFETY_STOP' } }),
      },
    });

    expect(stages(h)).toEqual(['load_signals', 'safety_gate']);
    expect(result.state.outcome).toEqual({ status: 'safety_stop', code: 'TRAINING_SAFETY_STOP' });
  });

  it('evaluate: no change records a review and ends', async () => {
    const h = createNodeContextHarness({ kind: 'evaluate' });

    const result = await h.runGraph({
      input: {},
      nodes: { ...STUB_AGENT_NODES, decide: async () => ({ changeSet: { accepted: [], decision: 'no_change' } }) },
    });

    expect(stages(h)).toEqual(['load_signals', 'safety_gate', 'evaluate', 'envelope', 'decide', 'record_review']);
    expect(result.state.outcome).toEqual({ status: 'no_change', verdict: 'reviewed' });
  });

  it('evaluate: a structural accepted operation goes through the light critique', async () => {
    const h = createNodeContextHarness({ kind: 'evaluate' });

    await h.runGraph({
      input: {},
      nodes: { ...STUB_AGENT_NODES, envelope: async () => ({ changeSet: { accepted: [{ op: 'swap_exercise' }] } }) },
    });

    expect(stages(h)).toEqual(['load_signals', 'safety_gate', 'evaluate', 'envelope', 'critique_light', 'decide', 'apply', 'notify']);
  });

  it('evaluate: ask_first pauses at await_approval and a resume with the decision continues, without re-running earlier nodes', async () => {
    const h = createNodeContextHarness({ kind: 'evaluate' });

    const paused = await h.runGraph({ input: { input: { autonomy: 'ask_first' } }, nodes: STUB_AGENT_NODES });

    expect(paused.interrupt).toEqual({ kind: 'approval', payload: { kind: 'approval', payload: { operations: 0 } } });
    expect(stages(h)).toEqual(['load_signals', 'safety_gate', 'evaluate', 'envelope', 'decide', 'record_proposal', 'await_approval']);

    const done = await h.runGraph({ resume: { decision: 'reject' }, nodes: STUB_AGENT_NODES });

    expect(done.interrupt).toBeNull();
    expect(done.state.approval).toEqual({ decision: 'reject' });
    expect(done.state.outcome).toEqual({ status: 'no_change', verdict: 'rejected_by_owner' });
    expect(stages(h)).toEqual([
      'load_signals',
      'safety_gate',
      'evaluate',
      'envelope',
      'decide',
      'record_proposal',
      'await_approval',
      'await_approval',
      'notify',
    ]);
  });

  it('an abort rejects the run and a fresh runner continues from the last checkpoint', async () => {
    const h = createNodeContextHarness({ kind: 'create' });
    let blockPlan = true;

    const running = h.runGraph({
      input: {},
      nodes: {
        ...STUB_AGENT_NODES,
        plan: async (_state, ctx) => {
          if (blockPlan) {
            await new Promise((_resolve, reject) =>
              ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }),
            );
          }
          return { draft: { resumed: true } };
        },
      },
    });

    await waitFor(() => stages(h).includes('plan'));
    h.abort();
    await expect(running).rejects.toThrow();

    // A new controller: the harness's own signal is spent, so run the graph directly.
    blockPlan = false;
    const resumed = createNodeContextHarness({ kind: 'create', runId: h.runId });
    const result = await resumed.runGraph({ checkpointer: h.saver, nodes: STUB_AGENT_NODES });

    expect(stages(resumed)).toEqual(['plan', 'guardrails', 'critique', 'finalize']);
    expect(result.state.outcome?.status).toBe('completed');
  });
});

describe('routes', () => {
  const base = initialRunState({ runId: 'r', userId: 'u', kind: 'create' });

  it('routeAfterPrepare researches only for create', () => {
    expect(routeAfterPrepare({ kind: 'create' })).toBe('research');
    expect(routeAfterPrepare({ kind: 'revise' })).toBe('plan');
  });

  const clean = { report: { status: 'clean' } };
  const blocked = { report: { status: 'blocked' } };
  const approve = (round: number) => ({ ...stubVerdict('approve'), round });
  const revise = (round: number) => ({ ...stubVerdict('revise'), round });

  it.each([
    ['approve, clean', clean, [approve(1)], 1, 2, 'finalize', 'approved'],
    ['approve, repaired', { report: { status: 'repaired' } }, [approve(1)], 1, 2, 'finalize', 'approved'],
    ['approve while a block remains, rounds left', blocked, [approve(1)], 1, 2, 'plan', 'revise'],
    ['approve while a block remains, rounds spent', blocked, [approve(1), approve(2)], 2, 2, 'finalize', 'exhausted'],
    ['revise, rounds left', clean, [revise(1)], 1, 2, 'plan', 'revise'],
    ['revise twice, rounds spent', clean, [revise(1), revise(2)], 2, 2, 'finalize', 'exhausted'],
    ['revise, max 1', clean, [revise(1)], 1, 1, 'finalize', 'exhausted'],
    ['revise, max 3, round 2', clean, [revise(1), revise(2)], 2, 3, 'plan', 'revise'],
    ['approve with a score of 3', clean, [{ ...approve(1), scores: { ...approve(1).scores, recovery: 3 } }], 1, 2, 'plan', 'revise'],
    ['approve with a blocker', clean, [{ ...approve(1), blockers: revise(1).blockers }], 1, 2, 'plan', 'revise'],
    ['skipped for budget', clean, [{ round: 1, skipped: 'budget' }], 1, 2, 'finalize', 'critic_skipped_budget'],
    ['critic unavailable', clean, [{ round: 1, skipped: 'unavailable' }], 1, 2, 'finalize', 'critic_unavailable'],
    ['a malformed verdict', clean, [{ approve: true }], 1, 2, 'plan', 'revise'],
    ['no report', null, [approve(1)], 1, 2, 'plan', 'revise'],
  ])('%s: routeAfterCritique goes to %s', (_label, guardrailReport, verdicts, round, maxCriticRounds, route, decision) => {
    const state = { ...base, guardrailReport, verdicts, roundCounters: { critique: round }, maxCriticRounds };
    expect(routeAfterCritique(state)).toBe(route);
    expect(critiqueDecision(state)).toBe(decision);
    expect(shipsNow(state)).toBe(decision === 'approved');
  });

  it('routeAfterPlan finalizes only after a budget stop on a revision', () => {
    expect(routeAfterPlan({ warnings: [] })).toBe('guardrails');
    expect(routeAfterPlan({ warnings: ['critic_open_notes'] })).toBe('guardrails');
    expect(routeAfterPlan({ warnings: [TRAINING_RUN_WARNINGS.SKIPPED_BUDGET] })).toBe('finalize');
  });

  it('routeAfterSafetyGate ends the run on a safety stop, before any model call', () => {
    expect(routeAfterSafetyGate({ outcome: null })).toBe('evaluate');
    expect(routeAfterSafetyGate({ outcome: { status: 'safety_stop', code: 'TRAINING_SAFETY_STOP' } })).toBe(ROUTE_END);
  });

  it('routeAfterEnvelope sends structural accepted operations to the light critique', () => {
    expect(routeAfterEnvelope({ changeSet: null })).toBe('decide');
    expect(routeAfterEnvelope({ changeSet: { accepted: [{ op: 'set_prescription' }, { op: 'mark_deload' }] } })).toBe('decide');
    for (const op of STRUCTURAL_OPERATIONS) {
      expect(routeAfterEnvelope({ changeSet: { accepted: [{ op: 'set_prescription' }, { op }] } })).toBe('critique_light');
    }
  });

  it('routeAfterDecide: no_change reviews, ask_first proposes, autonomous applies', () => {
    expect(routeAfterDecide({ changeSet: { decision: 'no_change' } })).toBe('record_review');
    expect(routeAfterDecide({ changeSet: { decision: 'ask_first' } })).toBe('record_proposal');
    expect(routeAfterDecide({ changeSet: { decision: 'autonomous' } })).toBe('apply');
  });

  it('routeAfterApproval applies only an approval', () => {
    expect(routeAfterApproval({ approval: { decision: 'approve' } })).toBe('apply');
    expect(routeAfterApproval({ approval: { decision: 'reject' } })).toBe('notify');
    expect(routeAfterApproval({ approval: null })).toBe('notify');
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
