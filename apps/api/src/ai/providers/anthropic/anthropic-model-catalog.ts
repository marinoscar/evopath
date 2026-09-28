// =============================================================================
// Anthropic model classifier (issue #446, epic #421)
// =============================================================================
//
// This table is a best-effort default; admins override per model. Update it
// when Anthropic ships a new family.
//
// Same contract as `openai-model-catalog.ts`: `GET /v1/models` lists ids, and
// `classifyModel()` answers from this ORDERED rule list — FIRST MATCH WINS,
// no match means `null` (the catalog stores the model as `unclassified` and
// an administrator decides; docs/specs/ai-platform.md §2.17). Every pattern is a
// prefix match so a dated snapshot (`claude-opus-4-5-20251101`) classifies
// like its alias (`claude-opus-4-5`).
//
// Each rule carries an `AnthropicModelProfile`: the neutral capabilities the
// catalog stores, plus three facts the REQUEST MAPPER needs that the neutral
// vocabulary deliberately does not model:
//
//   thinking          how extended thinking is configured on this family —
//                       'adaptive': `thinking: { type: 'adaptive' }` with
//                                   `output_config.effort` (Claude 4.6 and
//                                   later; `budget_tokens` is deprecated or
//                                   rejected there),
//                       'budget':   `thinking: { type: 'enabled',
//                                   budget_tokens }` (Claude 3.7 - 4.5),
//                       'none':     no extended thinking (Claude 3 / 3.5);
//   structuredOutput  'native' — `output_config.format` (Anthropic's own
//                     structured outputs), or 'tool' — a forced single tool
//                     whose `input_schema` is the schema (older families);
//   sampling          whether `temperature` is accepted at all (Claude 4.7+,
//                     Sonnet 5, Opus 5 and Fable/Mythos 5 reject sampling
//                     parameters with a 400).
//
// Every Claude model since Claude 3 calls tools and streams, and every
// current one reads images; PDFs (`file_input`) arrived with Claude 3.5
// Sonnet. `hosted_tools` is deliberately never declared: Anthropic's server
// tools are a different set with different shapes, and this adapter maps
// none of them yet.
// =============================================================================

import type { AiModelCapabilities, AiReasoningEffort } from '../../core/capabilities';

export type AnthropicThinkingStyle = 'adaptive' | 'budget' | 'none';
export type AnthropicStructuredOutputStyle = 'native' | 'tool';

export interface AnthropicModelProfile {
  capabilities: AiModelCapabilities;
  thinking: AnthropicThinkingStyle;
  structuredOutput: AnthropicStructuredOutputStyle;
  sampling: boolean;
}

export interface AnthropicClassifierRule {
  /** Tested against the full, lower-cased model id. */
  match: RegExp;
  /** `null` claims the id as deliberately unclassified. */
  profile: AnthropicModelProfile | null;
}

/** Every effort the neutral vocabulary has — each family maps all four (see below). */
const ALL_EFFORTS: AiReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

/**
 * `reasoning.effort` -> `thinking.budget_tokens`, for the 'budget' families.
 *
 * Anthropic's minimum budget is 1024 tokens. The ladder doubles-to-triples
 * per step so the four efforts are genuinely different amounts of thinking,
 * and tops out at 16k so `high` fits inside the default answer allowance
 * (`ANTHROPIC_DEFAULT_MAX_TOKENS`) plus headroom on every budget-style model.
 * `max_tokens` must exceed the budget: see `resolveMaxTokens` in the mapper.
 */
export const ANTHROPIC_THINKING_BUDGETS: Readonly<Record<AiReasoningEffort, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 6144,
  high: 16384,
};

/**
 * `reasoning.effort` -> `output_config.effort`, for the 'adaptive' families.
 * Anthropic's ladder is `low | medium | high | xhigh | max`; ours has no
 * `xhigh`/`max` and adds `minimal`, which maps to Anthropic's lowest, `low`.
 */
export const ANTHROPIC_ADAPTIVE_EFFORTS: Readonly<Record<AiReasoningEffort, 'low' | 'medium' | 'high'>> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/**
 * `max_tokens` when the caller sets no `maxOutputTokens` (the Messages API
 * REQUIRES one). 16k keeps a non-streaming answer well inside the client's
 * ten-minute timeout, and is capped at the model's own output limit.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16_000;

/** The output cap assumed for an unclassified model — the smallest any Claude 3+ model has. */
export const ANTHROPIC_UNCLASSIFIED_MAX_OUTPUT_TOKENS = 4096;

