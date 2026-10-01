/**
 * The admin Factory reset page's data (issue #211): the deployment-wide
 * summary of what a reset would delete (`useFactoryResetSummary`), and the
 * reset itself (`useFactoryReset`) — start the job, then poll it until it
 * settles, through the same `useResetJob` loop the per-user Danger Zone
 * (#202) uses.
 *
 * The API decides everything: whether the phrase is right, what is deleted,
 * and whether the caller may (`system:factory_reset`). This hook only reports
 * what it says.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getFactoryResetJob,
  getFactoryResetSummary,
  startFactoryReset,
  type FactoryResetJob,
  type FactoryResetSummary,
} from '../services/factoryReset';
import { useIsMounted } from './useIsMounted';
import {
  RESET_POLL_INTERVAL_MS,
  resetErrorMessage,
  useResetJob,
  type UseResetJobReturn,
} from './useResetJob';

export interface UseFactoryResetSummaryReturn {
  summary: FactoryResetSummary | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useFactoryResetSummary(): UseFactoryResetSummaryReturn {
  const [summary, setSummary] = useState<FactoryResetSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await getFactoryResetSummary();
      if (isMounted()) setSummary(next ?? {});
    } catch (err) {
      if (isMounted()) {
        setSummary(null);
        setError(resetErrorMessage(err, 'Could not load a summary of this deployment.'));
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { summary, isLoading, error, refresh };
}

export type UseFactoryResetReturn = UseResetJobReturn<FactoryResetJob>;

export function useFactoryReset(
  pollIntervalMs: number = RESET_POLL_INTERVAL_MS,
): UseFactoryResetReturn {
  return useResetJob<FactoryResetJob>({
    startJob: startFactoryReset,
    getJob: getFactoryResetJob,
    pollIntervalMs,
    messages: {
      failed: 'The factory reset failed. Some data may not have been deleted.',
      lost: 'Lost track of the factory reset. Check the Jobs page and try again.',
      notStarted: 'The factory reset could not be started.',
    },
  });
}
