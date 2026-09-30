/**
 * The port every training-agent graph runs behind.
 *
 * `LangGraphRunner` implements it over a compiled LangGraph graph; if
 * LangGraph ever has to go, a hand-rolled `SequentialRunner` implements the
 * same port over the same node functions, state type and checkpoint tables,
 * so nothing above this interface changes.
 */
export interface AgentGraphRunner<State> {
  run(args: AgentGraphRunArgs<State>): Promise<AgentGraphRunResult<State>>;
}

export interface AgentGraphRunArgs<State> {
  /** The checkpoint thread: the training run id. */
  threadId: string;
  /** First start only: the initial state. */
  input?: Partial<State>;
  /** Resuming an interrupt: the decision the interrupt asked for. */
  resume?: unknown;
  /** Cancel and deadline. An abort rejects the run at the last checkpoint. */
  signal: AbortSignal;
}

/** A pending interrupt: the run is paused until resumed with a decision. */
export interface AgentGraphInterrupt {
  kind: string;
  payload: unknown;
}

export interface AgentGraphRunResult<State> {
  /** The state at the last checkpoint written by this run. */
  state: State;
  /** Set when the run paused for a decision; `null` when it reached the end. */
  interrupt: AgentGraphInterrupt | null;
}
