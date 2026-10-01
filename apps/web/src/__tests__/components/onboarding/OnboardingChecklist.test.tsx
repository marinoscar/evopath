import { describe, it, expect } from 'vitest';
import { render, screen, within } from '../../utils/test-utils';
import { OnboardingChecklist } from '../../../components/onboarding/OnboardingChecklist';
import { adminSteps, userSteps } from '../../mocks/fixtures/onboarding';
import type { OnboardingStep } from '../../../types';

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
  // E7.12: once a plan exists the API sends the same `ai_plan` step as "Meet
  // your coach"; the checklist renders it as sent (no fifth step, no client logic).
  describe('the ai_plan step as "Meet your coach"', () => {
    const meetCoach = (status: OnboardingStep['status']): OnboardingStep => ({
      id: 'ai_plan',
      group: null,
      status,
      label: 'Meet your coach',
      detail: null,
      href: '/settings/coach',
    });

    it('a to-do step links to the coach settings', () => {
      render(<OnboardingChecklist steps={[...userSteps, meetCoach('todo')]} completed={1} total={4} />);
      const step = screen.getByTestId('onboarding-step-ai_plan');
      expect(step).toHaveAttribute('data-status', 'todo');
      expect(within(step).getByText('To do')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Meet your coach/ })).toHaveAttribute('href', '/settings/coach');
      expect(screen.queryByText('Create an AI training plan')).toBeNull();
      expect(screen.getAllByRole('listitem')).toHaveLength(4);
    });

    it('a done step is plain text with the Done status', () => {
      render(<OnboardingChecklist steps={[...userSteps, meetCoach('done')]} completed={2} total={4} />);
      const step = screen.getByTestId('onboarding-step-ai_plan');
      expect(within(step).getByText('Meet your coach')).toBeInTheDocument();
      expect(within(step).getByText('Done')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Meet your coach/ })).toBeNull();
    });
  });
});
