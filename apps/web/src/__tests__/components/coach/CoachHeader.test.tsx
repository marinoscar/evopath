/**
 * `CoachHeader` (E7.8, #248): every number equals `GET /api/coach/state` as
 * sent — the ring text, the streak, the passes and the next session — and the
 * paused banner shows while `pausedUntil` is in the future.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render } from '../../utils/test-utils';
import { CoachHeader, weeklyTargetText } from '../../../components/coach/CoachHeader';
import { mockCoachPersona, mockCoachState } from '../../mocks/fixtures/coach';

describe('CoachHeader', () => {
  it('shows the persona name and tagline as the page heading', () => {
    render(<CoachHeader persona={mockCoachPersona({ name: 'Nana' })} state={null} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Nana' })).toBeInTheDocument();
    expect(screen.queryByTestId('coach-header-signals')).not.toBeInTheDocument();
  });

  it('falls back to "Coach" before the persona loads', () => {
    render(<CoachHeader persona={null} state={null} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Coach' })).toBeInTheDocument();
  });

  it('displays the ring, streak, passes and next session exactly as the state says', () => {
    render(<CoachHeader persona={mockCoachPersona()} state={mockCoachState()} />);
    expect(screen.getByTestId('coach-weekly-target')).toHaveTextContent('2 of 3 this week');
    expect(screen.getByRole('progressbar', { name: 'Weekly target' })).toHaveAttribute('aria-valuenow', '67');
    expect(screen.getByTestId('coach-streak')).toHaveTextContent('4-week streak · 1 pass left');
    expect(screen.getByTestId('coach-next-session')).toHaveTextContent('Next: Upper body A');
  });

  it('says so when nothing is planned', () => {
    render(
      <CoachHeader
        persona={null}
        state={mockCoachState({ weeklyTarget: { done: 0, planned: 0 }, nextSession: null, streakPassesLeft: 2 })}
      />,
    );
    expect(screen.getByTestId('coach-weekly-target')).toHaveTextContent('No sessions planned this week');
    expect(screen.getByTestId('coach-next-session')).toHaveTextContent('No session planned in the next 7 days');
    expect(screen.getByTestId('coach-streak')).toHaveTextContent('2 passes left');
    expect(weeklyTargetText({ done: 1, planned: 4 })).toBe('1 of 4 this week');
  });

  it('shows the paused banner only while pausedUntil is in the future', () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const { rerender } = render(<CoachHeader persona={null} state={mockCoachState({ pausedUntil: future })} />);
    expect(screen.getByTestId('coach-paused')).toHaveTextContent(/Coach paused until/);

    const past = new Date(Date.now() - 86_400_000).toISOString();
    rerender(<CoachHeader persona={null} state={mockCoachState({ pausedUntil: past })} />);
    expect(screen.queryByTestId('coach-paused')).not.toBeInTheDocument();
  });

  it('links to coach settings when the coach is off', () => {
    render(<CoachHeader persona={null} state={mockCoachState({ enabled: false })} />);
    expect(screen.getByRole('link', { name: 'Coach settings' })).toHaveAttribute('href', '/settings/coach');
  });

  it('has no axe violations', async () => {
    const { container } = render(<CoachHeader persona={mockCoachPersona()} state={mockCoachState()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
