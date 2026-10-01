/**
 * The `/coach` header state, `GET /api/coach/state` (E7.8, #248).
 *
 * Every number (ring, streak, passes, next session) is the server's; the page
 * only displays it. The route also needs `programs:read`, so a `403` here is an
 * ordinary answer for a user without it: the header then renders without the
 * plan signals rather than as an error.
 */
import { useCallback, useEffect, useState } from 'react';
import { getCoachState, type CoachStateView } from '../services/coach';
import { useIsMounted } from './useIsMounted';

export interface UseCoachStateReturn {
  state: CoachStateView | null;
  isLoading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
}

export function useCoachState(options: { enabled?: boolean } = {}): UseCoachStateReturn {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<CoachStateView | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    try {
      const next = await getCoachState();
      if (isMounted()) {
        setState(next);
        setError(false);
      }
    } catch {
      if (isMounted()) setError(true);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [enabled, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, isLoading, error, refresh };
}
