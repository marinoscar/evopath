import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within, mockAdminUser } from '../../utils/test-utils';
import { OnboardingProvider } from '../../../contexts/OnboardingContext';
import SetupGuidePage from '../../../pages/Admin/SetupGuidePage';
import { adminBlock, onboardingState, useOnboardingState } from '../../mocks/fixtures/onboarding';

function renderPage() {
  return render(
    <OnboardingProvider>
      <SetupGuidePage />
    </OnboardingProvider>,
    { wrapperOptions: { user: mockAdminUser } },
  );
}

describe('SetupGuidePage', () => {
  it('renders grouped steps and no success alert while required steps remain', async () => {
    useOnboardingState(onboardingState({ admin: adminBlock() }));
    renderPage();
    expect(await screen.findByRole('list', { name: 'Required' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Optional features' })).toBeInTheDocument();
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument();
    expect(screen.queryByText(/Everything required is set up/)).toBeNull();
  });

  it('shows the success alert when requiredDone', async () => {
    useOnboardingState(onboardingState({ admin: adminBlock({ requiredDone: true }) }));
    renderPage();
    expect(await screen.findByText(/Everything required is set up/)).toBeInTheDocument();
  });

  it('Re-check calls /onboarding?refresh=true', async () => {
    const seen = useOnboardingState(onboardingState({ admin: adminBlock() }));
    renderPage();
    const button = await screen.findByRole('button', { name: 'Re-check' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(seen.urls.every((u) => !u.includes('refresh=true'))).toBe(true);
    await userEvent.click(button);
    await waitFor(() => expect(seen.urls.some((u) => u.includes('refresh=true'))).toBe(true));
  });

  it('links to the Doctor', async () => {
    useOnboardingState(onboardingState({ admin: adminBlock() }));
    renderPage();
    const link = await screen.findByRole('link', { name: 'Open the Doctor' });
    expect(within(document.body).getByRole('heading', { level: 1, name: 'Setup guide' })).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/admin/settings/doctor');
  });
});
