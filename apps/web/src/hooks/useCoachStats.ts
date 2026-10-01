/**
 * Coach engagement aggregates (`GET /api/admin/coach/stats`, E7.11, #251).
 *
 * `ai_config:read`; reachable while AI is off. The house hook contract: every
 * `setState` past an `await` is guarded by `useIsMounted()`, and `refresh`
 * resolves rather than throwing (the panel shows a retry on error).
 */
import { useCallback, useEffect, useState } from 'react';
import { coachErrorOf, getCoachStats, type CoachStats } from '../services/coach';
import { useIsMounted } from './useIsMounted';

export interface UseCoachStatsReturn {
  stats: CoachStats | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useCoachStats(days = 30): UseCoachStatsReturn {
  const [stats, setStats] = useState<CoachStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getCoachStats(days);
      if (isMounted()) {
        setStats(data);
        setError(null);
      }
    } catch (err) {
      if (isMounted()) setError(coachErrorOf(err, 'Failed to load the engagement stats').message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [days, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { stats, isLoading, error, refresh };
}
