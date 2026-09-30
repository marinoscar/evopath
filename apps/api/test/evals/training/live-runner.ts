import { AiError } from '../../../src/ai/core/ai-error';
import type { AiUserClient } from '../../../src/ai/runtime/ai.service';
import type { PlanDraft } from '../../../src/training-agents/agents/planner/plan-draft.contract';
import { HARNESS_USER } from '../../../src/ai/testing/ai-runtime-harness';
import { trainingGraphRunner } from '../../../src/training-agents/graph/graph-factory';
import type { FrozenRoleModel } from '../../../src/training-agents/graph/node-context';
import { AgentCaller, type AgentUsageReport } from '../../../src/training-agents/runtime/agent-caller';
import { researcherScript } from '../../../src/training-agents/testing/agent-scripts';
import { createFakeProgramsPort } from '../../../src/training-agents/testing/fake-programs-port';
import { HARNESS_FROZEN_MODEL, createNodeContextHarness } from '../../../src/training-agents/testing/node-context-harness';
import { judgeModelOf, judgePlan, type JudgeScores } from '../support/judge';
import { routeByAgent } from '../support/live-client';
import { evaluatePersona, type PersonaEvaluation } from './evaluate';
import type { EvalEnv } from './eval-env';
import { contextSourceOf } from './personas';
import type { EvalPersona } from './persona.schema';
import { buildLayers, violationCounts, type PersonaRun } from './run-persona';
import { personaPasses, scoreArtifact } from './score';
import type { GuardrailNodeOutput } from '../../../src/training-agents/nodes/guardrails.node';

// =============================================================================
// Runs a persona through the REAL create graph with REAL models
// =============================================================================
//
// Same graph, same nodes, same guardrails as the pipeline evals; only the
// model calls differ. `live` answers planner and critic (and the researcher
// when EVAL_RESEARCH=live); by default the researcher stays on the persona's
// stored brief so planner and critic comparisons are not confounded by
// search variance.
//
// A run that throws (a model that cannot produce strict-mode output:
// `AI_STRUCTURED_OUTPUT_INVALID`; a throttle that outlasted the backoff) is
// RECORDED as an error with a quality score of 0, never a suite crash.
// =============================================================================

export interface LiveRunResult {
  evaluation: PersonaEvaluation | null;
  /** The error code when the run threw. */
  error: string | null;
  judge: JudgeScores | null;
  usage: PersonaRun['usage'];
  latencyMs: number;
}

/** The run's frozen models: EVAL_MODELS for the live roles, the harness fake for a stored-brief researcher. */
export function frozenModels(env: EvalEnv): Record<'researcher' | 'planner' | 'critic', FrozenRoleModel> {
  const frozen = (role: 'planner' | 'critic' | 'researcher'): FrozenRoleModel => {
    const spec = env.models[role];
    if (!spec) throw new Error(`EVAL_MODELS names no ${role} model`);
    return { provider: spec.provider, modelId: spec.modelId, effort: (spec.effort as FrozenRoleModel['effort']) ?? null, keySource: 'user' };
  };
  return {
    researcher: env.research === 'live' ? frozen('researcher') : { ...HARNESS_FROZEN_MODEL },
    planner: frozen('planner'),
    critic: frozen('critic'),
  };
}

