import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useCheckIn } from '../../hooks/useCheckIn';
import { useCheckInHistory } from '../../hooks/useCheckInHistory';
import { MOCK_CHECK_IN_TODAY, mockCheckIn } from '../mocks/fixtures/checkIns';

const INPUT = { energy: 4, sleepQuality: 3, soreness: 2, stress: 3, note: 'Big presentation' };

describe('useCheckIn', () => {
  it('loads the server day and no check-in', async () => {
    const { result } = renderHook(() => useCheckIn());
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.date).toBe(MOCK_CHECK_IN_TODAY);
    expect(result.current.checkIn).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('save updates today and resolves with the stored check-in', async () => {
    const { result } = renderHook(() => useCheckIn());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let saved: unknown;
    await act(async () => {
      saved = await result.current.save(MOCK_CHECK_IN_TODAY, INPUT);
    });
    expect(saved).toMatchObject({ date: MOCK_CHECK_IN_TODAY, energy: 4 });
    expect(result.current.checkIn).toMatchObject({ energy: 4, note: 'Big presentation' });
  });

  it('save for another day (a dialog opened before midnight) leaves today alone', async () => {
    const { result } = renderHook(() => useCheckIn());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.save('2026-09-28', INPUT);
    });
    expect(result.current.checkIn).toBeNull();
  });

  it('save rejects with the ApiError on a 409', async () => {
    server.use(
      http.put('*/api/check-ins/:date', () =>
        HttpResponse.json({ message: 'Updated elsewhere' }, { status: 409 }),
      ),
    );
    const { result } = renderHook(() => useCheckIn());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await expect(result.current.save(MOCK_CHECK_IN_TODAY, INPUT)).rejects.toMatchObject({ status: 409 });
  });

  it('remove clears today, and a 404 counts as deleted', async () => {
    server.use(
      http.get('*/api/check-ins/today', () =>
        HttpResponse.json({ data: { date: MOCK_CHECK_IN_TODAY, checkIn: mockCheckIn() } }),
      ),
      http.delete('*/api/check-ins/:date', () => HttpResponse.json({ message: 'Not found' }, { status: 404 })),
    );
    const { result } = renderHook(() => useCheckIn());
    await waitFor(() => expect(result.current.checkIn).not.toBeNull());
    await act(() => result.current.remove(MOCK_CHECK_IN_TODAY));
    expect(result.current.checkIn).toBeNull();
  });

  it('remove rethrows anything but a 404', async () => {
    server.use(http.delete('*/api/check-ins/:date', () => HttpResponse.json({ message: 'Boom' }, { status: 500 })));
    const { result } = renderHook(() => useCheckIn());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await expect(result.current.remove(MOCK_CHECK_IN_TODAY)).rejects.toMatchObject({ status: 500 });
  });

  it('flags a 403 as forbidden', async () => {
    server.use(http.get('*/api/check-ins/today', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })));
    const { result } = renderHook(() => useCheckIn());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.forbidden).toBe(true);
    expect(result.current.error).toBe('Forbidden');
  });

  it('reports a network failure without forbidden', async () => {
    server.use(http.get('*/api/check-ins/today', () => HttpResponse.error()));
    const { result } = renderHook(() => useCheckIn());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.forbidden).toBe(false);
    expect(result.current.error).toBe("Failed to load today's check-in");
  });

  it('does not fetch while disabled', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/check-ins/today', () => {
        calls += 1;
        return HttpResponse.json({ data: { date: MOCK_CHECK_IN_TODAY, checkIn: null } });
      }),
    );
    const { result } = renderHook(() => useCheckIn({ enabled: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(calls).toBe(0);
  });
});

describe('useCheckInHistory', () => {
  it('loads the last N days and refetches on refresh', async () => {
    let days: string | null = null;
    let items = [mockCheckIn()];
    server.use(
      http.get('*/api/check-ins', ({ request }) => {
        days = new URL(request.url).searchParams.get('days');
        return HttpResponse.json({ data: { items } });
      }),
    );
    const { result } = renderHook(() => useCheckInHistory(14));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(days).toBe('14');
    expect(result.current.items).toHaveLength(1);

    items = [mockCheckIn(), mockCheckIn({ date: '2026-09-28' })];
    await act(() => result.current.refresh());
    expect(result.current.items).toHaveLength(2);
  });

  it('reports an error', async () => {
    server.use(http.get('*/api/check-ins', () => HttpResponse.error()));
    const { result } = renderHook(() => useCheckInHistory(14));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Failed to load your check-ins');
  });
});
