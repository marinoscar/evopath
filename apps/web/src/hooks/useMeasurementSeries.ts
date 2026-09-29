import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { getMeasurementSeries, type MeasurementSeries } from '../services/health';
import { useIsMounted } from './useIsMounted';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UseMeasurementSeriesReturn {
  /** One per requested metric key, in the same order; `[]` until loaded. */
  series: MeasurementSeries[];
  /** The first metric's points (the single-metric case). */
  points: MeasurementSeries['points'];
  /** The first metric's canonical unit, `null` until loaded. */
  unit: string | null;
  /** Any metric's range held more than 1000 points (the newest were kept). */
  truncated: boolean;
  /** The window that was requested: `from` = `to` − `days`. */
  range: { from: Date; to: Date } | null;
  isLoading: boolean;
  error: string | null;
  /** The API answered `403`: no health-data grant, nothing to retry. */
  forbidden: boolean;
  /** Refetch the current metric and range (after an edit, a delete, a new reading). */
  refresh: () => void;
}

/**
 * Issue #60 (E2.5). Chart points for one metric, or several read together
 * (blood pressure: `['bp_systolic', 'bp_diastolic']`, one request each),
 * over the last `days` days from `GET /api/measurements/series`.
 *
 * `from` is computed ONCE per (metrics, days) change or refresh, not per
 * render. A change of metric or range cancels the request in flight
 * (`AbortController`) and a request-id guard drops any answer that still
 * arrives late, so a slow response can never overwrite a newer one. The
 * previous data is dropped on a metric/range change (it would be mislabelled)
 * and kept on a refresh (no flicker).
 */
export function useMeasurementSeries(
  metricKeys: readonly string[],
  days: number,
  options: { enabled?: boolean } = {},
): UseMeasurementSeriesReturn {
  const enabled = options.enabled ?? true;
  const keysId = metricKeys.join(',');
  const selection = `${keysId}|${days}`;
  const [state, setState] = useState<{
    selection: string;
    series: MeasurementSeries[];
    range: { from: Date; to: Date } | null;
  }>({ selection, series: [], range: null });
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  const isMounted = useIsMounted();
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || keysId === '') {
      setIsLoading(false);
      return;
    }
    const id = ++requestId.current;
    const controller = new AbortController();
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);
    setIsLoading(true);
    setError(null);

    Promise.all(
      keysId.split(',').map((metricKey) =>
        getMeasurementSeries({ metricKey, from: from.toISOString() }, { signal: controller.signal }),
      ),
    ).then(
      (series) => {
        if (!isMounted() || id !== requestId.current) return;
        setState({ selection, series, range: { from, to } });
        setForbidden(false);
        setIsLoading(false);
      },
      (err: unknown) => {
        if (!isMounted() || id !== requestId.current || controller.signal.aborted) return;
        setForbidden(err instanceof ApiError && err.status === 403);
        setError(err instanceof ApiError ? err.message : 'Failed to load the chart');
        setIsLoading(false);
      },
    );

    return () => controller.abort();
  }, [enabled, keysId, days, selection, attempt, isMounted]);

  const current = state.selection === selection;
  const series = current ? state.series : [];

  return {
    series,
    points: series[0]?.points ?? [],
    unit: series[0]?.unit ?? null,
    truncated: series.some((s) => s.truncated),
    range: current ? state.range : null,
    isLoading: isLoading || (!current && enabled && error === null),
    error,
    forbidden,
    refresh,
  };
}
