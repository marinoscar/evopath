// First, so the telemetry pin runs before LangGraph is loaded.
import { disableFrameworkTelemetry } from '../disable-framework-telemetry';

import { Command, INTERRUPT, isInterrupted } from '@langchain/langgraph';

import type {
  AgentGraphInterrupt,
  AgentGraphRunArgs,
  AgentGraphRunResult,
  AgentGraphRunner,
} from './agent-graph-runner.interface';

/**
 * The slice of a compiled LangGraph graph the runner uses. A compiled
 * `StateGraph` (with a checkpointer) satisfies it structurally.
 */
export interface InvokableGraph<State, Nodes extends string = string> {
  invoke(
    input: Partial<State> | Command<unknown, Partial<State>, Nodes> | null,
    options: { configurable: { thread_id: string }; signal: AbortSignal; durability: 'sync' },
  ): Promise<unknown>;
}

/**
 * `AgentGraphRunner` over a compiled LangGraph graph (`create-graph.ts`,
 * `evaluate-graph.ts`).
 *
 * - First start: `invoke(input)`.
 * - Resume an interrupt: `invoke(new Command({ resume }))`.
 * - Neither (a crash or deploy ended the previous job mid-run): `invoke(null)`,
 *   which continues from the thread's last checkpoint.
 *
 * The thread id is the training run id; the graph's checkpointer (the
 * `PrismaCheckpointSaver`) persists after every node, so a fresh runner over
 * a fresh graph and saver instance continues where the last one stopped.
 */
export class LangGraphRunner<State extends object, Nodes extends string = string>
  implements AgentGraphRunner<State>
{
  constructor(private readonly graph: InvokableGraph<State, Nodes>) {}

  async run(args: AgentGraphRunArgs<State>): Promise<AgentGraphRunResult<State>> {
    disableFrameworkTelemetry();

    const input =
      args.resume !== undefined
        ? new Command<unknown, Partial<State>, Nodes>({ resume: args.resume })
        : (args.input ?? null);

    const result = await this.graph.invoke(input, {
      configurable: { thread_id: args.threadId },
      signal: args.signal,
      durability: 'sync',
    });

    return toRunResult<State>(result);
  }
}

/** Splits an `invoke` result into the state and the first pending interrupt. */
export function toRunResult<State>(result: unknown): AgentGraphRunResult<State> {
  if (!isInterrupted(result)) {
    return { state: result as State, interrupt: null };
  }

  const { [INTERRUPT]: interrupts, ...state } = result as Record<string, unknown> & {
    [INTERRUPT]: Array<{ value?: unknown }>;
  };

  return { state: state as State, interrupt: toInterrupt(interrupts[0]?.value) };
}

function toInterrupt(value: unknown): AgentGraphInterrupt {
  const kind =
    value !== null && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string'
      ? (value as { kind: string }).kind
      : 'interrupt';

  return { kind, payload: value };
}
