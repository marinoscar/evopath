import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within, mockAdminUser } from '../../utils/test-utils';
import { OnboardingProvider } from '../../../contexts/OnboardingContext';
import TodayPage from '../../../pages/TodayPage';
import {
  adminBlock,
  onboardingState,
  recordSettingsPatches,
  useOnboardingState,
  userSteps,
} from '../../mocks/fixtures/onboarding';

const SEEN = '2026-01-01T00:00:00.000Z';

function renderToday(user?: typeof mockAdminUser) {
  return render(
    <OnboardingProvider>
      <TodayPage />
    </OnboardingProvider>,
    { wrapperOptions: user ? { user } : undefined },
  );
}

describe('Today onboarding cards', () => {
  it('shows the getStarted card with the checklist', async () => {
    useOnboardingState(onboardingState({ welcomeSeenAt: SEEN }));
    renderToday();
    const card = await screen.findByRole('region', { name: 'Get started' });
    expect(within(card).getByText('1 of 3 done')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /Add your gym/ })).toHaveAttribute('href', '/gyms/new');
  });

  it('omits the AI step when the API omits it', async () => {
    useOnboardingState(onboardingState({ welcomeSeenAt: SEEN }));
    renderToday();
    const card = await screen.findByRole('region', { name: 'Get started' });
    expect(within(card).queryByText('Create an AI training plan')).toBeNull();
  });

  it('hides getStarted when dismissed', async () => {
    useOnboardingState(onboardingState({ welcomeSeenAt: SEEN, checklistDismissedAt: SEEN }));
    renderToday();
    await screen.findByRole('region', { name: "Today's workout" });
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
  });

  it('hides getStarted when every step is done', async () => {
    useOnboardingState(
      onboardingState({
        welcomeSeenAt: SEEN,
        user: { steps: userSteps.map((s) => ({ ...s, status: 'done' as const })), completed: 3, total: 3 },
      }),
    );
    renderToday();
    await screen.findByRole('region', { name: "Today's workout" });
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
  });

  it('Dismiss checklist PATCHes checklistDismissedAt and hides the card', async () => {
    useOnboardingState(onboardingState({ welcomeSeenAt: SEEN }));
    const patches = recordSettingsPatches();
    renderToday();
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss checklist' }));
    await waitFor(() => expect(patches.bodies).toHaveLength(1));
    expect(patches.bodies[0].onboarding.checklistDismissedAt).toEqual(expect.any(String));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull());
  });

  it('shows adminSetup only while required steps remain', async () => {
    useOnboardingState(onboardingState({ welcomeSeenAt: SEEN, admin: adminBlock() }));
    renderToday(mockAdminUser);
    const card = await screen.findByRole('region', { name: 'Set up the app' });
    expect(within(card).getByText('Setup 1 of 3')).toBeInTheDocument();
    expect(within(card).getByText('Next: Connect object storage')).toBeInTheDocument();
  });

  it('hides adminSetup when requiredDone', async () => {
    useOnboardingState(onboardingState({ welcomeSeenAt: SEEN, admin: adminBlock({ requiredDone: true }) }));
    renderToday(mockAdminUser);
    await screen.findByRole('region', { name: 'Get started' });
    expect(screen.queryByRole('region', { name: 'Set up the app' })).toBeNull();
  });

  it('hides adminSetup when admin is null', async () => {
    useOnboardingState(onboardingState({ welcomeSeenAt: SEEN, admin: null }));
    renderToday();
    await screen.findByRole('region', { name: 'Get started' });
    expect(screen.queryByRole('region', { name: 'Set up the app' })).toBeNull();
  });
});
