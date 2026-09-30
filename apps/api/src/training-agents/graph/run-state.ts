import type { TrainingRunKind } from '../models/token-estimate';

// =============================================================================
// RunState: the state every training graph carries, framework-agnostic
// =============================================================================
//
// No LangGraph import here: nodes (`nodes/*.ts`) read and return this type,
// and only `graph/create-graph.ts` and `graph/evaluate-graph.ts` turn it into
// LangGraph channels (`run-state.channels.ts` next to them owns the reducers).
//
// STATE HOLDS NODE OUTPUTS ONLY. Never a provider message, never a response
// id, never reasoning items: a checkpoint of this state is serialised to
// `training_run_checkpoints`, so anything here is stored. The provider's own
// continuation state (the `AI_PROVIDER_STATE` symbol) therefore never reaches
// a checkpoint.
//
// THE SEAM. The runtime kit owns `runId` through `outcome`. The agent fields
// below are typed `unknown` here and narrowed by the story that owns each
// agent: `context` (the context builder), `brief` (the researcher), `draft`,
// `guardrailReport` and `verdicts` (planner, guardrails, critic), and
// `evaluation`, `changeSet` and `approval` (the evaluator). Such a story
// replaces the `unknown` with its contract type in `RunStateSeams` and
// nothing else in the kit changes.
// =============================================================================

export type RunKind = TrainingRunKind;

/** How a graph ended, set by its last node. `null` while it runs. */
export interface RunOutcome {
  /**
   * `completed`: the graph produced its result. `rejected`: it finished
   * without a result it may ship (the code says why). `safety_stop`: a node
   * stopped the run for safety. `no_change`: an evaluation found nothing to
   * change.
   */
  status: 'completed' | 'rejected' | 'safety_stop' | 'no_change';
  /** A `TRAINING_*` reason for `rejected` and `safety_stop`. */
  code?: string;
  /** The program the run wrote, when it wrote one. */
  programId?: string | null;
  versionNumber?: number | null;
  changeLogId?: string | null;
  /** A short machine verdict (`approved`, `exhausted`, ...). No free text. */
  verdict?: string | null;
}

/** The agent outputs, typed by the stories that own them. */
export interface RunStateSeams {
  /** The minimised per-role context (context builder). */
  context: unknown | null;
  /** The researcher's evidence brief. */
  brief: unknown | null;
  /** The planner's latest draft. */
  draft: unknown | null;
  /** The guardrail report on the latest draft. */
  guardrailReport: unknown | null;
  /** Every critic verdict, oldest first (appended). */
  verdicts: unknown[];
  /** The evaluator's assessment. */
  evaluation: unknown | null;
  /** The typed plan changes an evaluation proposes. */
  changeSet: unknown | null;
  /** The user's decision at an approval interrupt. */
  approval: RunApproval | null;
}

/** What `POST /api/ai/training/runs/:runId/decision` records and a resume hands the graph. */
export interface RunApproval {
  decision: 'approve' | 'reject';
  /** Optional user note; never put in an event, a span or a log. */
  note?: string;
}

export interface RunState extends RunStateSeams {
  runId: string;
  userId: string;
  kind: RunKind;
  programId: string | null;
  /** The validated request the run was started with (`training_plan_runs.input.request`). */
  input: Record<string, unknown>;
  /** The node running now, for the UI. */
  stage: string | null;
  /** Loop counters by name (`critique` is the critic round count). Merged, never replaced. */
  roundCounters: Record<string, number>;
  /** Critic rounds allowed before the plan ships as it is (frozen at run start). */
  maxCriticRounds: number;
  /** Machine warning codes collected along the way (appended). No free text. */
  warnings: string[];
  outcome: RunOutcome | null;
}

/** A node's return value: the fields it changed. */
export type RunStateUpdate = Partial<RunState>;

/** Critic rounds when neither the run nor the user says. */
export const DEFAULT_MAX_CRITIC_ROUNDS = 2;

/** The state a first start begins from. */
export function initialRunState(init: {
  runId: string;
  userId: string;
  kind: RunKind;
  programId?: string | null;
  input?: Record<string, unknown>;
  maxCriticRounds?: number;
}): RunState {
  return {
    runId: init.runId,
    userId: init.userId,
    kind: init.kind,
    programId: init.programId ?? null,
    input: init.input ?? {},
    stage: null,
    roundCounters: {},
    maxCriticRounds: init.maxCriticRounds ?? DEFAULT_MAX_CRITIC_ROUNDS,
    warnings: [],
    outcome: null,
    context: null,
    brief: null,
    draft: null,
    guardrailReport: null,
    verdicts: [],
    evaluation: null,
    changeSet: null,
    approval: null,
  };
}
