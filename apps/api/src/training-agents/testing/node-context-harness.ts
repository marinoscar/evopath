import { randomUUID } from 'node:crypto';

import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { MemorySaver } from '@langchain/langgraph-checkpoint';

import type { AiResponseRequest } from '../../ai/core/types/responses.types';
import type { AiCallContext } from '../../ai/core/provider-adapter.interface';
import {
  type AiRuntimeHarnessOptions,
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_PROVIDER,
  HARNESS_USER,
} from '../../ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES, type FakeAiScriptedResponse } from '../../ai/testing/fake-ai-provider';
import { TRAINING_AGENT_ROLES, type TrainingAgentRole } from '../../common/schemas/settings.schema';
import type { AgentGraphRunResult } from '../graph/agent-graph-runner.interface';
import type { GraphHooks } from '../graph/create-graph';
import { trainingGraphRunner } from '../graph/graph-factory';
import type { FrozenRoleModel, NodeContext, NodeFn, NodeInterruptRequest } from '../graph/node-context';
import { initialRunState, type RunKind, type RunState } from '../graph/run-state';
import { AgentCaller, type AgentUsageReport } from '../runtime/agent-caller';
import { ContextBudget } from '../runtime/context-budget';
import { RunBudget } from '../runtime/run-budget';
import { InMemoryRunEventLog } from './in-memory-run-event-log';

// =============================================================================
// createNodeContextHarness: a real NodeContext without a job or a database
// =============================================================================
//
// For node and graph tests (this kit's, and the agent stories' after it):
// a real `AgentCaller`, `RunBudget` and `ContextBudget`, an in-memory event
// log, on top of `createAiRuntimeHarness()` (the real `AiService` over the
// scripted `FakeAiProvider`). `scripts` answers each model call by the role
// in `req.metadata.agent`. Run one node with `runNode`, or a whole graph with
// `runGraph` (an in-memory checkpointer unless one is given).
//
//   const h = createNodeContextHarness({ scripts: { planner: () => ({ outputText: JSON.stringify(draft) }) } });
//   const update = await h.runNode(planNode.run, { kind: 'create' });
// =============================================================================

export type AgentScript = (
  req: AiResponseRequest,
  ctx: AiCallContext,
) => FakeAiScriptedResponse | Promise<FakeAiScriptedResponse>;

export interface NodeContextHarnessOptions {
  kind?: RunKind;
  runId?: string;
  jobId?: string;
  /** Token cap of the run budget. Default 400,000. */
  tokenCap?: number;
  /** Frozen models; default every role on the harness model, effort `medium`. */
  roleModels?: Partial<Record<TrainingAgentRole, FrozenRoleModel>>;
  /** Answers per role (`req.metadata.agent`). A call for a role with no script throws. */
  scripts?: Partial<Record<TrainingAgentRole, AgentScript>>;
  /** Extra runtime-harness options (policy, catalog); `fake.responses` is owned by `scripts`. */
  runtime?: AiRuntimeHarnessOptions;
}

export const HARNESS_FROZEN_MODEL: FrozenRoleModel = {
  provider: HARNESS_PROVIDER,
  modelId: HARNESS_MODEL,
  effort: 'medium',
  keySource: 'user',
  contextWindow: FAKE_TEXT_MODEL_CAPABILITIES.contextWindow,
  maxOutputTokens: FAKE_TEXT_MODEL_CAPABILITIES.maxOutputTokens,
};

