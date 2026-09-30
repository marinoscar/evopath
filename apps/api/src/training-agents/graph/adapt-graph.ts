// =============================================================================
// The quick adaptation graph (E6.1), wired on LangGraph
// =============================================================================
//
//   START -> context --blocked--> END
//                    \-> adapt -> guardrails --first pass--> critic --accept--> finalize -> END
//                                            \--revision----------------------^   |
//                          ^--------------------- revise (revisions left) --------+
//
// The third file (with `create-graph.ts` and `evaluate-graph.ts`) that knows
// LangGraph; CLAUDE.md AI rule 6 keeps it under `training-agents/`. It owns
// the state channels and the edges only. The node functions and the pure
// route functions come from the feature (`training-adaptation/graph/`) as an
// `AdaptGraphDefinition`, so this kit file imports nothing from it and the
// feature never imports LangGraph.
//
// Compiled per job over `deps.checkpointer` (the `PrismaCheckpointSaver`, or
// a `MemorySaver` in tests): every node's output is checkpointed before the
// next node starts (`durability: 'sync'` in the runner), so a deferred job
// (a provider throttle) continues from the last completed node.
// =============================================================================

// First, so the telemetry pin runs before LangGraph is loaded.
import { disableFrameworkTelemetry } from '../disable-framework-telemetry';

import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

import type { AgentGraphRunner } from './agent-graph-runner.interface';
import type { AdaptGraphNodeName, AdaptRunOutcome, AdaptRunState, AdaptRunStateUpdate } from './adapt-run-state';
import { LangGraphRunner } from './langgraph-runner';

/** The checkpointer type, re-exported so the feature can name it without importing LangGraph. */
export type AdaptCheckpointer = BaseCheckpointSaver;

const last = <T>(fallback: () => T) => ({ reducer: (_prev: T, next: T) => next, default: fallback });

/** The adaptation state as LangGraph channels: last value wins, except `warnings` and `critiques` (appended) and `roundCounters` (merged). */
export const AdaptRunStateAnnotation = Annotation.Root({
  runId: Annotation<string>(last(() => '')),
  userId: Annotation<string>(last(() => '')),
  adaptationId: Annotation<string>(last(() => '')),
  request: Annotation<Record<string, unknown>>(last<Record<string, unknown>>(() => ({}))),
  stage: Annotation<string | null>(last<string | null>(() => null)),
  roundCounters: Annotation<Record<string, number>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  maxRevisions: Annotation<number>(last(() => 1)),
  warnings: Annotation<string[]>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
  outcome: Annotation<AdaptRunOutcome | null>(last<AdaptRunOutcome | null>(() => null)),
  adaptationContext: Annotation<unknown | null>(last<unknown | null>(() => null)),
  draft: Annotation<unknown | null>(last<unknown | null>(() => null)),
  proposal: Annotation<unknown | null>(last<unknown | null>(() => null)),
  guardrailReport: Annotation<unknown | null>(last<unknown | null>(() => null)),
  critiques: Annotation<unknown[]>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
  result: Annotation<unknown | null>(last<unknown | null>(() => null)),
});

/** A node: a plain async function over the state and the feature's own context. */
export type AdaptNodeFn<Ctx> = (state: AdaptRunState, ctx: Ctx) => Promise<AdaptRunStateUpdate>;

/** The route answer that ends the graph. */
export const ADAPT_ROUTE_END = 'end';

/** What the feature supplies: every node and the three conditional edges (pure functions). */
export interface AdaptGraphDefinition<Ctx> {
  nodes: Readonly<Record<AdaptGraphNodeName, AdaptNodeFn<Ctx>>>;
  routes: {
    afterContext(state: AdaptRunState): 'adapt' | typeof ADAPT_ROUTE_END;
    afterGuardrails(state: AdaptRunState): 'critic' | 'finalize';
    afterCritic(state: AdaptRunState): 'adapt' | 'finalize';
  };
}

/** Observes nodes as they run (stage column, stage events, spans). Must not throw. */
export interface AdaptGraphHooks {
  nodeStarted?(node: AdaptGraphNodeName, state: AdaptRunState): Promise<void> | void;
  nodeFinished?(
    node: AdaptGraphNodeName,
    state: AdaptRunState,
    outcome: { status: 'ok' | 'error'; durationMs: number },
  ): Promise<void> | void;
}

export interface AdaptGraphDeps<Ctx> {
  checkpointer: BaseCheckpointSaver;
  /** The job's node context, bound into every node. */
  context: Ctx;
  definition: AdaptGraphDefinition<Ctx>;
  hooks?: AdaptGraphHooks;
  /** Replace node implementations (tests). */
  nodes?: Partial<Record<AdaptGraphNodeName, AdaptNodeFn<Ctx>>>;
}

function adaptNode<Ctx>(name: AdaptGraphNodeName, deps: AdaptGraphDeps<Ctx>) {
  const run = deps.nodes?.[name] ?? deps.definition.nodes[name];

  return async (state: AdaptRunState): Promise<AdaptRunStateUpdate> => {
    const started = Date.now();
    let status: 'ok' | 'error' = 'ok';

    await deps.hooks?.nodeStarted?.(name, state);

    try {
      const update = await run(state, deps.context);
      return { ...update, stage: name };
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      await deps.hooks?.nodeFinished?.(name, state, { status, durationMs: Date.now() - started });
    }
  };
}

/** Builds and compiles the adaptation graph over `deps.checkpointer`. */
export function buildAdaptGraph<Ctx>(deps: AdaptGraphDeps<Ctx>) {
  disableFrameworkTelemetry();

  const { routes } = deps.definition;

  return new StateGraph(AdaptRunStateAnnotation)
    .addNode('context', adaptNode('context', deps))
    .addNode('adapt', adaptNode('adapt', deps))
    .addNode('guardrails', adaptNode('guardrails', deps))
    .addNode('critic', adaptNode('critic', deps))
    .addNode('finalize', adaptNode('finalize', deps))
    .addEdge(START, 'context')
    .addConditionalEdges('context', (state) => routes.afterContext(state as AdaptRunState), {
      adapt: 'adapt',
      [ADAPT_ROUTE_END]: END,
    })
    .addEdge('adapt', 'guardrails')
    .addConditionalEdges('guardrails', (state) => routes.afterGuardrails(state as AdaptRunState), ['critic', 'finalize'])
    .addConditionalEdges('critic', (state) => routes.afterCritic(state as AdaptRunState), ['adapt', 'finalize'])
    .addEdge('finalize', END)
    .compile({ checkpointer: deps.checkpointer });
}

/** The runner for one job of an adaptation run, behind the `AgentGraphRunner` port. */
export function adaptGraphRunner<Ctx>(deps: AdaptGraphDeps<Ctx>): AgentGraphRunner<AdaptRunState> {
  return new LangGraphRunner<AdaptRunState, AdaptGraphNodeName | '__start__'>(buildAdaptGraph(deps));
}

export type AdaptGraph = ReturnType<typeof buildAdaptGraph>;
