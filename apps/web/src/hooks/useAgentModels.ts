/**
 * The training agents' resolved models and the typical-plan token estimate.
 *
 * Loads `GET /api/ai/training/models` and `POST /api/ai/training/estimate`
 * (kind `create`) together. The page calls `refresh` after every save, since
 * both answers depend on the saved preferences. Nothing here decides anything:
 * the API resolves each role and computes the estimate.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  estimateTrainingRun,
  getTrainingModels,
  type TrainingModelsView,
  type TrainingRunEstimate,
} from '../services/trainingAgents';
import { useIsMounted } from './useIsMounted';

export interface UseAgentModelsReturn {
  view: TrainingModelsView | null;
  estimate: TrainingRunEstimate | null;
  isLoading: boolean;
  error: string | null;
  estimateError: string | null;
  refresh: () => Promise<void>;
}

export function useAgentModels(): UseAgentModelsReturn {
  const [view, setView] = useState<TrainingModelsView | null>(null);
  const [estimate, setEstimate] = useState<TrainingRunEstimate | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    const [models, est] = await Promise.allSettled([
      getTrainingModels(),
      estimateTrainingRun({ kind: 'create' }),
    ]);
    if (!isMounted()) return;

    if (models.status === 'fulfilled') {
      setView(models.value);
      setError(null);
    } else {
      setError(
        models.reason instanceof ApiError ? models.reason.message : 'Failed to load the training agents',
      );
    }

    if (est.status === 'fulfilled') {
      setEstimate(est.value);
      setEstimateError(null);
    } else {
      setEstimateError(
        est.reason instanceof ApiError ? est.reason.message : 'Failed to estimate a typical plan',
      );
    }
    setIsLoading(false);
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { view, estimate, isLoading, error, estimateError, refresh };
}
