import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listWorkouts,
  workoutErrorMessage,
  WORKOUT_LIST_PAGE_SIZE_DEFAULT,
  type WorkoutListItem,
} from '../services/workouts';
import { useIsMounted } from './useIsMounted';

export interface UseWorkoutsOptions {
  /** `false` skips the requests (the caller lacks `workouts:read`). */
  enabled?: boolean;
  pageSize?: number;
}

export interface UseWorkoutsReturn {
  /** Completed workouts, newest first, every page loaded so far. */
  items: WorkoutListItem[];
  total: number;
  hasMore: boolean;
  /** The workout in progress, if any (shown as the Resume banner). */
  inProgress: WorkoutListItem | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  /** The LOAD error (first page or a later one). */
  error: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * E4.3. The Train page's history (`GET /workouts?status=completed`, 20 per
 * page, "Load more" appends the next page) and the workout in progress
 * (`GET /workouts?status=in_progress&pageSize=1`).
 */
export function useWorkouts({
  enabled = true,
  pageSize = WORKOUT_LIST_PAGE_SIZE_DEFAULT,
}: UseWorkoutsOptions = {}): UseWorkoutsReturn {
  const [items, setItems] = useState<WorkoutListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [inProgress, setInProgress] = useState<WorkoutListItem | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const gen = ++generation.current;
    setIsLoading(true);
    setError(null);
    try {
      const [history, active] = await Promise.all([
        listWorkouts({ status: 'completed', page: 1, pageSize }),
        listWorkouts({ status: 'in_progress', page: 1, pageSize: 1 }),
      ]);
      if (!isMounted() || gen !== generation.current) return;
      setItems(history.items);
      setTotal(history.total);
      setPage(history.page);
      setTotalPages(history.totalPages);
      setInProgress(active.items[0] ?? null);
    } catch (err) {
      if (isMounted() && gen === generation.current) {
        setError(workoutErrorMessage(err, 'Failed to load your workouts'));
      }
    } finally {
      if (isMounted() && gen === generation.current) setIsLoading(false);
    }
  }, [enabled, pageSize, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!enabled || isLoadingMore || page >= totalPages) return;
    const gen = generation.current;
    setIsLoadingMore(true);
    setError(null);
    try {
      const next = await listWorkouts({ status: 'completed', page: page + 1, pageSize });
      if (!isMounted() || gen !== generation.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((w) => w.id));
        return [...prev, ...next.items.filter((w) => !seen.has(w.id))];
      });
      setTotal(next.total);
      setPage(next.page);
      setTotalPages(next.totalPages);
    } catch (err) {
      if (isMounted()) setError(workoutErrorMessage(err, 'Failed to load more workouts'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [enabled, isLoadingMore, page, totalPages, pageSize, isMounted]);

  return {
    items,
    total,
    hasMore: page < totalPages,
    inProgress,
    isLoading,
    isLoadingMore,
    error,
    loadMore,
    refresh,
  };
}

/** How many recent workouts feed the picker's Recent section. */
export const RECENT_WORKOUTS_FOR_PICKER = 5;

/**
 * E4.3. The exercises of the user's last {@link RECENT_WORKOUTS_FOR_PICKER}
 * workouts, most recent first, each once (derived client-side from
 * `GET /workouts`). Empty on failure: Recent is a convenience.
 */
export function useRecentExercises(enabled: boolean): Array<{ id: string; name: string }> {
  const [recent, setRecent] = useState<Array<{ id: string; name: string }>>([]);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled) return;
    listWorkouts({ page: 1, pageSize: RECENT_WORKOUTS_FOR_PICKER })
      .then((data) => {
        if (!isMounted()) return;
        const seen = new Set<string>();
        const out: Array<{ id: string; name: string }> = [];
        for (const workout of data.items) {
          for (const exercise of workout.exercises) {
            if (seen.has(exercise.id)) continue;
            seen.add(exercise.id);
            out.push(exercise);
          }
        }
        setRecent(out);
      })
      .catch(() => {
        if (isMounted()) setRecent([]);
      });
  }, [enabled, isMounted]);

  return recent;
}
