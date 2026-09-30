// Shared fixtures for the training-agents specs that drive the training
// graphs with nodes that really call a model (through `AgentCaller` and the
// real `AiService` over the scripted fake provider). These overrides stand in
// for the researcher, planner, critic and evaluator nodes so the runtime is
// exercised end to end without their contracts. Not a `*.spec.ts`
// file, so Jest never runs it as a suite.

import { z } from 'zod';

import type { NodeFn } from '../../src/training-agents/graph/node-context';
import type { RunState } from '../../src/training-agents/graph/run-state';
import type { AgentScript } from '../../src/training-agents/testing/node-context-harness';
import { STUB_AGENT_NODES, stubVerdict } from '../../src/training-agents/testing/stub-agent-nodes';
import type { TrainingAgentRole } from '../../src/common/schemas/settings.schema';

/** Per-call usage every scripted response reports. */
export const AGENT_CALL_USAGE = { inputTokens: 10, outputTokens: 5 } as const;

export const SCRIPTED_BRIEF = { summary: 'Brief', sources: ['https://example.com'] };
export const SCRIPTED_DRAFT = { title: 'Week 1', sessions: [{ day: 1, focus: 'legs' }] };

const briefSchema = z.object({ summary: z.string(), sources: z.array(z.string()) });
const draftSchema = z.object({
  title: z.string(),
  sessions: z.array(z.object({ day: z.number().int(), focus: z.string() })),
});
const verdictSchema = z.object({ approve: z.boolean(), score: z.number() });
const evaluationSchema = z.object({ operations: z.number().int() });

/**
 * Scripts answering by role: the critic rejects the first `rejections`
 * drafts and approves the next. `onCall` sees each request first (for
 * blocking, throwing or counting).
 */
export function agentScripts(
  opts: { rejections?: number; onCall?: (...args: Parameters<AgentScript>) => void | Promise<void> } = {},
): Partial<Record<TrainingAgentRole, AgentScript>> {
  const rejections = opts.rejections ?? 1;
  let critiques = 0;
  const wrap =
    (answer: () => Record<string, unknown>): AgentScript =>
    async (req, ctx) => {
      await opts.onCall?.(req, ctx);
      return { outputText: JSON.stringify(answer()), usage: AGENT_CALL_USAGE };
    };

  return {
    researcher: wrap(() => SCRIPTED_BRIEF),
    planner: wrap(() => SCRIPTED_DRAFT),
    critic: wrap(() => {
      critiques += 1;
      const approve = critiques > rejections;
      return { approve, score: approve ? 8 : 4 };
    }),
    evaluator: wrap(() => ({ operations: 2 })),
  };
}

/**
 * Node overrides that call the agents, standing in for the stories that
 * implement them. The model-free implemented nodes (context, guardrails,
 * finalize) are stubbed: these specs exercise the runtime, not the context or the rules.
 */
export const AGENT_NODES: Record<string, NodeFn> = {
  prepare_context: STUB_AGENT_NODES.prepare_context,
  guardrails: STUB_AGENT_NODES.guardrails,
  finalize: STUB_AGENT_NODES.finalize,
  research: async (_state, ctx) => {
    const { parsed } = await ctx.agent.structured({
      role: 'researcher',
      node: 'research',
      schema: briefSchema,
      schemaName: 'research_brief',
      instructions: 'Research the evidence for the goal.',
      input: 'goal',
      hostedTools: [{ type: 'web_search' }],
    });
    // A stand-in brief, not a verified one: these specs exercise the runtime.
    return { brief: parsed as unknown as RunState['brief'] };
  },
  plan: async (state, ctx) => {
    const round = state.roundCounters.critique ?? 0;
    const { parsed } = await ctx.agent.structured({
      role: 'planner',
      node: 'plan',
      round,
      schema: draftSchema,
      schemaName: 'plan_draft',
      instructions: 'Draft the plan.',
      input: JSON.stringify({ brief: state.brief, previous: state.draft }),
    });
    return { draft: parsed };
  },
  critique: async (state, ctx) => {
    const round = (state.roundCounters.critique ?? 0) + 1;
    const { parsed } = await ctx.agent.structured({
      role: 'critic',
      node: 'critique',
      round,
      schema: verdictSchema,
      schemaName: 'critic_verdict',
      instructions: 'Critique the draft.',
      input: JSON.stringify(state.draft),
    });
    // The rubric verdict the ship decision reads, from the scripted yes/no.
    return { verdicts: [{ ...stubVerdict(parsed.approve ? 'approve' : 'revise'), round }], roundCounters: { critique: round } };
  },
  evaluate: async (_state, ctx) => {
    const { parsed } = await ctx.agent.structured({
      role: 'evaluator',
      node: 'evaluate',
      schema: evaluationSchema,
      schemaName: 'evaluation',
      instructions: 'Evaluate progress.',
      input: 'signals',
    });
    return { evaluation: parsed, changeSet: { operations: parsed.operations } };
  },
};

/** The roles the fake saw, in call order. */
export function agentsCalled(calls: Array<{ request?: { metadata?: Record<string, string> } }>): string[] {
  return calls.map((call) => call.request?.metadata?.agent ?? '?');
}
