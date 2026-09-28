/**
 * The Telemetry Dashboard's data — issue #578, epic #576.
 *
 * One hook per endpoint, each fetching INDEPENDENTLY: a panel whose request
 * fails (or is slow) never holds up or blanks another. Every hook
 *
 * - aborts the request in flight when a newer one starts (a filter change, an
 *   auto-refresh tick or a Retry), so overlapping responses can never land out
 *   of order;
 * - keeps the last good result on screen while it refreshes (`isRefreshing`),
 *   and reports `isLoading` only before the first result;
 * - reports failures as {@link TelemetryErrorInfo}, whose `reason` is the
 *   API's `details.reason` (`TELEMETRY_UNREACHABLE`, …).
 *
 * `tick` is the page's refresh counter: bumping it refetches with the same
 * parameters. Polling itself (and pausing it in a hidden tab) is the page's
 * job, through `useVisiblePolling`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDashboardEvents,
  getDashboardFilters,
  getDashboardSummary,
  getDashboardTimeseries,
  getDashboardTop,
  type DashboardEvent,
  type DashboardEvents,
  type DashboardEventsQuery,
  type DashboardFilters,
  type DashboardQuery,
  type DashboardSummary,
  type DashboardTimeseries,
  type DashboardTimeseriesPanel,
  type DashboardTop,
  type DashboardTopKind,
} from '../services/telemetryDashboard';
import { toTelemetryError, type TelemetryErrorInfo } from './useTelemetryExplorer';

export interface DashboardResource<T> {
  data: T | null;
  error: TelemetryErrorInfo | null;
  /** No result yet and a request in flight. */
  isLoading: boolean;
  /** A result is on screen and a newer one is in flight. */
  isRefreshing: boolean;
  /** `Date.now()` when the last result arrived. */
  fetchedAt: number | null;
  /** Refetch now (a panel's Retry). */
  reload: () => void;
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * The shared fetch-with-abort engine. `key` identifies the parameters (a new
 * key refetches); `fetcher` is read through a ref so a fresh closure every
 * render does not refetch on its own.
 */
function useDashboardResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  tick: number,
  fallbackMessage: string,
): DashboardResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<TelemetryErrorInfo | null>(null);
  const [isFetching, setIsFetching] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    setIsFetching(true);
    fetcherRef
      .current(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
        setError(null);
        setFetchedAt(Date.now());
      })
      .catch((err: unknown) => {
        if (isAbort(err) || controller.signal.aborted) return;
        setError(toTelemetryError(err, fallbackMessage));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsFetching(false);
      });
    return () => controller.abort();
  }, [key, tick, reloadCount, fallbackMessage]);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  return {
    data,
    error,
    isLoading: isFetching && data === null,
    isRefreshing: isFetching && data !== null,
    fetchedAt,
    reload,
  };
}

const keyOf = (value: unknown) => JSON.stringify(value);

/** `GET …/summary` — verdict, tiles and optional runtime tiles. */
export function useDashboardSummary(query: DashboardQuery, tick: number) {
  return useDashboardResource<DashboardSummary>(
    keyOf(query),
    (signal) => getDashboardSummary(query, { signal }),
    tick,
    'Failed to load the summary',
  );
}

/** `GET …/timeseries?panel=api|logs`. */
export function useDashboardTimeseries<P extends DashboardTimeseriesPanel>(
  panel: P,
  query: DashboardQuery,
  tick: number,
) {
  return useDashboardResource<DashboardTimeseries<P>>(
    keyOf([panel, query]),
    (signal) => getDashboardTimeseries(panel, query, { signal }),
    tick,
    'Failed to load the time series',
  );
}

/** `GET …/top?kind=routes|errors`. */
export function useDashboardTop<K extends DashboardTopKind>(kind: K, query: DashboardQuery, tick: number) {
  return useDashboardResource<DashboardTop<K>>(
    keyOf([kind, query]),
    (signal) => getDashboardTop(kind, query, { signal }),
    tick,
    'Failed to load the top list',
  );
}

/** `GET …/filters` — the services and instances seen in the window. */
export function useDashboardFilters(query: Pick<DashboardQuery, 'range' | 'from' | 'to'>, tick: number) {
  return useDashboardResource<DashboardFilters>(
    keyOf(query),
    (signal) => getDashboardFilters(query, { signal }),
    tick,
    'Failed to load the filter values',
  );
}

export interface DashboardEventsResource extends DashboardResource<DashboardEvents> {
  /** Every page loaded so far, newest first. */
  items: DashboardEvent[];
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: TelemetryErrorInfo | null;
  loadMore: () => void;
}

/**
 * `GET …/events` with keyset paging. A new query (filters, severity, search)
 * or a refresh replaces the list with its first page — EXCEPT that an
 * auto-refresh tick is skipped while the reader has paged past the first page,
 * so the rows they scrolled to do not collapse under them every 30 seconds.
 */
export function useDashboardEvents(query: DashboardEventsQuery, tick: number): DashboardEventsResource {
  const key = keyOf(query);
  const [pages, setPages] = useState<DashboardEvents[]>([]);
  const [error, setError] = useState<TelemetryErrorInfo | null>(null);
  const [isFetching, setIsFetching] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<TelemetryErrorInfo | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  const queryRef = useRef(query);
  queryRef.current = query;
  const controllerRef = useRef<AbortController | null>(null);
  const pagedRef = useRef<{ key: string; paged: boolean }>({ key, paged: false });
  const lastRunRef = useRef<{ key: string; reloadCount: number } | null>(null);

  useEffect(() => {
    const last = lastRunRef.current;
    const onlyTick = last !== null && last.key === key && last.reloadCount === reloadCount;
    if (onlyTick && pagedRef.current.key === key && pagedRef.current.paged) return;
    lastRunRef.current = { key, reloadCount };

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsFetching(true);
    setIsLoadingMore(false);
    setLoadMoreError(null);
    getDashboardEvents(queryRef.current, { signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        pagedRef.current = { key, paged: false };
        setPages([page]);
        setError(null);
        setFetchedAt(Date.now());
      })
      .catch((err: unknown) => {
        if (isAbort(err) || controller.signal.aborted) return;
        setError(toTelemetryError(err, 'Failed to load events'));
      })
      .finally(() => {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setIsFetching(false);
        }
      });
  }, [key, tick, reloadCount]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const last = pages.length > 0 ? pages[pages.length - 1] : null;
  const nextCursor = last?.nextCursor ?? null;

  const loadMore = useCallback(() => {
    if (!nextCursor || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    getDashboardEvents({ ...queryRef.current, cursor: nextCursor }, { signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        pagedRef.current = { key: keyOf(queryRef.current), paged: true };
        setPages((prev) => [...prev, page]);
      })
      .catch((err: unknown) => {
        if (isAbort(err) || controller.signal.aborted) return;
        setLoadMoreError(toTelemetryError(err, 'Failed to load more events'));
      })
      .finally(() => {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setIsLoadingMore(false);
        }
      });
  }, [nextCursor]);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  const data = pages[0] ?? null;

  return {
    data,
    error,
    isLoading: isFetching && data === null,
    isRefreshing: isFetching && data !== null,
    fetchedAt,
    reload,
    items: pages.flatMap((page) => page.items),
    hasMore: nextCursor !== null,
    isLoadingMore,
    loadMoreError,
    loadMore,
  };
}
