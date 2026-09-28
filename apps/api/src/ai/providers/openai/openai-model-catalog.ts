// =============================================================================
// OpenAI model classifier (issue #426, epic #419)
// =============================================================================
//
// This table is a best-effort default; admins override per model. Update it
// when OpenAI ships new families.
//
// `GET /v1/models` returns ids and nothing about what a model can do, so
// `classifyModel()` answers from this ordered rule list: FIRST MATCH WINS, and
// no match means `null` — the catalog (#427) stores the model as
// `unclassified` and an administrator decides, rather than this file guessing
// (docs/specs/ai-platform.md §2.17: a wrong guess is worse than "unknown").
//
// Dated snapshots (`gpt-4o-2024-08-06`, `o3-mini-2025-01-31`) are kept, not
// filtered as noise, and classify like their family — every pattern is a
// prefix match for exactly that reason.
//
// A rule may map to `null` on purpose: a family this platform cannot drive
// through any port yet (Chat-Completions-only audio and search previews,
// legacy completions models) is claimed explicitly so that a broader rule
// further down cannot mis-classify it. Specific rules therefore come before
// general ones — the order IS the logic.
// =============================================================================

import type { AiModelCapabilities, AiReasoningEffort } from '../../core/capabilities';

export interface OpenAiClassifierRule {
  /** Tested against the full model id. */
  match: RegExp;
  /** `null` claims the id as deliberately unclassified. */
  capabilities: AiModelCapabilities | null;
}

const GPT5_EFFORTS: AiReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];
const O_SERIES_EFFORTS: AiReasoningEffort[] = ['low', 'medium', 'high'];

/** A reasoning model that sees images and files (gpt-5*, o1/o3/o4-mini, codex). */
function reasoningMultimodal(efforts: AiReasoningEffort[]): AiModelCapabilities {
  return {
    capabilities: [
      'responses',
      'reasoning',
      'tools',
      'hosted_tools',
      'structured_output',
      'streaming',
      'vision_input',
      'file_input',
    ],
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text'],
    reasoningEfforts: efforts,
  };
}

