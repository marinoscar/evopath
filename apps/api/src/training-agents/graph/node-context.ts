import type { TaskReasoningEffort, TrainingAgentRole } from '../../common/schemas/settings.schema';
import type { AiKeySource } from '../../ai/keys/ai-key-resolver.service';
import type {
  ApplyChangeInput,
  ApplyChangeResult,
  CreateWithTreeInput,
  CreateWithTreeResult,
} from '../../programs/programs.service';
import type { PlannerContextPort } from '../context/planner-context.loader';
import type { AgentCaller } from '../runtime/agent-caller';
import type { ContextBudget } from '../runtime/context-budget';
import type { RunBudget } from '../runtime/run-budget';
import type { RunEventType } from '../runtime/run-events.registry';
import type { RunKind, RunState, RunStateUpdate } from './run-state';

// =============================================================================
// NodeContext: everything a node gets from the runtime
// =============================================================================
//
// A node is a plain async function `(state, ctx) => Partial<RunState>` in
// `nodes/*.ts`, with no LangGraph import. Everything it needs from the
// runtime arrives here: the abort signal, the frozen models, progress events,
// the one door to a model (`agent`), the token budget and the context
// budgeter. `interrupt` pauses the run for a user decision; under LangGraph
// it is `interrupt()`, under a hand-rolled runner a thrown signal.
// =============================================================================

/** A role's model, frozen when the run was created. Identifiers only, never a key. */
export interface FrozenRoleModel {
  provider: string;
  modelId: string;
  /** The effort sent (`reasoning.effort`); `null` sends none. */
  effort: TaskReasoningEffort | null;
  /** Whose key pays. Not a key. */
  keySource: AiKeySource;
  /** From the catalog at freeze time, when known: the context budgeter reads it. */
  contextWindow?: number;
  /** From the catalog at freeze time, when known: `AgentCaller` clamps to it. */
  maxOutputTokens?: number;
}

/** What an interrupt asks the user. `kind` names the question (`approval`). */
export interface NodeInterruptRequest {
  kind: string;
  /** Identifiers and counts only; shown to the owner, stored in the checkpoint. */
  payload?: Record<string, unknown>;
}

/**
 * The read (and later write) services a node may reach, bound per job by the
 * handler. Each agent story adds the port its node needs; a node whose port
 * is missing fails the run (a wiring error, not a user error).
 */
export interface NodePorts {
  /** `prepare_context`: the context builder's reads (`context/planner-context.loader.ts`). */
  plannerContext?: PlannerContextPort;
  /** `finalize` writes through the programs chokepoint; `prepare_context` reads a revise run's stored brief. */
  programs?: ProgramsPort;
  /** `finalize` raises `training.plan_ready` after the write committed. */
  notifications?: NotificationsPort;
}

/** A program version a run wrote. */
export interface RunProgramVersion {
  programId: string;
  programName: string;
  versionNumber: number;
  changeLogId: string | null;
}

/**
 * The programs chokepoint as the nodes see it (`runtime/training-programs.port.ts`
 * binds it to `ProgramsService`). Writes go through `createWithTree` and
 * `applyChange` only.
 */
export interface ProgramsPort {
  createWithTree(input: CreateWithTreeInput): Promise<CreateWithTreeResult>;
  applyChange(input: ApplyChangeInput): Promise<ApplyChangeResult>;
  /** The version this run already wrote, if any: a resumed `finalize` never writes twice. */
  findRunVersion(userId: string, runId: string): Promise<RunProgramVersion | null>;
  /** Stored evidence of the caller's program's AI-made versions, newest first (at most a few), for brief reuse. */
  recentAiEvidence(userId: string, programId: string): Promise<unknown[]>;
}

/** `NotificationsService.notify`: detached, never rejects. */
export interface NotificationsPort {
  notify(eventKey: string, userId: string, data: unknown): Promise<void> | void;
}

export interface NodeContext {
  runId: string;
  userId: string;
  jobId: string;
  kind: RunKind;
  /** Aborts on cancel, deadline or shutdown. Pass it to anything that waits. */
  signal: AbortSignal;
  /** The roles this run froze a model for. A role the run's kind does not use is absent. */
  roleModels: Partial<Record<TrainingAgentRole, FrozenRoleModel>>;
  /**
   * Appends a progress event. Never throws: a failed or invalid event is
   * logged and dropped, so emitting can never fail a node. `data` is checked
   * against the type's registered schema and must carry no free text.
   */
  emit(type: RunEventType, data?: Record<string, unknown>): Promise<void>;
  /** The only way a node calls a model. */
  agent: AgentCaller;
  budget: RunBudget;
  contextBudget: ContextBudget;
  now(): Date;
  /** Services the nodes read through (see `NodePorts`). */
  ports?: NodePorts;
  /**
   * Pauses the run until the owner decides, and returns the decision on
   * resume. Call it at most once per node, as the node's first side effect
   * after any idempotent reads: on resume the node runs again from the top.
   */
  interrupt<T = unknown>(request: NodeInterruptRequest): T;
}

export type NodeFn = (state: RunState, ctx: NodeContext) => Promise<RunStateUpdate>;

/** One node, as a graph wires it. */
export interface GraphNode {
  name: string;
  run: NodeFn;
  /**
   * `false` while the node is a stub that echoes canned state. The story that
   * implements the node flips it; a graph is runnable for users only when its
   * readiness constant (`training-graphs.ts`) says so.
   */
  implemented: boolean;
}
