/**
 * useMeasurementSeries (issue #60, E2.5): `from` = now − days, one request per
 * metric key, stale answers dropped, refresh keeping the data on screen.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../mocks/server';
import { useMeasurementSeries } from '../../hooks/useMeasurementSeries';
import { mockSeries, mockSeriesPoint } from '../mocks/fixtures/measurements';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function seriesApi(delayFor: (metricKey: string, from: string | null) => number = () => 0) {
  const requests: Array<{ metricKey: string; from: string | null }> = [];
  server.use(
    http.get('*/api/measurements/series', async ({ request }) => {
      const url = new URL(request.url);
      const metricKey = url.searchParams.get('metricKey')!;
      const from = url.searchParams.get('from');
      requests.push({ metricKey, from });
      const wait = delayFor(metricKey, from);
      if (wait) await delay(wait);
      const days = from ? Math.round((NOW - Date.parse(from)) / DAY_MS) : 0;
      return HttpResponse.json({
        data: mockSeries(metricKey, [mockSeriesPoint(new Date(NOW - DAY_MS).toISOString(), days)]),
      });
    }),
  );
  return requests;
}

describe('useMeasurementSeries', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('requests from = now − days and exposes points, unit and range', async () => {
    const requests = seriesApi();
    const { result } = renderHook(() => useMeasurementSeries(['weight'], 30));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(requests).toEqual([{ metricKey: 'weight', from: new Date(NOW - 30 * DAY_MS).toISOString() }]);
    expect(result.current.points).toHaveLength(1);
    expect(result.current.unit).toBe('kg');
    expect(result.current.range?.from.getTime()).toBe(NOW - 30 * DAY_MS);
    expect(result.current.truncated).toBe(false);
  });

  it('makes one request per metric key (blood pressure)', async () => {
    const requests = seriesApi();
    const { result } = renderHook(() => useMeasurementSeries(['bp_systolic', 'bp_diastolic'], 90));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(requests.map((r) => r.metricKey)).toEqual(['bp_systolic', 'bp_diastolic']);
    expect(result.current.series.map((s) => s.metricKey)).toEqual(['bp_systolic', 'bp_diastolic']);
  });

  it('drops a slower answer for an earlier range', async () => {
    seriesApi((_key, from) => (from === new Date(NOW - 30 * DAY_MS).toISOString() ? 150 : 0));
    const { result, rerender } = renderHook(({ days }) => useMeasurementSeries(['weight'], days), {
      initialProps: { days: 30 },
    });
    rerender({ days: 365 });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.points[0].value).toBe(365);
    await act(() => delay(200));
    expect(result.current.points[0].value).toBe(365);
  });

  it('refresh refetches and keeps the previous data meanwhile', async () => {
    const requests = seriesApi(() => 50);
    const { result } = renderHook(() => useMeasurementSeries(['weight'], 90));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.refresh());
    expect(result.current.points).toHaveLength(1);
    await waitFor(() => expect(requests).toHaveLength(2));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('does nothing when disabled', async () => {
    const requests = seriesApi();
    const { result } = renderHook(() => useMeasurementSeries(['weight'], 90, { enabled: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(requests).toHaveLength(0);
  });

  it('flags a 403 as forbidden', async () => {
    server.use(
      http.get('*/api/measurements/series', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })),
    );
    const { result } = renderHook(() => useMeasurementSeries(['weight'], 90));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.forbidden).toBe(true);
  });
});
