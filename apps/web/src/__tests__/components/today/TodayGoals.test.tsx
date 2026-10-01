/**
 * The Today "Goals" card body (#268): progress rows, the empty state, the
 * check-in sheet's three modes (and its default from the goal), the day
 * picker, and progress refreshing in place after a check-in.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { GoalsGate, TodayGoals } from '../../../components/today/TodayGoals';
import { localDateIn } from '../../../utils/localDates';
import { addDays } from '../../../utils/goalFormat';
import { mockGoal, mockProgress, statefulGoalsApi } from '../../mocks/fixtures/goals';

const writer = { ...mockUser, permissions: [...mockUser.permissions, 'goals:read', 'goals:write'] };

function renderCard(user = writer) {
  return render(<TodayGoals />, { wrapperOptions: { user } });
}

describe('TodayGoals', () => {
  it('offers "Set a goal" linking to /train/goals with no active goals', async () => {
    statefulGoalsApi([]);
    renderCard();
    expect(await screen.findByRole('link', { name: 'Set a goal' })).toHaveAttribute('href', '/train/goals');
  });

  it('renders a ring, the progress line and on track / behind per goal', async () => {
    const walk = mockGoal({ title: 'Walk 4x' });
    const steps = mockGoal({ title: 'Steps', metric: 'steps', target: 8000, period: 'day' });
    server.use(
      http.get('*/api/goals/progress', () =>
        HttpResponse.json({
          data: [
            mockProgress(walk, { done: 2, daysLeft: 3, onTrack: true, streakPeriods: 3 }),
            mockProgress(steps, { done: 5240, daysLeft: 1, onTrack: false }),
          ],
        }),
      ),
    );
    renderCard();
    const walkRow = await screen.findByTestId(`today-goal-${walk.id}`);
    expect(within(walkRow).getByText('2 of 4 walks · 3 days left')).toBeInTheDocument();
    expect(within(walkRow).getByText('On track')).toBeInTheDocument();
    expect(within(walkRow).getByText('3-week streak')).toBeInTheDocument();
    expect(within(walkRow).getByRole('progressbar', { name: 'Walk 4x: 2 of 4 walks · 3 days left' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    const stepsRow = screen.getByTestId(`today-goal-${steps.id}`);
    expect(within(stepsRow).getByText('5,240 / 8,000 steps')).toBeInTheDocument();
    expect(within(stepsRow).getByText('Behind')).toBeInTheDocument();
  });

  it('checks in with "I did it" and refreshes progress without a reload', async () => {
    const walk = mockGoal({ title: 'Walk 4x' });
    const api = statefulGoalsApi([walk]);
    renderCard();
    const row = await screen.findByTestId(`today-goal-${walk.id}`);
    expect(within(row).getByText('0 of 4 walks · 6 days left')).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'Check in: Walk 4x' }));
    const sheet = await screen.findByRole('dialog', { name: 'Check in: Walk 4x' });
    expect(within(sheet).getByRole('button', { name: 'I did it', pressed: true })).toBeInTheDocument();
    await userEvent.click(within(sheet).getAllByRole('button', { name: 'I did it' }).at(-1)!);

    expect(await within(row).findByText('1 of 4 walks · 6 days left')).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/activity-entries')?.body).toEqual({ activityKind: 'walk' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent('Checked in: Walk 4x.');
  });

  it('opens on Steps for a steps goal and posts the daily total', async () => {
    const steps = mockGoal({ title: 'Steps', activityKind: 'walk', metric: 'steps', target: 8000, period: 'day' });
    const api = statefulGoalsApi([steps]);
    renderCard();
    const row = await screen.findByTestId(`today-goal-${steps.id}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Check in: Steps' }));
    const sheet = await screen.findByRole('dialog', { name: 'Check in: Steps' });
    expect(within(sheet).getByRole('button', { name: 'Steps', pressed: true })).toBeInTheDocument();
    await userEvent.type(within(sheet).getByRole('spinbutton', { name: 'Steps' }), '8200');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(await within(row).findByText('8,200 / 8,000 steps')).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/activity-entries')?.body).toEqual({ activityKind: 'steps', steps: 8200 });
  });

  it('records minutes for an earlier day', async () => {
    const walk = mockGoal({ title: 'Walk', metric: 'minutes', target: 150 });
    const api = statefulGoalsApi([walk]);
    renderCard();
    const row = await screen.findByTestId(`today-goal-${walk.id}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Check in: Walk' }));
    const sheet = await screen.findByRole('dialog', { name: 'Check in: Walk' });
    expect(within(sheet).getByRole('button', { name: 'Minutes', pressed: true })).toBeInTheDocument();

    await userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText('Enter a whole number above zero.')).toBeInTheDocument();

    await userEvent.type(within(sheet).getByRole('spinbutton', { name: 'Minutes' }), '30');
    await userEvent.click(within(sheet).getByRole('combobox', { name: 'Which day' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Yesterday' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(await within(row).findByText('30 / 150 min · 6 days left')).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/activity-entries')?.body).toEqual({
      activityKind: 'walk',
      durationSeconds: 1800,
      occurredOn: addDays(localDateIn(null), -1),
    });
  });

  it('offers no check-in without goals:write', async () => {
    const walk = mockGoal({ title: 'Walk' });
    statefulGoalsApi([walk]);
    renderCard({ ...mockUser, permissions: [...mockUser.permissions, 'goals:read'] });
    await screen.findByTestId(`today-goal-${walk.id}`);
    expect(screen.queryByRole('button', { name: /Check in/ })).toBeNull();
  });

  it('GoalsGate renders only with goals:read', () => {
    const { unmount } = render(
      <GoalsGate>
        <p>inside</p>
      </GoalsGate>,
    );
    expect(screen.queryByText('inside')).toBeNull();
    unmount();
    render(
      <GoalsGate>
        <p>inside</p>
      </GoalsGate>,
      { wrapperOptions: { user: writer } },
    );
    expect(screen.getByText('inside')).toBeInTheDocument();
  });
});
