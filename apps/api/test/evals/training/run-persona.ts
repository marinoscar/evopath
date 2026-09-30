import type { AiResponseRequest } from '../../../src/ai/core/types/responses.types';
import type { PlanDraft } from '../../../src/training-agents/agents/planner/plan-draft.contract';
import type { VerifiedEvidenceBrief } from '../../../src/training-agents/agents/researcher/evidence-brief.contract';
import { buildTrainingRunContext } from '../../../src/training-agents/context/build-planner-context';
import { compileDraft, type PlanHeader } from '../../../src/training-agents/compile/compile-plan';
import { freeTextOf } from '../../../src/training-agents/contracts/training-intake.contract';
import type { GuardrailNodeOutput } from '../../../src/training-agents/nodes/guardrails.node';
import { guardrailContextOf, type GuardrailContext } from '../../../src/training-agents/guardrails/types';
import type { PlanTree } from '../../../src/programs/contracts/plan-tree.contract';
import { FreeTextSafetyScreen } from '../../../src/training-agents/runtime/safety-screen';
import { criticScript, plannerScript, researcherScript } from '../../../src/training-agents/testing/agent-scripts';
import { createFakeProgramsPort } from '../../../src/training-agents/testing/fake-programs-port';
import { createNodeContextHarness } from '../../../src/training-agents/testing/node-context-harness';
import { stubVerdict } from '../../../src/training-agents/testing/stub-agent-nodes';
import { synthesizeDraft, type DraftVariant } from '../support/draft-synth';
import { SEED_LIBRARY } from '../support/seed-library';
import { contextSourceOf } from './personas';
import type { EvalPersona } from './persona.schema';
import type { EvalArtifact } from './properties';

// =============================================================================
// Runs one persona through the REAL create graph over the scripted fake
// provider and returns both artifact layers (raw and shipped) for scoring.
// =============================================================================

export type CriticMode = 'approve' | 'revise_once' | 'always_revise';

export interface PersonaRunOptions {
  variant: DraftVariant;
  critic?: CriticMode;
  maxCriticRounds?: number;
  /** Planner answers in order (the last repeats); default: the variant, then `good` on a revision. */
  drafts?: PlanDraft[];
}

export interface PersonaRun {
  personaId: string;
  variant: DraftVariant;
  /** `completed`, `rejected` (guardrails blocked, nothing created) or `stopped` (safety screen). */
  status: 'completed' | 'rejected' | 'stopped' | 'failed';
  verdict: string | null;
  warnings: string[];
  plannerCalls: number;
  criticRounds: number;
  providerCalls: number;
  latencyMs: number;
  /** Tokens by role as the scripted provider reported them. */
  usage: Record<string, { inputTokens: number; outputTokens: number }>;
  raw: EvalArtifact | null;
  shipped: EvalArtifact | null;
  /** The safety persona's artifact (no plan). */
  safety: EvalArtifact['safety'] | null;
  /** Planner requests, for prompt-placement checks. */
  plannerRequests: AiResponseRequest[];
  guardrailStatus: string | null;
  /** `rule:severity:code` of the last guardrail report, with counts. */
  violations: Record<string, number>;
}

const CRITICS: Record<CriticMode, Parameters<typeof criticScript>[0]> = {
  approve: () => stubVerdict('approve'),
  revise_once: (round) => stubVerdict(round <= 1 ? 'revise' : 'approve'),
  always_revise: () => stubVerdict('revise'),
};

/** The default critic for a variant: approves good and hostile plans, asks mediocre ones for one revision. */
export function defaultCritic(variant: DraftVariant): CriticMode {
  return variant === 'mediocre' ? 'revise_once' : 'approve';
}

