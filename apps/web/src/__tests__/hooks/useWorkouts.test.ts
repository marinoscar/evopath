/** `useWorkouts` (E4.3): the history pages and the workout in progress. */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useWorkouts } from '../../hooks/useWorkouts';
import { mockWorkout, statefulWorkoutsApi } from '../mocks/fixtures/workouts';

function history(n: number) {
  return Array.from({ length: n }, (_, i) =>
    mockWorkout({
      name: `Session ${i + 1}`,
      status: 'completed',
      date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      durationSeconds: 3000,
    }),
  );
}

describe('useWorkouts', () => {
  it('loads 20 completed workouts per page, newest first, and loads more', async () => {
    statefulWorkoutsApi(history(25));
    const { result } = renderHook(() => useWorkouts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toHaveLength(20);
    expect(result.current.items[0].name).toBe('Session 25');
    expect(result.current.total).toBe(25);
    expect(result.current.hasMore).toBe(true);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items).toHaveLength(25);
    expect(result.current.hasMore).toBe(false);
  });

  it('reports the workout in progress apart from the history', async () => {
    statefulWorkoutsApi([...history(2), mockWorkout({ name: 'Now' })]);
    const { result } = renderHook(() => useWorkouts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.inProgress?.name).toBe('Now');
    expect(result.current.items.map((w) => w.name)).not.toContain('Now');
  });

  it('requests nothing when disabled', async () => {
    const api = statefulWorkoutsApi(history(1));
    const { result } = renderHook(() => useWorkouts({ enabled: false }));
    expect(result.current.isLoading).toBe(false);
    expect(api.calls).toHaveLength(0);
    expect(result.current.items).toHaveLength(0);
  });
});
