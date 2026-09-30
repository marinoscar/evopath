// Smoke coverage for the spike graph through the REAL AiService (fake
// provider) over LangGraph's in-memory saver. The thorough scenario specs
// (abort, telemetry, real Postgres) live under test/training-agents/.

import { Command, MemorySaver } from '@langchain/langgraph';

import { createAiRuntimeHarness, HARNESS_MODEL, HARNESS_USER } from '../../ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../ai/testing/fake-ai-provider';
import type { AiResponseRequest } from '../../ai/core/types/responses.types';
import { toRunResult } from '../graph/langgraph-runner';
import type { SpikeState } from './nodes';
import { buildSpikeGraph } from './spike-graph';

function scriptedHarness() {
  let critiques = 0;

  return createAiRuntimeHarness({
    models: [
      {
        modelId: HARNESS_MODEL,
        capabilities: {
          ...FAKE_TEXT_MODEL_CAPABILITIES,
          capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'],
        },
      },
    ],
    policy: { hostedTools: { web_search: true } },
    fake: {
      hostedTools: ['web_search'],
      responses: (req: AiResponseRequest) => {
        const usage = { inputTokens: 10, outputTokens: 5 };
        switch (req.metadata?.agent) {
          case 'researcher':
            return { outputText: JSON.stringify({ summary: 'Brief', sources: ['https://example.com'] }), usage };
          case 'planner':
            return {
              outputText: JSON.stringify({ title: 'Week 1', sessions: [{ day: 1, focus: 'legs' }] }),
              usage,
            };
          case 'critic':
            critiques += 1;
            return {
              outputText: JSON.stringify({ approve: critiques > 1, score: critiques > 1 ? 8 : 4, notes: 'n' }),
              usage,
            };
          default:
            throw new Error(`unexpected agent ${req.metadata?.agent}`);
        }
      },
    },
  });
}

describe.each(['annotation', 'zod'] as const)('spike graph (%s state)', (state) => {
  it('runs research, plan, critic loop, interrupts, and resumes on a fresh graph to finalize', async () => {
    const h = scriptedHarness();
    const saver = new MemorySaver();
    const config = { configurable: { thread_id: 'run-1' }, signal: new AbortController().signal };

    const first = toRunResult<SpikeState>(
      await buildSpikeGraph({ ai: h.ai, userId: HARNESS_USER, checkpointer: saver, state, model: HARNESS_MODEL }).invoke(
        { goal: 'Run a 5k' },
        config,
      ),
    );

    expect(first.interrupt).toEqual({
      kind: 'approval',
      payload: { kind: 'approval', summary: 'Week 1 (1 sessions)' },
    });
    expect(first.state.round).toBe(2);
    expect(first.state.drafts).toHaveLength(2);
    expect(first.state.usage).toEqual({ calls: 5, inputTokens: 50, outputTokens: 25 });
    expect(h.fake.calls.map((c) => c.request?.metadata?.agent)).toEqual([
      'researcher',
      'planner',
      'critic',
      'planner',
      'critic',
    ]);

    const second = toRunResult<SpikeState>(
      await buildSpikeGraph({ ai: h.ai, userId: HARNESS_USER, checkpointer: saver, state, model: HARNESS_MODEL }).invoke(
        new Command({ resume: { decision: 'approve' } }),
        config,
      ),
    );

    expect(second.interrupt).toBeNull();
    expect(second.state.approved).toBe(true);
    expect(second.state.approval).toEqual({ decision: 'approve' });
    expect(h.fake.calls).toHaveLength(5);
  });
});

describe('spike graph abort', () => {
  it('aborts the in-flight provider call, rejects promptly, and resumes from the last checkpoint', async () => {
    let block = true;
    let critiques = 0;
    const planStarted = jest.fn();
    const planObservedAbort = jest.fn();
    const h = createAiRuntimeHarness({
      models: [
        {
          modelId: HARNESS_MODEL,
          capabilities: {
            ...FAKE_TEXT_MODEL_CAPABILITIES,
            capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'],
          },
        },
      ],
      policy: { hostedTools: { web_search: true } },
      fake: {
        hostedTools: ['web_search'],
        responses: async (req: AiResponseRequest, ctx) => {
          if (req.metadata?.agent === 'researcher') return { outputText: '{"summary":"b","sources":[]}' };
          if (req.metadata?.agent === 'planner') {
            if (block) {
              planStarted();
              await new Promise((_resolve, reject) =>
                ctx.signal?.addEventListener(
                  'abort',
                  () => {
                    planObservedAbort();
                    reject(ctx.signal?.reason);
                  },
                  { once: true },
                ),
              );
            }
            return { outputText: '{"title":"W1","sessions":[{"day":1,"focus":"legs"}]}' };
          }
          critiques += 1;
          return { outputText: JSON.stringify({ approve: true, score: 9, notes: 'ok' }) };
        },
      },
    });
    const saver = new MemorySaver();
    const controller = new AbortController();
    const graph = buildSpikeGraph({ ai: h.ai, userId: HARNESS_USER, checkpointer: saver, model: HARNESS_MODEL });

    const running = graph.invoke({ goal: 'Run a 5k' }, { configurable: { thread_id: 'run-abort' }, signal: controller.signal });
    await new Promise<void>((resolve) => {
      const tick = () => (planStarted.mock.calls.length > 0 ? resolve() : setImmediate(tick));
      tick();
    });
    const abortedAt = Date.now();
    controller.abort(new Error('cancelled'));

    await expect(running).rejects.toThrow();
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    // The provider call itself saw the abort (the fake's own `aborted` flag
    // is set only by its abort-aware `delayMs` pause, not by a script).
    expect(planObservedAbort).toHaveBeenCalledTimes(1);

    const snapshot = await graph.getState({ configurable: { thread_id: 'run-abort' } });
    expect(snapshot.next).toEqual(['plan']);
    expect(snapshot.values.brief).toEqual({ summary: 'b', sources: [] });

    block = false;
    const fresh = buildSpikeGraph({ ai: h.ai, userId: HARNESS_USER, checkpointer: saver, model: HARNESS_MODEL });
    const resumed = toRunResult<SpikeState>(
      await fresh.invoke(null, { configurable: { thread_id: 'run-abort' }, signal: new AbortController().signal }),
    );

    expect(resumed.interrupt?.kind).toBe('approval');
    expect(critiques).toBe(1);
    expect(h.fake.calls.map((c) => c.request?.metadata?.agent)).toEqual(['researcher', 'planner', 'planner', 'critic']);
  });
});
