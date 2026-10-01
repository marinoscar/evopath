/**
 * GoalsPage (`/train/goals`, #268): the list by status, create from a
 * template, custom-goal validation, edit with If-Match and a stale 412,
 * pause / resume / archive, the active-goal limit, history, read-only, axe.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import GoalsPage from '../../../pages/Train/GoalsPage';
import { GOAL_LIMIT_MESSAGE, GOAL_STALE_MESSAGE } from '../../../services/goals';
import { mockGoal, statefulGoalsApi } from '../../mocks/fixtures/goals';

const writer = { ...mockUser, permissions: [...mockUser.permissions, 'goals:read', 'goals:write'] };
const reader = { ...mockUser, permissions: [...mockUser.permissions, 'goals:read'] };

function renderPage(user = writer) {
  return render(<GoalsPage />, { wrapperOptions: { route: '/train/goals', user } });
}

async function openNewGoal() {
  await userEvent.click(screen.getByRole('button', { name: 'New goal' }));
  return screen.findByRole('dialog', { name: 'New goal' });
}

describe('GoalsPage', () => {
  it('lists active goals and filters by Paused and Archived', async () => {
    statefulGoalsApi([
      mockGoal({ title: 'Walk 4 times a week' }),
      mockGoal({ title: 'Evening runs', activityKind: 'run', status: 'paused' }),
      mockGoal({ title: 'Old yoga', activityKind: 'custom', customLabel: 'Yoga', status: 'archived' }),
    ]);
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Goals' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Walk 4 times a week' })).toBeInTheDocument();
    expect(screen.getByText('4 walks a week')).toBeInTheDocument();
    expect(screen.queryByText('Evening runs')).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: 'Paused' }));
    expect(await screen.findByRole('heading', { name: 'Evening runs' })).toBeInTheDocument();
    expect(screen.queryByText('Walk 4 times a week')).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume Evening runs' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    expect(await screen.findByRole('heading', { name: 'Old yoga' })).toBeInTheDocument();
    // Archived goals are read-only.
    expect(screen.queryByRole('button', { name: 'Edit Old yoga' })).toBeNull();
    expect(screen.getByText('Yoga')).toBeInTheDocument();
  });

  it('shows the empty state with a first-goal button', async () => {
    statefulGoalsApi([]);
    renderPage();
    expect(await screen.findByText('No active goals yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set your first goal' })).toBeInTheDocument();
  });

  it('creates a goal from a template', async () => {
    const api = statefulGoalsApi([]);
    renderPage();
    await screen.findByText('No active goals yet.');
    const dialog = await openNewGoal();
    await userEvent.click(await within(dialog).findByRole('button', { name: /8,000 steps a day/ }));
    expect(within(dialog).getByLabelText(/Goal name/)).toHaveValue('8,000 steps a day');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));

    expect(await screen.findByRole('heading', { name: '8,000 steps a day' })).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/goals');
    expect(post?.body).toEqual({ title: '8,000 steps a day', activityKind: 'walk', metric: 'steps', target: 8000, period: 'day' });
    expect(screen.getByText('Created 8,000 steps a day.')).toBeInTheDocument();
  });

  it('validates a custom goal before sending it, and forces sessions to weekly', async () => {
    const api = statefulGoalsApi([]);
    renderPage();
    await screen.findByText('No active goals yet.');
    const dialog = await openNewGoal();

    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Activity' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Custom' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));
    expect(within(dialog).getByText('Give the goal a name.')).toBeInTheDocument();
    expect(within(dialog).getByText('Say what the activity is, e.g. Yoga.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a target above zero.')).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    // Sessions are counted per week: the period is locked to weekly.
    expect(within(dialog).getByText('Sessions are counted per week.')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText(/Goal name/), 'Yoga twice a week');
    await userEvent.type(within(dialog).getByLabelText(/Activity name/), 'Yoga');
    await userEvent.type(within(dialog).getByLabelText(/Target/), '2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));

    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(api.calls[0].body).toEqual({
      title: 'Yoga twice a week',
      activityKind: 'custom',
      customLabel: 'Yoga',
      metric: 'sessions',
      target: 2,
      period: 'week',
    });
  });

  it('explains the active-goal limit (409 GOAL_LIMIT_REACHED)', async () => {
    statefulGoalsApi(Array.from({ length: 10 }, (_, i) => mockGoal({ title: `Goal ${i + 1}` })));
    renderPage();
    await screen.findByRole('heading', { name: 'Goal 1' });
    const dialog = await openNewGoal();
    await userEvent.click(await within(dialog).findByRole('button', { name: /Walk 4 times a week/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));
    expect(await within(dialog).findByText(GOAL_LIMIT_MESSAGE)).toBeInTheDocument();
  });

  it('edits with If-Match and sends only what changed', async () => {
    const goal = mockGoal({ title: 'Walk 4 times a week', version: 3 });
    const api = statefulGoalsApi([goal]);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Walk 4 times a week' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit goal' });
    const target = within(dialog).getByLabelText(/Target/);
    await userEvent.clear(target);
    await userEvent.type(target, '5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit goal' })).toBeNull());
    const patch = api.calls.find((c) => c.method === 'PATCH');
    expect(patch?.ifMatch).toBe('3');
    expect(patch?.body).toEqual({ target: 5 });
    expect(await screen.findByText('5 walks a week')).toBeInTheDocument();
  });

  it('explains a stale edit (412) and reloads the latest version', async () => {
    const goal = mockGoal({ title: 'Walk', version: 1 });
    const api = statefulGoalsApi([goal]);
    api.failNextPatchStale = true;
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Walk' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit goal' });
    const target = within(dialog).getByLabelText(/Target/);
    await userEvent.clear(target);
    await userEvent.type(target, '6');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(GOAL_STALE_MESSAGE)).toBeInTheDocument();
    // The form now holds the version saved elsewhere; saving again sends its version.
    await waitFor(() => expect(within(dialog).getByLabelText(/Goal name/)).toHaveValue('Walk (edited elsewhere)'));
    await userEvent.clear(within(dialog).getByLabelText(/Target/));
    await userEvent.type(within(dialog).getByLabelText(/Target/), '6');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit goal' })).toBeNull());
    const patches = api.calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => c.ifMatch)).toEqual(['1', '2']);
    expect(patches[1].body).toEqual({ target: 6 });
  });

  it('pauses, resumes and archives (with a confirmation)', async () => {
    const api = statefulGoalsApi([mockGoal({ title: 'Walk' })]);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Pause Walk' }));
    expect(await screen.findByText('Walk paused.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Walk' })).toBeNull());

    await userEvent.click(screen.getByRole('tab', { name: 'Paused' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Archive Walk' }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive this goal?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Walk archived.')).toBeInTheDocument();
    expect(api.calls.map((c) => c.path)).toEqual([
      `/goals/${api.goals[0].id}/pause`,
      `/goals/${api.goals[0].id}/archive`,
    ]);
    expect(api.goals[0].status).toBe('archived');
  });

  it('shows the history with Hit / Missed chips and the streak', async () => {
    const goal = mockGoal({ title: 'Walk' });
    const api = statefulGoalsApi([goal]);
    api.history[goal.id] = [
      { periodStart: '2026-09-21', periodEnd: '2026-09-27', done: 4, target: 4, hit: true },
      { periodStart: '2026-09-14', periodEnd: '2026-09-20', done: 4, target: 4, hit: true },
      { periodStart: '2026-09-07', periodEnd: '2026-09-13', done: 2, target: 4, hit: false },
    ];
    renderPage();
    const history = await screen.findByRole('button', { name: 'History' });
    expect(history).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(history);
    expect(history).toHaveAttribute('aria-expanded', 'true');
    const list = await screen.findByRole('list', { name: 'Walk history' });
    expect(within(list).getAllByText('Hit')).toHaveLength(2);
    expect(within(list).getByText('Missed')).toBeInTheDocument();
    expect(within(list).getByText('2 of 4 walks')).toBeInTheDocument();
    expect(screen.getByText('Current streak: 2 weeks')).toBeInTheDocument();
  });

  it('offers no writes without goals:write', async () => {
    statefulGoalsApi([mockGoal({ title: 'Walk' })]);
    renderPage(reader);
    expect(await screen.findByRole('heading', { name: 'Walk' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New goal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause Walk' })).toBeNull();
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    statefulGoalsApi([mockGoal({ title: 'Walk' })]);
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Walk' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
