/**
 * The AI Playground's modes — issue #445, epic #420.
 *
 * One entry per kind of AI call the playground can demonstrate. A mode is
 * defined by the ONE capability a model must declare to serve it (the API's
 * permanent `AI_CAPABILITIES` strings, `components/ai/aiCapabilities.ts`), so
 * which modes are offered and which models each lists is derived entirely
 * from `GET /api/ai/models` — there is no model name anywhere in this file,
 * and there must never be one.
 *
 * Order is display order. Adding a mode is an entry here plus a panel in
 * `pages/AiPlaygroundPage.tsx`'s `renderModePanel`.
 */
import type { UsableAiModel } from '../../../services/ai';
import { hasAiCapability } from '../AiModelSelect';

export type AiPlaygroundModeId = 'chat' | 'image' | 'transcribe' | 'speech' | 'embeddings' | 'voice';

export interface AiPlaygroundMode {
  id: AiPlaygroundModeId;
  label: string;
  /** The capability a model needs to be listed in this mode. */
  capability: string;
  /** Why the mode is unavailable when no usable model declares {@link capability}. */
  unavailableReason: string;
}

export const AI_PLAYGROUND_MODES: readonly AiPlaygroundMode[] = [
  {
    id: 'chat',
    label: 'Chat',
    capability: 'responses',
    unavailableReason: 'None of the models available to you can answer text prompts',
  },
  {
    id: 'image',
    label: 'Image',
    capability: 'image_generation',
    unavailableReason: 'None of the models available to you can generate images',
  },
  {
    id: 'transcribe',
    label: 'Transcribe',
    capability: 'audio_transcription',
    unavailableReason: 'None of the models available to you can transcribe audio',
  },
  {
    id: 'speech',
    label: 'Speech',
    capability: 'audio_speech',
    unavailableReason: 'None of the models available to you can generate speech',
  },
  {
    id: 'embeddings',
    label: 'Embeddings',
    capability: 'embeddings',
    unavailableReason: 'None of the models available to you can create embeddings',
  },
  {
    // #449. Also HIDDEN (not merely disabled) unless `GET /ai/config`
    // says `allowRealtime: true` — see {@link hiddenPlaygroundModes}.
    id: 'voice',
    label: 'Voice',
    capability: 'realtime',
    unavailableReason: 'None of the models available to you can hold a voice conversation',
  },
];

/**
 * Modes an administrator has switched off for the deployment, so they are
 * not offered at all (as opposed to {@link unavailableModes}, which are
 * offered but disabled with a reason). Voice needs `allowRealtime: true`; an
 * older API that omits the flag reads as off.
 */
export function hiddenPlaygroundModes(config: { allowRealtime?: boolean }): Set<AiPlaygroundModeId> {
  return config.allowRealtime === true ? new Set() : new Set<AiPlaygroundModeId>(['voice']);
}

export function aiPlaygroundMode(id: AiPlaygroundModeId): AiPlaygroundMode {
  return AI_PLAYGROUND_MODES.find((mode) => mode.id === id) ?? AI_PLAYGROUND_MODES[0];
}

/** The usable models that can serve `mode`, in the API's order. */
export function modelsForMode(models: readonly UsableAiModel[], mode: AiPlaygroundMode): UsableAiModel[] {
  return models.filter((model) => hasAiCapability(model, mode.capability));
}

/**
 * The modes that cannot be selected: those no usable model can serve (offered,
 * but disabled with their reason), plus any `hidden` ones.
 */
export function unavailableModes(
  models: readonly UsableAiModel[],
  hidden: ReadonlySet<AiPlaygroundModeId> = new Set(),
): Set<AiPlaygroundModeId> {
  return new Set(
    AI_PLAYGROUND_MODES.filter((mode) => hidden.has(mode.id) || modelsForMode(models, mode).length === 0).map(
      (mode) => mode.id,
    ),
  );
}

/** The mode to open on: Chat when it can be used, else the first mode that can. */
export function initialPlaygroundMode(
  models: readonly UsableAiModel[],
  hidden: ReadonlySet<AiPlaygroundModeId> = new Set(),
): AiPlaygroundModeId {
  const unavailable = unavailableModes(models, hidden);
  return AI_PLAYGROUND_MODES.find((mode) => !unavailable.has(mode.id))?.id ?? 'chat';
}