export async function runPersona(persona: EvalPersona, options: PersonaRunOptions): Promise<PersonaRun> {
  const base = { personaId: persona.id, variant: options.variant };
  const started = Date.now();

  if (persona.kind === 'safety') {
    const source = contextSourceOf(persona);
    const harness = createNodeContextHarness({ scripts: {} });
    const stop = await new FreeTextSafetyScreen().screen({ userId: 'eval', kind: 'create', input: { kind: 'create', intake: source.intake } });
    const providerCalls = harness.runtime.fake.callsTo('responses.create').length;
    return {
      ...base,
      status: stop.stop ? 'stopped' : 'failed',
      verdict: null,
      warnings: [],
      plannerCalls: 0,
      criticRounds: 0,
      providerCalls,
      latencyMs: Date.now() - started,
      usage: {},
      raw: null,
      shipped: null,
      safety: { providerCalls, guidance: stop.stop ? stop.guidance : null },
      plannerRequests: [],
      guardrailStatus: null,
      violations: {},
    };
  }

  const source = contextSourceOf(persona);
  const drafts = options.drafts ?? (options.variant === 'mediocre' ? [synthesizeDraft(persona, 'mediocre'), synthesizeDraft(persona, 'good')] : [synthesizeDraft(persona, options.variant)]);
  const plannerRequests: AiResponseRequest[] = [];
  const fake = createFakeProgramsPort();
  const critic = options.critic ?? defaultCritic(options.variant);
  const h = createNodeContextHarness({
    kind: 'create',
    scripts: {
      researcher: researcherScript(persona.brief),
      planner: plannerScript(drafts, plannerRequests),
      critic: criticScript(CRITICS[critic]),
    },
    ports: { plannerContext: { load: async () => source }, programs: fake.port, notifications: fake.notify },
  });

  const result = await h.runGraph({ input: { input: { kind: 'create', intake: source.intake }, maxCriticRounds: options.maxCriticRounds ?? 2 } });
  const latencyMs = Date.now() - started;
  const state = result.state;

  const brief = (state.brief ?? null) as VerifiedEvidenceBrief | null;
  const context = buildTrainingRunContext(source);
  const ctx: GuardrailContext = guardrailContextOf(context, brief);
  const outcome = state.outcome as { status?: string; verdict?: string } | null;
  const program = [...fake.programs.values()][0];

  const compiledRaw = compileDraft(drafts[0], { library: SEED_LIBRARY, brief, seed: `eval:${persona.id}:1` });
  const raw: EvalArtifact = { layer: 'raw', tree: compiledRaw.tree, ctx, header: compiledRaw.header };

  let shipped: EvalArtifact | null = null;
  if (program) {
    const output = state.guardrailReport as GuardrailNodeOutput | null;
    shipped = { layer: 'shipped', tree: program.versions[0].tree as PlanTree, ctx, header: (output?.header ?? null) as PlanHeader | null, flags: Object.keys(violationCounts(output)) };
  }

  const usage: PersonaRun['usage'] = {};
  for (const report of h.usage) {
    const entry = (usage[report.role] ??= { inputTokens: 0, outputTokens: 0 });
    entry.inputTokens += report.usage.inputTokens;
    entry.outputTokens += report.usage.outputTokens;
  }

  return {
    ...base,
    status: outcome?.status === 'completed' ? 'completed' : outcome?.status === 'rejected' ? 'rejected' : 'failed',
    verdict: outcome?.verdict ?? null,
    warnings: [...state.warnings],
    plannerCalls: h.runtime.fake.callsTo('responses.create').filter((c) => c.request?.metadata?.agent === 'planner').length,
    criticRounds: state.roundCounters.critique ?? 0,
    providerCalls: h.runtime.fake.callsTo('responses.create').length,
    latencyMs,
    usage,
    raw,
    shipped,
    safety: null,
    plannerRequests,
    guardrailStatus: (state.guardrailReport as { report?: { status?: string } } | null)?.report?.status ?? null,
    violations: violationCounts(state.guardrailReport as GuardrailNodeOutput | null),
  };
}

function violationCounts(output: GuardrailNodeOutput | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of output?.report.violations ?? []) {
    const key = `${v.rule}:${v.severity}:${v.code}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
