import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  BIOMARKER_SERIES_YEARS,
  getBiomarkerSummary,
  getLabSeries,
  getMeasurementRevisions,
  listLabResults,
  type BiomarkerSummaryItem,
  type BiomarkerSummaryParams,
  type LabMeasurementPage,
  type LabSeries,
  type MeasurementRevision,
} from '../services/biomarkers';
import { useIsMounted } from './useIsMounted';

export interface UseResourceReturn<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  /** The API answered `403`: no health-data grant, nothing to retry. */
  forbidden: boolean;
  /** The API answered `404`. */
  notFound: boolean;
  refresh: () => void;
}

/**
 * One GET keyed by `key`: refetched when the key changes or on `refresh`. A
 * key change aborts the request in flight and a request-id guard drops a late
 * answer, so a slow response never overwrites a newer one. The data of the
 * previous key is dropped on a key change (it would be mislabelled).
 */
function useResource<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  fallbackError: string,
): UseResourceReturn<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null }>({ key: null, data: null });
  const [isLoading, setIsLoading] = useState(key !== null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  const loadRef = useRef(load);
  // Declared before the fetch effect, so the fetch always reads this render's loader.
  useEffect(() => {
    loadRef.current = load;
  });
  const isMounted = useIsMounted();
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (key === null) {
      setIsLoading(false);
      return;
    }
    const id = ++requestId.current;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    setStatus(null);
    loadRef.current(controller.signal).then(
      (data) => {
        if (!isMounted() || id !== requestId.current) return;
        setState({ key, data });
        setIsLoading(false);
      },
      (err: unknown) => {
        if (!isMounted() || id !== requestId.current || controller.signal.aborted) return;
        setStatus(err instanceof ApiError ? err.status : null);
        setError(err instanceof ApiError ? err.message : fallbackError);
        setIsLoading(false);
      },
    );
    return () => controller.abort();
  }, [key, attempt, fallbackError, isMounted]);

  const current = state.key === key;
  return {
    data: current ? state.data : null,
    isLoading: isLoading || (!current && key !== null && error === null),
    error,
    forbidden: status === 403,
    notFound: status === 404,
    refresh,
  };
}

/** `GET /api/health/biomarkers/summary` with the page's filters. */
export function useBiomarkerSummary(
  params: BiomarkerSummaryParams,
  options: { enabled?: boolean } = {},
): UseResourceReturn<BiomarkerSummaryItem[]> {
  const enabled = options.enabled ?? true;
  const key = enabled ? `${params.panel ?? ''}|${params.outOfRange ? 1 : 0}` : null;
  return useResource(
    key,
    (signal) => getBiomarkerSummary(params, { signal }),
    'Failed to load your biomarkers',
  );
}

/** Every result of one analyte for the chart (the API's maximum window, five years). */
export function useBiomarkerSeries(analyteKey: string | null): UseResourceReturn<LabSeries> {
  return useResource(
    analyteKey,
    (signal) => {
      const from = new Date();
      from.setFullYear(from.getFullYear() - BIOMARKER_SERIES_YEARS);
      // A day inside the limit, so clock skew never makes the window one second too long.
      from.setDate(from.getDate() + 1);
      return getLabSeries({ metricKey: analyteKey!, from: from.toISOString() }, { signal });
    },
    'Failed to load the chart',
  );
}

/** One page of an analyte's results, newest first. */
export function useBiomarkerResults(analyteKey: string | null, page: number): UseResourceReturn<LabMeasurementPage> {
  return useResource(
    analyteKey === null ? null : `${analyteKey}|${page}`,
    (signal) => listLabResults({ metricKey: analyteKey!, page }, { signal }),
    'Failed to load the results',
  );
}

/** A reading's revisions, newest first; `id` null = closed (nothing fetched). */
export function useMeasurementRevisions(id: string | null): UseResourceReturn<MeasurementRevision[]> {
  return useResource(id, (signal) => getMeasurementRevisions(id!, { signal }), 'Failed to load the history');
}