export function createNodeContextHarness(opts: NodeContextHarnessOptions = {}) {
  const runId = opts.runId ?? randomUUID();
  const jobId = opts.jobId ?? randomUUID();
  const kind = opts.kind ?? 'create';
  const scripts = opts.scripts ?? {};
  const roleModels =
    opts.roleModels ??
    (Object.fromEntries(TRAINING_AGENT_ROLES.map((role) => [role, { ...HARNESS_FROZEN_MODEL }])) as Record<
      TrainingAgentRole,
      FrozenRoleModel
    >);

  const runtime = createAiRuntimeHarness({
    models: [
      {
        modelId: HARNESS_MODEL,
        capabilities: {
          ...FAKE_TEXT_MODEL_CAPABILITIES,
          capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'],
        },
      },
    ],
    policy: { hostedTools: { web_search: true } },
    ...opts.runtime,
    fake: {
      hostedTools: ['web_search'],
      ...opts.runtime?.fake,
      responses: (req, ctx) => {
        const role = req.metadata?.agent as TrainingAgentRole | undefined;
        const script = role ? scripts[role] : undefined;
        if (!script) throw new Error(`No script for agent ${String(role)}`);
        return script(req, ctx);
      },
    },
  });

  const events = new InMemoryRunEventLog();
  const budget = new RunBudget(opts.tokenCap ?? 400_000);
  const controller = new AbortController();
  const usage: AgentUsageReport[] = [];
  const saver: BaseCheckpointSaver = new MemorySaver();

  const agent = new AgentCaller({
    ai: runtime.ai.forUser(HARNESS_USER, { jobId }),
    signal: controller.signal,
    roleModels,
    budget,
    onUsage: async (report) => {
      usage.push(report);
      const { usage: totals, ...rest } = report;
      await events.emit(runId, 'agent.usage', {
        ...rest,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        reasoningTokens: totals.reasoningTokens,
      });
    },
  });

  const context: Omit<NodeContext, 'interrupt'> = {
    runId,
    userId: HARNESS_USER,
    jobId,
    kind,
    signal: controller.signal,
    roleModels,
    emit: async (type, data) => {
      await events.emit(runId, type, data);
    },
    agent,
    budget,
    contextBudget: new ContextBudget(),
    now: () => new Date(),
  };

  const hooks: GraphHooks = {
    nodeStarted: async (node, state) => {
      await events.emit(runId, 'stage.started', { node, ...roundOf(node, state) }, node);
    },
    nodeFinished: async (node, state, outcome) => {
      if (outcome.status !== 'ok') return;
      await events.emit(runId, 'stage.completed', { node, ...roundOf(node, state), durationMs: outcome.durationMs }, node);
    },
  };

  const state = (partial: Partial<RunState> = {}): RunState => ({
    ...initialRunState({ runId, userId: HARNESS_USER, kind }),
    ...partial,
  });

  return {
    runId,
    jobId,
    kind,
    runtime,
    events,
    budget,
    usage,
    controller,
    context,
    hooks,
    /** A full `RunState` for this run, with `partial` over the initial one. */
    state,
    /** Aborts the run's signal (cancel, deadline). */
    abort(reason: unknown = new Error('Training run cancelled')) {
      controller.abort(reason);
    },
    /** Runs one node. `interrupt` answers `ctx.interrupt`; without it, an interrupt throws. */
    runNode(node: NodeFn, partial: Partial<RunState> = {}, interrupt?: (request: NodeInterruptRequest) => unknown) {
      return node(state(partial), {
        ...context,
        interrupt: <T>(request: NodeInterruptRequest) => {
          if (!interrupt) throw new Error(`Unexpected interrupt ${request.kind}`);
          return interrupt(request) as T;
        },
      });
    },
    /** Runs the kind's graph on `checkpointer` (default: one in-memory saver per harness). */
    runGraph(args: {
      input?: Partial<RunState>;
      resume?: unknown;
      checkpointer?: BaseCheckpointSaver;
      nodes?: Partial<Record<string, NodeFn>>;
    } = {}): Promise<AgentGraphRunResult<RunState>> {
      const runner = trainingGraphRunner(kind, {
        checkpointer: args.checkpointer ?? saver,
        context,
        hooks,
        ...(args.nodes ? { nodes: args.nodes } : {}),
      });

      return runner.run({
        threadId: runId,
        ...(args.input ? { input: state(args.input) } : {}),
        ...(args.resume !== undefined ? { resume: args.resume } : {}),
        signal: controller.signal,
      });
    },
    /** The harness's default in-memory checkpointer. */
    saver,
  };
}

/** The critic round for stage events (critique reports the round it runs). */
export function roundOf(node: string, state: RunState): { round?: number } {
  if (node !== 'critique' && node !== 'plan') return {};
  const done = state.roundCounters.critique ?? 0;

  return { round: node === 'critique' ? done + 1 : done };
}

export type NodeContextHarness = ReturnType<typeof createNodeContextHarness>;
