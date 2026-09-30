/**
 * Load and save the administrator's AI model assignments
 * (`/api/admin/ai/assignments`, #173).
 *
 * The house hook contract (`useAiAdminConfig`): every write resolves rather
 * than throwing, and every `setState` past an `await` is guarded by
 * `useIsMounted()`.
 *
 * THE RESPONSE IS THE NEW BASELINE: the server owns `version`, which the NEXT
 * save sends as `If-Match`, so two saves in a row work with no reload.
 *
 * A 409 (someone else saved first) is NOT auto-reloaded: the page keeps the
 * administrator's unsaved edits on screen and offers a reload, which replaces
 * them with what is stored now. A 400 `AI_ASSIGNMENT_INVALID` comes back as
 * per-field errors (`default`, `features.<id>`) for the page to place on the
 * right rows.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  assignmentFieldErrorsOf,
  getAiAssignments,
  updateAiAssignments,
  type AiAssignmentFieldError,
  type AiAssignments,
  type AiAssignmentsView,
} from '../services/aiAssignments';
import { useIsMounted } from './useIsMounted';

export type AiAssignmentsSaveResult =
  | { ok: true }
  | { ok: false; conflict: true }
  | { ok: false; fieldErrors: AiAssignmentFieldError[] }
  | { ok: false; message: string };

export interface UseAiAssignmentsReturn {
  view: AiAssignmentsView | null;
  isLoading: boolean;
  loadError: string | null;
  isSaving: boolean;
  refresh: () => Promise<void>;
  save: (input: AiAssignments) => Promise<AiAssignmentsSaveResult>;
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to change the AI model assignments.';
    return err.message || fallback;
  }
  return fallback;
}

export function useAiAssignments(): UseAiAssignmentsReturn {
  const [view, setView] = useState<AiAssignmentsView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getAiAssignments();
      if (isMounted()) {
        setView(data);
        setLoadError(null);
      }
    } catch (err) {
      if (isMounted()) setLoadError(messageOf(err, 'Failed to load the AI model assignments'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (input: AiAssignments): Promise<AiAssignmentsSaveResult> => {
      setIsSaving(true);
      try {
        const data = await updateAiAssignments(input, view?.version ?? 0);
        if (isMounted()) setView(data);
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) return { ok: false, conflict: true };
        const fieldErrors = assignmentFieldErrorsOf(err);
        if (fieldErrors) return { ok: false, fieldErrors };
        return { ok: false, message: messageOf(err, 'Failed to save the AI model assignments') };
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [view?.version, isMounted],
  );

  return { view, isLoading, loadError, isSaving, refresh, save };
}
