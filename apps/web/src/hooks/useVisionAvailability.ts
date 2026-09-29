/**
 * Can this user's photos be read by an AI model right now, and by which one?
 *
 * The state behind `components/intake/AiVisionDisclosure.tsx`. Every photo
 * flow has a manual path; this only decides whether the AI path is offered
 * and names the model (and whose key) the photos would be sent to.
 *
 * - `ai_disabled`: AI is off in this deployment (`useAiConfig`, fail-closed).
 * - `no_key`: AI is on but the caller can reach no model at all (no key of
 *   their own, no organisation key covering them).
 * - `no_vision_model`: the caller has models, but none reads images with
 *   structured output.
 * - `ready`: at least one vision model; `selected` defaults to the user's
 *   saved `user_settings.ai.defaultModel` when it is a vision model, else the
 *   first vision model.
 *
 * The API re-checks the chosen model at analyze time
 * (`UsableModelsService.assertUsable`); this is presentation only.
 */
import { useMemo } from 'react';
import type { UsableAiModel } from '../services/ai';
import { useAiConfig } from './useAiConfig';
import { useUsableAiModels } from './useUsableAiModels';
import { useUserSettings } from './useUserSettings';
import { usePlaygroundModel } from '../components/ai/playground/usePlaygroundModel';
import { aiModelKey } from '../components/ai/AiModelSelect';

export type VisionAvailabilityStatus = 'loading' | 'ready' | 'ai_disabled' | 'no_key' | 'no_vision_model';

/** Models that read images AND answer in structured output. */
export function visionModels(models: readonly UsableAiModel[]): UsableAiModel[] {
  return models.filter(
    (model) =>
      model.capabilities.capabilities.includes('vision_input') &&
      model.capabilities.capabilities.includes('structured_output') &&
      model.capabilities.inputModalities.includes('image'),
  );
}

export interface UseVisionAvailabilityReturn {
  status: VisionAvailabilityStatus;
  /** The vision models (empty unless `ready`). */
  models: UsableAiModel[];
  selected: UsableAiModel | null;
  select: (provider: string, modelId: string) => void;
}

export function useVisionAvailability(): UseVisionAvailabilityReturn {
  const { config, isLoading: configLoading } = useAiConfig();
  const enabled = config.enabled === true;
  const { models: usable, isLoading: modelsLoading } = useUsableAiModels();
  const { settings, isLoading: settingsLoading } = useUserSettings({ syncTheme: false });

  const vision = useMemo(() => (enabled ? visionModels(usable) : []), [enabled, usable]);
  const preferred = settings?.ai?.defaultModel ?? null;
  const ready = !modelsLoading && !settingsLoading;
  const { setModelKey, selected } = usePlaygroundModel(vision, preferred, ready);

  let status: VisionAvailabilityStatus;
  if (configLoading) status = 'loading';
  else if (!enabled) status = 'ai_disabled';
  else if (modelsLoading) status = 'loading';
  else if (usable.length === 0) status = 'no_key';
  else if (vision.length === 0) status = 'no_vision_model';
  else if (settingsLoading || !selected) status = 'loading';
  else status = 'ready';

  return {
    status,
    models: status === 'ready' ? vision : [],
    selected: status === 'ready' ? selected : null,
    select: (provider: string, modelId: string) => setModelKey(aiModelKey({ provider, modelId })),
  };
}
