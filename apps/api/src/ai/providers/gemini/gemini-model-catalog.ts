// =============================================================================
// Gemini model classifier (issue #447, epic #421)
// =============================================================================
//
// This table is a best-effort default; admins override per model. Update it
// when Google ships a new family.
//
// TWO SOURCES, ONE ANSWER. Unlike OpenAI's and Anthropic's, Gemini's model
// list says things about each model: `inputTokenLimit`, `outputTokenLimit`,
// `supportedGenerationMethods` (the SDK's `supportedActions`) and a
// `thinking` flag. The catalog sync hands those back as
// `AiDiscoveredModelMetadata` (`AiProviderAdapter.classifyModel`'s optional
// second argument), and `classifyGeminiModel` uses them to ENRICH what the
// curated rule table below says:
//
//   - the token limits replace the table's (the provider is the authority on
//     its own limits, and they move between previews);
//   - `supportedActions`, when present, must include the method the profile
//     needs (`generateContent` for a generative model, `embedContent` /
//     `batchEmbedContents` for an embedding model) or the id is left
//     unclassified — a listing that says a model cannot generate outranks a
//     name that looks like it can;
//   - an id NO rule matches is still classified when its metadata is clear:
//     a `gemini-*` model that supports `generateContent` gets the generic
//     Gemini profile (reasoning only if `thinking` says so), a model that
//     supports `embedContent` the embedding profile. Aliases such as
//     `gemini-flash-latest` land here.
//
// Without metadata (a request-time lookup, a test) the rule table answers
// alone. The rule list is ORDERED — FIRST MATCH WINS — and every pattern is
// tested against the lower-cased id with any `models/` prefix removed, so a
// dated or `-preview-MM-YYYY` snapshot classifies like its family.
//
// Each rule carries a `GeminiModelProfile`: the neutral capabilities the
// catalog stores, plus the facts the REQUEST MAPPER needs that the neutral
// vocabulary deliberately does not model:
//
//   thinking            how `reasoning.effort` is expressed —
//                         'level':  `thinkingConfig.thinkingLevel` (Gemini 3.x,
//                                   where the level is the recommended control),
//                         'budget': `thinkingConfig.thinkingBudget` (Gemini 2.5),
//                         'none':   no thinking (Gemini 2.0 / 1.5);
//   thinkingLevels      'level' families: effort -> level (Gemini 3 Pro has
//                       only LOW and HIGH; Flash has all four);
//   structuredOutput    whether `responseJsonSchema` is sent at all (2.5+);
//   structuredWithTools whether a schema may be combined with function tools
//                       (Gemini 3.x; 2.5 answers that combination with a 400);
//   embeddingDimensions embedding models: whether `outputDimensionality`
//                       (Matryoshka truncation) is accepted.
//
// Every generative Gemini model reads images and documents (PDF, text,
// audio, video) inline, so `vision_input` and `file_input` are declared for
// all of them. `hosted_tools` is never declared: this adapter maps none of
// Google's built-in tools yet (see `gemini.adapter.ts`).
// =============================================================================

import type { AiDiscoveredModelMetadata } from '../../core/provider-adapter.interface';
import type { AiModelCapabilities, AiReasoningEffort } from '../../core/capabilities';

export type GeminiThinkingStyle = 'level' | 'budget' | 'none';

/** `thinkingConfig.thinkingLevel` values (the SDK's `ThinkingLevel`). */
export type GeminiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface GeminiModelProfile {
  kind: 'generate' | 'embedding';
  capabilities: AiModelCapabilities;
  thinking: GeminiThinkingStyle;
  thinkingLevels?: Readonly<Record<AiReasoningEffort, GeminiThinkingLevel>>;
  structuredOutput: boolean;
  structuredWithTools: boolean;
  embeddingDimensions?: boolean;
}

export interface GeminiClassifierRule {
  /** Tested against the lower-cased id without its `models/` prefix. */
  match: RegExp;
  /** `null` claims the id as deliberately unclassified. */
  profile: GeminiModelProfile | null;
}

const ALL_EFFORTS: AiReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

/**
 * `reasoning.effort` -> `thinkingConfig.thinkingBudget`, for the 'budget'
 * families (Gemini 2.5), and for an unclassified model.
 *
 * The ranges Google documents are 128-32768 (2.5 Pro), 0-24576 (2.5 Flash)
 * and 512-24576 (2.5 Flash-Lite), so every rung sits inside all three: the
 * floor is Flash-Lite's minimum, the top is Flash's maximum, and the rungs
 * roughly quadruple so the four efforts are genuinely different amounts of
 * thinking. Gemini 3.x still accepts a budget (it is how an unclassified
 * model is asked), though a level is the recommended control there.
 */
