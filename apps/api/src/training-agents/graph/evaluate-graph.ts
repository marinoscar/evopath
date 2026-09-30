// =============================================================================
// The evaluate graph (evaluate runs), wired on LangGraph
// =============================================================================
//
//   START -> load_signals -> evaluate -> envelope --autonomous--> apply -> END
//                                                \--ask_first--> await_approval (interrupt) -> apply
//
// The second of the two files that knows LangGraph. Same node adapter and
// state channels as the create graph. `await_approval` pauses the run
// (`interrupt`): the job ends normally with the run `awaiting_approval`, and
// the owner's decision resumes it in a new job from the checkpoint.
// =============================================================================

// First, so the telemetry pin runs before LangGraph is loaded.
import { disableFrameworkTelemetry } from '../disable-framework-telemetry';

import { END, START, StateGraph } from '@langchain/langgraph';

import { EVALUATE_GRAPH_NODES, type EvaluateGraphNodeName } from '../nodes';
import { RunStateAnnotation, type TrainingGraphDeps, adaptNode } from './create-graph';
import { routeAfterEnvelope } from './routes';

/** Builds and compiles the evaluate graph over `deps.checkpointer`. */
export function buildEvaluateGraph(deps: TrainingGraphDeps<EvaluateGraphNodeName>) {
  disableFrameworkTelemetry();

  const n = (name: EvaluateGraphNodeName) => adaptNode(EVALUATE_GRAPH_NODES[name], deps);

  return new StateGraph(RunStateAnnotation)
    .addNode('load_signals', n('load_signals'))
    .addNode('evaluate', n('evaluate'))
    .addNode('envelope', n('envelope'))
    .addNode('await_approval', n('await_approval'))
    .addNode('apply', n('apply'))
    .addEdge(START, 'load_signals')
    .addEdge('load_signals', 'evaluate')
    .addEdge('evaluate', 'envelope')
    .addConditionalEdges('envelope', routeAfterEnvelope, ['await_approval', 'apply'])
    .addEdge('await_approval', 'apply')
    .addEdge('apply', END)
    .compile({ checkpointer: deps.checkpointer });
}

export type EvaluateGraph = ReturnType<typeof buildEvaluateGraph>;
