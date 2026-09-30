/**
 * The caller's training plans (`GET /api/programs`), plus where the active
 * plan is ("Week X of Y", from `GET /api/training/today`, only when a plan
 * is active). `createBlank` makes a manual plan (`POST /api/programs`).
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  createProgram,
  getTrainingToday,
  listPrograms,
  type Program,
  type ProgramGoal,
  type ProgramListItem,
} from '../services/programs';
import { localDateIn } from '../utils/localDates';
import { useIsMounted } from './useIsMounted';

export interface ActivePosition {
  programId: string;
  weekNumber: number;
  totalWeeks: number;
}

export interface UsePlansReturn {
  plans: ProgramListItem[];
  active: ActivePosition | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createBlank: (input?: { name?: string; goal?: ProgramGoal }) => Promise<Program>;
}

export const BLANK_PLAN_NAME = 'My plan';

export function usePlans({ enabled = true }: { enabled?: boolean } = {}): UsePlansReturn {
  const [plans, setPlans] = useState<ProgramListItem[]>([]);
  const [active, setActive] = useState<ActivePosition | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    setError(null);
    try {
      const list = await listPrograms();
      if (!isMounted()) return;
      setPlans(list);
      if (list.some((plan) => plan.status === 'active')) {
        try {
          const today = await getTrainingToday(localDateIn(null));
          if (isMounted() && (today.kind === 'workout' || today.kind === 'rest_day')) {
            setActive({ programId: today.program.id, weekNumber: today.weekNumber, totalWeeks: today.totalWeeks });
          }
        } catch {
          // The position is a nicety; the list stands without it.
        }
      } else {
        setActive(null);
      }
    } catch (err) {
      if (isMounted()) setError(err instanceof ApiError || err instanceof Error ? err.message || 'Could not load your plans' : 'Could not load your plans');
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [enabled, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createBlank = useCallback(
    (input: { name?: string; goal?: ProgramGoal } = {}) =>
      createProgram({ name: input.name ?? BLANK_PLAN_NAME, goal: input.goal ?? 'general' }),
    [],
  );

  return { plans, active, isLoading, error, refresh, createBlank };
}
