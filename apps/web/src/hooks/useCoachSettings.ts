/**
 * The caller's coach settings and the persona gallery (E7.3, #243).
 *
 * Loads `GET /api/coach/personas` and `GET /api/coach/settings` together. The
 * house hook contract (`useAiAssignments`): `save` resolves rather than
 * throwing, and every `setState` past an `await` is guarded by
 * `useIsMounted()`.
 *
 * THE RESPONSE IS THE NEW BASELINE. A successful PUT answers the whole view
 * (settings, effective register, policy), so the page re-reads nothing. After
 * a save that changes the register (profanity, persona, intensity) the
 * personas are re-read too: whether Sarge's level-3 lines are served
 * uncensored depends on the register, and only the server decides it.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  coachErrorOf,
  getCoachPersonas,
  getCoachSettings,
  updateCoachSettings,
  type CoachErrorInfo,
  type CoachPersonaCard,
  type CoachSettingsPut,
  type CoachSettingsView,
} from '../services/coach';
import { useIsMounted } from './useIsMounted';

export type CoachSettingsSaveResult = { ok: true; view: CoachSettingsView } | { ok: false; error: CoachErrorInfo };

export interface UseCoachSettingsReturn {
  view: CoachSettingsView | null;
  personas: CoachPersonaCard[];
  isLoading: boolean;
  loadError: string | null;
  isSaving: boolean;
  refresh: () => Promise<void>;
  save: (body: CoachSettingsPut) => Promise<CoachSettingsSaveResult>;
}

/** Fields whose change can flip the register, and with it the served sample lines. */
const REGISTER_FIELDS: ReadonlyArray<keyof CoachSettingsPut> = ['profanity', 'personaId', 'intensity', 'confirmAdult'];

export function useCoachSettings(): UseCoachSettingsReturn {
  const [view, setView] = useState<CoachSettingsView | null>(null);
  const [personas, setPersonas] = useState<CoachPersonaCard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [nextPersonas, nextView] = await Promise.all([getCoachPersonas(), getCoachSettings()]);
      if (isMounted()) {
        setPersonas(nextPersonas);
        setView(nextView);
        setLoadError(null);
      }
    } catch (err) {
      if (isMounted()) setLoadError(coachErrorOf(err, 'Failed to load your coach settings').message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (body: CoachSettingsPut): Promise<CoachSettingsSaveResult> => {
      setIsSaving(true);
      try {
        const next = await updateCoachSettings(body);
        if (isMounted()) setView(next);
        if (REGISTER_FIELDS.some((field) => field in body)) {
          try {
            const nextPersonas = await getCoachPersonas();
            if (isMounted()) setPersonas(nextPersonas);
          } catch {
            // The save stood; a stale gallery is corrected on the next load.
          }
        }
        return { ok: true, view: next };
      } catch (err) {
        return { ok: false, error: coachErrorOf(err, 'Failed to save your coach settings') };
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  return { view, personas, isLoading, loadError, isSaving, refresh, save };
}
