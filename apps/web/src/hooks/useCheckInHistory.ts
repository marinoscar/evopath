import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import { listCheckIns, type CheckIn } from '../services/health';
import { useIsMounted } from './useIsMounted';

export interface UseCheckInHistoryReturn {
  /** Newest day first; days without a check-in are absent. `[]` until loaded. */
  items: CheckIn[];
  isLoading: boolean;
  error: string | null;
  forbidden: boolean;
  refresh: () => Promise<void>;
}

/** Issue #56 (E2.4). The last `days` days of check-ins (`GET /api/check-ins?days=`). */
export function useCheckInHistory(days: number, options: { enabled?: boolean } = {}): UseCheckInHistoryReturn {
  const enabled = options.enabled ?? true;
  const [items, setItems] = useState<CheckIn[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await listCheckIns(days);
      if (isMounted()) {
        setItems(data);
        setForbidden(false);
      }
    } catch (err) {
      if (!isMounted()) return;
      setForbidden(err instanceof ApiError && err.status === 403);
      setError(err instanceof ApiError ? err.message : 'Failed to load your check-ins');
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [days, isMounted]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { items, isLoading, error, forbidden, refresh };
}
