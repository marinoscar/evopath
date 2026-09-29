/**
 * `useMeasurementCatalog` (#53, E2.3): one request per session, shared by
 * every consumer; a failure is not cached.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { resetMeasurementCatalogCache, useMeasurementCatalog } from '../../hooks/useMeasurementCatalog';
import { mockMetricCatalog } from '../mocks/fixtures/measurements';

function countRequests(respond: () => Response) {
  const counter = { n: 0 };
  server.use(
    http.get('*/api/measurements/metrics', () => {
      counter.n += 1;
      return respond();
    }),
  );
  return counter;
}

describe('useMeasurementCatalog', () => {
  beforeEach(() => {
    resetMeasurementCatalogCache();
  });

  it('loads the catalog', async () => {
    const { result } = renderHook(() => useMeasurementCatalog());
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.catalog).toEqual(mockMetricCatalog);
    expect(result.current.error).toBeNull();
  });

  it('shares one request between concurrent and later consumers', async () => {
    const counter = countRequests(() => HttpResponse.json({ data: mockMetricCatalog }));
    const a = renderHook(() => useMeasurementCatalog());
    const b = renderHook(() => useMeasurementCatalog());
    await waitFor(() => expect(a.result.current.catalog).not.toBeNull());
    await waitFor(() => expect(b.result.current.catalog).not.toBeNull());

    const c = renderHook(() => useMeasurementCatalog());
    // A later mount reads the cached value synchronously.
    expect(c.result.current.catalog).toEqual(mockMetricCatalog);
    expect(c.result.current.isLoading).toBe(false);
    expect(counter.n).toBe(1);
  });

  it('does not fetch while disabled', async () => {
    const counter = countRequests(() => HttpResponse.json({ data: mockMetricCatalog }));
    const { result } = renderHook(() => useMeasurementCatalog({ enabled: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.catalog).toBeNull();
    expect(counter.n).toBe(0);
  });

  it('reports a failure, does not cache it, and refresh retries', async () => {
    let fail = true;
    const counter = countRequests(() =>
      fail
        ? HttpResponse.json({ message: 'Forbidden' }, { status: 403 })
        : HttpResponse.json({ data: mockMetricCatalog }),
    );
    const { result } = renderHook(() => useMeasurementCatalog());
    await waitFor(() => expect(result.current.error).toBe('Forbidden'));
    expect(result.current.errorStatus).toBe(403);
    expect(result.current.catalog).toBeNull();

    fail = false;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.catalog).toEqual(mockMetricCatalog));
    expect(result.current.error).toBeNull();
    expect(counter.n).toBe(2);
  });
});
