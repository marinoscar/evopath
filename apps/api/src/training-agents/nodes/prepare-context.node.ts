import { buildTrainingRunContext } from '../context/build-planner-context';
import { reusableBrief } from '../finalize/plan-evidence';
import type { TrainingRunContext } from '../context/planner-context.contract';
import type { GraphNode, NodeFn } from '../graph/node-context';
import type { RunState } from '../graph/run-state';
import { TrainingRunFailedError } from '../runtime/training-run-errors';

// =============================================================================
// Node `prepare_context`: the minimised context for every agent of the run
// =============================================================================
//
// Reads through `ctx.ports.plannerContext` (queries scoped by the run's
// user), builds the `TrainingRunContext` with the pure builder and returns it
// as `state.context`: `context.researcher` is what the research node sends,
// `context.planner` what the planner sends, `context.mode.conservative` the
// run's conservative flag; the rest is server-only (library, gym, history).
// No model call, no event beyond the stage events.
//
// A `revise` run skips research (its graph edge goes straight to `plan`) and
// reuses the program's stored verified brief when it is still fit
// (`reusableBrief`, through `ctx.ports.programs`): the result then carries
// `brief` too.
// =============================================================================

export const CONTEXT_PORT_MISSING = 'TRAINING_CONTEXT_UNAVAILABLE';

export const runPrepareContext: NodeFn = async (state, ctx) => {
  const port = ctx.ports?.plannerContext;

  if (!port) {
    throw new TrainingRunFailedError(CONTEXT_PORT_MISSING, 'The training context could not be loaded.');
  }

  const source = await port.load(ctx.userId, state.input, ctx.now());
  const context: TrainingRunContext = buildTrainingRunContext(source);

  // A revise run does not research: it reuses the plan's stored brief when
  // the instruction leaves the goal and limitations alone and the brief is
  // younger than 30 days; otherwise the planner works without evidence.
  if (context.kind === 'revise' && context.revise && ctx.ports?.programs) {
    const stored = await ctx.ports.programs.recentAiEvidence(ctx.userId, context.revise.programId);
    const brief = reusableBrief(stored, context.planner.request.instruction, ctx.now());
    if (brief) return { context, brief };
  }

  return { context };
};

/** The run's context, narrowed; throws when `prepare_context` has not produced one. */
export function runContextOf(state: Pick<RunState, 'context'>): TrainingRunContext {
  const context = state.context as Partial<TrainingRunContext> | null;

  if (!context || context.version !== 1 || !context.planner || !context.library) {
    throw new TrainingRunFailedError(CONTEXT_PORT_MISSING, 'The training context is missing.');
  }

  return context as TrainingRunContext;
}

/** Builds the minimised per-role context (the context builder). */
export const prepareContextNode: GraphNode = { name: 'prepare_context', run: runPrepareContext, implemented: true };
