import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useLatestMeasurements } from '../../hooks/useLatestMeasurements';
import { mockLatest, mockLatestEmpty, mockMeasurement } from '../mocks/fixtures/measurements';

describe('useLatestMeasurements', () => {
  it('loads the items', async () => {
    const { result } = renderHook(() => useLatestMeasurements());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toEqual(mockLatestEmpty);
    expect(result.current.error).toBeNull();
    expect(result.current.forbidden).toBe(false);
  });

  it('refresh refetches', async () => {
    const { result } = renderHook(() => useLatestMeasurements());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const items = mockLatest({ weight: { latest: mockMeasurement('weight', 80) } });
    server.use(http.get('*/api/measurements/latest', () => HttpResponse.json({ data: { items } })));
    await act(() => result.current.refresh());
    expect(result.current.items).toEqual(items);
  });

  it('flags a 403 as forbidden', async () => {
    server.use(
      http.get('*/api/measurements/latest', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })),
    );
    const { result } = renderHook(() => useLatestMeasurements());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.forbidden).toBe(true);
    expect(result.current.error).toBe('Forbidden');
  });

  it('reports a network failure without forbidden', async () => {
    server.use(http.get('*/api/measurements/latest', () => HttpResponse.error()));
    const { result } = renderHook(() => useLatestMeasurements());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.forbidden).toBe(false);
    expect(result.current.error).toBe('Failed to load your measurements');
  });

  it('does not fetch while disabled', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/measurements/latest', () => {
        calls += 1;
        return HttpResponse.json({ data: { items: [] } });
      }),
    );
    const { result } = renderHook(() => useLatestMeasurements({ enabled: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(calls).toBe(0);
  });
});
