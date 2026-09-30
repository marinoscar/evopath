import '../graph/events';

import { randomUUID } from 'node:crypto';

import type { AiResponseRequest } from '../../ai/core/types/responses.types';
import {
  type AiRuntimeHarnessOptions,
  createAiRuntimeHarness,
  HARNESS_USER,
} from '../../ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES, type FakeAiScriptedResponse } from '../../ai/testing/fake-ai-provider';
import type { TrainingAgentRole } from '../../common/schemas/settings.schema';
import type { AdaptCheckpointer, AdaptGraphHooks, AdaptNodeFn } from '../../training-agents/graph/adapt-graph';
import {
  type AdaptGraphNodeName,
  type AdaptRunState,
  initialAdaptRunState,
} from '../../training-agents/graph/adapt-run-state';
import type { AgentGraphRunResult } from '../../training-agents/graph/agent-graph-runner.interface';
import type { FrozenRoleModel } from '../../training-agents/graph/node-context';
import { AgentCaller, type AgentUsageReport } from '../../training-agents/runtime/agent-caller';
import { RunBudget } from '../../training-agents/runtime/run-budget';
import { inMemoryAdaptCheckpointer } from '../../training-agents/testing/adapt-graph-support';
import { InMemoryRunEventLog } from '../../training-agents/testing/in-memory-run-event-log';
import { HARNESS_FROZEN_MODEL, type AgentScript } from '../../training-agents/testing/node-context-harness';
import { SCRIPT_USAGE } from '../../training-agents/testing/agent-scripts';
import { ADAPT_MAX_REVISIONS } from '../adaptation.constants';
import type { AdaptationContextPort } from '../context/adaptation-context.builder';
import type { AdaptationContext } from '../context/adaptation-context.contract';
import type { AdaptationCritiqueModel } from '../contracts/adaptation-critique.contract';
import type { AdaptationProposalModel } from '../contracts/adapted-workout.contract';
import type { AdaptationRequest } from '../dto/adaptation-request.dto';
import { adaptationGraphRunner } from '../graph/adaptation.graph';
import type { AdaptationNodeContext } from '../graph/node-context';
import { adaptationContextFixture, adaptationRequestFixture } from './adaptation-fixtures';

// =============================================================================
// createAdaptationGraphHarness: the adaptation graph on the fake provider
// =============================================================================
//
// A real `AgentCaller` and `RunBudget` over `createAiRuntimeHarness()` (the
// real `AiService` over the scripted `FakeAiProvider`), an in-memory event
// log and checkpointer, and the context port answered from a fixture. Model
// calls are routed by `req.metadata.agent` (`planner`, `critic`) to
// `scripts`; `runtime.fake.calls` is the provider call log.
//
//   const h = createAdaptationGraphHarness({
//     request: onlyDumbbellsRequest({ minutes: 30 }),
//     scripts: { planner: plannerAnswers([DUMBBELL_30_ANSWER]), critic: criticAnswers([ACCEPT]) },
//   });
//   const { state } = await h.runGraph();
//   expect(state.outcome?.status).toBe('ready');
// =============================================================================

export interface AdaptationGraphHarnessOptions {
  request?: AdaptationRequest;
  /** The context the `context` node gets; a function receives the request. Default: `adaptationContextFixture({ request })`. */
  context?: AdaptationContext | ((request: AdaptationRequest) => AdaptationContext | Promise<AdaptationContext>);
  scripts?: Partial<Record<TrainingAgentRole, AgentScript>>;
  tokenCap?: number;
  roleModels?: Partial<Record<TrainingAgentRole, FrozenRoleModel>>;
  runtime?: AiRuntimeHarnessOptions;
  maxRevisions?: number;
}

