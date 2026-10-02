/**
 * `CoachHeader` (E7.8, #248): every number equals `GET /api/coach/state` as
 * sent — the ring text, the streak, the passes and the next session — and the
 * paused banner shows while `pausedUntil` is in the future.
 *
 * Collapsible header (#324): collapsed by default below `sm`, expanded from
 * `sm` up, an explicit toggle persisted in localStorage, and the paused banner
 * visible in both states.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import {
  CoachHeader,
  HEADER_EXPANDED_STORAGE_KEY,
  weeklyTargetChipText,
  weeklyTargetText,
} from '../../../components/coach/CoachHeader';
import { mockCoachPersona, mockCoachState } from '../../mocks/fixtures/coach';

const PHONE = 375;
const DESKTOP = 1280;

beforeEach(() => {
  window.localStorage.clear();
});

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

  describe('collapsible (#324)', () => {
    const toggle = (name: RegExp | string) => screen.getByRole('button', { name });

    it('starts collapsed at phone width, with the compact chips', () => {
      setViewportWidth(PHONE);
      render(<CoachHeader persona={mockCoachPersona({ name: 'Nana' })} state={mockCoachState()} />);
      const button = toggle('Show coach details');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('heading', { level: 1, name: 'Nana' })).toBeInTheDocument();
      expect(screen.getByTestId('coach-target-chip')).toHaveTextContent('2/3 this week');
      expect(screen.getByTestId('coach-streak-chip')).toHaveTextContent('4');
      expect(within(screen.getByTestId('coach-streak-chip')).getByText('4-week streak')).toBeInTheDocument();
    });

    it('starts expanded at desktop width, without the compact chips', () => {
      setViewportWidth(DESKTOP);
      render(<CoachHeader persona={mockCoachPersona()} state={mockCoachState()} />);
      expect(toggle('Hide coach details')).toHaveAttribute('aria-expanded', 'true');
      expect(screen.queryByTestId('coach-header-chips')).not.toBeInTheDocument();
      expect(screen.getByTestId('coach-weekly-target')).toBeVisible();
    });

    it('shows "No plan" when nothing is planned', () => {
      setViewportWidth(PHONE);
      render(<CoachHeader persona={null} state={mockCoachState({ weeklyTarget: { done: 0, planned: 0 }, weeklyStreak: 0 })} />);
      expect(screen.getByTestId('coach-target-chip')).toHaveTextContent('No plan');
      expect(screen.getByTestId('coach-streak-chip')).toHaveTextContent('0');
      expect(weeklyTargetChipText({ done: 1, planned: 4 })).toBe('1/4 this week');
    });

    it('omits the chips but keeps the toggle while the state is unavailable', () => {
      setViewportWidth(PHONE);
      render(<CoachHeader persona={mockCoachPersona()} state={null} />);
      expect(screen.queryByTestId('coach-header-chips')).not.toBeInTheDocument();
      expect(toggle('Show coach details')).toBeInTheDocument();
    });

    it('wires aria-controls to the details region', () => {
      setViewportWidth(PHONE);
      render(<CoachHeader persona={mockCoachPersona()} state={mockCoachState()} />);
      const controls = toggle('Show coach details').getAttribute('aria-controls');
      expect(controls).toBeTruthy();
      const region = document.getElementById(controls!);
      expect(region).toBe(screen.getByTestId('coach-header-details'));
      expect(region).toContainElement(screen.getByTestId('coach-weekly-target'));
    });

    it('toggles on click and persists the explicit choice', async () => {
      setViewportWidth(PHONE);
      const user = userEvent.setup();
      const { unmount } = render(<CoachHeader persona={mockCoachPersona()} state={mockCoachState()} />);
      await user.click(toggle('Show coach details'));
      expect(toggle('Hide coach details')).toHaveAttribute('aria-expanded', 'true');
      expect(window.localStorage.getItem(HEADER_EXPANDED_STORAGE_KEY)).toBe('true');
      unmount();

      // A remount on a phone honours the stored choice over the phone default.
      render(<CoachHeader persona={mockCoachPersona()} state={mockCoachState()} />);
      expect(toggle('Hide coach details')).toHaveAttribute('aria-expanded', 'true');
    });

    it('honours a stored collapsed choice at desktop width', () => {
      window.localStorage.setItem(HEADER_EXPANDED_STORAGE_KEY, 'false');
      setViewportWidth(DESKTOP);
      render(<CoachHeader persona={mockCoachPersona()} state={mockCoachState()} />);
      expect(toggle('Show coach details')).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByTestId('coach-target-chip')).toBeInTheDocument();
    });

    it('ignores an unrecognised stored value', () => {
      window.localStorage.setItem(HEADER_EXPANDED_STORAGE_KEY, 'maybe');
      setViewportWidth(PHONE);
      render(<CoachHeader persona={null} state={mockCoachState()} />);
      expect(toggle('Show coach details')).toHaveAttribute('aria-expanded', 'false');
    });

    it('falls back to the default when storage throws', async () => {
      const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      try {
        setViewportWidth(PHONE);
        const user = userEvent.setup();
        render(<CoachHeader persona={null} state={mockCoachState()} />);
        expect(toggle('Show coach details')).toHaveAttribute('aria-expanded', 'false');
        await user.click(toggle('Show coach details'));
        expect(toggle('Hide coach details')).toHaveAttribute('aria-expanded', 'true');
      } finally {
        getItem.mockRestore();
        setItem.mockRestore();
      }
    });

    it('toggles from the keyboard with Enter and Space', async () => {
      setViewportWidth(PHONE);
      const user = userEvent.setup();
      render(<CoachHeader persona={mockCoachPersona()} state={mockCoachState()} />);
      await user.tab();
      expect(toggle('Show coach details')).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(toggle('Hide coach details')).toHaveAttribute('aria-expanded', 'true');
      await user.keyboard(' ');
      expect(toggle('Show coach details')).toHaveAttribute('aria-expanded', 'false');
      expect(window.localStorage.getItem(HEADER_EXPANDED_STORAGE_KEY)).toBe('false');
    });

    it('keeps the paused banner visible in both states', async () => {
      setViewportWidth(PHONE);
      const user = userEvent.setup();
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
      render(<CoachHeader persona={null} state={mockCoachState({ pausedUntil: future })} />);
      expect(screen.getByTestId('coach-paused')).toBeVisible();
      expect(screen.getByTestId('coach-header-details')).not.toContainElement(screen.getByTestId('coach-paused'));
      await user.click(toggle('Show coach details'));
      expect(screen.getByTestId('coach-paused')).toBeVisible();
    });

    it('has no axe violations when collapsed on a phone', async () => {
      setViewportWidth(PHONE);
      const { container } = render(
        <CoachHeader
          persona={mockCoachPersona()}
          state={mockCoachState({ pausedUntil: new Date(Date.now() + 86_400_000).toISOString() })}
        />,
      );
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
