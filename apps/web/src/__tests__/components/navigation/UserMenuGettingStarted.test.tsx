import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../utils/test-utils';
import { OnboardingProvider } from '../../../contexts/OnboardingContext';
import { UserMenu } from '../../../components/navigation/UserMenu';
import { onboardingState, recordSettingsPatches, useOnboardingState } from '../../mocks/fixtures/onboarding';

describe('UserMenu Getting started (#203)', () => {
  it('is absent without an OnboardingProvider', async () => {
    render(<UserMenu />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('menuitem', { name: 'Getting started' })).toBeNull();
  });

  it('PATCHes both timestamps to null', async () => {
    const SEEN = '2026-01-01T00:00:00.000Z';
    useOnboardingState(onboardingState({ welcomeSeenAt: SEEN, checklistDismissedAt: SEEN }));
    const patches = recordSettingsPatches();
    render(
      <OnboardingProvider>
        <UserMenu />
      </OnboardingProvider>,
    );
    // The item needs the first read to have landed.
    await userEvent.click(screen.getByRole('button'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Getting started' }));
    await waitFor(() => expect(patches.bodies).toHaveLength(1));
    expect(patches.bodies[0]).toEqual({ onboarding: { welcomeSeenAt: null, checklistDismissedAt: null } });
  });
});
