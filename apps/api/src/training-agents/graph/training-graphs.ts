import type { RunKind } from './run-state';

// =============================================================================
// Which graph runs each kind of run, and whether users may start it yet
// =============================================================================
//
// `TRAINING_GRAPH_READY` is a CODE CONSTANT per graph, not a setting. While a
// graph's nodes are stubs, `POST /api/ai/training/runs` for a kind that runs
// it answers `501` with `details.reason: 'TRAINING_NOT_IMPLEMENTED'`. The
// story that implements the last node of a graph flips its entry to `true`
// in the same commit. (The queue handler does not read it: a run row that
// exists is executed, which is how the stub graph is exercised in tests.)
// =============================================================================

export type TrainingGraphName = 'create' | 'evaluate';

export const TRAINING_GRAPH_READY: Record<TrainingGraphName, boolean> = {
  /** `create` and `revise` runs. Flipped when planner, critic and guardrails ship. */
  create: true,
  /** `evaluate` runs. Flipped when the evaluator ships. */
  evaluate: true,
};

export function graphForKind(kind: RunKind): TrainingGraphName {
  return kind === 'evaluate' ? 'evaluate' : 'create';
}

export function isGraphReady(kind: RunKind): boolean {
  return TRAINING_GRAPH_READY[graphForKind(kind)];
}
