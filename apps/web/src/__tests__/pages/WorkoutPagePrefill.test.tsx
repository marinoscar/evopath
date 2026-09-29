/**
 * The workout page's E4.5 parts: "Prefill from photo" (enabled with AI and a
 * vision model, disabled with the reason otherwise, absent without
 * `workouts:write`) on the active and the completed view, manual logging
 * unaffected when AI is off, the Photos section, and the prefill summary
 * snackbar / "Continue manually" handed over in the navigation state.
 */
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { render, screen, within, mockUser } from '../utils/test-utils';
import WorkoutPage from '../../pages/WorkoutPage';
import { mockExercise, statefulExercisesApi } from '../mocks/fixtures/exercises';
import { mockWorkout, statefulWorkoutsApi } from '../mocks/fixtures/workouts';

const PREFILLER = { ...mockUser, permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'] };
const bench = mockExercise({ name: 'Dumbbell bench press', slug: 'dumbbell_bench_press' });

function renderPage(id: string, options: { user?: typeof mockUser; aiEnabled?: boolean; state?: unknown } = {}) {
  return render(
    <Routes>
      <Route path="/train/workouts/:workoutId" element={<WorkoutPage />} />
    </Routes>,
    {
      wrapperOptions: {
        route: `/train/workouts/${id}`,
        user: options.user ?? PREFILLER,
        aiEnabled: options.aiEnabled ?? true,
        routeState: options.state,
      },
    },
  );
}

describe('WorkoutPage: Prefill from photo', () => {
  it('links to the prefill page on an active workout with AI on', async () => {
    const w = mockWorkout();
    statefulWorkoutsApi([w]);
    renderPage(w.id);
    expect(await screen.findByRole('link', { name: 'Prefill from photo' })).toHaveAttribute(
      'href',
      `/train/workouts/${w.id}/prefill`,
    );
  });

  it('is offered on the completed view too', async () => {
    const w = mockWorkout({ status: 'completed', endedAt: '2026-09-29T13:00:00.000Z', durationSeconds: 3600 });
    statefulWorkoutsApi([w]);
    renderPage(w.id);
    expect(await screen.findByRole('link', { name: 'Prefill from photo' })).toBeInTheDocument();
  });

  it('with AI off is disabled with the reason, and manual logging still works', async () => {
    const w = mockWorkout();
    const api = statefulWorkoutsApi([w], { exercises: [bench] });
    statefulExercisesApi([bench]);
    const user = userEvent.setup();
    renderPage(w.id, { aiEnabled: false });

    const button = await screen.findByRole('button', { name: 'Prefill from photo' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('AI is turned off for this app.');

    await user.click(screen.getByRole('button', { name: 'Add exercise' }));
    const picker = await screen.findByRole('dialog', { name: 'Add exercises' });
    await user.click(await within(picker).findByRole('checkbox', { name: 'Dumbbell bench press' }));
    await user.click(within(picker).getByRole('button', { name: 'Add exercise' }));
    expect(await screen.findByRole('region', { name: 'Dumbbell bench press' })).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/exercises'))).toBe(true);
  });

  it('a viewer without ai:use sees it disabled with the reason', async () => {
    const w = mockWorkout();
    statefulWorkoutsApi([w]);
    renderPage(w.id, { user: { ...PREFILLER, permissions: PREFILLER.permissions.filter((p) => p !== 'ai:use') } });
    const button = await screen.findByRole('button', { name: 'Prefill from photo' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Your account cannot use AI features.');
  });

  it('is absent without workouts:write', async () => {
    const w = mockWorkout();
    statefulWorkoutsApi([w]);
    renderPage(w.id, { user: { ...PREFILLER, permissions: PREFILLER.permissions.filter((p) => p !== 'workouts:write') } });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('Prefill from photo')).toBeNull();
  });

  it('lists the photos the workout was prefilled from', async () => {
    const w = mockWorkout({
      status: 'completed',
      endedAt: '2026-09-29T13:00:00.000Z',
      durationSeconds: 3600,
      photos: [
        { id: 'wp1', storageObjectId: '00000000-0000-4000-8000-920000000001', caption: null, createdAt: '2026-09-29T12:00:00.000Z' },
        { id: 'wp2', storageObjectId: '00000000-0000-4000-8000-920000000002', caption: 'Notebook', createdAt: '2026-09-29T12:00:00.000Z' },
      ],
    });
    statefulWorkoutsApi([w]);
    renderPage(w.id);
    const list = await screen.findByRole('list', { name: 'Workout photos' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(await within(list).findByRole('img', { name: 'Notebook' })).toBeInTheDocument();
  });

  it('shows no Photos section without photos', async () => {
    const w = mockWorkout();
    statefulWorkoutsApi([w]);
    renderPage(w.id);
    await screen.findByRole('link', { name: 'Prefill from photo' });
    expect(screen.queryByRole('list', { name: 'Workout photos' })).toBeNull();
  });

  it('shows the prefill summary handed over in the navigation state', async () => {
    const w = mockWorkout();
    statefulWorkoutsApi([w]);
    renderPage(w.id, { state: { snack: '3 exercises added. Sets are not marked done; check them off as you train.' } });
    expect(
      await screen.findByText('3 exercises added. Sets are not marked done; check them off as you train.'),
    ).toBeInTheDocument();
  });
});
