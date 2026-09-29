/**
 * Which photo intake the gym scan page works on (E3.4): the newest unfinished
 * `gym_equipment` intake of this gym, or a new one
 * (`startOrResumeGymScan`).
 *
 * Runs only while `enabled` (the page asks only once AI can read photos and
 * the caller may scan), and at most once per gym per mount: the in-flight
 * request is kept in a ref, so React's development double effect never
 * creates two intakes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toAiErrorInfo, type AiErrorInfo } from '../services/aiErrors';
import { startOrResumeGymScan } from '../services/gymScan';
import { useIsMounted } from './useIsMounted';

export interface UseGymScanIntakeReturn {
  intakeId: string | null;
  isLoading: boolean;
  error: AiErrorInfo | null;
  /** Try again after a failure, or start over after the intake was discarded. */
  retry: () => void;
}

export function useGymScanIntake(gymId: string | undefined, enabled: boolean): UseGymScanIntakeReturn {
  const [intakeId, setIntakeId] = useState<string | null>(null);
  const [error, setError] = useState<AiErrorInfo | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inflight = useRef<{ key: string; promise: Promise<string> } | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled || !gymId) return undefined;
    const key = `${gymId}:${attempt}`;
    if (inflight.current?.key !== key) {
      inflight.current = { key, promise: startOrResumeGymScan(gymId) };
    }
    let cancelled = false;
    setError(null);
    inflight.current.promise
      .then((id) => {
        if (!cancelled && isMounted()) setIntakeId(id);
      })
      .catch((err: unknown) => {
        if (!cancelled && isMounted()) setError(toAiErrorInfo(err, 'Could not start the scan'));
      });
    return () => {
      cancelled = true;
    };
  }, [gymId, enabled, attempt, isMounted]);

  const retry = useCallback(() => {
    setIntakeId(null);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { intakeId, isLoading: enabled && intakeId === null && error === null, error, retry };
}
