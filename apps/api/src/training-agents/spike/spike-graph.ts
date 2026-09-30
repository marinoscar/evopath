// =============================================================================
// Spike graph (THROWAWAY: replaced by the production training graph).
// =============================================================================
//
//   START -> research -> plan -> critique -> route --revise (round < 2)--> plan
//                                                \--approve or round == 2--> await_approval -> finalize -> END
//
// The ONLY spike file that imports LangGraph. It adapts the plain node
// functions in `nodes.ts` to LangGraph nodes: each gets a `SpikeNodeContext`
// built from the runnable config (the run's `signal`, the `custom` stream
// `writer`, LangGraph's `interrupt`). Never registered as a provider or a job
// type; constructed only inside specs.
//
// Two equivalent state definitions exist on purpose, to prove both work with
// this repo's Zod v4: `SpikeAnnotationState` (`Annotation.Root`) and
// `SpikeZodState` (`StateSchema` over our own Zod v4 schemas).
// =============================================================================

// First, so the telemetry pin runs before LangGraph is loaded.
import { disableFrameworkTelemetry } from '../disable-framework-telemetry';

import { z } from 'zod';
import type { BaseCheckpointSaver, LangGraphRunnableConfig } from '@langchain/langgraph';
import { Annotation, END, ReducedValue, START, StateGraph, StateSchema, interrupt } from '@langchain/langgraph';

import type { AiService } from '../../ai/runtime/ai.service';
import {
  EMPTY_SPIKE_USAGE,
  SPIKE_NODES,
  type SpikeApproval,
  type SpikeBrief,
  type SpikeDraft,
  type SpikeNode,
  type SpikeNodeContext,
  type SpikeNodeName,
  type SpikeState,
  type SpikeUsage,
  type SpikeVerdict,
  routeAfterCritique,
  spikeApprovalSchema,
  spikeBriefSchema,
  spikeDraftSchema,
  spikeUsageSchema,
  spikeVerdictSchema,
} from './nodes';

function addUsage(a: SpikeUsage, b: SpikeUsage): SpikeUsage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** The spike state as `Annotation.Root`. */
export const SpikeAnnotationState = Annotation.Root({
  goal: Annotation<string>(),
  brief: Annotation<SpikeBrief | null>({ reducer: (_prev, next) => next, default: () => null }),
  drafts: Annotation<SpikeDraft[]>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
  round: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  verdicts: Annotation<SpikeVerdict[]>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
  approved: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  approval: Annotation<SpikeApproval | null>({ reducer: (_prev, next) => next, default: () => null }),
  usage: Annotation<SpikeUsage>({ reducer: addUsage, default: () => ({ ...EMPTY_SPIKE_USAGE }) }),
});

/** The same state as a `StateSchema` over this repo's Zod v4 schemas. */
export const SpikeZodState = new StateSchema({
  goal: z.string(),
  brief: spikeBriefSchema.nullable().default(null),
  drafts: new ReducedValue(z.array(spikeDraftSchema).default(() => []), {
    inputSchema: z.array(spikeDraftSchema),
    reducer: (prev: SpikeDraft[], next: SpikeDraft[]) => [...prev, ...next],
  }),
  round: z.number().int().min(0).default(0),
  verdicts: new ReducedValue(z.array(spikeVerdictSchema).default(() => []), {
    inputSchema: z.array(spikeVerdictSchema),
    reducer: (prev: SpikeVerdict[], next: SpikeVerdict[]) => [...prev, ...next],
  }),
  approved: z.boolean().default(false),
  approval: spikeApprovalSchema.nullable().default(null),
  usage: new ReducedValue(spikeUsageSchema.default(() => ({ ...EMPTY_SPIKE_USAGE })), {
    inputSchema: spikeUsageSchema,
    reducer: addUsage,
  }),
});

export type SpikeStateDefinition = 'annotation' | 'zod';

export interface SpikeGraphDeps {
  ai: AiService;
  /** The user every model call is made for (`AiService.forUser`). */
  userId: string;
  /** The queue job running the graph; tagged on every usage row. */
  jobId?: string;
  checkpointer: BaseCheckpointSaver;
  /** Model override; omitted: the gateway's default for the user. */
  model?: string;
  /** Which state definition to build with. Default `annotation`. */
  state?: SpikeStateDefinition;
}

/** The input a first start takes. */
export interface SpikeGraphInput {
  goal: string;
}

/** Adapts a plain node to a LangGraph node, building its context from the config. */
function adapt(node: SpikeNode, deps: SpikeGraphDeps) {
  const client = deps.ai.forUser(deps.userId, deps.jobId ? { jobId: deps.jobId } : {});

  return async (state: SpikeState, config: LangGraphRunnableConfig): Promise<Partial<SpikeState>> => {
    const writer = config.writer;
    const ctx: SpikeNodeContext = {
      ai: client,
      signal: config.signal,
      ...(deps.model ? { model: deps.model } : {}),
      emit: (event) => writer?.(event),
      interrupt: (request) => (config.interrupt ?? interrupt)(request),
    };

    return node(state, ctx);
  };
}

/**
 * Builds and compiles the spike graph over `deps.checkpointer`. Invoke it with
 * `{ configurable: { thread_id: runId }, signal }`; resume an interrupt with
 * `new Command({ resume: { decision: 'approve' } })` on a fresh instance.
 */
export function buildSpikeGraph(deps: SpikeGraphDeps) {
  disableFrameworkTelemetry();

  const nodes = Object.fromEntries(
    Object.entries(SPIKE_NODES).map(([name, node]) => [name, adapt(node, deps)]),
  ) as Record<SpikeNodeName, ReturnType<typeof adapt>>;

  if (deps.state === 'zod') {
    return new StateGraph(SpikeZodState)
      .addNode('research', nodes.research)
      .addNode('plan', nodes.plan)
      .addNode('critique', nodes.critique)
      .addNode('await_approval', nodes.await_approval)
      .addNode('finalize', nodes.finalize)
      .addEdge(START, 'research')
      .addEdge('research', 'plan')
      .addEdge('plan', 'critique')
      .addConditionalEdges('critique', routeAfterCritique, ['plan', 'await_approval'])
      .addEdge('await_approval', 'finalize')
      .addEdge('finalize', END)
      .compile({ checkpointer: deps.checkpointer });
  }

  return new StateGraph(SpikeAnnotationState)
    .addNode('research', nodes.research)
    .addNode('plan', nodes.plan)
    .addNode('critique', nodes.critique)
    .addNode('await_approval', nodes.await_approval)
    .addNode('finalize', nodes.finalize)
    .addEdge(START, 'research')
    .addEdge('research', 'plan')
    .addEdge('plan', 'critique')
    .addConditionalEdges('critique', routeAfterCritique, ['plan', 'await_approval'])
    .addEdge('await_approval', 'finalize')
    .addEdge('finalize', END)
    .compile({ checkpointer: deps.checkpointer });
}

export type SpikeGraph = ReturnType<typeof buildSpikeGraph>;
