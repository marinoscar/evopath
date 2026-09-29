import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addSet as addSetCall,
  addWorkoutExercise,
  deleteSet as deleteSetCall,
  deleteWorkout,
  finishWorkout,
  getWorkout,
  isWorkoutNotFound,
  removeWorkoutExercise,
  updateSet as updateSetCall,
  updateWorkout,
  updateWorkoutExercise,
  workoutErrorMessage,
  type FinishWorkoutInput,
  type SetInput,
  type SetLogView,
  type UpdateWorkoutExerciseInput,
  type UpdateWorkoutInput,
  type Workout,
  type WorkoutExerciseView,
} from '../services/workouts';
import { useIsMounted } from './useIsMounted';

export interface UseWorkoutReturn {
  workout: Workout | null;
  isLoading: boolean;
  /** The LOAD error only; a failed mutation rejects instead. */
  error: string | null;
  /** The workout answered `404` (deleted, or not the caller's). */
  notFound: boolean;
  refresh: () => Promise<void>;
  update: (input: UpdateWorkoutInput) => Promise<Workout>;
  finish: (input?: FinishWorkoutInput) => Promise<Workout>;
  remove: () => Promise<void>;
  /** Adds the exercises one after another, in the order given. */
  addExercises: (exerciseIds: string[]) => Promise<WorkoutExerciseView[]>;
  /** Moves an entry one place up (`-1`) or down (`1`). */
  moveExercise: (weId: string, direction: -1 | 1) => Promise<void>;
  updateExercise: (weId: string, input: UpdateWorkoutExerciseInput) => Promise<WorkoutExerciseView>;
  removeExercise: (weId: string) => Promise<void>;
  /** An empty body lets the server copy weight/reps/time/distance from the previous set. */
  addSet: (weId: string, input?: SetInput, options?: AddSetOptions) => Promise<SetLogView>;
  /** Optimistic; reconciles with the server's answer, reverts on failure and rejects. */
  updateSet: (setId: string, input: SetInput) => Promise<SetLogView>;
  deleteSet: (setId: string) => Promise<void>;
  /** Resolves once every mutation in flight has settled. */
  settle: () => Promise<void>;
  /**
   * Deletes the rows added automatically after a completed set that are
   * still untouched and not done; resolves with their ids.
   */
  discardUntouchedAutoSets: () => Promise<string[]>;
}

export interface AddSetOptions {
  /**
   * The client added this row by itself (after the previous set was
   * completed). Until the user edits it, Finish discards it instead of
   * asking about it.
   */
  auto?: boolean;
}

/** How long after an edit to a completed workout its totals are read again. */
export const SUMMARY_REFRESH_DELAY_MS = 800;

function mapSets(
  workout: Workout,
  fn: (set: SetLogView, entry: WorkoutExerciseView) => SetLogView | null,
): Workout {
  return {
    ...workout,
    exercises: workout.exercises.map((entry) => {
      let changed = false;
      const sets: SetLogView[] = [];
      for (const set of entry.sets) {
        const next = fn(set, entry);
        if (next !== set) changed = true;
        if (next) sets.push(next);
      }
      if (!changed) return entry;
      return { ...entry, sets: sets.map((s, i) => (s.setNumber === i + 1 ? s : { ...s, setNumber: i + 1 })) };
    }),
  };
}

/** Apply a set body locally, the way the server will. */
function applySetInput(set: SetLogView, input: SetInput): SetLogView {
  const next: SetLogView = { ...set };
  for (const key of Object.keys(input) as Array<keyof SetInput>) {
    if (key === 'completed') continue;
    const value = input[key];
    if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
  }
  if (input.completed === true && !set.completed) {
    next.completed = true;
    next.completedAt = new Date().toISOString();
  } else if (input.completed === false) {
    next.completed = false;
    next.completedAt = null;
  }
  return next;
}

/**
 * E4.3. One workout (`GET /workouts/:id`) with its mutation helpers. Set edits
 * are optimistic: applied locally at once, then replaced by the server's
 * answer (only the newest request per set reconciles, so a slow early answer
 * never overwrites a later edit). A failure reverts the set to the last value
 * the server confirmed and rejects, so the row can keep what was typed and
 * offer Retry. The workout is read again when the window regains focus (two
 * tabs: last write wins), unless a mutation is in flight.
 */
