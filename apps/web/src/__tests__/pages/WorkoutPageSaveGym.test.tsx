/**
 * E6.2: the finish summary of a workout at a temporary gym asks "Save {name}
 * for future use?". Save gym makes it permanent with the same id; Not now
 * leaves it temporary; a workout at a saved gym is not asked. Against the
 * stateful MSW workouts and gyms APIs.
 */
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import WorkoutPage from '../../pages/WorkoutPage';
import { mockExercise, statefulExercisesApi } from '../mocks/fixtures/exercises';
import { mockEntry, mockSet, mockWorkout, statefulWorkoutsApi } from '../mocks/fixtures/workouts';
import { mockGymDetail, statefulGymsApi } from '../mocks/fixtures/gyms';

const HOTEL_ID = '00000000-0000-4000-8000-a00000000e62';
const HOME_ID = '00000000-0000-4000-8000-a00000000e63';
const bench = mockExercise({ name: 'Dumbbell bench press', slug: 'dumbbell_bench_press' });

function setup(gymId: string, name: string, isTemporary: boolean) {
  statefulExercisesApi([bench]);
  const gymRef = { id: gymId, name };
  const workout = mockWorkout({
    name: 'Hotel session',
    gym: gymRef,
    gymId,
    exercises: [mockEntry(bench, { sets: [mockSet({ weightKg: 20, reps: 10, completed: true })] })],
  });
  statefulWorkoutsApi([workout], { exercises: [bench], gyms: [gymRef] });
  const gyms = statefulGymsApi([
    mockGymDetail({ id: HOME_ID, name: 'Home Gym', isDefault: true }),
    ...(gymId === HOME_ID ? [] : [mockGymDetail({ id: gymId, name, type: 'hotel', isDefault: false, isTemporary })]),
  ]);
  render(
    <Routes>
      <Route path="/train/workouts/:workoutId" element={<WorkoutPage />} />
    </Routes>,
    { wrapperOptions: { route: `/train/workouts/${workout.id}`, user: mockUser } },
  );
  return gyms;
}

async function finish(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 1, name: 'Hotel session' });
  // The gyms list loads with the page; the summary reads it when it opens.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Finish' })).toBeEnabled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  await user.click(screen.getByRole('button', { name: 'Finish' }));
  return screen.findByRole('dialog', { name: 'Workout finished' });
}

describe('WorkoutPage: save a temporary gym after the workout (E6.2)', () => {
  it('Save gym makes the gym permanent with the same id', async () => {
    const gyms = setup(HOTEL_ID, 'Hotel gym Sep 30', true);
    const user = userEvent.setup();
    const summary = await finish(user);

    const prompt = within(summary).getByRole('region', { name: 'Save Hotel gym Sep 30 for future use?' });
    await user.click(within(prompt).getByRole('button', { name: 'Save gym' }));
    await user.click(within(summary).getByRole('button', { name: 'Save' }));

    expect(await within(summary).findByTestId('save-gym-saved')).toHaveTextContent('Saved. Hotel gym Sep 30 is in your gyms.');
    expect(gyms.calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: `/gyms/${HOTEL_ID}`,
      body: { name: 'Hotel gym Sep 30', type: 'hotel', isTemporary: false },
    });
    expect(gyms.gyms.find((g) => g.id === HOTEL_ID)?.isTemporary).toBe(false);
  });

  it('Not now leaves it temporary', async () => {
    const gyms = setup(HOTEL_ID, 'Hotel gym Sep 30', true);
    const user = userEvent.setup();
    const summary = await finish(user);
    await user.click(within(summary).getByRole('button', { name: 'Not now' }));
    expect(within(summary).getByTestId('save-gym-dismissed')).toHaveTextContent('stays temporary');
    expect(gyms.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(gyms.gyms.find((g) => g.id === HOTEL_ID)?.isTemporary).toBe(true);
  });

  it('does not ask for a saved gym', async () => {
    setup(HOME_ID, 'Home Gym', false);
    const user = userEvent.setup();
    const summary = await finish(user);
    expect(within(summary).queryByTestId('save-gym-prompt')).toBeNull();
  });
});
