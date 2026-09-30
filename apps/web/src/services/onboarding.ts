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
import type { OnboardingState } from '../types';

export type {
  OnboardingAdminState,
  OnboardingChecklistState,
  OnboardingGoal,
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
