/**
 * `/train/workouts/:workoutId` with "Last time" and PRs (E4.4), against the
 * stateful MSW workouts API and the issue's fixture history (kg, all
 * completed working sets): Sep 1 60x10, 60x10; Sep 8 62.5x8, 62.5x8; Sep 15
 * 65x6. In a new workout on Sep 22: "Last time" shows Sep 15; Copy sets
 * pre-fills 65 x 6 not done; 65x7 earns Rep PR and Est. 1RM PR the moment it
 * is completed; 67.5x5 earns Weight PR only; the summary lists them; after a
 * reload the chips are still there. A warm-up (Sep 8, 100x1) and an
 * uncompleted set (Sep 15, 90x3) are never "prior".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import WorkoutPage from '../../pages/WorkoutPage';
import { clearExerciseHistoryCache } from '../../hooks/useExerciseHistory';
import { mockExercise, statefulExercisesApi } from '../mocks/fixtures/exercises';
import { mockEntry, mockSet, mockWorkout, statefulWorkoutsApi } from '../mocks/fixtures/workouts';
import type { Workout } from '../../services/workouts';

const GYM = { id: '00000000-0000-4000-8000-a00000000001', name: 'Home Gym' };
const OTHER_GYM = { id: '00000000-0000-4000-8000-a00000000002', name: 'Office Gym' };
const bench = mockExercise({ name: 'Dumbbell bench press', slug: 'dumbbell_bench_press' });
const plank = mockExercise({ name: 'Plank', slug: 'plank', primaryMuscles: ['abs'], trackingMode: 'time' });
const LIBRARY = [bench, plank];

function done(weightKg: number, reps: number, extra: Parameters<typeof mockSet>[0] = {}) {
  return mockSet({ weightKg, reps, completed: true, ...extra });
}

function past(date: string, sets: ReturnType<typeof mockSet>[], gym: typeof GYM | null = GYM): Workout {
  return mockWorkout({
    name: `Workout ${date}`,
    status: 'completed',
    date,
    startedAt: `${date}T12:00:00.000Z`,
    endedAt: `${date}T13:00:00.000Z`,
    durationSeconds: 3600,
    gym,
    exercises: [mockEntry(bench, { sets })],
  });
}

function fixtureHistory() {
  return [
    past('2026-09-01', [done(60, 10), done(60, 10)]),
    past('2026-09-08', [done(62.5, 8), done(62.5, 8), done(100, 1, { isWarmup: true })]),
    past('2026-09-15', [done(65, 6), mockSet({ weightKg: 90, reps: 3 })]),
  ];
}

function today(sets = [mockSet()]) {
  return mockWorkout({
    name: 'Push day',
    date: '2026-09-22',
    startedAt: '2026-09-22T12:00:00.000Z',
    gym: GYM,
    exercises: [mockEntry(bench, { sets })],
  });
}

function renderPage(id: string) {
  return render(
    <Routes>
      <Route path="/train/workouts/:workoutId" element={<WorkoutPage />} />
    </Routes>,
    { wrapperOptions: { route: `/train/workouts/${id}`, user: mockUser } },
  );
}

beforeEach(() => clearExerciseHistoryCache());

describe('WorkoutPage: last time and PRs', () => {
  it('shows last time, copies it, earns PRs on completion, summarises them, and keeps them after reload', async () => {
    statefulExercisesApi(LIBRARY);
    const workout = today();
    const api = statefulWorkoutsApi([...fixtureHistory(), workout], { exercises: LIBRARY, gyms: [GYM] });
    const user = userEvent.setup();
    const { unmount } = renderPage(workout.id);

    const card = await screen.findByRole('region', { name: 'Dumbbell bench press' });
    const line = await within(card).findByTestId('last-time');
    expect(line).toHaveTextContent('Last time (Tue, Sep 15, Home Gym): 65 kg × 6');
    expect(line).toHaveTextContent('Best est. 1RM 80 kg');

    // Copy sets fills the empty row, not done.
    await user.click(within(card).getByRole('button', { name: "Copy last time's sets into Dumbbell bench press" }));
    await waitFor(() => expect(within(card).getByRole('textbox', { name: 'Set 1 weight in kg' })).toHaveValue('65'));
    expect(within(card).getByRole('textbox', { name: 'Set 1 reps' })).toHaveValue('6');
    expect(within(card).getByRole('button', { name: 'Complete set 1' })).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(within(card).queryByRole('button', { name: /Copy last time/ })).toBeNull());

    // 65 x 7: Rep PR (6 at >= 65 kg) and Est. 1RM PR (80.2 > 80.0), not a weight PR.
    const reps1 = within(card).getByRole('textbox', { name: 'Set 1 reps' });
    await user.clear(reps1);
    await user.type(reps1, '7');
    await user.click(within(card).getByRole('button', { name: 'Complete set 1' }));
    const set1 = within(card).getByRole('group', { name: 'Set 1' });
    const chips1 = await within(set1).findByRole('list', { name: 'Personal records' });
    expect(chips1).toHaveTextContent('Rep PR: 7 reps. Previous best 6 reps at this weight or heavier');
    expect(chips1).toHaveTextContent('Est. 1RM PR: 80.2 kg. Previous best est. 1RM 80 kg');
    expect(chips1).not.toHaveTextContent('Weight PR');
    expect(within(set1).getByRole('status')).toHaveTextContent('Set 1: Rep PR, Est. 1RM PR');

    // 67.5 x 5: Weight PR only (e1RM 78.8 < 80.2; nothing prior at >= 67.5 kg).
    const weight2 = await within(card).findByRole('textbox', { name: 'Set 2 weight in kg' });
    await user.clear(weight2);
    await user.type(weight2, '67.5');
    const reps2 = within(card).getByRole('textbox', { name: 'Set 2 reps' });
    await user.clear(reps2);
    await user.type(reps2, '5');
    await user.click(within(card).getByRole('button', { name: 'Complete set 2' }));
    const set2 = within(card).getByRole('group', { name: 'Set 2' });
    const chips2 = await within(set2).findByRole('list', { name: 'Personal records' });
    expect(chips2).toHaveTextContent('Weight PR: 67.5 kg. Previous best 65 kg');
    expect(within(chips2).getAllByRole('listitem')).toHaveLength(1);

    // The fixture's warm-up 100x1 and uncompleted 90x3 are not prior: the previous best is 65 kg.
    await within(card).findByRole('textbox', { name: 'Set 3 weight in kg' });

    await user.click(screen.getByRole('button', { name: 'Finish' }));
    const summary = await screen.findByRole('dialog', { name: 'Workout finished' });
    const prs = within(summary).getByRole('region', { name: 'Personal records' });
    expect(within(prs).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Weight PR 67.5 kg (set 2). Previous best 65 kg.',
      'Rep PR 7 reps (set 1). Previous best 6 reps at this weight or heavier.',
      'Est. 1RM PR 80.2 kg (set 1). Previous best est. 1RM 80 kg.',
    ]);
    await user.click(within(summary).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    // The completed view lists them too.
    expect(screen.getByRole('region', { name: 'Personal records' })).toHaveTextContent('Weight PR 67.5 kg (set 2)');

    // Reload: the chips come back from GET /workouts/:id.
    unmount();
    expect(api.workouts.find((w) => w.id === workout.id)?.status).toBe('completed');
    renderPage(workout.id);
    const reloaded = await screen.findByRole('region', { name: 'Dumbbell bench press' });
    const again = await within(within(reloaded).getByRole('group', { name: 'Set 1' })).findByRole('list', {
      name: 'Personal records',
    });
    expect(again).toHaveTextContent('Rep PR');
    expect(again).toHaveTextContent('Est. 1RM PR');
    expect(within(within(reloaded).getByRole('group', { name: 'Set 2' })).getByText('Weight PR')).toBeInTheDocument();
  });

  it('prefers the same gym when one of the two most recent workouts was there', async () => {
    statefulExercisesApi(LIBRARY);
    const history = [
      past('2026-09-08', [done(62.5, 8)], GYM),
      past('2026-09-15', [done(65, 6)], OTHER_GYM),
    ];
    const workout = today();
    statefulWorkoutsApi([...history, workout], { exercises: LIBRARY, gyms: [GYM, OTHER_GYM] });
    renderPage(workout.id);
    const card = await screen.findByRole('region', { name: 'Dumbbell bench press' });
    expect(await within(card).findByTestId('last-time')).toHaveTextContent(
      'Last time (Tue, Sep 8, Home Gym): 62.5 kg × 8',
    );
  });

  it('says "First time logging this exercise" and marks the first set', async () => {
    statefulExercisesApi(LIBRARY);
    const workout = today([mockSet({ weightKg: 40, reps: 10 })]);
    statefulWorkoutsApi([workout], { exercises: LIBRARY });
    const user = userEvent.setup();
    renderPage(workout.id);
    const card = await screen.findByRole('region', { name: 'Dumbbell bench press' });
    expect(await within(card).findByText('First time logging this exercise')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Complete set 1' }));
    const set1 = within(card).getByRole('group', { name: 'Set 1' });
    expect(await within(set1).findByText('First time logged')).toBeInTheDocument();
    expect(within(set1).queryByText('Weight PR')).toBeNull();
  });

  it('a timed exercise shows its durations and never PR chips', async () => {
    statefulExercisesApi(LIBRARY);
    const earlier = mockWorkout({
      status: 'completed',
      date: '2026-09-15',
      startedAt: '2026-09-15T12:00:00.000Z',
      exercises: [mockEntry(plank, { sets: [mockSet({ durationSeconds: 60, completed: true })] })],
    });
    const workout = mockWorkout({
      date: '2026-09-22',
      startedAt: '2026-09-22T12:00:00.000Z',
      exercises: [mockEntry(plank, { sets: [mockSet({ durationSeconds: 90 })] })],
    });
    statefulWorkoutsApi([earlier, workout], { exercises: LIBRARY });
    const user = userEvent.setup();
    renderPage(workout.id);
    const card = await screen.findByRole('region', { name: 'Plank' });
    expect(await within(card).findByTestId('last-time')).toHaveTextContent('Last time (Tue, Sep 15): 1:00');
    await user.click(within(card).getByRole('button', { name: 'Complete set 1' }));
    await within(card).findByRole('group', { name: 'Set 2' });
    expect(within(card).queryByRole('list', { name: 'Personal records' })).toBeNull();
  });

  it('has no axe violations with last time and PR chips', async () => {
    statefulExercisesApi(LIBRARY);
    const workout = today([done(65, 7)]);
    statefulWorkoutsApi([...fixtureHistory(), workout], { exercises: LIBRARY, gyms: [GYM] });
    const { container } = renderPage(workout.id);
    const card = await screen.findByRole('region', { name: 'Dumbbell bench press' });
    await within(card).findByTestId('last-time');
    await within(card).findByRole('list', { name: 'Personal records' });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
