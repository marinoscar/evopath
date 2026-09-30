import type { CreateGraphNodeName, EvaluateGraphNodeName } from '../nodes';
import type { AgentGraphRunner } from './agent-graph-runner.interface';
import { buildCreateGraph } from './create-graph';
import type { TrainingGraphDeps } from './create-graph';
import { buildEvaluateGraph } from './evaluate-graph';
import { LangGraphRunner } from './langgraph-runner';
import type { RunKind, RunState } from './run-state';
import { graphForKind } from './training-graphs';

/**
 * The runner for one job of a `kind` run: the kind's graph, built with this
 * job's context and compiled over `deps.checkpointer`, behind the
 * `AgentGraphRunner` port. Knows no LangGraph itself.
 */
export function trainingGraphRunner(kind: RunKind, deps: TrainingGraphDeps<string>): AgentGraphRunner<RunState> {
  return graphForKind(kind) === 'evaluate'
    ? new LangGraphRunner<RunState, EvaluateGraphNodeName | '__start__'>(buildEvaluateGraph(deps))
    : new LangGraphRunner<RunState, CreateGraphNodeName | '__start__'>(buildCreateGraph(deps));
}
