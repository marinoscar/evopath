import { describe, it, expect } from 'vitest';
import { render, screen, within } from '../../utils/test-utils';
import { OnboardingChecklist } from '../../../components/onboarding/OnboardingChecklist';
import { adminSteps, userSteps } from '../../mocks/fixtures/onboarding';

describe('OnboardingChecklist', () => {
  it('shows status as text and the N of M progress', () => {
    render(<OnboardingChecklist steps={userSteps} completed={1} total={3} />);
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument();
    const done = screen.getByTestId('onboarding-step-health_profile');
    expect(within(done).getByText('Done')).toBeInTheDocument();
    const todo = screen.getByTestId('onboarding-step-gym');
    expect(within(todo).getByText('To do')).toBeInTheDocument();
    expect(within(todo).getByText(/Tell us where you train/)).toBeInTheDocument();
  });

  it('links only to-do steps to their href', () => {
    render(<OnboardingChecklist steps={userSteps} completed={1} total={3} />);
    expect(screen.getByRole('link', { name: /Add your gym/ })).toHaveAttribute('href', '/gyms/new');
    expect(screen.getByRole('link', { name: /Log your first workout/ })).toHaveAttribute('href', '/train');
    expect(screen.queryByRole('link', { name: /health profile/ })).toBeNull();
  });

  it('groups steps under subheaders when grouped', () => {
    render(<OnboardingChecklist steps={adminSteps} completed={1} total={3} grouped label="Setup" />);
    const required = screen.getByRole('list', { name: 'Required' });
    const features = screen.getByRole('list', { name: 'Optional features' });
    expect(within(required).getAllByRole('listitem')).toHaveLength(2);
    expect(within(features).getByText('Turn on AI')).toBeInTheDocument();
  });

  it('renders one labelled list when not grouped', () => {
    render(<OnboardingChecklist steps={userSteps} completed={1} total={3} label="Getting started" />);
    expect(screen.getAllByRole('list')).toHaveLength(1);
    expect(screen.getByRole('list', { name: 'Getting started' })).toBeInTheDocument();
  });
});
