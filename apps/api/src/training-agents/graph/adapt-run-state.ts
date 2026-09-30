// =============================================================================
// AdaptRunState: the state of a quick workout adaptation's graph (E6.1)
// =============================================================================
//
// No LangGraph import (like `run-state.ts`): the nodes live in
// `training-adaptation/graph/nodes/` and read and return this type; only
// `adapt-graph.ts` turns it into LangGraph channels.
//
// STATE HOLDS NODE OUTPUTS ONLY, never a provider message or response id:
// every field is checkpointed to `training_run_checkpoints` under the kit's
// run id. The agent fields are typed `unknown` here and narrowed by the
// adaptation module that owns them (its `state.ts` accessors), so this kit
// file never imports the feature.
// =============================================================================

/** The graph's nodes, in the order they first run. */
export const ADAPT_GRAPH_NODE_NAMES = ['context', 'adapt', 'guardrails', 'critic', 'finalize'] as const;

export type AdaptGraphNodeName = (typeof ADAPT_GRAPH_NODE_NAMES)[number];

/** How the graph ended, set by `context` (blocked) or `finalize` (ready). `null` while it runs. */
export interface AdaptRunOutcome {
  status: 'ready' | 'blocked_safety';
  /** A machine code for `blocked_safety`. */
  code?: string;
}

export interface AdaptRunState {
  runId: string;
  userId: string;
  adaptationId: string;
  /** The validated adaptation request (`workout_adaptations.request`). */
  request: Record<string, unknown>;
  /** The node running now, for the UI. */
  stage: string | null;
  /** Loop counters by name (`adapt`: planner passes, `critic`: critic rounds). Merged, never replaced. */
  roundCounters: Record<string, number>;
  /** Critic-driven revisions allowed (frozen at start). */
  maxRevisions: number;
  /** Machine warning codes (appended). No free text. */
  warnings: string[];
  outcome: AdaptRunOutcome | null;
  /**
   * The adaptation context (sent half plus server-only facts). Not named
   * `context`: LangGraph refuses a channel named like a node.
   */
  adaptationContext: unknown | null;
  /** The planner's latest parsed answer. */
  draft: unknown | null;
  /** The latest proposal that passed the guardrails. */
  proposal: unknown | null;
  /** The guardrail report of `proposal`. */
  guardrailReport: unknown | null;
  /** Every critic round, oldest first (appended). */
  critiques: unknown[];
  /** What `finalize` assembled for the adaptation row. */
  result: unknown | null;
}

export type AdaptRunStateUpdate = Partial<AdaptRunState>;

export function initialAdaptRunState(init: {
  runId: string;
  userId: string;
  adaptationId: string;
  request: Record<string, unknown>;
  maxRevisions: number;
}): AdaptRunState {
  return {
    runId: init.runId,
    userId: init.userId,
    adaptationId: init.adaptationId,
    request: init.request,
    stage: null,
    roundCounters: {},
    maxRevisions: init.maxRevisions,
    warnings: [],
    outcome: null,
    adaptationContext: null,
    draft: null,
    proposal: null,
    guardrailReport: null,
    critiques: [],
    result: null,
  };
}