export function useWorkout(id: string | undefined): UseWorkoutReturn {
  const [workout, setWorkout] = useState<Workout | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const isMounted = useIsMounted();

  const workoutRef = useRef<Workout | null>(null);
  workoutRef.current = workout;
  const pending = useRef(new Set<Promise<unknown>>());
  const confirmed = useRef(new Map<string, SetLogView>());
  const latestSetRequest = useRef(new Map<string, number>());
  const requestSeq = useRef(0);
  const autoAdded = useRef(new Set<string>());
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remember = useCallback((w: Workout) => {
    for (const entry of w.exercises) for (const set of entry.sets) confirmed.current.set(set.id, set);
  }, []);

  const load = useCallback(
    async (silent: boolean) => {
      if (!id) return;
      if (!silent) {
        setIsLoading(true);
        setError(null);
      }
      try {
        const data = await getWorkout(id);
        if (!isMounted()) return;
        remember(data);
        setWorkout(data);
        setNotFound(false);
        setError(null);
      } catch (err) {
        if (!isMounted()) return;
        if (isWorkoutNotFound(err)) {
          setNotFound(true);
          setWorkout(null);
        } else if (!silent) {
          setError(workoutErrorMessage(err, 'Failed to load the workout'));
        }
      } finally {
        if (isMounted() && !silent) setIsLoading(false);
      }
    },
    [id, isMounted, remember],
  );

  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const onFocus = () => {
      if (pending.current.size === 0) void load(true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  useEffect(
    () => () => {
      if (summaryTimer.current) clearTimeout(summaryTimer.current);
    },
    [],
  );

  /** Track a mutation; a 404 re-reads the workout (which may turn into "not found"). */
  const track = useCallback(
    <T,>(promise: Promise<T>): Promise<T> => {
      pending.current.add(promise);
      const done = () => pending.current.delete(promise);
      promise.then(done, (err: unknown) => {
        done();
        if (isWorkoutNotFound(err)) void load(true);
      });
      return promise;
    },
    [load],
  );

  const settle = useCallback(async () => {
    while (pending.current.size > 0) {
      await Promise.allSettled([...pending.current]);
    }
  }, []);

  /** A completed workout's totals come from the server; read them again after an edit. */
  const scheduleSummaryRefresh = useCallback(() => {
    if (!id || workoutRef.current?.status !== 'completed') return;
    if (summaryTimer.current) clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(() => {
      getWorkout(id)
        .then((data) => {
          if (isMounted()) {
            setWorkout((prev) =>
              prev ? { ...prev, summary: data.summary, durationSeconds: data.durationSeconds } : prev,
            );
          }
        })
        .catch(() => undefined);
    }, SUMMARY_REFRESH_DELAY_MS);
  }, [id, isMounted]);

  const requireId = useCallback(() => {
    if (!id) throw new Error('No workout');
    return id;
  }, [id]);

  const update = useCallback(
    async (input: UpdateWorkoutInput) => {
      const saved = await track(updateWorkout(requireId(), input));
      if (isMounted()) {
        remember(saved);
        setWorkout(saved);
      }
      return saved;
    },
    [track, requireId, isMounted, remember],
  );

  const finish = useCallback(
    async (input: FinishWorkoutInput = {}) => {
      const saved = await track(finishWorkout(requireId(), input));
      if (isMounted()) {
        remember(saved);
        setWorkout(saved);
      }
      return saved;
    },
    [track, requireId, isMounted, remember],
  );

  const remove = useCallback(async () => {
    await track(deleteWorkout(requireId()));
  }, [track, requireId]);

  const addExercises = useCallback(
    async (exerciseIds: string[]) => {
      const workoutId = requireId();
      const added: WorkoutExerciseView[] = [];
      for (const exerciseId of exerciseIds) {
        const entry = await track(addWorkoutExercise(workoutId, { exerciseId }));
        added.push(entry);
        if (isMounted()) {
          setWorkout((prev) =>
            prev ? { ...prev, exercises: [...prev.exercises.filter((e) => e.id !== entry.id), entry] } : prev,
          );
        }
      }
      scheduleSummaryRefresh();
      return added;
    },
    [requireId, track, isMounted, scheduleSummaryRefresh],
  );

  const moveExercise = useCallback(
    async (weId: string, direction: -1 | 1) => {
      const current = workoutRef.current;
      if (!current) return;
      const index = current.exercises.findIndex((e) => e.id === weId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.exercises.length) return;
      const reordered = [...current.exercises];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(target, 0, moved);
      setWorkout({ ...current, exercises: reordered.map((e, i) => ({ ...e, position: i })) });
      try {
        await track(updateWorkoutExercise(requireId(), weId, { position: target }));
      } finally {
        await load(true);
      }
    },
    [track, requireId, load],
  );

  const updateExercise = useCallback(
    async (weId: string, input: UpdateWorkoutExerciseInput) => {
      const saved = await track(updateWorkoutExercise(requireId(), weId, input));
      if (isMounted()) {
        setWorkout((prev) =>
          prev
            ? {
                ...prev,
                exercises: prev.exercises.map((e) =>
                  e.id === weId ? { ...e, notes: saved.notes, equipmentTypeId: saved.equipmentTypeId, equipmentType: saved.equipmentType } : e,
                ),
              }
            : prev,
        );
      }
      return saved;
    },
    [track, requireId, isMounted],
  );

  const removeExercise = useCallback(
    async (weId: string) => {
      const before = workoutRef.current;
      if (before) {
        setWorkout({
          ...before,
          exercises: before.exercises.filter((e) => e.id !== weId).map((e, i) => ({ ...e, position: i })),
        });
      }
      try {
        await track(removeWorkoutExercise(requireId(), weId));
        scheduleSummaryRefresh();
      } catch (err) {
        if (isMounted() && !isWorkoutNotFound(err)) await load(true);
        throw err;
      }
    },
    [track, requireId, isMounted, load, scheduleSummaryRefresh],
  );

  const addSet = useCallback(
    async (weId: string, input: SetInput = {}, options: AddSetOptions = {}) => {
      const set = await track(addSetCall(requireId(), weId, input));
      confirmed.current.set(set.id, set);
      if (options.auto) autoAdded.current.add(set.id);
      if (isMounted()) {
        setWorkout((prev) =>
          prev
            ? {
                ...prev,
                exercises: prev.exercises.map((e) =>
                  e.id === weId ? { ...e, sets: [...e.sets.filter((s) => s.id !== set.id), set] } : e,
                ),
              }
            : prev,
        );
      }
      scheduleSummaryRefresh();
      return set;
    },
    [track, requireId, isMounted, scheduleSummaryRefresh],
  );

  const updateSet = useCallback(
    async (setId: string, input: SetInput) => {
      const workoutId = requireId();
      const requestId = ++requestSeq.current;
      latestSetRequest.current.set(setId, requestId);
      // Any edit makes an auto-added row the user's own.
      autoAdded.current.delete(setId);
      setWorkout((prev) => (prev ? mapSets(prev, (s) => (s.id === setId ? applySetInput(s, input) : s)) : prev));
      try {
        const saved = await track(updateSetCall(workoutId, setId, input));
        confirmed.current.set(setId, saved);
        if (isMounted() && latestSetRequest.current.get(setId) === requestId) {
          setWorkout((prev) => (prev ? mapSets(prev, (s) => (s.id === setId ? saved : s)) : prev));
        }
        scheduleSummaryRefresh();
        return saved;
      } catch (err) {
        if (isMounted() && latestSetRequest.current.get(setId) === requestId) {
          const last = confirmed.current.get(setId);
          if (last) setWorkout((prev) => (prev ? mapSets(prev, (s) => (s.id === setId ? last : s)) : prev));
        }
        throw err;
      }
    },
    [requireId, track, isMounted, scheduleSummaryRefresh],
  );

  const deleteSet = useCallback(
    async (setId: string) => {
      const workoutId = requireId();
      setWorkout((prev) => (prev ? mapSets(prev, (s) => (s.id === setId ? null : s)) : prev));
      try {
        await track(deleteSetCall(workoutId, setId));
        confirmed.current.delete(setId);
        autoAdded.current.delete(setId);
        scheduleSummaryRefresh();
      } catch (err) {
        if (isMounted() && !isWorkoutNotFound(err)) await load(true);
        throw err;
      }
    },
    [requireId, track, isMounted, load, scheduleSummaryRefresh],
  );

  const discardUntouchedAutoSets = useCallback(async () => {
    const current = workoutRef.current;
    if (!current) return [];
    const ids: string[] = [];
    for (const entry of current.exercises) {
      for (const set of entry.sets) {
        if (autoAdded.current.has(set.id) && !set.completed) ids.push(set.id);
      }
    }
    const discarded: string[] = [];
    for (const setId of ids) {
      try {
        await deleteSet(setId);
        discarded.push(setId);
      } catch {
        // Kept: it is then asked about like any other pending set.
      }
    }
    return discarded;
  }, [deleteSet]);

  return {
    workout,
    isLoading,
    error,
    notFound,
    refresh,
    update,
    finish,
    remove,
    addExercises,
    moveExercise,
    updateExercise,
    removeExercise,
    addSet,
    updateSet,
    deleteSet,
    settle,
    discardUntouchedAutoSets,
  };
}