export function errorCodeOf(err: unknown): string {
  if (err instanceof AiError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'TRAINING_RUN_FAILED';
}

export async function runLivePersona(persona: EvalPersona, deps: { live: AiUserClient; env: EvalEnv; tokenCap?: number }): Promise<LiveRunResult> {
  const started = Date.now();

  if (persona.kind === 'safety') {
    const evaluation = await evaluatePersona(persona, { variant: 'good' });
    return { evaluation, error: null, judge: null, usage: {}, latencyMs: Date.now() - started };
  }

  const source = contextSourceOf(persona);
  const fake = createFakeProgramsPort();
  const roleModels = frozenModels(deps.env);
  const h = createNodeContextHarness({
    kind: 'create',
    tokenCap: deps.tokenCap ?? 400_000,
    roleModels,
    scripts: { researcher: researcherScript(persona.brief) },
    ports: { plannerContext: { load: async () => source }, programs: fake.port, notifications: fake.notify },
  });

  // The first planner draft is the RAW layer: what the model wrote before any repair.
  let firstDraft: PlanDraft | null = null;
  const capturing: AiUserClient = {
    ...deps.live,
    respondStructured: (async (req: { metadata?: Record<string, string> }, opts: never) => {
      const response = await deps.live.respondStructured(req as never, opts);
      if (req.metadata?.agent === 'planner' && firstDraft === null) firstDraft = response.parsed as PlanDraft;
      return response;
    }) as AiUserClient['respondStructured'],
  };
  const stored = deps.env.research !== 'live';
  const ai = routeByAgent(capturing, h.runtime.ai.forUser(HARNESS_USER, { jobId: h.jobId }), (agent) => stored && agent === 'researcher');

  const usage: PersonaRun['usage'] = {};
  const agent = new AgentCaller({
    ai,
    signal: h.controller.signal,
    roleModels,
    budget: h.budget,
    onUsage: (report: AgentUsageReport) => {
      const entry = (usage[report.role] ??= { inputTokens: 0, outputTokens: 0 });
      entry.inputTokens += report.usage.inputTokens;
      entry.outputTokens += report.usage.outputTokens;
    },
  });

  try {
    const result = await trainingGraphRunner('create', { checkpointer: h.saver, context: { ...h.context, agent }, hooks: h.hooks }).run({
      threadId: h.runId,
      input: h.state({ input: { kind: 'create', intake: source.intake }, maxCriticRounds: 2 }),
      signal: h.controller.signal,
    });
    const state = result.state;
    const { raw, shipped } = buildLayers({ persona, source, state, program: [...fake.programs.values()][0], firstDraft });
    const outcome = state.outcome as { status?: string; verdict?: string } | null;

    const run: PersonaRun = {
      personaId: persona.id,
      variant: 'good',
      status: outcome?.status === 'completed' ? 'completed' : outcome?.status === 'rejected' ? 'rejected' : 'failed',
      verdict: outcome?.verdict ?? null,
      warnings: [...state.warnings],
      plannerCalls: 0,
      criticRounds: state.roundCounters.critique ?? 0,
      providerCalls: 0,
      latencyMs: Date.now() - started,
      usage,
      raw,
      shipped,
      safety: null,
      plannerRequests: [],
      guardrailStatus: (state.guardrailReport as { report?: { status?: string } } | null)?.report?.status ?? null,
      violations: violationCounts(state.guardrailReport as GuardrailNodeOutput | null),
    };
    const rawScore = raw ? scoreArtifact(persona, raw) : null;
    const shippedScore = shipped ? scoreArtifact(persona, shipped) : null;
    const evaluation: PersonaEvaluation = { persona, run, raw: rawScore, shipped: shippedScore, passes: personaPasses(shippedScore) };

    let judge: JudgeScores | null = null;
    if (deps.env.judge && shipped) {
      try {
        judge = await judgePlan(deps.live, judgeModelOf(deps.env.models), shipped, persona);
      } catch {
        judge = null;
      }
    }
    return { evaluation, error: null, judge, usage, latencyMs: run.latencyMs };
  } catch (err) {
    return { evaluation: null, error: errorCodeOf(err), judge: null, usage, latencyMs: Date.now() - started };
  }
}

export interface SampledResult {
  persona: EvalPersona;
  results: LiveRunResult[];
  /** Mean and spread of the shipped score over samples (0 for a run that errored). */
  shipped: { mean: number; min: number; max: number };
  raw: { mean: number; min: number; max: number };
}

const stats = (values: number[]) => {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { mean: round(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)), min: round(Math.min(...values)), max: round(Math.max(...values)) };
};

/** Runs `samples` times, sequentially, and summarises. */
export async function runSamples(persona: EvalPersona, samples: number, deps: Parameters<typeof runLivePersona>[1]): Promise<SampledResult> {
  const results: LiveRunResult[] = [];
  for (let i = 0; i < samples; i += 1) results.push(await runLivePersona(persona, deps));
  return {
    persona,
    results,
    shipped: stats(results.map((r) => r.evaluation?.shipped?.score ?? 0)),
    raw: stats(results.map((r) => r.evaluation?.raw?.score ?? 0)),
  };
}
