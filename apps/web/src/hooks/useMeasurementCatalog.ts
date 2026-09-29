import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import { getMeasurementCatalog, type MetricCatalog } from '../services/health';
import { useIsMounted } from './useIsMounted';

/**
 * Issue #53 (E2.3). The metric catalog (`GET /api/measurements/metrics`):
 * units, conversion factors, bounds and methods, owned by the API.
 *
 * Fetched ONCE per session and shared: the promise is cached in module scope,
 * so the quick-entry dialog, the Health tiles and the Today card all read the
 * same request. The catalog is static per deployment, so it is never
 * refetched; a FAILED request is dropped from the cache, so the next mount
 * retries instead of replaying the failure. There is no fallback to a local
 * table of factors: a caller shows the error and does not convert.
 */

let cached: Promise<MetricCatalog> | null = null;
let resolved: MetricCatalog | null = null;

function loadCatalog(): Promise<MetricCatalog> {
  if (!cached) {
    cached = getMeasurementCatalog().then(
      (catalog) => {
        resolved = catalog;
        return catalog;
      },
      (err: unknown) => {
        cached = null;
        throw err;
      },
    );
  }
  return cached;
}

/** Tests only: forget the session cache. */
export function resetMeasurementCatalogCache(): void {
  cached = null;
  resolved = null;
}

export interface UseMeasurementCatalogReturn {
  catalog: MetricCatalog | null;
  isLoading: boolean;
  error: string | null;
  /** The `ApiError` status of the failure, when there is one (a `403` is not a retryable error). */
  errorStatus: number | null;
  /** Try again after a failure (a loaded catalog is never refetched). */
  refresh: () => void;
}

export function useMeasurementCatalog(options: { enabled?: boolean } = {}): UseMeasurementCatalogReturn {
  const enabled = options.enabled ?? true;
  const [catalog, setCatalog] = useState<MetricCatalog | null>(resolved);
  const [isLoading, setIsLoading] = useState(enabled && resolved === null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const isMounted = useIsMounted();
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || resolved) {
      if (resolved) setCatalog(resolved);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    setErrorStatus(null);
    loadCatalog().then(
      (data) => {
        if (!isMounted()) return;
        setCatalog(data);
        setIsLoading(false);
      },
      (err: unknown) => {
        if (!isMounted()) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load the measurement catalog');
        setErrorStatus(err instanceof ApiError ? err.status : null);
        setIsLoading(false);
      },
    );
  }, [enabled, isMounted, attempt]);

  return { catalog, isLoading, error, errorStatus, refresh };
}
