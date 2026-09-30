import {
  type AdaptCheckpointer,
  type AdaptGraphDefinition,
  type AdaptGraphHooks,
  type AdaptNodeFn,
  adaptGraphRunner,
} from '../../training-agents/graph/adapt-graph';
import type { AgentGraphRunner } from '../../training-agents/graph/agent-graph-runner.interface';
import type { AdaptGraphNodeName, AdaptRunState } from '../../training-agents/graph/adapt-run-state';
import type { AdaptationNodeContext } from './node-context';
import { runAdaptNode } from './nodes/adapt.node';
import { runContextNode } from './nodes/context.node';
import { runCriticNode } from './nodes/critic.node';
import { runFinalizeNode } from './nodes/finalize.node';
import { runGuardrailsNode } from './nodes/guardrails.node';
import { routeAfterContext, routeAfterCritic, routeAfterGuardrails } from './routes';

// =============================================================================
// The quick adaptation graph: nodes and routes, hosted on the E5.3 kit
// =============================================================================
//
//   START -> context -> [blocked? END(blocked_safety)] -> adapt -> guardrails -> critic
//            critic --accept--> finalize -> END
//            critic --revise (round < 1)--> adapt (with critic notes) -> guardrails -> finalize -> END
//
// The LangGraph wiring (channels, edges, checkpoints) is the kit's
// `training-agents/graph/adapt-graph.ts`; this module never imports LangGraph
// (CLAUDE.md AI rule 6). Tests drive the same definition on the fake
// provider through `testing/adaptation-graph-harness.ts`.
// =============================================================================

export const ADAPTATION_GRAPH: AdaptGraphDefinition<AdaptationNodeContext> = {
  nodes: {
    context: runContextNode,
    adapt: runAdaptNode,
    guardrails: runGuardrailsNode,
    critic: runCriticNode,
    finalize: runFinalizeNode,
  },
  routes: {
    afterContext: routeAfterContext,
    afterGuardrails: routeAfterGuardrails,
    afterCritic: routeAfterCritic,
  },
};

export interface AdaptationGraphRunnerDeps {
  checkpointer: AdaptCheckpointer;
  context: AdaptationNodeContext;
  hooks?: AdaptGraphHooks;
  /** Replace node implementations (tests). */
  nodes?: Partial<Record<AdaptGraphNodeName, AdaptNodeFn<AdaptationNodeContext>>>;
}

/** The runner for one job of an adaptation run. */
export function adaptationGraphRunner(deps: AdaptationGraphRunnerDeps): AgentGraphRunner<AdaptRunState> {
  return adaptGraphRunner({ ...deps, definition: ADAPTATION_GRAPH });
}
