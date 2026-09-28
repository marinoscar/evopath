/**
 * The models the caller can actually call right now (`GET /api/ai/models`) —
 * issue #430, epic #419.
 *
 * "Usable" is decided entirely server-side: admin-enabled ∩ reachable with the
 * caller's key, or every enabled model when the organisation's key covers the
 * provider (`keySource: 'org'`). This hook only fetches it; the page calls
 * `refresh` after anything that can change it (saving, testing or removing a
 * key).
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import { listUsableAiModels, type UsableAiModel } from '../services/ai';
import { useIsMounted } from './useIsMounted';

export interface UseUsableAiModelsReturn {
  models: UsableAiModel[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useUsableAiModels(): UseUsableAiModelsReturn {
  const [models, setModels] = useState<UsableAiModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await listUsableAiModels();
      if (isMounted()) setModels(data);
    } catch (err) {
      if (isMounted()) {
        setError(err instanceof ApiError ? err.message : 'Failed to load available models');
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { models, isLoading, error, refresh };
}
