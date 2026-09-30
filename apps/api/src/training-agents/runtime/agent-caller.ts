import type { z } from 'zod';

import { AiError } from '../../ai/core/ai-error';
import type { AiDefinedTool } from '../../ai/core/tools';
import type {
  AiHostedTool,
  AiInputItem,
  AiResponse,
  AiTool,
} from '../../ai/core/types/responses.types';
import type { AiToolLoopResult, AiToolStep } from '../../ai/runtime/ai-runtime.types';
import type { AiUserClient } from '../../ai/runtime/ai.service';
import type { RateLimitError } from '../../jobs/rate-limit.error';
import type { TrainingAgentRole } from '../../common/schemas/settings.schema';
import type { FrozenRoleModel } from '../graph/node-context';
import type { RunBudget, UsageTotals } from './run-budget';

// =============================================================================
// AgentCaller: the one door from a node to a model
// =============================================================================
//
// Every model call from every node goes through here, and nothing else in
// `training-agents/` touches `AiService`. Per call it:
//
//   1. refuses to start once the run's signal has aborted (cancel, deadline,
//      shutdown);
//   2. `budget.assertAvailable(role)`;
//   3. builds the request from the role's FROZEN model: `provider`, `model`,
//      `reasoning.effort` (when not null), `metadata` `{ agent, node, round }`
//      (opaque attribution, no personal data; only the OpenAI Responses
//      adapter forwards it, so nothing may depend on it for correctness), and
//      `maxOutputTokens` clamped to `min(model max, caller max, remaining)`;
//   4. calls `AiService.forUser(userId, { jobId })` with the run's signal, so
//      keys, the kill switch, capability checks, limits and usage rows stay
//      the gateway's;
//   5. charges the usage to the budget (by role and by node) and reports it
//      (`onUsage`: the `agent.usage` event and `training_plan_runs.usage`);
//   6. throws `AgentOutputTruncated` on `finishReason: 'length'`, so the node
//      can retry more compactly;
//   7. maps a provider throttle (`AI_RATE_LIMITED`) to `RunDeferredError`;
//      every other error propagates as it is (the handler maps terminal AI
//      codes, the budget and the rest).
//
// PROMPT TEXT, INSTRUCTIONS AND MODEL OUTPUT ARE NEVER LOGGED, TRACED OR PUT
// IN AN EVENT. What leaves this class is identifiers and counts.
// =============================================================================

/** What `onUsage` receives after each provider round-trip. Identifiers and counts only. */
export interface AgentUsageReport {
  role: TrainingAgentRole;
  node: string;
  provider: string;
  model: string;
  round?: number;
  /** 1-based round-trip of a tool loop. */
  step?: number;
  usage: UsageTotals;
  latencyMs: number;
}

export interface AgentCallBase {
  role: TrainingAgentRole;
  /** The node making the call (snake case, e.g. `plan`). */
  node: string;
  /** The loop round, when the node runs in one. */
  round?: number;
  instructions: string;
  input: string | AiInputItem[];
  /** Upper bound on output tokens; clamped further by the model and the budget. */
  maxOutputTokens?: number;
}

export interface AgentStructuredCall<S extends z.ZodTypeAny> extends AgentCallBase {
  schema: S;
  schemaName: string;
  /** Function or hosted tools the model may use in this single round-trip. */
  tools?: AiTool[];
  /** Provider-executed tools (`{ type: 'web_search' }` for the researcher). */
  hostedTools?: AiHostedTool[];
}

export interface AgentToolsCall extends AgentCallBase {
  tools: AiDefinedTool[];
  maxSteps: number;
  /** Observes each round-trip after it was charged. A throw aborts the loop. */
  onStep?: (step: AiToolStep) => void;
}

/** The model stopped because it hit `maxOutputTokens`. The node may retry compactly. */
export class AgentOutputTruncated extends Error {
  readonly code = 'TRAINING_OUTPUT_TRUNCATED';

  constructor(
    readonly role: TrainingAgentRole,
    readonly node: string,
    readonly maxOutputTokens: number | undefined
  ) {
    super(`The ${role} output was cut off at its token limit in node ${node}.`);
    this.name = 'AgentOutputTruncated';
  }
}

/** A provider throttle: the run goes back to the queue and resumes from its checkpoint. */
export class RunDeferredError extends Error {
  readonly code = 'AI_RATE_LIMITED';

  constructor(readonly aiError: AiError) {
    super(aiError.message);
    this.name = 'RunDeferredError';
  }

  get retryAfterMs(): number | undefined {
    return this.aiError.retryAfterMs;
  }

  /** The queue's rate-limit signal: `throw err.toRateLimitError() ?? err`. */
  toRateLimitError(): RateLimitError | null {
    return this.aiError.toRateLimitError();
  }
}

/**
 * A role the run did not freeze a model for was asked for: a terminal
 * `AI_INVALID_REQUEST`. (An `AiError`; it cannot be subclassed, its
 * constructor pins the prototype.)
 */
