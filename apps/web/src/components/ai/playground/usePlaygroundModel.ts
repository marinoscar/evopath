/**
 * One mode's model selection — issue #445 (generalised from #434's chat).
 *
 * Defaults to the caller's saved `user_settings.ai.defaultModel` when it is
 * among `models`, else the first of them; and re-picks when the selection
 * stops being offered (the list changed under it).
 */
import { useEffect, useState } from 'react';
import type { UsableAiModel } from '../../../services/ai';
import { aiModelKey } from '../AiModelSelect';

export interface PlaygroundModelSelection {
  /** {@link aiModelKey} of the selection, or `''` before one is made. */
  modelKey: string;
  setModelKey: (key: string) => void;
  selected: UsableAiModel | null;
}

export function usePlaygroundModel(
  models: readonly UsableAiModel[],
  preferred?: { provider: string; modelId: string } | null,
  /** False while `models` or `preferred` are still loading. */
  ready = true,
): PlaygroundModelSelection {
  const [modelKey, setModelKey] = useState('');
  const selected = models.find((model) => aiModelKey(model) === modelKey) ?? null;

  useEffect(() => {
    if (!ready || models.length === 0) return;
    if (modelKey && models.some((model) => aiModelKey(model) === modelKey)) return;
    const match = preferred ? models.find((model) => aiModelKey(model) === aiModelKey(preferred)) : undefined;
    setModelKey(aiModelKey(match ?? models[0]));
  }, [modelKey, models, preferred, ready]);

  return { modelKey, setModelKey, selected };
}
