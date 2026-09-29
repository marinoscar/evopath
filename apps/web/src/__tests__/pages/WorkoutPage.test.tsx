/**
 * `/train/workouts/:workoutId` (E4.3) against the stateful MSW workouts and
 * exercises APIs: the active logger end to end (add an exercise, log sets
 * with the next row prefilled and focused, finish with the confirm and the
 * summary), the completed detail view (edit, delete), tracking modes, the
 * not-found state and permissions.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import WorkoutPage from '../../pages/WorkoutPage';
import { mockExercise, statefulExercisesApi } from '../mocks/fixtures/exercises';
import { mockHealthProfileSaved } from '../mocks/fixtures/health';
import { mockEntry, mockSet, mockWorkout, statefulWorkoutsApi } from '../mocks/fixtures/workouts';

const GYM = { id: '00000000-0000-4000-8000-a00000000001', name: 'Home Gym' };
const bench = mockExercise({ name: 'Dumbbell bench press', slug: 'dumbbell_bench_press' });
const pullUp = mockExercise({
  name: 'Pull-up',
  slug: 'pull_up',
  primaryMuscles: ['lats'],
  trackingMode: 'bodyweight_reps',
  isBodyweight: true,
});
const plank = mockExercise({ name: 'Plank', slug: 'plank', primaryMuscles: ['abs'], trackingMode: 'time' });
const run = mockExercise({ name: 'Run', slug: 'run', primaryMuscles: ['full_body'], trackingMode: 'distance_time' });
const LIBRARY = [bench, pullUp, plank, run];

function imperial() {
  server.use(http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })));
}

function renderPage(id: string, options: { permissions?: string[]; state?: unknown } = {}) {
  const user = options.permissions ? { ...mockUser, permissions: options.permissions } : mockUser;
  return render(
    <Routes>
      <Route path="/train/workouts/:workoutId" element={<WorkoutPage />} />
      <Route path="/train" element={<h1>Train stand-in</h1>} />
    </Routes>,
    { wrapperOptions: { route: `/train/workouts/${id}`, user, routeState: options.state } },
  );
}

describe('WorkoutPage', () => {
  it('logs a workout end to end: add, three sets with the next row prefilled and focused, finish', async () => {
    imperial();
    statefulExercisesApi(LIBRARY);
    const workout = mockWorkout({ name: 'Push day', gym: GYM });
    const api = statefulWorkoutsApi([workout], { exercises: LIBRARY, gyms: [GYM] });
    const user = userEvent.setup();
    renderPage(workout.id);

    expect(await screen.findByRole('heading', { level: 1, name: 'Push day' })).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Elapsed time' })).toHaveAttribute('aria-live', 'off');
    expect(screen.getByRole('button', { name: 'Gym: Home Gym. Change gym' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add exercise' }));
    const picker = await screen.findByRole('dialog', { name: 'Add exercises' });
    await user.click(await within(picker).findByRole('checkbox', { name: 'Dumbbell bench press' }));
    await user.click(within(picker).getByRole('button', { name: 'Add exercise' }));

    const card = await screen.findByRole('region', { name: 'Dumbbell bench press' });
    const weight1 = await within(card).findByRole('textbox', { name: 'Set 1 weight in lb' });
    await user.type(weight1, '70');
    await user.type(within(card).getByRole('textbox', { name: 'Set 1 reps' }), '10');
    await user.click(within(card).getByRole('button', { name: 'Complete set 1' }));

    // The next row is prefilled by the server and focused.
    const weight2 = await within(card).findByRole('textbox', { name: 'Set 2 weight in lb' });
    await waitFor(() => expect(weight2).toHaveFocus());
    expect(weight2).toHaveValue('70');
    expect(within(card).getByRole('textbox', { name: 'Set 2 reps' })).toHaveValue('10');

    // "70" lb is stored as 31.751 kg.
    const weightPatch = api.calls.find(
      (c) => c.method === 'PATCH' && (c.body as { weightKg?: number }).weightKg !== undefined,
    );
    expect(weightPatch?.body).toMatchObject({ weightKg: 31.751 });

    await user.click(within(card).getByRole('button', { name: 'Complete set 2' }));
    const reps3 = await within(card).findByRole('textbox', { name: 'Set 3 reps' });
    await user.clear(reps3);
    await user.type(reps3, '9');
    await user.click(within(card).getByRole('button', { name: 'Complete set 3' }));
    await within(card).findByRole('textbox', { name: 'Set 4 weight in lb' });

    // The untouched prefilled row 4 is dropped, not asked about.
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    const summary = await screen.findByRole('dialog', { name: 'Workout finished' });
    expect(screen.queryByRole('dialog', { name: 'Finish workout?' })).toBeNull();
    expect(api.calls.filter((c) => c.method === 'DELETE' && c.path.includes('/sets/'))).toHaveLength(1);
    expect(api.workouts[0].exercises[0].sets).toHaveLength(3);
    expect(summary).toHaveTextContent('Sets3');
    expect(summary).toHaveTextContent('Exercises1');
    expect(summary).toHaveTextContent(`Volume${(2030).toLocaleString()} lb`);
    await user.click(within(summary).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(api.workouts[0].status).toBe('completed');
  });

  it('an auto-added row the user edited but did not mark done still asks', async () => {
    const workout = mockWorkout({
      exercises: [mockEntry(bench, { sets: [mockSet({ weightKg: 50, reps: 5 })] })],
    });
    const api = statefulWorkoutsApi([workout], { exercises: LIBRARY });
    const user = userEvent.setup();
    renderPage(workout.id);
    await user.click(await screen.findByRole('button', { name: 'Complete set 1' }));
    const reps2 = await screen.findByRole('textbox', { name: 'Set 2 reps' });
    await user.clear(reps2);
    await user.type(reps2, '4');
    await user.tab();
    await waitFor(() => expect(api.calls.some((c) => (c.body as { reps?: number })?.reps === 4)).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    const confirm = await screen.findByRole('dialog', { name: 'Finish workout?' });
    expect(confirm).toHaveTextContent('1 set is not marked done. Mark it done, or leave it?');
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Leave them' }));
    const summary = await screen.findByRole('dialog', { name: 'Workout finished' });
    expect(summary).toHaveTextContent('Sets1');
    expect(api.workouts[0].exercises[0].sets).toHaveLength(2);
  });

  it('Mark done completes the pending sets before finishing', async () => {
    const workout = mockWorkout({
      exercises: [mockEntry(bench, { sets: [mockSet({ weightKg: 50, reps: 5 }), mockSet({ weightKg: 50, reps: 5 })] })],
    });
    const api = statefulWorkoutsApi([workout], { exercises: LIBRARY });
    const user = userEvent.setup();
    renderPage(workout.id);
    await user.click(await screen.findByRole('button', { name: 'Finish' }));
    const confirm = await screen.findByRole('dialog', { name: 'Finish workout?' });
    expect(confirm).toHaveTextContent('2 sets are not marked done. Mark them done, or leave them?');
    await user.click(within(confirm).getByRole('button', { name: 'Mark done' }));
    const summary = await screen.findByRole('dialog', { name: 'Workout finished' });
    expect(summary).toHaveTextContent('Sets2');
    const completions = api.calls.filter((c) => (c.body as { completed?: boolean } | undefined)?.completed === true);
    expect(completions).toHaveLength(2);
  });

  it('finishes without asking when every valued set is done', async () => {
    const workout = mockWorkout({
      exercises: [mockEntry(bench, { sets: [mockSet({ weightKg: 50, reps: 5, completed: true })] })],
    });
    statefulWorkoutsApi([workout], { exercises: LIBRARY });
    const user = userEvent.setup();
    renderPage(workout.id);
    await user.click(await screen.findByRole('button', { name: 'Finish' }));
    expect(await screen.findByRole('dialog', { name: 'Workout finished' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Finish workout?' })).toBeNull();
  });

  it('the same stored weight reads 31.75 kg with metric units', async () => {
    const workout = mockWorkout({
      exercises: [mockEntry(bench, { sets: [mockSet({ weightKg: 31.751, reps: 10 })] })],
    });
    statefulWorkoutsApi([workout], { exercises: LIBRARY });
    renderPage(workout.id);
    expect(await screen.findByRole('textbox', { name: 'Set 1 weight in kg' })).toHaveValue('31.75');
  });

  it('shows duration for a timed exercise and distance and time for cardio, bodyweight only reps', async () => {
    const workout = mockWorkout({
      exercises: [
        mockEntry(plank, { sets: [mockSet({ durationSeconds: 60 })] }),
        mockEntry(run, { sets: [mockSet({ distanceMeters: 5000, durationSeconds: 1500 })] }),
        mockEntry(pullUp, { sets: [mockSet({ reps: 8 })] }),
      ],
    });
    statefulWorkoutsApi([workout], { exercises: LIBRARY });
    renderPage(workout.id);
    const plankCard = await screen.findByRole('region', { name: 'Plank' });
    expect(within(plankCard).getByRole('textbox', { name: 'Set 1 time (minutes:seconds)' })).toHaveValue('1:00');
    expect(within(plankCard).queryByRole('textbox', { name: /weight/ })).toBeNull();
    const runCard = screen.getByRole('region', { name: 'Run' });
    expect(within(runCard).getByRole('textbox', { name: 'Set 1 distance in km' })).toHaveValue('5');
    expect(within(runCard).getByRole('textbox', { name: 'Set 1 time (minutes:seconds)' })).toHaveValue('25:00');
    const pullCard = screen.getByRole('region', { name: 'Pull-up' });
    expect(within(pullCard).getByRole('textbox', { name: 'Set 1 reps' })).toHaveValue('8');
    expect(within(pullCard).queryByRole('textbox', { name: /weight/ })).toBeNull();
  });

  it('shows a not-found state for a deleted workout', async () => {
    statefulWorkoutsApi([]);
    renderPage('00000000-0000-4000-8000-000000000000');
    expect(await screen.findByRole('heading', { level: 1, name: 'Workout not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Train' })).toHaveAttribute('href', '/train');
  });

  it('shows the "already in progress" notice handed over by Start', async () => {
    const workout = mockWorkout();
    statefulWorkoutsApi([workout]);
    renderPage(workout.id, { state: { notice: 'You already have a workout in progress.' } });
    expect(await screen.findByText('You already have a workout in progress.')).toBeInTheDocument();
  });

  it('removes an exercise with a snackbar', async () => {
    const workout = mockWorkout({ exercises: [mockEntry(bench), mockEntry(plank)] });
    statefulWorkoutsApi([workout], { exercises: LIBRARY });
    const user = userEvent.setup();
    renderPage(workout.id);
    await user.click(await screen.findByRole('button', { name: 'Actions for Plank' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove exercise' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Plank' })).toBeNull());
    expect(await screen.findByText('Removed Plank')).toBeInTheDocument();
  });

  it('moves an exercise down', async () => {
    const workout = mockWorkout({ exercises: [mockEntry(bench), mockEntry(plank)] });
    const api = statefulWorkoutsApi([workout], { exercises: LIBRARY });
    const user = userEvent.setup();
    renderPage(workout.id);
    await user.click(await screen.findByRole('button', { name: 'Actions for Dumbbell bench press' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
        'Plank',
        'Dumbbell bench press',
      ]),
    );
    expect(api.calls.some((c) => (c.body as { position?: number })?.position === 1)).toBe(true);
  });

  describe('a completed workout', () => {
    function completedWorkout() {
      return mockWorkout({
        name: 'Leg day',
        status: 'completed',
        endedAt: '2026-09-29T13:00:00.000Z',
        durationSeconds: 3600,
        exercises: [mockEntry(bench, { sets: [mockSet({ weightKg: 40, reps: 10, completed: true })] })],
      });
    }

    it('shows the Completed header and totals, and edits a set weight', async () => {
      const workout = completedWorkout();
      const api = statefulWorkoutsApi([workout], { exercises: LIBRARY });
      const user = userEvent.setup();
      renderPage(workout.id);
      expect(await screen.findByText('Completed')).toBeInTheDocument();
      const totals = screen.getByRole('region', { name: 'Totals' });
      expect(totals).toHaveTextContent('Volume400 kg');
      expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull();
      const weight = screen.getByRole('textbox', { name: 'Set 1 weight in kg' });
      await user.clear(weight);
      await user.type(weight, '45');
      await user.tab();
      await waitFor(() =>
        expect(api.calls.some((c) => (c.body as { weightKg?: number })?.weightKg === 45)).toBe(true),
      );
      await waitFor(() => expect(screen.getByRole('region', { name: 'Totals' })).toHaveTextContent('Volume450 kg'), {
        timeout: 3000,
      });
    });

    it('adds a set to a completed workout', async () => {
      const workout = completedWorkout();
      statefulWorkoutsApi([workout], { exercises: LIBRARY });
      const user = userEvent.setup();
      renderPage(workout.id);
      await user.click(await screen.findByRole('button', { name: 'Add set to Dumbbell bench press' }));
      const weight2 = await screen.findByRole('textbox', { name: 'Set 2 weight in kg' });
      expect(weight2).toHaveValue('40');
      await waitFor(() => expect(weight2).toHaveFocus());
    });

    it('Edit details changes the date', async () => {
      const workout = completedWorkout();
      const api = statefulWorkoutsApi([workout], { exercises: LIBRARY });
      const user = userEvent.setup();
      renderPage(workout.id);
      await user.click(await screen.findByRole('button', { name: 'Edit details' }));
      const dialog = await screen.findByRole('dialog', { name: 'Edit details' });
      const date = within(dialog).getByLabelText('Date');
      await user.clear(date);
      await user.type(date, '2026-09-27');
      await user.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit details' })).toBeNull());
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ date: '2026-09-27' });
    });

    it('deletes after confirmation and returns to Train', async () => {
      const workout = completedWorkout();
      const api = statefulWorkoutsApi([workout], { exercises: LIBRARY });
      const user = userEvent.setup();
      renderPage(workout.id);
      await user.click(await screen.findByRole('button', { name: 'Delete workout' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete workout?' });
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
      expect(await screen.findByRole('heading', { name: 'Train stand-in' })).toBeInTheDocument();
      expect(api.workouts).toHaveLength(0);
    });

    it('has no axe violations', async () => {
      const workout = completedWorkout();
      statefulWorkoutsApi([workout], { exercises: LIBRARY });
      const { container } = renderPage(workout.id);
      await screen.findByText('Completed');
      const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
      expect(results).toHaveNoViolations();
    });
  });

  it('without workouts:write everything is read-only', async () => {
    const workout = mockWorkout({ exercises: [mockEntry(bench, { sets: [mockSet({ reps: 5 })] })] });
    statefulWorkoutsApi([workout], { exercises: LIBRARY });
    renderPage(workout.id, { permissions: mockUser.permissions.filter((p) => p !== 'workouts:write') });
    expect(await screen.findByRole('textbox', { name: 'Set 1 reps' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add exercise' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Complete set 1' })).toBeDisabled();
  });

  it('without workouts:read says so and requests nothing', async () => {
    const api = statefulWorkoutsApi([]);
    renderPage('x', { permissions: mockUser.permissions.filter((p) => !p.startsWith('workouts:')) });
    expect(await screen.findByText('Workout logging is not available for your account.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('the active logger has no axe violations', async () => {
    const workout = mockWorkout({
      gym: GYM,
      exercises: [mockEntry(bench, { sets: [mockSet({ weightKg: 40, reps: 10, painFlag: true })] })],
    });
    statefulWorkoutsApi([workout], { exercises: LIBRARY, gyms: [GYM] });
    const { container } = renderPage(workout.id);
    await screen.findByText('Discomfort flagged');
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
