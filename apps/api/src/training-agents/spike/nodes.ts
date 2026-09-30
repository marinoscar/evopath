// =============================================================================
// Spike graph nodes (THROWAWAY: replaced by the production training graph).
// =============================================================================
//
// Plain async functions `(state, ctx) => Partial<SpikeState>`. This file
// imports NO LangGraph: everything a node needs from the runtime (the abort
// signal, the progress writer, the interrupt) arrives through `ctx`. That is
// the convention the production graph keeps, so the same nodes could run
// under a hand-rolled sequential runner without changing.
//
// Every model call goes through `AiService.forUser(userId, { jobId })`
// (`ctx.ai`), with `metadata.agent` naming the role, so keys, the kill
// switch, capabilities, limits and usage rows stay in the gateway. State
// holds node outputs only (brief, drafts, verdicts, counters), never raw
// provider messages.
// =============================================================================

import { z } from 'zod';

import type { AiUserClient } from '../../ai/runtime/ai.service';
import type { AiStructuredResponse } from '../../ai/runtime/ai-runtime.types';

/** Critic rounds after which the plan goes to the user even without approval. */
export const SPIKE_MAX_ROUNDS = 2;

/** The roles a node reports in `metadata.agent` (a scripted fake routes on it). */
export const SPIKE_AGENT_ROLES = {
  research: 'researcher',
  plan: 'planner',
  critique: 'critic',
} as const;

export type SpikeAgentRole = (typeof SPIKE_AGENT_ROLES)[keyof typeof SPIKE_AGENT_ROLES];

export const spikeBriefSchema = z.object({
  summary: z.string().min(1),
  sources: z.array(z.string()),
});
export type SpikeBrief = z.infer<typeof spikeBriefSchema>;

export const spikeDraftSchema = z.object({
  title: z.string().min(1),
  sessions: z.array(z.object({ day: z.number().int().min(1).max(7), focus: z.string().min(1) })),
});
export type SpikeDraft = z.infer<typeof spikeDraftSchema>;

export const spikeVerdictSchema = z.object({
  approve: z.boolean(),
  score: z.number().min(0).max(10),
  notes: z.string(),
});
export type SpikeVerdict = z.infer<typeof spikeVerdictSchema>;

export const spikeApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().optional(),
});
export type SpikeApproval = z.infer<typeof spikeApprovalSchema>;

