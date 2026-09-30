// =============================================================================
// The evaluate graph (evaluate runs), wired on LangGraph
// =============================================================================
//
//   START -> load_signals -> safety_gate --stop--> END
//                                        \-> evaluate -> envelope --structural--> critique_light -> decide
//                                                                 \-------------------------------^
//   decide: no_change  -> record_review -> END
//           autonomous -> apply -> notify -> END
//           ask_first  -> record_proposal -> await_approval (interrupt) --approve--> apply -> notify -> END
//                                                                        \-reject---> notify -> END
//
// The second of the two files that knows LangGraph. Same node adapter and
// state channels as the create graph; the routes are the pure functions in
// `routes.ts`. `await_approval` pauses the run (`interrupt`): the job ends
// normally with the run `awaiting_approval`, and the owner's decision resumes
// it in a new job from the checkpoint. `load_signals` and `safety_gate` are
// deterministic (no model); a safety stop ends the run before `evaluate`.
// =============================================================================

// First, so the telemetry pin runs before LangGraph is loaded.
import { disableFrameworkTelemetry } from '../disable-framework-telemetry';

import { END, START, StateGraph } from '@langchain/langgraph';

import { EVALUATE_GRAPH_NODES, type EvaluateGraphNodeName } from '../nodes';
import { RunStateAnnotation, type TrainingGraphDeps, adaptNode } from './create-graph';
import { ROUTE_END, routeAfterApproval, routeAfterDecide, routeAfterEnvelope, routeAfterSafetyGate } from './routes';

/** Builds and compiles the evaluate graph over `deps.checkpointer`. */
export function buildEvaluateGraph(deps: TrainingGraphDeps<EvaluateGraphNodeName>) {
  disableFrameworkTelemetry();

  const n = (name: EvaluateGraphNodeName) => adaptNode(EVALUATE_GRAPH_NODES[name], deps);

  return new StateGraph(RunStateAnnotation)
    .addNode('load_signals', n('load_signals'))
    .addNode('safety_gate', n('safety_gate'))
    .addNode('evaluate', n('evaluate'))
    .addNode('envelope', n('envelope'))
    .addNode('critique_light', n('critique_light'))
    .addNode('decide', n('decide'))
    .addNode('record_review', n('record_review'))
    .addNode('record_proposal', n('record_proposal'))
    .addNode('await_approval', n('await_approval'))
    .addNode('apply', n('apply'))
    .addNode('notify', n('notify'))
    .addEdge(START, 'load_signals')
    .addEdge('load_signals', 'safety_gate')
    .addConditionalEdges('safety_gate', routeAfterSafetyGate, { evaluate: 'evaluate', [ROUTE_END]: END })
    .addEdge('evaluate', 'envelope')
    .addConditionalEdges('envelope', routeAfterEnvelope, ['critique_light', 'decide'])
    .addEdge('critique_light', 'decide')
    .addConditionalEdges('decide', routeAfterDecide, ['record_review', 'apply', 'record_proposal'])
    .addEdge('record_review', END)
    .addEdge('record_proposal', 'await_approval')
    .addConditionalEdges('await_approval', routeAfterApproval, ['apply', 'notify'])
    .addEdge('apply', 'notify')
    .addEdge('notify', END)
    .compile({ checkpointer: deps.checkpointer });
}

export type EvaluateGraph = ReturnType<typeof buildEvaluateGraph>;
