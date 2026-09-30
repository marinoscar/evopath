// =============================================================================
// The create graph (create and revise runs), wired on LangGraph
// =============================================================================
//
//   START -> prepare_context --create--> research -> plan -> guardrails -> critique -> route
//                            \--revise-----------------^  |                           |
//                                                      ^--|-- revise (round < max) ---|
//                                                         |   ship, exhausted, skipped -> finalize -> END
//                        budget spent on a revision ------+-----------------------------^
//
// ONE OF THE TWO FILES (with `evaluate-graph.ts`) THAT KNOWS LANGGRAPH, apart
// from the runner and the checkpoint saver. Nodes are plain functions over
// `RunState` and `NodeContext` (`nodes/*.ts`); this file adapts them to
// LangGraph nodes, owns the state channels (reducers), and wires the edges
// with the pure routes in `routes.ts`. Replacing LangGraph means replacing
// these two files and the runner, nothing else.
//
// The graph is built per job, with that job's `NodeContext` bound in, and
// compiled over the `PrismaCheckpointSaver`: a node's output is checkpointed
// before the next node starts (the runner invokes with `durability: 'sync'`),
// so a crash, deploy or abort loses at most the node that was running.
// =============================================================================

// First, so the telemetry pin runs before LangGraph is loaded.
import { disableFrameworkTelemetry } from '../disable-framework-telemetry';

import type { BaseCheckpointSaver, LangGraphRunnableConfig } from '@langchain/langgraph';
import { Annotation, END, START, StateGraph, interrupt, isGraphInterrupt } from '@langchain/langgraph';

import { CREATE_GRAPH_NODES, type CreateGraphNodeName } from '../nodes';
import type { GraphNode, NodeContext, NodeFn, NodeInterruptRequest } from './node-context';
import { routeAfterCritique, routeAfterPlan, routeAfterPrepare } from './routes';
import type { RunApproval, RunKind, RunOutcome, RunState } from './run-state';
import { DEFAULT_MAX_CRITIC_ROUNDS } from './run-state';

const last = <T>(fallback: () => T) => ({ reducer: (_prev: T, next: T) => next, default: fallback });

/**
 * The run state as LangGraph channels. Every field keeps the last value
 * written, except `verdicts` and `warnings` (appended) and `roundCounters`
 * (merged by key).
 */
export const RunStateAnnotation = Annotation.Root({
  runId: Annotation<string>(last(() => '')),
  userId: Annotation<string>(last(() => '')),
  kind: Annotation<RunKind>(last<RunKind>(() => 'create')),
  programId: Annotation<string | null>(last<string | null>(() => null)),
  input: Annotation<Record<string, unknown>>(last<Record<string, unknown>>(() => ({}))),
  stage: Annotation<string | null>(last<string | null>(() => null)),
  roundCounters: Annotation<Record<string, number>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  maxCriticRounds: Annotation<number>(last(() => DEFAULT_MAX_CRITIC_ROUNDS)),
  warnings: Annotation<string[]>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
  outcome: Annotation<RunOutcome | null>(last<RunOutcome | null>(() => null)),
  context: Annotation<unknown | null>(last<unknown | null>(() => null)),
  brief: Annotation<unknown | null>(last<unknown | null>(() => null)),
  draft: Annotation<unknown | null>(last<unknown | null>(() => null)),
  guardrailReport: Annotation<unknown | null>(last<unknown | null>(() => null)),
  verdicts: Annotation<unknown[]>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
  evaluation: Annotation<unknown | null>(last<unknown | null>(() => null)),
  changeSet: Annotation<unknown | null>(last<unknown | null>(() => null)),
  approval: Annotation<RunApproval | null>(last<RunApproval | null>(() => null)),
});

/** Observes nodes as they run (stage column, stage events, node spans). Must not throw. */
export interface GraphHooks {
  nodeStarted?(node: string, state: RunState): Promise<void> | void;
  /** `status` is `interrupted` when the node paused the run for a decision. */
  nodeFinished?(
    node: string,
    state: RunState,
    outcome: { status: 'ok' | 'error' | 'interrupted'; durationMs: number },
  ): Promise<void> | void;
}

export interface TrainingGraphDeps<Name extends string> {
  checkpointer: BaseCheckpointSaver;
  /** The job's node context, minus `interrupt` (bound per node invocation here). */
  context: Omit<NodeContext, 'interrupt'>;
  hooks?: GraphHooks;
  /** Replace node implementations (tests, the scripted-graph helper). */
  nodes?: Partial<Record<Name, NodeFn>>;
}

/** Adapts a plain node to a LangGraph node: binds the context, reports to the hooks, records the stage. */
export function adaptNode<Name extends string>(
  node: GraphNode,
  deps: TrainingGraphDeps<Name>,
): (state: RunState, config: LangGraphRunnableConfig) => Promise<Partial<RunState>> {
  const run = deps.nodes?.[node.name as Name] ?? node.run;

  return async (state, config) => {
    const ctx: NodeContext = {
      ...deps.context,
      interrupt: <T>(request: NodeInterruptRequest) => (config.interrupt ?? interrupt)(request) as T,
    };
    const started = Date.now();
    let status: 'ok' | 'error' | 'interrupted' = 'ok';

    await deps.hooks?.nodeStarted?.(node.name, state);

    try {
      const update = await run(state, ctx);
      return { ...update, stage: node.name };
    } catch (error) {
      status = isGraphInterrupt(error) ? 'interrupted' : 'error';
      throw error;
    } finally {
      await deps.hooks?.nodeFinished?.(node.name, state, { status, durationMs: Date.now() - started });
    }
  };
}

/** Builds and compiles the create graph over `deps.checkpointer`. */
export function buildCreateGraph(deps: TrainingGraphDeps<CreateGraphNodeName>) {
  disableFrameworkTelemetry();

  const n = (name: CreateGraphNodeName) => adaptNode(CREATE_GRAPH_NODES[name], deps);

  return new StateGraph(RunStateAnnotation)
    .addNode('prepare_context', n('prepare_context'))
    .addNode('research', n('research'))
    .addNode('plan', n('plan'))
    .addNode('guardrails', n('guardrails'))
    .addNode('critique', n('critique'))
    .addNode('finalize', n('finalize'))
    .addEdge(START, 'prepare_context')
    .addConditionalEdges('prepare_context', routeAfterPrepare, ['research', 'plan'])
    .addEdge('research', 'plan')
    .addConditionalEdges('plan', routeAfterPlan, ['guardrails', 'finalize'])
    .addEdge('guardrails', 'critique')
    .addConditionalEdges('critique', routeAfterCritique, ['plan', 'finalize'])
    .addEdge('finalize', END)
    .compile({ checkpointer: deps.checkpointer });
}

export type CreateGraph = ReturnType<typeof buildCreateGraph>;
