import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createExercise,
  exerciseErrorMessage,
  getExercise,
  isExerciseForbidden,
  listExercises,
  type Exercise,
  type ExerciseDetail,
  type ExerciseInput,
} from '../services/exercises';
import { useIsMounted } from './useIsMounted';

/** How long the search waits after the last keystroke. */
export const EXERCISE_SEARCH_DEBOUNCE_MS = 250;

export interface UseExercisesOptions {
  q?: string;
  muscle?: string | null;
  pattern?: string | null;
  /** `true`: only custom; `false`: only the library; omitted: both. */
  custom?: boolean;
  /** Also list the caller's AI proposals awaiting approval. */
  includePending?: boolean;
  gymId?: string | null;
  availableOnly?: boolean;
  /** `false` skips the requests (the caller lacks `exercises:read`). */
  enabled?: boolean;
}

export interface UseExercisesReturn {
  exercises: Exercise[];
  isLoading: boolean;
  /** The LOAD error only; a failed mutation rejects instead. */
  error: string | null;
  /** The load answered `403`. */
  forbidden: boolean;
  /** Re-run the current query now. */
  refresh: () => void;
  /** Resolves with the created exercise, then refetches the list. */
  create: (input: ExerciseInput) => Promise<ExerciseDetail>;
}

/**
 * E4.1. `GET /api/exercises` with search and filters, debounced by
 * {@link EXERCISE_SEARCH_DEBOUNCE_MS}. A response that arrives after a newer
 * request was sent is ignored, so a slow early search never overwrites the
 * results of a later one.
 */
export function useExercises({
  q = '',
  muscle = null,
  pattern = null,
  custom,
  includePending = false,
  gymId = null,
  availableOnly = false,
  enabled = true,
}: UseExercisesOptions = {}): UseExercisesReturn {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [nonce, setNonce] = useState(0);
  const latestRequest = useRef(0);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled) return undefined;
    setIsLoading(true);
    const timer = setTimeout(() => {
      const requestId = ++latestRequest.current;
      listExercises({ q, muscle, pattern, custom, includePending, gymId, availableOnly })
        .then((data) => {
          if (!isMounted() || requestId !== latestRequest.current) return;
          setExercises(data);
          setError(null);
          setForbidden(false);
        })
        .catch((err: unknown) => {
          if (!isMounted() || requestId !== latestRequest.current) return;
          setForbidden(isExerciseForbidden(err));
          setError(exerciseErrorMessage(err, 'Failed to load exercises'));
        })
        .finally(() => {
          if (isMounted() && requestId === latestRequest.current) setIsLoading(false);
        });
    }, EXERCISE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, muscle, pattern, custom, includePending, gymId, availableOnly, enabled, nonce, isMounted]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const create = useCallback(
    async (input: ExerciseInput) => {
      const created = await createExercise(input);
      refresh();
      return created;
    },
    [refresh]
  );

  return { exercises, isLoading, error, forbidden, refresh, create };
}

export interface UseExerciseDetailReturn {
  exercise: ExerciseDetail | null;
  isLoading: boolean;
  error: string | null;
}

/** E4.1. `GET /api/exercises/:id`; `null` loads nothing (a closed drawer). */
export function useExerciseDetail(id: string | null): UseExerciseDetailReturn {
  const [exercise, setExercise] = useState<ExerciseDetail | null>(null);
  const [isLoading, setIsLoading] = useState(id !== null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (id === null) {
      setExercise(null);
      setError(null);
      setIsLoading(false);
      return undefined;
    }
    let current = true;
    setIsLoading(true);
    setError(null);
    setExercise(null);
    getExercise(id)
      .then((data) => {
        if (current && isMounted()) setExercise(data);
      })
      .catch((err: unknown) => {
        if (current && isMounted())
          setError(exerciseErrorMessage(err, 'Failed to load the exercise'));
      })
      .finally(() => {
        if (current && isMounted()) setIsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [id, isMounted]);

  return { exercise, isLoading, error };
}
