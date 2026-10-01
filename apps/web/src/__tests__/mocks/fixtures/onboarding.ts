/**
 * `GET /api/onboarding` fixtures and a per-test override helper (#203).
 * The default MSW handler says "welcome seen, checklist dismissed"; suites
 * that exercise onboarding replace it with `useOnboardingState`.
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type { OnboardingState, OnboardingStep } from '../../../types';

export function step(overrides: Partial<OnboardingStep> & Pick<OnboardingStep, 'id'>): OnboardingStep {
  return {
    group: null,
    status: 'todo',
    label: overrides.id,
    detail: null,
    href: `/${overrides.id}`,
    ...overrides,
  };
}

export const userSteps: OnboardingStep[] = [
  step({ id: 'health_profile', label: 'Complete your health profile', href: '/settings/health-profile', status: 'done' }),
  step({ id: 'gym', label: 'Add your gym', href: '/gyms/new', detail: 'Tell us where you train.' }),
  step({ id: 'first_workout', label: 'Log your first workout', href: '/train' }),
];

export function onboardingState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    welcomeSeenAt: null,
    checklistDismissedAt: null,
    goal: null,
    user: { steps: userSteps, completed: 1, total: 3 },
    admin: null,
    ...overrides,
  };
}

export const adminSteps: OnboardingStep[] = [
  step({ id: 'storage', group: 'required', label: 'Connect object storage', href: '/admin/settings/storage', detail: 'No bucket yet.' }),
  step({ id: 'email', group: 'required', label: 'Set up email delivery', href: '/admin/settings/email', status: 'done' }),
  step({ id: 'ai', group: 'features', label: 'Turn on AI', href: '/admin/settings/ai' }),
];

export function adminBlock(overrides: Partial<NonNullable<OnboardingState['admin']>> = {}) {
  return { steps: adminSteps, completed: 1, total: 3, requiredDone: false, ...overrides };
}

// The state `GET /onboarding` serves. `recordSettingsPatches` folds a PATCHed
// `onboarding` namespace into it, as the real API would, so the re-read that
// follows a write agrees with the write.
let served: OnboardingState = onboardingState();

/** Serve `state` from `GET /onboarding`; returns the recorded request URLs. */
export function useOnboardingState(state: OnboardingState): { urls: string[] } {
  served = state;
  const seen: { urls: string[] } = { urls: [] };
  server.use(
    http.get('*/api/onboarding', ({ request }) => {
      seen.urls.push(request.url);
      return HttpResponse.json({ data: served });
    }),
  );
  return seen;
}

/** Record `PATCH /user-settings` bodies. */
export function recordSettingsPatches(): { bodies: Array<Record<string, any>> } {
  const rec: { bodies: Array<Record<string, any>> } = { bodies: [] };
  server.use(
    http.patch('*/api/user-settings', async ({ request }) => {
      const body = (await request.json()) as Record<string, any>;
      rec.bodies.push(body);
      if (body.onboarding) served = { ...served, ...body.onboarding };
      return HttpResponse.json({
        data: { theme: 'system', profile: {}, updatedAt: new Date().toISOString(), version: 2, ...body },
      });
    }),
  );
  return rec;
}
