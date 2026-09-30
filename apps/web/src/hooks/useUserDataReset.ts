/**
 * The Danger Zone page's data (issue #202): the summary of what a factory
 * reset would delete (`useUserDataSummary`), and the reset itself
 * (`useUserDataReset`) — start the job, then poll it until it settles.
 *
 * The start-and-poll loop is `useResetJob`, shared with the admin factory
 * reset (#211); see that hook for why the poll is a plain timeout chain.
 *
 * The API decides everything: whether the phrase is right, what is deleted,
 * and whether the caller may. This hook only reports what it says.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getUserDataResetJob,
  getUserDataSummary,
  startUserDataReset,
  type UserDataResetJob,
  type UserDataSummary,
} from '../services/userData';
import { useIsMounted } from './useIsMounted';
import {
  RESET_POLL_INTERVAL_MS,
  resetErrorMessage,
  useResetJob,
  type ResetPhase,
  type UseResetJobReturn,
} from './useResetJob';

export { RESET_POLL_INTERVAL_MS };

export interface UseUserDataSummaryReturn {
  summary: UserDataSummary | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useUserDataSummary(): UseUserDataSummaryReturn {
  const [summary, setSummary] = useState<UserDataSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await getUserDataSummary();
      if (isMounted()) setSummary(next ?? {});
    } catch (err) {
      if (isMounted()) {
        setSummary(null);
        setError(resetErrorMessage(err, 'Could not load a summary of your data.'));
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

export type { ResetPhase };

export type UseUserDataResetReturn = UseResetJobReturn<UserDataResetJob>;

export function useUserDataReset(
  pollIntervalMs: number = RESET_POLL_INTERVAL_MS,
): UseUserDataResetReturn {
  return useResetJob<UserDataResetJob>({
    startJob: startUserDataReset,
    getJob: getUserDataResetJob,
    pollIntervalMs,
    messages: {
      failed: 'The reset failed. Some of your data may not have been deleted.',
      lost: 'Lost track of the reset. Check your data and try again.',
      notStarted: 'The reset could not be started.',
    },
  });
}
