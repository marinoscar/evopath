/**
 * First-run onboarding state (`GET /api/onboarding`) and the three UI writes
 * that go with it — issue #203.
 *
 * WHAT IS DERIVED AND WHAT IS STORED
 * ----------------------------------
 * Every checklist step's `done`/`todo` comes from the API, which reads real
 * data (a saved health profile, a gym, a completed workout, a Doctor check).
 * The browser never ticks a step. The only things the browser writes are the
 * three UI facts in `user_settings.onboarding` — "welcome seen", "checklist
 * dismissed" and the optional goal — through the SAME `PATCH /api/user-settings`
 * every other settings namespace uses (`useUserSettings`, `syncTheme: false`
 * because this is mounted by the shell, exactly like `useNavigationPrefs`).
 * After each write the onboarding state is re-read so every consumer agrees.
 *
 * ONE FETCH PER SHELL
 * -------------------
 * The welcome dialog (in `Layout`), the two Today cards, the user menu and the
 * setup guide all read the same answer, so `OnboardingProvider`
 * (`contexts/OnboardingContext.tsx`) runs {@link useOnboardingQuery} once
 * around the authenticated shell and {@link useOnboarding} reads it. Unlike
 * `useAiConfig` there is deliberately NO per-consumer fallback fetch: with no
 * provider above it, `useOnboarding` answers an inert "nothing to show", so
 * chrome rendered in isolation (tests, previews) makes no request and shows
 * no onboarding surface.
 *
 * WRITES ARE OPTIMISTIC
 * ---------------------
 * Closing the welcome dialog must close it now, not after two round trips. A
 * local overlay carries the written fields until the re-read lands. When a
 * write FAILS the overlay is kept for the rest of the session: nagging the
 * user with a dialog they just closed is worse than a preference that did not
 * persist, and `error` still reports it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { getOnboarding } from '../services/onboarding';
import type { OnboardingGoal, OnboardingSettingsPatch, OnboardingState } from '../types';
import { useIsMounted } from './useIsMounted';
import { usePermissions } from './usePermissions';
import { useUserSettings } from './useUserSettings';

export interface UseOnboardingReturn {
  /** True under `OnboardingProvider`; false for the inert no-provider answer. */
  available: boolean;
  /** `null` until the first read resolves, when it failed, or without `user_settings:read`. */
  state: OnboardingState | null;
  /** The goal chosen in the welcome dialog (`settings.onboarding.goal`), or `null`. */
  goal: OnboardingGoal | null;
  /** True only until the FIRST read settles. */
  isLoading: boolean;
  /** A later re-read (after a write, or "Re-check") is in flight. */
  isRefreshing: boolean;
  error: string | null;
  /** Re-read the state; `refresh: true` asks the API to re-run the Doctor probes. */
  refresh: (options?: { refresh?: boolean }) => Promise<void>;
  /** Close the welcome for good, optionally recording the goal. Never throws. */
  markWelcomeSeen: (goal?: OnboardingGoal | null) => Promise<void>;
  /** Hide the "Get started" checklist. Never throws. */
  dismissChecklist: () => Promise<void>;
  /** Show the welcome and the checklist again ("Getting started" in the user menu). Never throws. */
  reopen: () => Promise<void>;
}

const noop = async () => undefined;

/** The answer without a provider: nothing to show, nothing to do. */
export const ONBOARDING_INERT: UseOnboardingReturn = Object.freeze({
  available: false,
  state: null,
  goal: null,
  isLoading: false,
  isRefreshing: false,
  error: null,
  refresh: noop,
  markWelcomeSeen: noop,
  dismissChecklist: noop,
  reopen: noop,
});

export const OnboardingContext = createContext<UseOnboardingReturn | null>(null);

