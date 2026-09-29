/**
 * `useExerciseHistory` (E4.4): the query it sends, one request per exercise
 * per workout (cached across remounts, shared while in flight), refresh
 * bypassing the cache, disabled requesting nothing, and an error state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { clearExerciseHistoryCache, useExerciseHistory } from '../../hooks/useExerciseHistory';

const EX = '00000000-0000-4000-8000-f00000000001';
const W1 = '00000000-0000-4000-8000-f00000000002';
const GYM = '00000000-0000-4000-8000-f00000000003';

function track() {
  const urls: string[] = [];
  server.use(
    http.get('*/api/exercises/:id/history', ({ params, request }) => {
      urls.push(request.url);
      return HttpResponse.json({
        data: {
          exerciseId: String(params.id),
          lastTime: { workoutId: W1, date: '2026-09-22', gym: null, sets: [] },
          recent: [],
          records: { maxWeightKg: null, maxReps: null, bestE1rmKg: null },
        },
      });
    }),
  );
  return urls;
}

beforeEach(() => clearExerciseHistoryCache());

describe('useExerciseHistory', () => {
  it('reads the history in the context of the workout and its gym', async () => {
    const urls = track();
    const { result } = renderHook(() => useExerciseHistory(EX, { workoutId: W1, gymId: GYM }));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.history?.lastTime?.date).toBe('2026-09-22'));
    expect(result.current.isLoading).toBe(false);
    const url = new URL(urls[0]);
    expect(url.pathname).toBe(`/api/exercises/${EX}/history`);
    expect(url.searchParams.get('workoutId')).toBe(W1);
    expect(url.searchParams.get('gymId')).toBe(GYM);
  });

  it('reads once per exercise per workout, across mounts and while in flight', async () => {
    const urls = track();
    const a = renderHook(() => useExerciseHistory(EX, { workoutId: W1 }));
    const b = renderHook(() => useExerciseHistory(EX, { workoutId: W1 }));
    await waitFor(() => expect(a.result.current.history).not.toBeNull());
    await waitFor(() => expect(b.result.current.history).not.toBeNull());
    a.unmount();
    const c = renderHook(() => useExerciseHistory(EX, { workoutId: W1 }));
    expect(c.result.current.history).not.toBeNull();
    expect(c.result.current.isLoading).toBe(false);
    expect(urls).toHaveLength(1);

    renderHook(() => useExerciseHistory(EX, { workoutId: 'other' }));
    await waitFor(() => expect(urls).toHaveLength(2));
  });

  it('refresh reads again', async () => {
    const urls = track();
    const { result } = renderHook(() => useExerciseHistory(EX, { workoutId: W1 }));
    await waitFor(() => expect(result.current.history).not.toBeNull());
    await act(() => result.current.refresh());
    expect(urls).toHaveLength(2);
  });

  it('requests nothing when disabled or without an exercise', async () => {
    const urls = track();
    const a = renderHook(() => useExerciseHistory(EX, { workoutId: W1, enabled: false }));
    const b = renderHook(() => useExerciseHistory(undefined));
    await new Promise((r) => setTimeout(r, 20));
    expect(urls).toHaveLength(0);
    expect(a.result.current.history).toBeNull();
    expect(a.result.current.isLoading).toBe(false);
    expect(b.result.current.isLoading).toBe(false);
  });

  it('reports an error and keeps history null', async () => {
    server.use(
      http.get('*/api/exercises/:id/history', () =>
        HttpResponse.json({ statusCode: 404, message: 'Exercise not found', error: 'Not Found' }, { status: 404 }),
      ),
    );
    const { result } = renderHook(() => useExerciseHistory(EX, { workoutId: W1 }));
    await waitFor(() => expect(result.current.error).toBe('Exercise not found'));
    expect(result.current.history).toBeNull();
  });
});