export function roleNotFrozen(role: TrainingAgentRole): AiError {
  return new AiError('AI_INVALID_REQUEST', `This run has no model for the ${role} agent.`, {
    details: { role },
  });
}

export interface AgentCallerDeps {
  /** `AiService.forUser(userId, { jobId })`. */
  ai: AiUserClient;
  signal: AbortSignal;
  roleModels: Partial<Record<TrainingAgentRole, FrozenRoleModel>>;
  budget: RunBudget;
  /** Called after every charged round-trip. Must not throw (the caller logs and moves on). */
  onUsage?: (report: AgentUsageReport) => Promise<void> | void;
  /** Milliseconds clock for latency. */
  clock?: () => number;
}

export class AgentCaller {
  private readonly clock: () => number;

  constructor(private readonly deps: AgentCallerDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  /** One structured round-trip; `parsed` is validated against `schema`. */
  async structured<S extends z.ZodTypeAny>(
    call: AgentStructuredCall<S>
  ): Promise<{ parsed: z.output<S>; response: AiResponse<z.output<S>> }> {
    const model = this.prepare(call);
    const maxOutputTokens = this.clamp(model, call.maxOutputTokens);
    const tools = [...(call.tools ?? []), ...(call.hostedTools ?? [])];
    const started = this.clock();

    const response = await this.guard(() =>
      this.deps.ai.respondStructured(
        {
          ...this.base(call, model, maxOutputTokens),
          ...(tools.length > 0 ? { tools } : {}),
          schema: call.schema,
          schemaName: call.schemaName,
        },
        { signal: this.deps.signal }
      )
    );

    await this.charge(call, model, response, this.clock() - started);

    if (response.finishReason === 'length') {
      throw new AgentOutputTruncated(call.role, call.node, maxOutputTokens);
    }

    return { parsed: response.parsed, response };
  }

  /** The function-calling loop (`runTools`); every round-trip is charged as it happens. */
  async withTools(call: AgentToolsCall): Promise<AiToolLoopResult> {
    const model = this.prepare(call);
    const maxOutputTokens = this.clamp(model, call.maxOutputTokens);
    let stepStarted = this.clock();
    const charges: Promise<void>[] = [];

    let result: AiToolLoopResult;

    try {
      result = await this.guard(() =>
        this.deps.ai.runTools(
          {
            ...this.base(call, model, maxOutputTokens),
            tools: call.tools,
            maxSteps: call.maxSteps,
            onStep: (step) => {
              const latencyMs = this.clock() - stepStarted;
              stepStarted = this.clock();
              charges.push(this.charge(call, model, step.response, latencyMs, step.step));
              // A spent budget stops the loop before its next round-trip.
              if (step.calls.length > 0) this.deps.budget.assertAvailable(call.role);
              call.onStep?.(step);
            },
          },
          { signal: this.deps.signal }
        )
      );
    } finally {
      await Promise.allSettled(charges);
    }

    if (result.final.finishReason === 'length') {
      throw new AgentOutputTruncated(call.role, call.node, maxOutputTokens);
    }

    return result;
  }

  private prepare(call: AgentCallBase): FrozenRoleModel {
    if (this.deps.signal.aborted) {
      throw this.deps.signal.reason instanceof Error
        ? this.deps.signal.reason
        : new Error('Training run aborted');
    }

    this.deps.budget.assertAvailable(call.role);

    const model = this.deps.roleModels[call.role];
    if (!model) throw roleNotFrozen(call.role);

    return model;
  }

  /** `min(model max, caller max, remaining budget)`, or `undefined` when nothing bounds it. */
  private clamp(model: FrozenRoleModel, requested: number | undefined): number | undefined {
    const bounds = [model.maxOutputTokens, requested, this.deps.budget.remaining()].filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value)
    );

    return bounds.length > 0 ? Math.max(1, Math.floor(Math.min(...bounds))) : undefined;
  }

  private base(call: AgentCallBase, model: FrozenRoleModel, maxOutputTokens: number | undefined) {
    const metadata: Record<string, string> = { agent: call.role, node: call.node };
    if (call.round !== undefined) metadata.round = String(call.round);

    return {
      provider: model.provider,
      model: model.modelId,
      instructions: call.instructions,
      input: call.input,
      ...(model.effort ? { reasoning: { effort: model.effort } } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      metadata,
    };
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AiError && err.code === 'AI_RATE_LIMITED') {
        throw new RunDeferredError(err);
      }

      throw err;
    }
  }

  private async charge(
    call: AgentCallBase,
    model: FrozenRoleModel,
    response: AiResponse,
    latencyMs: number,
    step?: number
  ): Promise<void> {
    const usage = this.deps.budget.charge(response.usage, { role: call.role, node: call.node });

    await this.deps.onUsage?.({
      role: call.role,
      node: call.node,
      provider: model.provider,
      model: model.modelId,
      ...(call.round !== undefined ? { round: call.round } : {}),
      ...(step !== undefined ? { step } : {}),
      usage,
      latencyMs: Math.max(0, Math.round(latencyMs)),
    });
  }
}
