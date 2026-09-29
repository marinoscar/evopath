/**
 * Which photo intake the "Prefill from photo" page works on (E4.5): the
 * newest unfinished `workout_prefill` intake of this workout, or a new one
 * (`startOrResumeWorkoutPrefill`).
 *
 * Runs only while `enabled` (the page asks only once AI can read photos and
 * the caller may prefill), and at most once per workout per mount: the
 * in-flight request is kept in a ref, so React's development double effect
 * never creates two intakes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toAiErrorInfo, type AiErrorInfo } from '../services/aiErrors';
import { startOrResumeWorkoutPrefill } from '../services/workoutPrefill';
import { useIsMounted } from './useIsMounted';

export interface UseWorkoutPrefillIntakeReturn {
  intakeId: string | null;
  isLoading: boolean;
  error: AiErrorInfo | null;
  /** Try again after a failure, or start over after the intake was discarded. */
  retry: () => void;
}

export function useWorkoutPrefillIntake(workoutId: string | undefined, enabled: boolean): UseWorkoutPrefillIntakeReturn {
  const [intakeId, setIntakeId] = useState<string | null>(null);
  const [error, setError] = useState<AiErrorInfo | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inflight = useRef<{ key: string; promise: Promise<string> } | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled || !workoutId) return undefined;
    const key = `${workoutId}:${attempt}`;
    if (inflight.current?.key !== key) {
      inflight.current = { key, promise: startOrResumeWorkoutPrefill(workoutId) };
    }
    let cancelled = false;
    setError(null);
    inflight.current.promise
      .then((id) => {
        if (!cancelled && isMounted()) setIntakeId(id);
      })
      .catch((err: unknown) => {
        if (!cancelled && isMounted()) setError(toAiErrorInfo(err, 'Could not start the prefill'));
      });
    return () => {
      cancelled = true;
    };
  }, [workoutId, enabled, attempt, isMounted]);

  const retry = useCallback(() => {
    setIntakeId(null);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { intakeId, isLoading: enabled && intakeId === null && error === null, error, retry };
}