export function createAdaptationGraphHarness(opts: AdaptationGraphHarnessOptions = {}) {
  const runId = randomUUID();
  const jobId = randomUUID();
  const adaptationId = randomUUID();
  const request = opts.request ?? adaptationRequestFixture();
  const scripts = opts.scripts ?? {};
  const roleModels = opts.roleModels ?? { planner: { ...HARNESS_FROZEN_MODEL }, critic: { ...HARNESS_FROZEN_MODEL } };

  const runtime = createAiRuntimeHarness({
    models: [{ modelId: HARNESS_FROZEN_MODEL.modelId, capabilities: FAKE_TEXT_MODEL_CAPABILITIES }],
    ...opts.runtime,
    fake: {
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
  const budget = new RunBudget(opts.tokenCap ?? 120_000);
  const controller = new AbortController();
  const usage: AgentUsageReport[] = [];
  const contextBuilds: AdaptationRequest[] = [];

  const contextPort: AdaptationContextPort = {
    build: async (_userId, req) => {
      contextBuilds.push(req);
      if (typeof opts.context === 'function') return opts.context(req);
      return opts.context ?? adaptationContextFixture({ request: req });
    },
  };

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

  const context: AdaptationNodeContext = {
    runId,
    userId: HARNESS_USER,
    jobId,
    adaptationId,
    signal: controller.signal,
    roleModels,
    agent,
    budget,
    emit: async (type, data) => {
      await events.emit(runId, type, data ?? {});
    },
    now: () => new Date('2026-09-30T12:00:00.000Z'),
    contextPort,
  };

  const hooks: AdaptGraphHooks = {
    nodeStarted: async (node) => {
      await events.emit(runId, 'stage.started', { node }, node);
    },
    nodeFinished: async (node, _state, outcome) => {
      if (outcome.status === 'ok') await events.emit(runId, 'stage.completed', { node, durationMs: outcome.durationMs }, node);
    },
  };

  const saver = inMemoryAdaptCheckpointer();

  const state = (partial: Partial<AdaptRunState> = {}): AdaptRunState => ({
    ...initialAdaptRunState({
      runId,
      userId: HARNESS_USER,
      adaptationId,
      request: request as unknown as Record<string, unknown>,
      maxRevisions: opts.maxRevisions ?? ADAPT_MAX_REVISIONS,
    }),
    ...partial,
  });

  return {
    runId,
    jobId,
    adaptationId,
    request,
    runtime,
    /** The provider call log (`runtime.fake.calls`). */
    calls: () => runtime.fake.calls,
    events,
    budget,
    usage,
    contextBuilds,
    context,
    saver,
    state,
    abort(reason: unknown = new Error('Adaptation cancelled')) {
      controller.abort(reason);
    },
    /** Runs one node against `state(partial)`. */
    runNode(node: AdaptNodeFn<AdaptationNodeContext>, partial: Partial<AdaptRunState> = {}) {
      return node(state(partial), context);
    },
    /** Runs the whole graph from its start (or resumes from `checkpointer` when `resume` is set). */
    runGraph(args: {
      checkpointer?: AdaptCheckpointer;
      nodes?: Partial<Record<AdaptGraphNodeName, AdaptNodeFn<AdaptationNodeContext>>>;
      resume?: boolean;
    } = {}): Promise<AgentGraphRunResult<AdaptRunState>> {
      const runner = adaptationGraphRunner({
        checkpointer: args.checkpointer ?? saver,
        context,
        hooks,
        ...(args.nodes ? { nodes: args.nodes } : {}),
      });
      return runner.run({ threadId: runId, signal: controller.signal, ...(args.resume ? {} : { input: state() }) });
    },
  };
}

export type AdaptationGraphHarness = ReturnType<typeof createAdaptationGraphHarness>;

/** A planner answering `answers[i]` on its i-th call (the last one repeats). `seen` records each request. */
export function plannerAnswers(
  answers: Array<AdaptationProposalModel | (() => FakeAiScriptedResponse)>,
  seen: AiResponseRequest[] = [],
): AgentScript {
  let i = 0;
  return (req) => {
    seen.push(req);
    const next = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : { outputText: JSON.stringify(next), usage: SCRIPT_USAGE };
  };
}

/** A critic answering `answers[i]` on its i-th call (the last one repeats). */
export function criticAnswers(
  answers: Array<AdaptationCritiqueModel | (() => FakeAiScriptedResponse)>,
  seen: AiResponseRequest[] = [],
): AgentScript {
  return plannerAnswers(answers as never, seen);
}
