import { CREATE_GRAPH_NODES, EVALUATE_GRAPH_NODES } from '../nodes';
import { createNodeContextHarness } from '../testing/node-context-harness';
import { STUB_AGENT_NODES } from '../testing/stub-agent-nodes';
import { routeAfterCritique, routeAfterEnvelope, routeAfterPrepare } from './routes';
import { initialRunState } from './run-state';
import { TRAINING_GRAPH_READY, graphForKind, isGraphReady } from './training-graphs';

const stages = (h: ReturnType<typeof createNodeContextHarness>) =>
  (h.events.events.get(h.runId) ?? []).filter((e) => e.type === 'stage.started').map((e) => e.data.node);

describe('training graphs on stub nodes', () => {
  it('only the implemented agent nodes are real, and every graph still answers not-implemented', () => {
    const implemented = Object.values(CREATE_GRAPH_NODES)
      .filter((node) => node.implemented)
      .map((node) => node.name);
    expect(implemented).toEqual(Object.keys(STUB_AGENT_NODES));
    expect(Object.values(EVALUATE_GRAPH_NODES).every((node) => node.implemented === false)).toBe(true);
    expect(TRAINING_GRAPH_READY).toEqual({ create: false, evaluate: false });
    expect(graphForKind('create')).toBe('create');
    expect(graphForKind('revise')).toBe('create');
    expect(graphForKind('evaluate')).toBe('evaluate');
    expect(isGraphReady('create')).toBe(false);
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

  it('evaluate: autonomous applies without pausing', async () => {
    const h = createNodeContextHarness({ kind: 'evaluate' });

    const result = await h.runGraph({ input: {}, nodes: STUB_AGENT_NODES });

    expect(result.interrupt).toBeNull();
    expect(stages(h)).toEqual(['load_signals', 'evaluate', 'envelope', 'apply']);
    expect(result.state.outcome).toEqual({ status: 'completed', verdict: 'applied' });
  });

  it('evaluate: ask_first pauses at await_approval and a resume with the decision applies it, without re-running earlier nodes', async () => {
    const h = createNodeContextHarness({ kind: 'evaluate' });

    const paused = await h.runGraph({ input: { input: { autonomy: 'ask_first' } } });

    expect(paused.interrupt).toEqual({ kind: 'approval', payload: { kind: 'approval', payload: { operations: 0 } } });
    expect(stages(h)).toEqual(['load_signals', 'evaluate', 'envelope', 'await_approval']);

    const done = await h.runGraph({ resume: { decision: 'reject' } });

    expect(done.interrupt).toBeNull();
    expect(done.state.approval).toEqual({ decision: 'reject' });
    expect(done.state.outcome).toEqual({ status: 'no_change', verdict: 'rejected_by_owner' });
    expect(stages(h)).toEqual(['load_signals', 'evaluate', 'envelope', 'await_approval', 'await_approval', 'apply']);
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

  it.each([
    [[{ approve: true }], 1, 'finalize'],
    [[{ approve: false }], 1, 'plan'],
    [[{ approve: false }, { approve: false }], 2, 'finalize'],
    [[{ approve: 'yes' }], 1, 'plan'],
    [[null], 1, 'plan'],
  ])('routeAfterCritique(%j, round %i) goes to %s', (verdicts, round, expected) => {
    expect(routeAfterCritique({ ...base, verdicts, roundCounters: { critique: round }, maxCriticRounds: 2 })).toBe(
      expected,
    );
  });

  it('routeAfterEnvelope pauses only for ask_first', () => {
    expect(routeAfterEnvelope({ input: { autonomy: 'ask_first' } })).toBe('await_approval');
    expect(routeAfterEnvelope({ input: { autonomy: 'autonomous' } })).toBe('apply');
    expect(routeAfterEnvelope({ input: {} })).toBe('apply');
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
