// =============================================================================
// AI capabilities (issue #424, epic #419)
// =============================================================================
//
// The closed vocabulary every other AI story speaks: the catalog (#429) stores
// an `AiModelCapabilities` per model, the admin UI renders it as chips, and the
// runtime gate pipeline (#431) refuses a request whose shape needs a
// capability the chosen model does not declare.
//
// TWO LEVELS, deliberately not conflated:
//
//   - MODEL level (this file): what one model can do. Declared by the
//     adapter's `classifyModel()` and overridable by an administrator.
//   - PROVIDER level (`AiProviderRegistry.supports()`): which capability
//     PORTS the adapter implements at all. Derived from port presence, never
//     declared, so it cannot drift from the code.
//
// A request needs both: the provider must carry the port, and the model must
// declare the capability.
// =============================================================================

import { z } from 'zod';

/**
 * Every capability a model can declare. Permanent strings — they are stored
 * in the catalog table and in administrator overrides, so renaming one is a
 * data migration, not a refactor.
 */
export const AI_CAPABILITIES = [
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

export type AiCapability = (typeof AI_CAPABILITIES)[number];

export const AI_INPUT_MODALITIES = ['text', 'image', 'audio', 'file'] as const;
export const AI_OUTPUT_MODALITIES = ['text', 'image', 'audio', 'embedding'] as const;
export const AI_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export type AiInputModality = (typeof AI_INPUT_MODALITIES)[number];
export type AiOutputModality = (typeof AI_OUTPUT_MODALITIES)[number];
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

/**
 * What one model can do. Validated with this schema wherever it crosses a
 * trust boundary (an adapter's classifier output, an administrator override,
 * a JSONB column read back from the database).
 */
export const aiModelCapabilitiesSchema = z.object({
  capabilities: z.array(z.enum(AI_CAPABILITIES)),
  inputModalities: z.array(z.enum(AI_INPUT_MODALITIES)),
  outputModalities: z.array(z.enum(AI_OUTPUT_MODALITIES)),
  reasoningEfforts: z.array(z.enum(AI_REASONING_EFFORTS)).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /**
   * The voices an `audio_speech` model speaks in (#439) — surfaced through
   * `GET /api/ai/models` so a picker can offer them. Optional: absent means
   * "the provider's own list" (`AiAudioPort.voices`).
   */
  voices: z.array(z.string().min(1).max(64)).max(100).optional(),
});

export type AiModelCapabilities = z.infer<typeof aiModelCapabilitiesSchema>;

/** Type guard for an arbitrary string read from the database or a request. */
export function isAiCapability(value: string): value is AiCapability {
  return (AI_CAPABILITIES as readonly string[]).includes(value);
}
