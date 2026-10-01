/**
 * Activity goals (#268): the caller's goals by status, the templates, this
 * period's progress for the active goals, and one goal's history. Each is a
 * plain load-and-refresh over `services/goals.ts`; writes are called directly
 * by the page, which then calls `refresh`.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getGoalHistory,
  getGoalProgress,
  goalErrorMessage,
  listGoalTemplates,
  listGoals,
  type Goal,
  type GoalHistoryPeriod,
  type GoalProgress,
  type GoalStatus,
  type GoalTemplate,
} from '../services/goals';
import { useIsMounted } from './useIsMounted';

export interface UseLoadReturn<T> {
  data: T;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function useLoad<T>(
  load: (() => Promise<T>) | null,
  initial: T,
  fallbackError: string,
): UseLoadReturn<T> {
  const [data, setData] = useState<T>(initial);
  const [isLoading, setIsLoading] = useState(load !== null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!load) return;
    setIsLoading(true);
    setError(null);
    try {
      const next = await load();
      if (isMounted()) setData(next);
    } catch (err) {
      if (isMounted()) setError(goalErrorMessage(err, fallbackError));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [load, isMounted, fallbackError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, isLoading, error, refresh };
}

const NO_GOALS: Goal[] = [];
const NO_TEMPLATES: GoalTemplate[] = [];
const NO_PROGRESS: GoalProgress[] = [];
const NO_HISTORY: GoalHistoryPeriod[] = [];

/** `GET /api/goals?status=` */
export function useGoals(status: GoalStatus, { enabled = true }: { enabled?: boolean } = {}) {
  const load = useCallback(() => listGoals(status), [status]);
  const { data, ...rest } = useLoad(enabled ? load : null, NO_GOALS, 'Could not load your goals.');
  return { goals: data, ...rest };
}

/** `GET /api/goals/templates` */
export function useGoalTemplates({ enabled = true }: { enabled?: boolean } = {}) {
  const { data, ...rest } = useLoad(enabled ? listGoalTemplates : null, NO_TEMPLATES, 'Could not load goal ideas.');
  return { templates: data, ...rest };
}

/** `GET /api/goals/progress` (today, the server's local day). */
export function useGoalProgress({ enabled = true }: { enabled?: boolean } = {}) {
  const load = useCallback(() => getGoalProgress(), []);
  const { data, ...rest } = useLoad(enabled ? load : null, NO_PROGRESS, 'Could not load your goals.');
  return { progress: data, ...rest };
}

/** `GET /api/goals/:id/history` (newest first). */
export function useGoalHistory(goalId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const load = useCallback(() => getGoalHistory(goalId), [goalId]);
  const { data, ...rest } = useLoad(enabled ? load : null, NO_HISTORY, 'Could not load the history.');
  return { history: data, ...rest };
}
