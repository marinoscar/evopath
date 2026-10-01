/**
 * The one `GET /api/onboarding` fetch for the authenticated shell — issue #203.
 * See `hooks/useOnboarding.ts` for why there is exactly one, and why there is
 * no per-consumer fallback.
 *
 * Mounted inside `ProtectedRoute` (the endpoint is `@Auth()`) and around
 * `Layout`, so the welcome dialog, the Today cards, the user menu and the
 * setup guide read — and write through — the same state.
 */
import type { ReactNode } from 'react';
import { OnboardingContext, useOnboardingQuery } from '../hooks/useOnboarding';

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const value = useOnboardingQuery();
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}
