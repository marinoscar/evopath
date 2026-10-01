import { describe, it, expect, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, mockUser } from '../../utils/test-utils';
import { OnboardingProvider } from '../../../contexts/OnboardingContext';
import PlanWizardPage from '../../../pages/Train/PlanWizardPage';
import {
  DEFAULT_GOAL_TYPE,
  WIZARD_STORAGE_KEY,
  initialWizardForm,
} from '../../../components/training/planWizard';
import { onboardingState, useOnboardingState } from '../../mocks/fixtures/onboarding';

const user = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };

function renderWizard() {
  return render(
    <OnboardingProvider>
      <Routes>
        <Route path="/train/plans/new" element={<PlanWizardPage />} />
      </Routes>
    </OnboardingProvider>,
    { wrapperOptions: { route: '/train/plans/new', aiEnabled: true, user } },
  );
}

beforeEach(() => window.sessionStorage.clear());

describe('initialWizardForm(goalType)', () => {
  it('seeds goalType and defaults otherwise', () => {
    expect(initialWizardForm('fat_loss').goalType).toBe('fat_loss');
    expect(initialWizardForm().goalType).toBe(DEFAULT_GOAL_TYPE);
    expect(initialWizardForm(null).goalType).toBe(DEFAULT_GOAL_TYPE);
  });
});

describe('PlanWizardPage onboarding goal', () => {
  it('starts on the onboarding goal when there is no draft', async () => {
    useOnboardingState(onboardingState({ welcomeSeenAt: '2026-01-01T00:00:00.000Z', goal: 'fat_loss' }));
    renderWizard();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Fat loss' })).toBeChecked());
  });

  it('keeps the default when no goal was chosen', async () => {
    useOnboardingState(onboardingState({ welcomeSeenAt: '2026-01-01T00:00:00.000Z' }));
    renderWizard();
    expect(await screen.findByRole('radio', { name: 'Build muscle' })).toBeChecked();
  });

  it('a saved draft wins over the onboarding goal', async () => {
    window.sessionStorage.setItem(
      WIZARD_STORAGE_KEY,
      JSON.stringify({ step: 0, form: initialWizardForm('strength') }),
    );
    useOnboardingState(onboardingState({ welcomeSeenAt: '2026-01-01T00:00:00.000Z', goal: 'fat_loss' }));
    renderWizard();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('radio', { name: 'Strength' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Fat loss' })).not.toBeChecked();
  });
});
