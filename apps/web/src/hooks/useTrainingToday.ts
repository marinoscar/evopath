import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { getTrainingToday, type TrainingToday } from '../services/programs';
import { localDateIn } from '../utils/localDates';
import { weightUnitFor, type WeightUnit } from '../utils/units';
import { useHealthProfile } from './useHealthProfile';
import { useIsMounted } from './useIsMounted';

export interface UseTrainingTodayOptions {
  /** `false` skips every request (the caller lacks `programs:read`). */
  enabled?: boolean;
}

export interface UseTrainingTodayReturn {
  today: TrainingToday | null;
  /** The `YYYY-MM-DD` last sent as `?date=`; null before the first request. */
  date: string | null;
  /** True until the first answer (or failure); a refetch keeps the old answer. */
  isLoading: boolean;
  /** The last load failed. The previous answer, if any, is kept. */
  error: string | null;
  /** The API answered 403. */
  forbidden: boolean;
  /** The Health Profile weight unit (kg while it loads or cannot be read). */
  weightUnit: WeightUnit;
  /** The user's local day right now, `YYYY-MM-DD` (what a start sends). */
  localDate: () => string;
  refresh: () => Promise<void>;
}

/**
 * What the active plan asks for today: `GET /api/training/today?date=`.
 *
 * `date` is the current day in the Health Profile `timeZone` when the profile
 * has one, else the browser's local day, so the first request waits for the
 * profile to answer (or fail). Fetched again when the window regains focus,
 * so a workout finished in another tab (or the logger, on return) flips the
 * card to Done; the profile is re-read at the same time.
 */
export function useTrainingToday({ enabled = true }: UseTrainingTodayOptions = {}): UseTrainingTodayReturn {
  const { profile, isLoading: profileLoading, refresh: refreshProfile } = useHealthProfile();
  const [today, setToday] = useState<TrainingToday | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [profileSettled, setProfileSettled] = useState(false);
  const isMounted = useIsMounted();
  const generation = useRef(0);

  useEffect(() => {
    if (!profileLoading) setProfileSettled(true);
  }, [profileLoading]);

  const timeZone = profile?.timeZone ?? null;
  const localDate = useCallback(() => localDateIn(timeZone), [timeZone]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const gen = ++generation.current;
    const day = localDateIn(timeZone);
    setError(null);
    try {
      const data = await getTrainingToday(day);
      if (!isMounted() || gen !== generation.current) return;
      setToday(data);
      setDate(day);
      setForbidden(false);
    } catch (err) {
      if (!isMounted() || gen !== generation.current) return;
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      setError("Couldn't load your plan");
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
    today,
    date,
    isLoading: enabled && isLoading,
    error,
    forbidden,
    weightUnit: weightUnitFor(profile?.unitSystem),
    localDate,
    refresh,
  };
}
