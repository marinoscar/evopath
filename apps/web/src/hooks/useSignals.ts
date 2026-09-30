import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { getTrainingSignals, type PlanSignals } from '../services/programs';
import { localDateIn } from '../utils/localDates';
import { weightUnitFor, type WeightUnit } from '../utils/units';
import { useHealthProfile } from './useHealthProfile';
import { useIsMounted } from './useIsMounted';

/** The range choices the Progress view offers, in weeks. */
export const SIGNALS_RANGE_WEEKS = [4, 8, 12, 26] as const;
export type SignalsRangeWeeks = (typeof SIGNALS_RANGE_WEEKS)[number];
export const DEFAULT_SIGNALS_WEEKS: SignalsRangeWeeks = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `{ from, to }` for the last `weeks` ISO weeks ending on `asOf`: `from` is
 * the Monday `weeks - 1` weeks before `asOf`'s week, `to` is `asOf` (or that
 * week's Sunday with `toEndOfWeek`, so upcoming sessions are listed). At most
 * 26 weeks of days, the API's limit.
 */
export function signalsRange(
  asOf: string,
  weeks: number,
  options: { toEndOfWeek?: boolean } = {}
): { from: string; to: string } {
  const day = parseDay(asOf);
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  const from = new Date(day.getTime() - (sinceMonday + (weeks - 1) * 7) * DAY_MS);
  const to = options.toEndOfWeek
    ? formatDay(new Date(day.getTime() + (6 - sinceMonday) * DAY_MS))
    : asOf;
  return { from: formatDay(from), to };
}

export interface UseSignalsOptions {
  /** Omitted: the active program. */
  programId?: string;
  weeks?: number;
  /** End the range on the current week's Sunday instead of today. */
  toEndOfWeek?: boolean;
  /** `false` skips every request (the caller lacks `programs:read`). */
  enabled?: boolean;
}

export interface UseSignalsReturn {
  signals: PlanSignals | null;
  /** True until the current range answers (or fails); a range change shows loading again. */
  isLoading: boolean;
  error: string | null;
  /** 404: the program is not the caller's (or does not exist). */
  notFound: boolean;
  /** 403: the caller lacks `programs:read`. */
  forbidden: boolean;
  weightUnit: WeightUnit;
  refresh: () => Promise<void>;
}

/**
 * Plan signals for the last `weeks` weeks: `GET /api/training/signals`.
 * `asOf` is the current day in the Health Profile time zone when set, else
 * the browser's, so the first request waits for the profile to settle.
 * Weights stay in kilograms; `weightUnit` is the display unit.
 */
export function useSignals({
  programId,
  weeks = DEFAULT_SIGNALS_WEEKS,
  toEndOfWeek = false,
  enabled = true,
}: UseSignalsOptions = {}): UseSignalsReturn {
  const { profile, isLoading: profileLoading } = useHealthProfile();
  const [signals, setSignals] = useState<PlanSignals | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [forbidden, setForbidden] = useState(false);
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
    const asOf = localDateIn(timeZone);
    setIsLoading(true);
    setError(null);
    try {
      const data = await getTrainingSignals({
        programId,
        asOf,
        ...signalsRange(asOf, weeks, { toEndOfWeek }),
      });
      if (!isMounted() || gen !== generation.current) return;
      setSignals(data);
      setNotFound(false);
      setForbidden(false);
    } catch (err) {
      if (!isMounted() || gen !== generation.current) return;
      const status = err instanceof ApiError ? err.status : null;
      setNotFound(status === 404);
      setForbidden(status === 403);
      setSignals(null);
      setError("Couldn't load your progress");
    } finally {
      if (isMounted() && gen === generation.current) setIsLoading(false);
    }
  }, [enabled, timeZone, programId, weeks, toEndOfWeek, isMounted]);

  useEffect(() => {
    if (!profileSettled) return;
    void refresh();
  }, [profileSettled, refresh]);

  return {
    signals,
    isLoading: enabled && isLoading,
    error,
    notFound,
    forbidden,
    weightUnit: weightUnitFor(profile?.unitSystem),
    refresh,
  };
}