interface ProfileSpec {
  thinking: AnthropicThinkingStyle;
  structuredOutput: AnthropicStructuredOutputStyle;
  sampling: boolean;
  vision: boolean;
  pdf: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

function profile(spec: ProfileSpec): AnthropicModelProfile {
  const inputModalities: AiModelCapabilities['inputModalities'] = ['text'];

  if (spec.vision) inputModalities.push('image');
  if (spec.pdf) inputModalities.push('file');

  return {
    capabilities: {
      capabilities: [
        'responses',
        ...(spec.thinking !== 'none' ? (['reasoning'] as const) : []),
        'tools',
        'structured_output',
        'streaming',
        ...(spec.vision ? (['vision_input'] as const) : []),
        ...(spec.pdf ? (['file_input'] as const) : []),
      ],
      inputModalities,
      outputModalities: ['text'],
      ...(spec.thinking !== 'none' ? { reasoningEfforts: [...ALL_EFFORTS] } : {}),
      contextWindow: spec.contextWindow,
      maxOutputTokens: spec.maxOutputTokens,
    },
    thinking: spec.thinking,
    structuredOutput: spec.structuredOutput,
    sampling: spec.sampling,
  };
}

const M = 1_000_000;
const K200 = 200_000;

/** Claude 4.7+ / 5.x: adaptive thinking only, native structured outputs, no sampling parameters. */
const FRONTIER = profile({
  thinking: 'adaptive',
  structuredOutput: 'native',
  sampling: false,
  vision: true,
  pdf: true,
  contextWindow: M,
  maxOutputTokens: 128_000,
});

/** Opus 4.7: as FRONTIER, but native structured outputs are not listed for it — use the tool path. */
const OPUS_4_7 = { ...FRONTIER, structuredOutput: 'tool' as const };

/** Opus 4.6 / Sonnet 4.6: adaptive thinking, sampling still accepted, the tool path for schemas. */
const GEN_4_6 = profile({
  thinking: 'adaptive',
  structuredOutput: 'tool',
  sampling: true,
  vision: true,
  pdf: true,
  contextWindow: M,
  maxOutputTokens: 128_000,
});

function budgetFamily(structuredOutput: AnthropicStructuredOutputStyle, maxOutputTokens: number): AnthropicModelProfile {
  return profile({
    thinking: 'budget',
    structuredOutput,
    sampling: true,
    vision: true,
    pdf: true,
    contextWindow: K200,
    maxOutputTokens,
  });
}

/** Ordered; first match wins. See the file header before reordering. */
export const ANTHROPIC_CLASSIFIER_RULES: readonly AnthropicClassifierRule[] = [
  // ---- Fable / Mythos 5.x (and the Mythos preview): the frontier tier.
  { match: /^claude-(?:fable|mythos)-(?:5(?:-\d+)?|preview)(?:-|$)/, profile: FRONTIER },

  // ---- Opus 5 / 5.5, Sonnet 5.
  { match: /^claude-opus-5(?:-\d+)?(?:-|$)/, profile: FRONTIER },
  { match: /^claude-sonnet-5(?:-\d+)?(?:-|$)/, profile: FRONTIER },

  // ---- Claude 4.6 - 4.8: adaptive thinking.
  { match: /^claude-opus-4-8(?:-|$)/, profile: FRONTIER },
  { match: /^claude-opus-4-7(?:-|$)/, profile: OPUS_4_7 },
  { match: /^claude-(?:opus|sonnet)-4-6(?:-|$)/, profile: GEN_4_6 },

  // ---- Claude 4.5 / 4.1 / 4: extended thinking with a token budget.
  { match: /^claude-opus-4-5(?:-|$)/, profile: budgetFamily('native', 64_000) },
  { match: /^claude-haiku-4-5(?:-|$)/, profile: budgetFamily('native', 64_000) },
  { match: /^claude-sonnet-4-5(?:-|$)/, profile: budgetFamily('tool', 64_000) },
  { match: /^claude-opus-4-1(?:-|$)/, profile: budgetFamily('native', 32_000) },
  // `claude-opus-4-0`, `claude-opus-4-20250514`.
  { match: /^claude-opus-4(?:-0)?(?:-\d{8})?$/, profile: budgetFamily('tool', 32_000) },
  // `claude-sonnet-4-0`, `claude-sonnet-4-20250514`.
  { match: /^claude-sonnet-4(?:-0)?(?:-\d{8})?$/, profile: budgetFamily('tool', 64_000) },
  { match: /^claude-3-7-sonnet(?:-|$)/, profile: budgetFamily('tool', 64_000) },

  // ---- Claude 3.5 / 3: no extended thinking.
  {
    match: /^claude-3-5-sonnet(?:-|$)/,
    profile: profile({ thinking: 'none', structuredOutput: 'tool', sampling: true, vision: true, pdf: true, contextWindow: K200, maxOutputTokens: 8192 }),
  },
  {
    match: /^claude-3-5-haiku(?:-|$)/,
    profile: profile({ thinking: 'none', structuredOutput: 'tool', sampling: true, vision: false, pdf: false, contextWindow: K200, maxOutputTokens: 8192 }),
  },
  {
    match: /^claude-3-(?:opus|sonnet|haiku)(?:-|$)/,
    profile: profile({ thinking: 'none', structuredOutput: 'tool', sampling: true, vision: true, pdf: false, contextWindow: K200, maxOutputTokens: 4096 }),
  },

  // ---- Deliberately unclassified: pre-Messages-era models no port drives.
  { match: /^claude-(?:2|instant)/, profile: null },
];

/**
 * The full profile for `modelId`, or `null` when this table does not
 * recognise it. A fresh copy each call, so a caller cannot corrupt the table.
 */
export function anthropicModelProfile(
  modelId: string,
  rules: readonly AnthropicClassifierRule[] = ANTHROPIC_CLASSIFIER_RULES,
): AnthropicModelProfile | null {
  const id = modelId.trim().toLowerCase();

  for (const rule of rules) {
    if (rule.match.test(id)) {
      return rule.profile ? structuredClone(rule.profile) : null;
    }
  }

  return null;
}

/** `classifyModel()`: the neutral capabilities only. */
export function classifyAnthropicModel(modelId: string): AiModelCapabilities | null {
  return anthropicModelProfile(modelId)?.capabilities ?? null;
}