export const spikeUsageSchema = z.object({
  calls: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export type SpikeUsage = z.infer<typeof spikeUsageSchema>;

export const EMPTY_SPIKE_USAGE: SpikeUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

/** The graph state. Node outputs only. */
export interface SpikeState {
  goal: string;
  brief: SpikeBrief | null;
  /** Every plan draft, oldest first (appended by `plan`). */
  drafts: SpikeDraft[];
  /** Critic rounds completed. */
  round: number;
  /** Every critic verdict, oldest first (appended by `critique`). */
  verdicts: SpikeVerdict[];
  /** The final outcome: the user approved the plan (set by `finalize`). */
  approved: boolean;
  /** The user's decision at the interrupt (set by `await_approval`). */
  approval: SpikeApproval | null;
  /** Summed over every model call (reducer: add). */
  usage: SpikeUsage;
}

export type SpikeUpdate = Partial<SpikeState>;

/** What `await_approval` hands the user. */
export interface SpikeApprovalRequest {
  kind: 'approval';
  summary: string;
}

/** A progress event a node emits on the graph's `custom` stream. */
export interface SpikeProgressEvent {
  node: SpikeNodeName;
  phase: 'started' | 'finished';
  round?: number;
}

export type SpikeNodeName = 'research' | 'plan' | 'critique' | 'await_approval' | 'finalize';

/** Everything a node gets from the runtime. No LangGraph type leaks in here. */
export interface SpikeNodeContext {
  /** `AiService.forUser(userId, { jobId })`. */
  ai: AiUserClient;
  /** The run's abort signal (cancel, deadline); passed to every model call. */
  signal?: AbortSignal;
  /** Model override; omitted: the gateway's default for the user. */
  model?: string;
  /** Progress on the `custom` stream. A no-op when nobody listens. */
  emit(event: SpikeProgressEvent): void;
  /**
   * Pauses the run for a decision and returns it on resume. Under LangGraph
   * this is `interrupt()`; under a sequential runner it throws a signal the
   * runner catches.
   */
  interrupt(request: SpikeApprovalRequest): unknown;
}

export type SpikeNode = (state: SpikeState, ctx: SpikeNodeContext) => Promise<SpikeUpdate>;

function usageOf(response: AiStructuredResponse<unknown>): SpikeUsage {
  return {
    calls: 1,
    inputTokens: response.usage.inputTokens ?? 0,
    outputTokens: response.usage.outputTokens ?? 0,
  };
}

function modelOf(ctx: SpikeNodeContext): { model?: string } {
  return ctx.model ? { model: ctx.model } : {};
}

export const researchNode: SpikeNode = async (state, ctx) => {
  ctx.emit({ node: 'research', phase: 'started' });

  const response = await ctx.ai.respondStructured(
    {
      ...modelOf(ctx),
      instructions: 'Research the evidence for a training plan that meets the goal. Cite sources.',
      input: state.goal,
      tools: [{ type: 'web_search' }],
      schema: spikeBriefSchema,
      schemaName: 'research_brief',
      metadata: { agent: SPIKE_AGENT_ROLES.research },
    },
    { signal: ctx.signal },
  );

  ctx.emit({ node: 'research', phase: 'finished' });
  return { brief: response.parsed, usage: usageOf(response) };
};

export const planNode: SpikeNode = async (state, ctx) => {
  ctx.emit({ node: 'plan', phase: 'started', round: state.round });

  const lastVerdict = state.verdicts.at(-1);
  const response = await ctx.ai.respondStructured(
    {
      ...modelOf(ctx),
      instructions: 'Draft a one-week training plan for the goal from the research brief.',
      input: JSON.stringify({
        goal: state.goal,
        brief: state.brief,
        previousDraft: state.drafts.at(-1) ?? null,
        critique: lastVerdict?.notes ?? null,
      }),
      schema: spikeDraftSchema,
      schemaName: 'plan_draft',
      metadata: { agent: SPIKE_AGENT_ROLES.plan },
    },
    { signal: ctx.signal },
  );

  ctx.emit({ node: 'plan', phase: 'finished', round: state.round });
  return { drafts: [response.parsed], usage: usageOf(response) };
};

export const critiqueNode: SpikeNode = async (state, ctx) => {
  const round = state.round + 1;
  ctx.emit({ node: 'critique', phase: 'started', round });

  const response = await ctx.ai.respondStructured(
    {
      ...modelOf(ctx),
      instructions: 'Critique the plan draft against the goal and the brief. Approve only a safe, coherent plan.',
      input: JSON.stringify({ goal: state.goal, brief: state.brief, draft: state.drafts.at(-1) ?? null }),
      schema: spikeVerdictSchema,
      schemaName: 'critic_verdict',
      metadata: { agent: SPIKE_AGENT_ROLES.critique },
    },
    { signal: ctx.signal },
  );

  ctx.emit({ node: 'critique', phase: 'finished', round });
  return { verdicts: [response.parsed], round, usage: usageOf(response) };
};

/** The conditional edge after `critique`. */
export function routeAfterCritique(state: SpikeState): 'plan' | 'await_approval' {
  const approved = state.verdicts.at(-1)?.approve ?? false;
  return approved || state.round >= SPIKE_MAX_ROUNDS ? 'await_approval' : 'plan';
}

export const awaitApprovalNode: SpikeNode = async (state, ctx) => {
  ctx.emit({ node: 'await_approval', phase: 'started' });

  const draft = state.drafts.at(-1);
  const decision = spikeApprovalSchema.parse(
    ctx.interrupt({
      kind: 'approval',
      summary: draft ? `${draft.title} (${draft.sessions.length} sessions)` : 'No draft',
    }),
  );

  ctx.emit({ node: 'await_approval', phase: 'finished' });
  return { approval: decision };
};

export const finalizeNode: SpikeNode = async (state, ctx) => {
  ctx.emit({ node: 'finalize', phase: 'started' });
  const approved = state.approval?.decision === 'approve';
  ctx.emit({ node: 'finalize', phase: 'finished' });
  return { approved };
};

export const SPIKE_NODES: Record<SpikeNodeName, SpikeNode> = {
  research: researchNode,
  plan: planNode,
  critique: critiqueNode,
  await_approval: awaitApprovalNode,
  finalize: finalizeNode,
};