function messageFor(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

function has<K extends keyof OnboardingSettingsPatch>(
  patch: OnboardingSettingsPatch | null,
  key: K,
): patch is OnboardingSettingsPatch & Required<Pick<OnboardingSettingsPatch, K>> {
  return patch !== null && Object.prototype.hasOwnProperty.call(patch, key);
}

/** The fetching implementation, mounted once by `OnboardingProvider`. */
export function useOnboardingQuery(): UseOnboardingReturn {
  const { hasPermission } = usePermissions();
  // `GET /api/onboarding` is `user_settings:read`. Without it there is nothing
  // to fetch and nothing to show; the API would 403 anyway.
  const canRead = hasPermission('user_settings:read');
  const { settings, updateSettings } = useUserSettings({ syncTheme: false });
  const isMounted = useIsMounted();

  const [state, setState] = useState<OnboardingState | null>(null);
  const [isLoading, setIsLoading] = useState(canRead);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OnboardingSettingsPatch | null>(null);
  const loaded = useRef(false);
  const writeSeq = useRef(0);
  // A write made before `/user-settings` has answered has no `version` for the
  // If-Match header yet; it waits here and is flushed once settings arrive.
  const pending = useRef<{ patch: OnboardingSettingsPatch; seq: number } | null>(null);

  const load = useCallback(
    async (options: { refresh?: boolean } = {}) => {
      if (!canRead) {
        if (isMounted()) setIsLoading(false);
        return;
      }
      try {
        if (loaded.current) setIsRefreshing(true);
        setError(null);
        const data = await getOnboarding(options.refresh ? { refresh: true } : {});
        loaded.current = true;
        if (isMounted()) setState(data);
      } catch (err) {
        if (isMounted()) setError(messageFor(err, 'Failed to load getting-started steps'));
      } finally {
        if (isMounted()) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [canRead, isMounted],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const commit = useCallback(
    async (patch: OnboardingSettingsPatch, seq: number) => {
      try {
        await updateSettings({ onboarding: patch });
      } catch (err) {
        // Keep the overlay: see "WRITES ARE OPTIMISTIC" above.
        if (isMounted()) setError(messageFor(err, 'Failed to save your onboarding progress'));
        return;
      }
      await load();
      if (isMounted() && writeSeq.current === seq) setOverlay(null);
    },
    [updateSettings, load, isMounted],
  );

  // Flush a write that was made before settings had loaded.
  useEffect(() => {
    if (!settings || !pending.current) return;
    const { patch, seq } = pending.current;
    pending.current = null;
    void commit(patch, seq);
  }, [settings, commit]);

  const write = useCallback(
    async (patch: OnboardingSettingsPatch) => {
      const seq = ++writeSeq.current;
      setOverlay((current) => ({ ...(current ?? {}), ...patch }));
      if (!settings) {
        pending.current = {
          patch: { ...(pending.current?.patch ?? {}), ...patch },
          seq,
        };
        return;
      }
      await commit(patch, seq);
    },
    [settings, commit],
  );

  const markWelcomeSeen = useCallback(
    (goal?: OnboardingGoal | null) =>
      write({
        welcomeSeenAt: new Date().toISOString(),
        ...(goal !== undefined ? { goal } : {}),
      }),
    [write],
  );

  const dismissChecklist = useCallback(
    () => write({ checklistDismissedAt: new Date().toISOString() }),
    [write],
  );

  const reopen = useCallback(
    () => write({ welcomeSeenAt: null, checklistDismissedAt: null }),
    [write],
  );

  const effective = useMemo<OnboardingState | null>(() => {
    if (!state) return null;
    return {
      ...state,
      welcomeSeenAt: has(overlay, 'welcomeSeenAt') ? (overlay.welcomeSeenAt ?? null) : state.welcomeSeenAt,
      checklistDismissedAt: has(overlay, 'checklistDismissedAt')
        ? (overlay.checklistDismissedAt ?? null)
        : state.checklistDismissedAt,
      goal: has(overlay, 'goal') ? (overlay.goal ?? null) : state.goal,
    };
  }, [state, overlay]);

  const goal: OnboardingGoal | null = has(overlay, 'goal')
    ? (overlay.goal ?? null)
    : (settings?.onboarding?.goal ?? state?.goal ?? null);

  return useMemo(
    () => ({
      available: true,
      state: effective,
      goal,
      isLoading,
      isRefreshing,
      error,
      refresh: load,
      markWelcomeSeen,
      dismissChecklist,
      reopen,
    }),
    [effective, goal, isLoading, isRefreshing, error, load, markWelcomeSeen, dismissChecklist, reopen],
  );
}

/** The shell's shared onboarding state, or {@link ONBOARDING_INERT} with no provider. */
export function useOnboarding(): UseOnboardingReturn {
  return useContext(OnboardingContext) ?? ONBOARDING_INERT;
}
