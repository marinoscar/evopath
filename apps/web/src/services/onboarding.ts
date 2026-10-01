/**
 * First-run onboarding (`GET /api/onboarding`), as the web app sees it.
 *
 * Issue #203. `services/api.ts` stays the transport; this module holds the one
 * call. The endpoint is READ-ONLY: every step's `done`/`todo` is derived from
 * real data by the API, never ticked by the browser. The UI state it echoes
 * (`welcomeSeenAt`, `checklistDismissedAt`, `goal`) is WRITTEN through the
 * existing `PATCH /api/user-settings` (`{ onboarding: {...} }`), not here.
 */

import { api } from './api';
import type { OnboardingMetrics, OnboardingState } from '../types';

export type {
  OnboardingAdminState,
  OnboardingChecklistState,
  OnboardingGoal,
  OnboardingMetrics,
  OnboardingMetricsStep,
  OnboardingMetricsStepId,
  OnboardingState,
  OnboardingStep,
} from '../types';

export interface OnboardingQuery {
  /** Forwarded to the Doctor on the admin steps: run every probe again. */
  refresh?: boolean;
}

/** `GET /onboarding` — `user_settings:read`. `admin` is non-null only for `system_settings:read`. */
export async function getOnboarding(query: OnboardingQuery = {}): Promise<OnboardingState> {
  return api.get<OnboardingState>(query.refresh ? '/onboarding?refresh=true' : '/onboarding');
}

/** The activation windows the Setup guide offers, in days (#212). The API accepts 1..365. */
export const ONBOARDING_METRICS_WINDOWS = [7, 30, 90] as const;
export type OnboardingMetricsWindow = (typeof ONBOARDING_METRICS_WINDOWS)[number];

/**
 * `GET /admin/onboarding/metrics?days=` — `system_settings:read`. Read-only
 * aggregates over the users who signed up in the last `days` days; the API
 * computes every count and rate, the browser only presents them.
 */
export async function getOnboardingMetrics(days: number = 30): Promise<OnboardingMetrics> {
  return api.get<OnboardingMetrics>(`/admin/onboarding/metrics?days=${encodeURIComponent(String(days))}`);
}
