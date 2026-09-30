import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { getWorkoutSummary, workoutErrorMessage, type WorkoutSummary } from '../services/workouts';
import { localDateIn } from '../utils/localDates';
import { weightUnitFor, type WeightUnit } from '../utils/units';
import { useHealthProfile } from './useHealthProfile';
import { useIsMounted } from './useIsMounted';

export interface UseWorkoutSummaryOptions {
  /** `false` skips every request (the caller lacks `workouts:read`). */
  enabled?: boolean;
}

export interface UseWorkoutSummaryReturn {
  summary: WorkoutSummary | null;
  /** The `YYYY-MM-DD` last sent as `?today=`; null before the first request. */
  today: string | null;
  /** True until the first answer (or failure); a refetch keeps the old summary. */
  isLoading: boolean;
  /** The last load failed. The previous summary, if any, is kept. */
  error: string | null;
  /** The API answered 403. */
  forbidden: boolean;
  /** The Health Profile weight unit (kg while it loads or cannot be read). */
  weightUnit: WeightUnit;
  refresh: () => Promise<void>;
}

/**
 * E4.6. The Today page's training card: `GET /workouts/summary`.
 *
 * `?today=` is the current day in the Health Profile `timeZone` when the
 * profile has one, else the browser's local day, so the first request waits
 * for the profile to answer (or fail). The summary is fetched again when the
 * window regains focus, so a workout finished or started in another tab shows
 * up on return; the profile is re-read at the same time, so a unit or time
 * zone change made elsewhere applies too.
 */
export function useWorkoutSummary({ enabled = true }: UseWorkoutSummaryOptions = {}): UseWorkoutSummaryReturn {
  const { profile, isLoading: profileLoading, refresh: refreshProfile } = useHealthProfile();
  const [summary, setSummary] = useState<WorkoutSummary | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // Once the profile has answered once, a background re-read must not hold the summary back.
  const [profileSettled, setProfileSettled] = useState(false);
  const isMounted = useIsMounted();
  const generation = useRef(0);

  useEffect(() => {
    if (!profileLoading) setProfileSettled(true);
  }, [profileLoading]);

  const timeZone = profile?.timeZone ?? null;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const gen = ++generation.current;
    const day = localDateIn(timeZone);
    setError(null);
    try {
      const data = await getWorkoutSummary(day);
      if (!isMounted() || gen !== generation.current) return;
      setSummary(data);
      setToday(day);
      setForbidden(false);
    } catch (err) {
      if (!isMounted() || gen !== generation.current) return;
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      setError(workoutErrorMessage(err, "Couldn't load training"));
    } finally {
      if (isMounted() && gen === generation.current) setIsLoading(false);
    }
  }, [enabled, timeZone, isMounted]);

  useEffect(() => {
    if (!profileSettled) return;
    void refresh();
  }, [profileSettled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      void refreshProfile();
      if (profileSettled) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled, profileSettled, refresh, refreshProfile]);

  return {
    summary,
    today,
    isLoading: enabled && isLoading,
    error,
    forbidden,
    weightUnit: weightUnitFor(profile?.unitSystem),
    refresh,
  };
}
