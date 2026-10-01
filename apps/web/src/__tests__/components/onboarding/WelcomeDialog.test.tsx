import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { render, screen, waitFor, mockAdminUser } from '../../utils/test-utils';
import { OnboardingProvider } from '../../../contexts/OnboardingContext';
import { WelcomeDialog } from '../../../components/onboarding/WelcomeDialog';
import {
  adminBlock,
  onboardingState,
  recordSettingsPatches,
  useOnboardingState,
} from '../../mocks/fixtures/onboarding';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderDialog(user?: typeof mockAdminUser) {
  return render(
    <OnboardingProvider>
      <WelcomeDialog />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </OnboardingProvider>,
    { wrapperOptions: user ? { user } : undefined },
  );
}

describe('WelcomeDialog', () => {
  it('is absent once the welcome has been seen', async () => {
    useOnboardingState(onboardingState({ welcomeSeenAt: '2026-01-01T00:00:00.000Z' }));
    renderDialog();
    await screen.findByTestId('where');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is named by its title via aria-labelledby', async () => {
    useOnboardingState(onboardingState());
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Welcome, Test' });
    expect(dialog).toHaveAttribute('aria-labelledby');
  });

  it('shows the admin copy and Start setup goes to the setup guide', async () => {
    useOnboardingState(onboardingState({ admin: adminBlock() }));
    const patches = recordSettingsPatches();
    renderDialog(mockAdminUser);
    expect(await screen.findByText(/You're the administrator/)).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 done so far/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start setup' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/settings/setup'));
    await waitFor(() => expect(patches.bodies).toHaveLength(1));
    expect(patches.bodies[0].onboarding.welcomeSeenAt).toEqual(expect.any(String));
  });

  it('user copy: choosing a goal PATCHes goal and welcomeSeenAt', async () => {
    useOnboardingState(onboardingState());
    const patches = recordSettingsPatches();
    renderDialog();
    expect(await screen.findByText(/helps you log workouts/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start setup' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Lose fat' }));
    await userEvent.click(screen.getByRole('button', { name: 'Get started' }));
    await waitFor(() => expect(patches.bodies).toHaveLength(1));
    const { onboarding } = patches.bodies[0];
    expect(onboarding.goal).toBe('fat_loss');
    expect(new Date(onboarding.welcomeSeenAt).toISOString()).toBe(onboarding.welcomeSeenAt);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Later marks it seen without a goal', async () => {
    useOnboardingState(onboardingState());
    const patches = recordSettingsPatches();
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Later' }));
    await waitFor(() => expect(patches.bodies).toHaveLength(1));
    expect(patches.bodies[0].onboarding).not.toHaveProperty('goal');
    expect(patches.bodies[0].onboarding.welcomeSeenAt).toEqual(expect.any(String));
  });

  it('Escape marks it seen without a goal', async () => {
    useOnboardingState(onboardingState());
    const patches = recordSettingsPatches();
    renderDialog();
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(patches.bodies).toHaveLength(1));
    expect(patches.bodies[0].onboarding).not.toHaveProperty('goal');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