export const GEMINI_THINKING_BUDGETS: Readonly<Record<AiReasoningEffort, number>> = {
  minimal: 512,
  low: 2048,
  medium: 8192,
  high: 24576,
};

/** Gemini 3.x Flash / Flash-Lite: all four levels. */
const FLASH_LEVELS: Readonly<Record<AiReasoningEffort, GeminiThinkingLevel>> = {
  minimal: 'MINIMAL',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
};

/** Gemini 3.x Pro: LOW and HIGH only — the lower two efforts ask for LOW, the upper two HIGH. */
const PRO_LEVELS: Readonly<Record<AiReasoningEffort, GeminiThinkingLevel>> = {
  minimal: 'LOW',
  low: 'LOW',
  medium: 'HIGH',
  high: 'HIGH',
};

const M1 = 1_048_576;

interface GenerateSpec {
  thinking: GeminiThinkingStyle;
  thinkingLevels?: Readonly<Record<AiReasoningEffort, GeminiThinkingLevel>>;
  structuredOutput: boolean;
  structuredWithTools: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

function generate(spec: GenerateSpec): GeminiModelProfile {
  const reasoning = spec.thinking !== 'none';

  return {
    kind: 'generate',
    capabilities: {
      capabilities: [
        'responses',
        ...(reasoning ? (['reasoning'] as const) : []),
        'tools',
        ...(spec.structuredOutput ? (['structured_output'] as const) : []),
        'streaming',
        'vision_input',
        'file_input',
      ],
      inputModalities: ['text', 'image', 'file'],
      outputModalities: ['text'],
      ...(reasoning ? { reasoningEfforts: [...ALL_EFFORTS] } : {}),
      contextWindow: spec.contextWindow,
      maxOutputTokens: spec.maxOutputTokens,
    },
    thinking: spec.thinking,
    ...(spec.thinkingLevels ? { thinkingLevels: spec.thinkingLevels } : {}),
    structuredOutput: spec.structuredOutput,
    structuredWithTools: spec.structuredWithTools,
  };
}

function embedding(contextWindow: number): GeminiModelProfile {
  return {
    kind: 'embedding',
    capabilities: {
      capabilities: ['embeddings'],
      inputModalities: ['text'],
      outputModalities: ['embedding'],
      contextWindow,
    },
    thinking: 'none',
    structuredOutput: false,
    structuredWithTools: false,
    embeddingDimensions: true,
  };
}

const GEMINI_3_PRO = generate({
  thinking: 'level',
  thinkingLevels: PRO_LEVELS,
  structuredOutput: true,
  structuredWithTools: true,
  contextWindow: M1,
  maxOutputTokens: 65_536,
});

const GEMINI_3_FLASH = { ...GEMINI_3_PRO, thinkingLevels: FLASH_LEVELS };

const GEMINI_2_5 = generate({
  thinking: 'budget',
  structuredOutput: true,
  structuredWithTools: false,
  contextWindow: M1,
  maxOutputTokens: 65_536,
});

function legacy(contextWindow: number): GeminiModelProfile {
  return generate({
    thinking: 'none',
    structuredOutput: false,
    structuredWithTools: false,
    contextWindow,
    maxOutputTokens: 8192,
  });
}

/**
 * The profile an unmatched `gemini-*` id gets when its listing says it can
 * `generateContent` — current-generation defaults, with reasoning decided by
 * the listing's `thinking` flag (see `classifyGeminiModel`).
 */
const GENERIC_GEMINI = generate({
  thinking: 'budget',
  structuredOutput: true,
  structuredWithTools: true,
  contextWindow: M1,
  maxOutputTokens: 65_536,
});

/** Ordered; first match wins. See the file header before reordering. */
export const GEMINI_CLASSIFIER_RULES: readonly GeminiClassifierRule[] = [
  // ---- Deliberately unclassified: models no port here drives — image
  // output, speech output, the Live API, computer use, robotics, and the
  // non-Gemini families the listing also carries.
  { match: /-(?:image|tts)(?:-|$)|native-audio|-live(?:-|$)|computer-use|robotics/, profile: null },
  { match: /^(?:imagen|veo|aqa|gemma|learnlm|lyria)-?/, profile: null },
  { match: /^(?:embedding-001|embedding-gecko)/, profile: null },

  // ---- Embeddings.
  { match: /^gemini-embedding-2(?:-|$)/, profile: embedding(8192) },
  { match: /^gemini-embedding-/, profile: embedding(2048) },
  { match: /^text-embedding-004$/, profile: embedding(2048) },

  // ---- Gemini 3.x: thinking levels, schemas with tools.
  { match: /^gemini-3(?:\.\d+)?-pro(?:-|$)/, profile: GEMINI_3_PRO },
  { match: /^gemini-3(?:\.\d+)?-flash(?:-lite)?(?:-|$)/, profile: GEMINI_3_FLASH },

  // ---- Gemini 2.5: thinking budgets.
  { match: /^gemini-2\.5-(?:pro|flash|flash-lite)(?:-|$)/, profile: GEMINI_2_5 },

  // ---- Gemini 2.0 / 1.5: no thinking; `responseJsonSchema` not sent.
  { match: /^gemini-2\.0-flash(?:-lite)?(?:-|$)/, profile: legacy(M1) },
  { match: /^gemini-1\.5-pro(?:-|$)/, profile: legacy(2_097_152) },
  { match: /^gemini-1\.5-flash(?:-8b)?(?:-|$)/, profile: legacy(M1) },
];

/** The id the rules are tested against: trimmed, lower-cased, without `models/`. */
export function normalizeGeminiModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/^models\//, '');
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function supports(metadata: AiDiscoveredModelMetadata | undefined, ...actions: string[]): boolean | undefined {
  const listed = metadata?.supportedActions;

  if (!Array.isArray(listed)) return undefined;

  return actions.some((action) => listed.includes(action));
}

/** `profile` with the listing's own token limits and thinking flag folded in. */
function enrich(profile: GeminiModelProfile, metadata: AiDiscoveredModelMetadata | undefined): GeminiModelProfile {
  if (!metadata) return profile;

  const out = structuredClone(profile);
  const context = positiveInt(metadata.inputTokenLimit);
  const output = positiveInt(metadata.outputTokenLimit);

  if (context !== undefined) out.capabilities.contextWindow = context;
  if (output !== undefined && out.kind === 'generate') out.capabilities.maxOutputTokens = output;

  return out;
}

/** The generic profile for an unmatched `gemini-*` id, reasoning per the listing's flag. */
function genericFromMetadata(metadata: AiDiscoveredModelMetadata): GeminiModelProfile {
  if (metadata.thinking === true) return GENERIC_GEMINI;

  const noThinking = structuredClone(GENERIC_GEMINI);

  noThinking.thinking = 'none';
  noThinking.capabilities.capabilities = noThinking.capabilities.capabilities.filter((c) => c !== 'reasoning');
  delete noThinking.capabilities.reasoningEfforts;

  return noThinking;
}

/**
 * The full profile for `modelId`, or `null` when neither the table nor the
 * listing metadata classifies it. A fresh copy each call, so a caller cannot
 * corrupt the table.
 */
export function geminiModelProfile(
  modelId: string,
  metadata?: AiDiscoveredModelMetadata,
  rules: readonly GeminiClassifierRule[] = GEMINI_CLASSIFIER_RULES,
): GeminiModelProfile | null {
  const id = normalizeGeminiModelId(modelId);
  const rule = rules.find((candidate) => candidate.match.test(id));

  if (rule) {
    if (!rule.profile) return null;

    const needed =
      rule.profile.kind === 'embedding'
        ? supports(metadata, 'embedContent', 'batchEmbedContents')
        : supports(metadata, 'generateContent');

    // A listing that says the model cannot do what its name suggests wins.
    if (needed === false) return null;

    return enrich(structuredClone(rule.profile), metadata);
  }

  if (!metadata) return null;

  if (id.startsWith('gemini-') && supports(metadata, 'generateContent')) {
    return enrich(genericFromMetadata(metadata), metadata);
  }

  if (id.includes('embedding') && supports(metadata, 'embedContent', 'batchEmbedContents')) {
    return enrich(embedding(2048), metadata);
  }

  return null;
}

/** `classifyModel()`: the neutral capabilities only. */
export function classifyGeminiModel(modelId: string, metadata?: AiDiscoveredModelMetadata): AiModelCapabilities | null {
  return geminiModelProfile(modelId, metadata)?.capabilities ?? null;
}
