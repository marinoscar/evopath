import { useCallback, useEffect, useState } from 'react';
import {
  exerciseErrorMessage,
  getExerciseHistory,
  type ExerciseHistory,
  type ExerciseHistoryParams,
} from '../services/exercises';
import { useIsMounted } from './useIsMounted';

export interface UseExerciseHistoryOptions {
  /** The workout being logged: it is excluded, and only earlier completed workouts count. */
  workoutId?: string;
  /** Prefer this gym for "last time". */
  gymId?: string | null;
  /** Anything else that changes the answer (for example the workout's date); part of the cache key only. */
  contextKey?: string;
  /** False: nothing is requested (no `workouts:read`, or no exercise yet). */
  enabled?: boolean;
}

export interface UseExerciseHistoryReturn {
  history: ExerciseHistory | null;
  isLoading: boolean;
  error: string | null;
  /** Reads the history again, bypassing the cache. */
  refresh: () => Promise<void>;
}

/**
 * Answers per (exercise, workout, gym, context). The history of the OTHER,
 * earlier workouts does not change while a workout is logged, so each card
 * reads it once; remounting a card (reordering, navigating back) reuses it.
 */
const cache = new Map<string, ExerciseHistory>();
const inflight = new Map<string, Promise<ExerciseHistory>>();

/** Test helper: forget every cached answer. */
export function clearExerciseHistoryCache(): void {
  cache.clear();
  inflight.clear();
}

function keyFor(exerciseId: string, options: UseExerciseHistoryOptions): string {
  return [exerciseId, options.workoutId ?? '', options.gymId ?? '', options.contextKey ?? ''].join('|');
}

function fetchShared(key: string, exerciseId: string, params: ExerciseHistoryParams, force: boolean) {
  const running = inflight.get(key);
  if (running && !force) return running;
  const promise = getExerciseHistory(exerciseId, params).then(
    (data) => {
      cache.set(key, data);
      if (inflight.get(key) === promise) inflight.delete(key);
      return data;
    },
    (err: unknown) => {
      if (inflight.get(key) === promise) inflight.delete(key);
      throw err;
    },
  );
  inflight.set(key, promise);
  return promise;
}

/**
 * E4.4. `GET /exercises/:id/history` for one exercise card: "last time" and
 * the all-time records, as the API computed them. A failure leaves
 * `history` null with an `error`; the card still logs sets without it.
 */
export function useExerciseHistory(
  exerciseId: string | undefined,
  options: UseExerciseHistoryOptions = {},
): UseExerciseHistoryReturn {
  const { workoutId, gymId, contextKey, enabled = true } = options;
  const key = exerciseId ? keyFor(exerciseId, { workoutId, gymId, contextKey }) : null;
  const active = enabled && key !== null;
  const [history, setHistory] = useState<ExerciseHistory | null>(() => (key ? (cache.get(key) ?? null) : null));
  const [isLoading, setIsLoading] = useState(() => active && key !== null && !cache.has(key));
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(
    async (force: boolean) => {
      if (!active || !key || !exerciseId) return;
      const cached = cache.get(key);
      if (cached && !force) {
        setHistory(cached);
        setIsLoading(false);
        setError(null);
        return;
      }
      setIsLoading(true);
      setError(null);
      const params: ExerciseHistoryParams = {};
      if (workoutId) params.workoutId = workoutId;
      if (gymId) params.gymId = gymId;
      try {
        const data = await fetchShared(key, exerciseId, params, force);
        if (isMounted()) setHistory(data);
      } catch (err) {
        if (isMounted()) setError(exerciseErrorMessage(err, 'Could not load the history'));
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [active, key, exerciseId, workoutId, gymId, isMounted],
  );

  useEffect(() => {
    if (!active) {
      setHistory(null);
      setIsLoading(false);
      return;
    }
    setHistory(key ? (cache.get(key) ?? null) : null);
    void load(false);
  }, [active, key, load]);

  const refresh = useCallback(() => load(true), [load]);

  return { history, isLoading, error, refresh };
}
