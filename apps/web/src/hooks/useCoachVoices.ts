/**
 * The voices the coach can speak in, for the caller (E7.3, #243).
 *
 * THE SERVER CHOOSES THE MODEL. An administrator assigns `coach.voice` at
 * `/admin/settings/ai/assignments`; `GET /api/ai/features` resolves it for
 * the caller, and `GET /api/ai/models` (the models the caller can call) lists
 * that model's `capabilities.voices`. The browser never picks a model and
 * hard-codes no voice: an unresolved feature, or a model listing no voices,
 * is an empty list, and the page tells the user to ask an administrator.
 */
import { useCallback, useEffect, useState } from 'react';
import { listUsableAiModels } from '../services/ai';
import { getAiFeatures, RUNNABLE_FEATURE_STATES, type FeatureResolution } from '../services/aiAssignments';
import { useIsMounted } from './useIsMounted';

export type CoachVoicesStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export interface UseCoachVoicesReturn {
  status: CoachVoicesStatus;
  voices: string[];
  /** The resolved `coach.voice` model, when there is one. */
  model: FeatureResolution['model'] | null;
  refresh: () => Promise<void>;
}

export function useCoachVoices({ enabled = true }: { enabled?: boolean } = {}): UseCoachVoicesReturn {
  const [status, setStatus] = useState<CoachVoicesStatus>('loading');
  const [voices, setVoices] = useState<string[]>([]);
  const [model, setModel] = useState<FeatureResolution['model'] | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setStatus('loading');
    try {
      const [features, models] = await Promise.all([getAiFeatures(), listUsableAiModels()]);
      if (!isMounted()) return;
      const voice = features.features.find((feature) => feature.featureId === 'coach.voice');
      const resolved = voice && RUNNABLE_FEATURE_STATES.includes(voice.state) ? voice.model : undefined;
      if (!resolved) {
        setModel(null);
        setVoices([]);
        setStatus('unavailable');
        return;
      }
      const usable = models.find(
        (entry) => entry.provider === resolved.provider && entry.modelId === resolved.modelId,
      );
      const list = usable?.capabilities.voices ?? [];
      setModel(resolved);
      setVoices(list);
      setStatus(list.length > 0 ? 'ready' : 'unavailable');
    } catch {
      if (isMounted()) {
        setModel(null);
        setVoices([]);
        setStatus('error');
      }
    }
  }, [enabled, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, voices, model, refresh };
}
