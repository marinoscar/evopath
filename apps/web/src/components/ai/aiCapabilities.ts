/**
 * The AI capability vocabulary as the web app renders it — shared by every
 * AI surface (issues #429, #430, #434; epic #419).
 *
 * The values mirror the API's permanent `AI_CAPABILITIES`,
 * `AI_INPUT_MODALITIES`, `AI_OUTPUT_MODALITIES` and `AI_REASONING_EFFORTS`
 * (`apps/api/src/ai/core/capabilities.ts`). They are stored in the catalogue
 * table and in administrator overrides, so they never change spelling — and
 * no legacy alias is accepted here: a string the API does not emit is shown
 * as itself, never silently mapped.
 */

export const AI_CAPABILITY_VALUES = [
  'responses',
  'reasoning',
  'tools',
  'hosted_tools',
  'structured_output',
  'streaming',
  'vision_input',
  'file_input',
  'image_generation',
  'image_edit',
  'audio_transcription',
  'audio_speech',
  'embeddings',
  'realtime',
] as const;

export const AI_INPUT_MODALITY_VALUES = ['text', 'image', 'audio', 'file'] as const;
export const AI_OUTPUT_MODALITY_VALUES = ['text', 'image', 'audio', 'embedding'] as const;
export const AI_REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high'] as const;

/** One short, UNIQUE label per capability. */
export const AI_CAPABILITY_LABELS: Record<string, string> = {
  responses: 'Text',
  reasoning: 'Reasoning',
  tools: 'Tools',
  hosted_tools: 'Hosted tools',
  structured_output: 'Structured output',
  streaming: 'Streaming',
  vision_input: 'Vision',
  file_input: 'Files',
  image_generation: 'Image generation',
  image_edit: 'Image editing',
  audio_transcription: 'Transcription',
  audio_speech: 'Speech',
  embeddings: 'Embeddings',
  realtime: 'Realtime',
};

/** A capability's label; an unknown one renders as itself so it never vanishes. */
export function aiCapabilityLabel(capability: string): string {
  return AI_CAPABILITY_LABELS[capability] ?? capability;
}

export interface AiCapabilityGroup {
  id: string;
  label: string;
  members: readonly string[];
}

/**
 * Nine families, for surfaces where fourteen chips per row would be
 * unreadable (the admin catalogue): Text / Reasoning / Tools / Structured /
 * Vision / Image / Audio / Embeddings / Realtime.
 */
export const AI_CAPABILITY_GROUPS: readonly AiCapabilityGroup[] = [
  { id: 'text', label: 'Text', members: ['responses', 'streaming', 'file_input'] },
  { id: 'reasoning', label: 'Reasoning', members: ['reasoning'] },
  { id: 'tools', label: 'Tools', members: ['tools', 'hosted_tools'] },
  { id: 'structured', label: 'Structured', members: ['structured_output'] },
  { id: 'vision', label: 'Vision', members: ['vision_input'] },
  { id: 'image', label: 'Image', members: ['image_generation', 'image_edit'] },
  { id: 'audio', label: 'Audio', members: ['audio_transcription', 'audio_speech'] },
  { id: 'embeddings', label: 'Embeddings', members: ['embeddings'] },
  { id: 'realtime', label: 'Realtime', members: ['realtime'] },
];

const GROUPED = new Set(AI_CAPABILITY_GROUPS.flatMap((group) => group.members));

/** The families a capability list covers, in display order, plus any unknown strings. */
export function groupCapabilities(capabilities: readonly string[]): {
  groups: { group: AiCapabilityGroup; present: string[] }[];
  unknown: string[];
} {
  const groups = AI_CAPABILITY_GROUPS.map((group) => ({
    group,
    present: group.members.filter((member) => capabilities.includes(member)),
  })).filter((entry) => entry.present.length > 0);
  const unknown = capabilities.filter((capability) => !GROUPED.has(capability));
  return { groups, unknown };
}

/** Plain-text family summary — a table's CSV value and search text. */
export function capabilitySummary(capabilities: readonly string[]): string {
  const { groups, unknown } = groupCapabilities(capabilities);
  return [...groups.map((entry) => entry.group.label), ...unknown].join(', ');
}