/** A text-only reasoning model (o1-mini, o3-mini). */
const REASONING_TEXT: AiModelCapabilities = {
  capabilities: ['responses', 'reasoning', 'tools', 'structured_output', 'streaming'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  reasoningEfforts: O_SERIES_EFFORTS,
};

/**
 * A non-reasoning multimodal chat model (gpt-4o, gpt-4.1, gpt-5-chat). It and
 * the reasoning multimodal family above carry `hosted_tools` (#442): the
 * Responses API offers them web search, file search, code interpreter,
 * image generation and remote MCP. An individual model that lacks one is
 * refused by OpenAI itself; an administrator can override the chip.
 */
const CHAT_MULTIMODAL: AiModelCapabilities = {
  capabilities: ['responses', 'tools', 'hosted_tools', 'structured_output', 'streaming', 'vision_input', 'file_input'],
  inputModalities: ['text', 'image', 'file'],
  outputModalities: ['text'],
};

/** gpt-4-turbo: vision and tools, but predates strict structured outputs. */
const CHAT_VISION_LEGACY: AiModelCapabilities = {
  capabilities: ['responses', 'tools', 'streaming', 'vision_input'],
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
};

/** gpt-4 / gpt-3.5-turbo: text in, text out, function calling. */
const CHAT_TEXT_LEGACY: AiModelCapabilities = {
  capabilities: ['responses', 'tools', 'streaming'],
  inputModalities: ['text'],
  outputModalities: ['text'],
};

const IMAGE_GENERATE_AND_EDIT: AiModelCapabilities = {
  capabilities: ['image_generation', 'image_edit'],
  inputModalities: ['text', 'image'],
  outputModalities: ['image'],
};

const IMAGE_GENERATE_ONLY: AiModelCapabilities = {
  capabilities: ['image_generation'],
  inputModalities: ['text'],
  outputModalities: ['image'],
};

const TRANSCRIPTION: AiModelCapabilities = {
  capabilities: ['audio_transcription'],
  inputModalities: ['audio'],
  outputModalities: ['text'],
};

/**
 * Every voice OpenAI's speech endpoint accepts — `OpenAiProviderAdapter
 * .audio.voices`. The `tts-1` family speaks the first nine only.
 */
export const OPENAI_SPEECH_VOICES = [
  'alloy',
  'ash',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'ballad',
  'verse',
  'marin',
  'cedar',
] as const;

/** The voices `tts-1` and `tts-1-hd` speak. */
export const OPENAI_TTS1_VOICES = OPENAI_SPEECH_VOICES.slice(0, 9);

function speech(voices: readonly string[]): AiModelCapabilities {
  return {
    capabilities: ['audio_speech'],
    inputModalities: ['text'],
    outputModalities: ['audio'],
    voices: [...voices],
  };
}

const EMBEDDINGS: AiModelCapabilities = {
  capabilities: ['embeddings'],
  inputModalities: ['text'],
  outputModalities: ['embedding'],
};

/**
 * Every voice a realtime session accepts — `OpenAiProviderAdapter.realtime
 * .voices` and the `realtime` classification's `voices` (#449). Not the
 * speech list: `fable`, `onyx` and `nova` are `/v1/audio/speech` only.
 * `marin` and `cedar` are the GA `gpt-realtime` voices OpenAI recommends.
 */
export const OPENAI_REALTIME_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;

/**
 * `gpt-realtime*`, `gpt-4o-realtime-preview*` and `gpt-4o-mini-realtime*`:
 * speech-to-speech over a browser-held session (#449), minted by the
 * adapter's `realtime` port.
 */
const REALTIME: AiModelCapabilities = {
  capabilities: ['realtime'],
  inputModalities: ['text', 'audio'],
  outputModalities: ['text', 'audio'],
  voices: [...OPENAI_REALTIME_VOICES],
};

/** Ordered; first match wins. See the file header before reordering. */
export const OPENAI_CLASSIFIER_RULES: readonly OpenAiClassifierRule[] = [
  // ---- Special-purpose families first: their ids share prefixes with chat models.
  { match: /realtime/, capabilities: REALTIME },
  { match: /transcribe|^whisper-/, capabilities: TRANSCRIPTION },
  { match: /^tts-1(?:-|$)/, capabilities: speech(OPENAI_TTS1_VOICES) },
  { match: /^tts-|-tts(?:-|$)/, capabilities: speech(OPENAI_SPEECH_VOICES) },
  { match: /^text-embedding-/, capabilities: EMBEDDINGS },
  { match: /^dall-e-2(?:-|$)/, capabilities: IMAGE_GENERATE_AND_EDIT },
  { match: /^dall-e-3(?:-|$)/, capabilities: IMAGE_GENERATE_ONLY },
  { match: /^(?:chatgpt-|gpt-)image-|-image-/, capabilities: IMAGE_GENERATE_AND_EDIT },

  // ---- Deliberately unclassified: no port drives these yet.
  { match: /^gpt-(?:4o-(?:mini-)?)?audio/, capabilities: null },
  { match: /-search-(?:preview|api)/, capabilities: null },
  { match: /moderation/, capabilities: null },
  { match: /^computer-use/, capabilities: null },
  { match: /^gpt-3\.5-turbo-instruct/, capabilities: null },

  // ---- GPT-5 family: reasoning, except the `-chat` variants.
  { match: /^gpt-5(?:\.\d+)?-chat/, capabilities: CHAT_MULTIMODAL },
  { match: /^gpt-5(?:[.-]|$)/, capabilities: reasoningMultimodal(GPT5_EFFORTS) },

  // ---- o-series reasoning.
  { match: /^o[13]-mini(?:-|$)/, capabilities: REASONING_TEXT },
  { match: /^o\d(?:-|$)/, capabilities: reasoningMultimodal(O_SERIES_EFFORTS) },
  { match: /^codex-/, capabilities: reasoningMultimodal(O_SERIES_EFFORTS) },

  // ---- Non-reasoning chat models.
  { match: /^gpt-4\.1(?:-|$)/, capabilities: CHAT_MULTIMODAL },
  { match: /^gpt-4o(?:-|$)/, capabilities: CHAT_MULTIMODAL },
  { match: /^chatgpt-4o-/, capabilities: CHAT_MULTIMODAL },
  { match: /^gpt-4-turbo|^gpt-4-(?:\d{4}-)?vision/, capabilities: CHAT_VISION_LEGACY },
  { match: /^gpt-4(?:-|$)/, capabilities: CHAT_TEXT_LEGACY },
  { match: /^gpt-3\.5-turbo(?:-|$)/, capabilities: CHAT_TEXT_LEGACY },
];

/**
 * The capabilities OpenAI model `modelId` is believed to have, or `null` when
 * this table does not recognise it. Returns a fresh copy each call, so a
 * caller mutating the result cannot corrupt the table.
 */
export function classifyOpenAiModel(
  modelId: string,
  rules: readonly OpenAiClassifierRule[] = OPENAI_CLASSIFIER_RULES,
): AiModelCapabilities | null {
  const id = modelId.trim().toLowerCase();

  for (const rule of rules) {
    if (rule.match.test(id)) {
      return rule.capabilities ? structuredClone(rule.capabilities) : null;
    }
  }

  return null;
}
