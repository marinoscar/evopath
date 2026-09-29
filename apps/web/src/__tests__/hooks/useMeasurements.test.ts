/**
 * useMeasurements (issue #60, E2.5): History's paging hook. Page size 100,
 * grouping merged across Load more, refresh reloading the pages shown, a
 * filter change starting over, and the blood-pressure pair asking for both.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../mocks/server';
import { HISTORY_PAGE_SIZE, useMeasurements } from '../../hooks/useMeasurements';
import type { MeasurementDto } from '../../services/health';
import { mockListPage, mockMeasurement } from '../mocks/fixtures/measurements';

type Req = { metricKey: string | null; page: number; pageSize: number };

/** Serves `rows()` in pages of `size`, recording each request. */
function listApi(rows: () => MeasurementDto[], size = 2, options: { delayFor?: (req: Req) => number } = {}) {
  const requests: Req[] = [];
  server.use(
    http.get('*/api/measurements', async ({ request }) => {
      const url = new URL(request.url);
      const req: Req = {
        metricKey: url.searchParams.get('metricKey'),
        page: Number(url.searchParams.get('page') ?? '1'),
        pageSize: Number(url.searchParams.get('pageSize')),
      };
      requests.push(req);
      const wait = options.delayFor?.(req) ?? 0;
      if (wait) await delay(wait);
      const all = rows().filter((r) => !req.metricKey || r.metricKey === req.metricKey);
      return HttpResponse.json({
        data: mockListPage(all.slice((req.page - 1) * size, req.page * size), {
          page: req.page,
          pageSize: size,
          total: all.length,
        }),
      });
    }),
  );
  return requests;
}

const at = (day: number) => new Date(Date.UTC(2026, 8, day, 8)).toISOString();

describe('useMeasurements', () => {
  it('loads page 1 with pageSize 100 and groups rows into entries', async () => {
    const rows = [
      mockMeasurement('weight', 80, { entryId: 'a', measuredAt: at(29) }),
      mockMeasurement('body_fat_pct', 27, { entryId: 'a', measuredAt: at(29) }),
    ];
    const requests = listApi(() => rows, 100);
    const { result } = renderHook(() => useMeasurements());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(requests[0]).toEqual({ metricKey: null, page: 1, pageSize: HISTORY_PAGE_SIZE });
    expect(HISTORY_PAGE_SIZE).toBe(100);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].readings.map((r) => r.metricKey)).toEqual(['weight', 'body_fat_pct']);
    expect(result.current.hasMore).toBe(false);
  });

  it('loadMore appends the next page and merges an entry split across pages', async () => {
    const rows = [
      mockMeasurement('weight', 80, { entryId: 'new', measuredAt: at(29) }),
      mockMeasurement('weight', 81, { entryId: 'split', measuredAt: at(20) }),
      mockMeasurement('body_fat_pct', 28, { entryId: 'split', measuredAt: at(20) }),
    ];
    const requests = listApi(() => rows, 2);
    const { result } = renderHook(() => useMeasurements());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasMore).toBe(true);
    expect(result.current.entries.map((e) => e.readings.length)).toEqual([1, 1]);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(requests.map((r) => r.page)).toEqual([1, 2]);
    expect(result.current.entries.map((e) => e.entryId)).toEqual(['new', 'split']);
    expect(result.current.entries[1].readings).toHaveLength(2);
  });

  it('refresh reloads every page already shown', async () => {
    let rows = [
      mockMeasurement('weight', 80, { entryId: 'a', measuredAt: at(29) }),
      mockMeasurement('weight', 81, { entryId: 'b', measuredAt: at(28) }),
      mockMeasurement('weight', 82, { entryId: 'c', measuredAt: at(27) }),
    ];
    const requests = listApi(() => rows, 2);
    const { result } = renderHook(() => useMeasurements());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.entries).toHaveLength(3));

    rows = rows.filter((r) => r.entryId !== 'b');
    requests.length = 0;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(requests.map((r) => r.page).sort()).toEqual([1, 2]);
    expect(result.current.entries.map((e) => e.entryId)).toEqual(['a', 'c']);
  });

  it('a filter change starts over at page 1 and a slow earlier answer never lands', async () => {
    const rows = [
      mockMeasurement('weight', 80, { entryId: 'w', measuredAt: at(29) }),
      mockMeasurement('resting_hr', 58, { entryId: 'hr', measuredAt: at(28) }),
    ];
    listApi(() => rows, 100, { delayFor: (req) => (req.metricKey === null ? 150 : 0) });
    const { result, rerender } = renderHook(({ keys }) => useMeasurements({ metricKeys: keys }), {
      initialProps: { keys: [] as string[] },
    });
    rerender({ keys: ['resting_hr'] });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.entries.map((e) => e.entryId)).toEqual(['hr']);
    await act(() => delay(200));
    expect(result.current.entries.map((e) => e.entryId)).toEqual(['hr']);
  });

  it('asks for both halves of a blood-pressure pair and shows them as one entry', async () => {
    const rows = [
      mockMeasurement('bp_systolic', 128, { entryId: 'bp', measuredAt: at(29) }),
      mockMeasurement('bp_diastolic', 84, { entryId: 'bp', measuredAt: at(29) }),
    ];
    const requests = listApi(() => rows, 100);
    const { result } = renderHook(() => useMeasurements({ metricKeys: ['bp_systolic', 'bp_diastolic'] }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(requests.map((r) => r.metricKey).sort()).toEqual(['bp_diastolic', 'bp_systolic']);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].readings).toHaveLength(2);
  });

  it('flags a 403 as forbidden', async () => {
    server.use(http.get('*/api/measurements', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })));
    const { result } = renderHook(() => useMeasurements());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.forbidden).toBe(true);
    expect(result.current.error).toBe('Forbidden');
  });
});
