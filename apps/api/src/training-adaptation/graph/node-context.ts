import type { TrainingAgentRole } from '../../common/schemas/settings.schema';
import type { FrozenRoleModel } from '../../training-agents/graph/node-context';
import type { AgentCaller } from '../../training-agents/runtime/agent-caller';
import type { RunBudget } from '../../training-agents/runtime/run-budget';
import type { AdaptationContextPort } from '../context/adaptation-context.builder';

// =============================================================================
// What an adaptation node gets from the runtime
// =============================================================================
//
// A node is a plain async function `(state, ctx) => Partial<AdaptRunState>`
// with no LangGraph import. `agent` is the kit's `AgentCaller` (the one door
// to a model: `AiService.forUser`, the run's abort signal, the frozen role
// models, the token budget, usage attribution); `emit` appends a run event
// and never throws; `contextPort` is the context builder (a fake in tests).
// =============================================================================

export interface AdaptationNodeContext {
  runId: string;
  userId: string;
  jobId: string;
  adaptationId: string;
  /** Aborts on cancel, deadline or shutdown. */
  signal: AbortSignal;
  /** The planner and critic models frozen at create. */
  roleModels: Partial<Record<TrainingAgentRole, FrozenRoleModel>>;
  agent: AgentCaller;
  budget: RunBudget;
  /** Appends a run event (validated against its registered schema). Never throws. */
  emit(type: string, data?: Record<string, unknown>): Promise<void>;
  now(): Date;
  contextPort: AdaptationContextPort;
}
