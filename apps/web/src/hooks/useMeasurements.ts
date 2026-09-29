import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { listMeasurements, MEASUREMENTS_PAGE_SIZE_MAX, type MeasurementDto } from '../services/health';
import { groupByEntry, type HistoryEntry } from '../utils/measurementSeries';
import { useIsMounted } from './useIsMounted';

/** Readings per request: the API's maximum, so most histories are one page. */
export const HISTORY_PAGE_SIZE = MEASUREMENTS_PAGE_SIZE_MAX;

export interface UseMeasurementsReturn {
  /** Loaded readings grouped by entry, newest first (merged across pages). */
  entries: HistoryEntry[];
  /** More readings exist beyond the loaded pages. */
  hasMore: boolean;
  /** Append the next page (a no-op while loading or without `hasMore`). */
  loadMore: () => void;
  /** First load, a filter change or a refresh. */
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  /** The API answered `403`: no health-data grant, nothing to retry. */
  forbidden: boolean;
  /** Reload every page loaded so far (after an edit, a delete, a new reading). */
  refresh: () => void;
}

type PageResult = { rows: MeasurementDto[]; hasMore: boolean };

/**
 * One page of the list for `metricKeys`: all metrics when empty, else one
 * request per key (the blood-pressure pair asks for systolic AND diastolic,
 * so each row shows both numbers) merged. Each entry of a pair has exactly one
 * reading of each, in the same order, so their page N cover the same entries.
 */
async function fetchPage(metricKeys: readonly string[], page: number, signal: AbortSignal): Promise<PageResult> {
  const keys = metricKeys.length === 0 ? [undefined] : metricKeys;
  const pages = await Promise.all(
    keys.map((metricKey) =>
      listMeasurements({ metricKey, page, pageSize: HISTORY_PAGE_SIZE }, { signal }),
    ),
  );
  return {
    rows: pages.flatMap((p) => p.items),
    hasMore: pages.some((p) => p.page < p.totalPages),
  };
}

/**
 * Issue #60 (E2.5). The History list: `GET /api/measurements`, `pageSize`
 * 100, newest first, grouped into entries in the client
 * (`groupByEntry`), so an entry split across two pages becomes one row once
 * both are loaded. `Load more` appends; a filter change starts over and
 * cancels whatever was in flight; `refresh` reloads the pages already shown.
 */
export function useMeasurements(
  options: { metricKeys?: readonly string[]; enabled?: boolean } = {},
): UseMeasurementsReturn {
  const enabled = options.enabled ?? true;
  const keysId = (options.metricKeys ?? []).join(',');
  const [rows, setRows] = useState<MeasurementDto[]>([]);
  const [pagesLoaded, setPagesLoaded] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const pagesRef = useRef(0);
  const isMounted = useIsMounted();

  const fail = useCallback((err: unknown) => {
    setForbidden(err instanceof ApiError && err.status === 403);
    setError(err instanceof ApiError ? err.message : 'Failed to load your history');
  }, []);

  const begin = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return { id: ++requestId.current, controller };
  }, []);

  // A filter change resets to page 1; a refresh reloads pages 1..N.
  const lastKeys = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    const filterChanged = lastKeys.current !== keysId;
    lastKeys.current = keysId;
    const pageCount = filterChanged ? 1 : Math.max(1, pagesRef.current);
    if (filterChanged) {
      setRows([]);
      setHasMore(false);
      pagesRef.current = 0;
      setPagesLoaded(0);
    }
    const { id, controller } = begin();
    const keys = keysId === '' ? [] : keysId.split(',');
    setIsLoading(true);
    setIsLoadingMore(false);
    setError(null);

    Promise.all(
      Array.from({ length: pageCount }, (_, index) => fetchPage(keys, index + 1, controller.signal)),
    ).then(
      (pages) => {
        if (!isMounted() || id !== requestId.current) return;
        setRows(pages.flatMap((p) => p.rows));
        setHasMore(pages[pages.length - 1].hasMore);
        pagesRef.current = pageCount;
        setPagesLoaded(pageCount);
        setForbidden(false);
        setIsLoading(false);
      },
      (err: unknown) => {
        if (!isMounted() || id !== requestId.current || controller.signal.aborted) return;
        fail(err);
        setIsLoading(false);
      },
    );
  }, [enabled, keysId, attempt, begin, fail, isMounted]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const loadMore = useCallback(() => {
    if (isLoading || isLoadingMore || !hasMore) return;
    const { id, controller } = begin();
    const keys = keysId === '' ? [] : keysId.split(',');
    const next = pagesLoaded + 1;
    setIsLoadingMore(true);
    setError(null);
    fetchPage(keys, next, controller.signal).then(
      (page) => {
        if (!isMounted() || id !== requestId.current) return;
        setRows((prev) => [...prev, ...page.rows]);
        setHasMore(page.hasMore);
        pagesRef.current = next;
        setPagesLoaded(next);
        setIsLoadingMore(false);
      },
      (err: unknown) => {
        if (!isMounted() || id !== requestId.current || controller.signal.aborted) return;
        fail(err);
        setIsLoadingMore(false);
      },
    );
  }, [isLoading, isLoadingMore, hasMore, begin, keysId, pagesLoaded, fail, isMounted]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  const entries = useMemo(() => groupByEntry(rows), [rows]);

  return { entries, hasMore, loadMore, isLoading, isLoadingMore, error, forbidden, refresh };
}
