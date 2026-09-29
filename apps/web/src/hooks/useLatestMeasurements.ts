import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import { getLatestMeasurements, type LatestItem } from '../services/health';
import { useIsMounted } from './useIsMounted';

export interface UseLatestMeasurementsReturn {
  /** One item per body/vital metric, in registry order; `[]` until loaded. */
  items: LatestItem[];
  isLoading: boolean;
  error: string | null;
  /** True when the API answered `403`: no health-data grant, nothing to retry. */
  forbidden: boolean;
  refresh: () => Promise<void>;
}

/**
 * Issue #53 (E2.3). `GET /api/measurements/latest`: the newest and previous
 * reading of each body and vital metric, canonical values. Refetched after a
 * save (`refresh`) rather than updated optimistically: the server is the only
 * authority on what "latest" is.
 */
export function useLatestMeasurements(options: { enabled?: boolean } = {}): UseLatestMeasurementsReturn {
  const enabled = options.enabled ?? true;
  const [items, setItems] = useState<LatestItem[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const isMounted = useIsMounted();

  const fetchLatest = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getLatestMeasurements();
      if (isMounted()) {
        setItems(data);
        setForbidden(false);
      }
    } catch (err) {
      if (!isMounted()) return;
      setForbidden(err instanceof ApiError && err.status === 403);
      setError(err instanceof ApiError ? err.message : 'Failed to load your measurements');
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void fetchLatest();
  }, [enabled, fetchLatest]);

  return { items, isLoading, error, forbidden, refresh: fetchLatest };
}
