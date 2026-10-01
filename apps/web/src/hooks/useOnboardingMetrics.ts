/**
 * Activation metrics for the Setup guide (`GET /api/admin/onboarding/metrics`)
 * — issue #212.
 *
 * `{ metrics, isLoading, error, refresh }` for one window of `days`. Changing
 * `days` re-reads; the previous answer stays on screen until the new one
 * lands (the section marks itself busy meanwhile), so the tiles do not
 * collapse to a skeleton on every window change. A response for a window the
 * caller has since left is dropped.
 *
 * Presentation only: every count and rate is computed by the API from
 * aggregates; nothing per-user reaches the browser.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { getOnboardingMetrics } from '../services/onboarding';
import type { OnboardingMetrics } from '../types';
import { useIsMounted } from './useIsMounted';

export interface UseOnboardingMetricsReturn {
  metrics: OnboardingMetrics | null;
  /** A read for the current `days` is in flight. */
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useOnboardingMetrics(days: number): UseOnboardingMetricsReturn {
  const [metrics, setMetrics] = useState<OnboardingMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++latest.current;
    setIsLoading(true);
    setError(null);
    try {
      const data = await getOnboardingMetrics(days);
      if (isMounted() && request === latest.current) setMetrics(data);
    } catch (err) {
      if (isMounted() && request === latest.current) {
        setError(err instanceof ApiError && err.message ? err.message : 'Could not load the activation metrics');
      }
    } finally {
      if (isMounted() && request === latest.current) setIsLoading(false);
    }
  }, [days, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { metrics, isLoading, error, refresh };
}

export default useOnboardingMetrics;
