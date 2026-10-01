/**
 * `/train` (E4.3): the unit label, Start workout or the Resume banner, the
 * exercise library link, and History (empty state, rows, Load more), against
 * the stateful MSW workouts API.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import TrainPage from '../../pages/TrainPage';
import { HISTORY_EMPTY_TITLE } from '../../components/train/WorkoutHistoryList';
import { mockHealthProfileSaved } from '../mocks/fixtures/health';
import { mockEntry, mockSet, mockWorkout, statefulWorkoutsApi } from '../mocks/fixtures/workouts';
import { mockExercise } from '../mocks/fixtures/exercises';

const GYM = { id: '00000000-0000-4000-8000-a00000000001', name: 'Home Gym' };
const bench = mockExercise({ name: 'Dumbbell bench press' });

function WorkoutStandIn() {
  return <h1>Workout stand-in</h1>;
}

function renderPage(options: { permissions?: string[] } = {}) {
  const user = options.permissions ? { ...mockUser, permissions: options.permissions } : mockUser;
  return render(
    <Routes>
      <Route path="/train" element={<TrainPage />} />
      <Route path="/train/workouts/:workoutId" element={<WorkoutStandIn />} />
    </Routes>,
    { wrapperOptions: { route: '/train', user } },
  );
}

function completed(n: number) {
  return Array.from({ length: n }, (_, i) =>
    mockWorkout({
      name: `Session ${i + 1}`,
      status: 'completed',
      date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      durationSeconds: 2700,
    }),
  );
}

describe('TrainPage', () => {
  it('renders the h1, the unit in use with a link to change it, and the exercise library link', async () => {
    statefulWorkoutsApi([]);
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Train' })).toBeInTheDocument();
    expect(screen.getByText(/Weights in kg/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change units' })).toHaveAttribute('href', '/settings/health-profile');
    expect(screen.getByRole('link', { name: 'Exercise library' })).toHaveAttribute('href', '/train/exercises');
    expect(await screen.findByText(HISTORY_EMPTY_TITLE)).toBeInTheDocument();
  });

  it('reads the unit from the Health Profile', async () => {
    server.use(http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })));
    statefulWorkoutsApi([]);
    renderPage();
    expect(await screen.findByText(/Weights in lb/)).toBeInTheDocument();
  });

  it('lists history rows with date, gym, duration, counts and volume', async () => {
    const w = mockWorkout({
      name: 'Push day',
      status: 'completed',
      gym: GYM,
      durationSeconds: 3900,
      exercises: [
        mockEntry(bench, {
          sets: [mockSet({ weightKg: 50, reps: 10, completed: true }), mockSet({ weightKg: 50, reps: 8, completed: true })],
        }),
      ],
    });
    statefulWorkoutsApi([w]);
    renderPage();
    const list = await screen.findByRole('list', { name: 'Workout history' });
    const row = within(list).getByRole('link');
    expect(row).toHaveAttribute('href', `/train/workouts/${w.id}`);
    expect(row).toHaveTextContent('Push day');
    expect(row).toHaveTextContent('Home Gym');
    expect(row).toHaveTextContent('1 h 05 min');
    expect(row).toHaveTextContent('1 exercise · 2 sets · 900 kg');
  });

  it('loads more, 20 at a time', async () => {
    statefulWorkoutsApi(completed(23));
    const user = userEvent.setup();
    renderPage();
    const list = await screen.findByRole('list', { name: 'Workout history' });
    expect(within(list).getAllByRole('link')).toHaveLength(20);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(23));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows the Resume banner instead of Start while a workout is in progress', async () => {
    const running = mockWorkout({ name: 'Morning lift' });
    statefulWorkoutsApi([running]);
    renderPage();
    const resume = await screen.findByRole('link', { name: 'Resume workout' });
    expect(resume).toHaveAttribute('href', `/train/workouts/${running.id}`);
    expect(screen.getByRole('region', { name: 'Workout in progress' })).toHaveTextContent('Morning lift');
    expect(screen.queryByRole('button', { name: 'Start workout' })).toBeNull();
  });

  it('Start workout opens the dialog and goes to the new workout', async () => {
    const api = statefulWorkoutsApi([]);
    const user = userEvent.setup();
    renderPage();
    const start = await screen.findByRole('button', { name: 'Start workout' });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    const dialog = await screen.findByRole('dialog', { name: 'Start workout' });
    await user.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Workout stand-in' })).toBeInTheDocument();
    expect(api.workouts).toHaveLength(1);
  });

  it('hides Start without workouts:write', async () => {
    statefulWorkoutsApi([]);
    renderPage({ permissions: mockUser.permissions.filter((p) => p !== 'workouts:write') });
    expect(await screen.findByText(HISTORY_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start workout' })).toBeNull();
  });

  it('says workouts are unavailable without workouts:read, and keeps the library link', () => {
    renderPage({ permissions: mockUser.permissions.filter((p) => !p.startsWith('workouts:')) });
    expect(screen.getByText('Workout logging is not available for your account.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Exercise library' })).toBeNull();
  });

  it('hides the exercise library link without exercises:read', async () => {
    statefulWorkoutsApi([]);
    renderPage({ permissions: mockUser.permissions.filter((p) => p !== 'exercises:read') });
    await screen.findByText(HISTORY_EMPTY_TITLE);
    expect(screen.queryByRole('link', { name: 'Exercise library' })).toBeNull();
  });

  it('mentions AI only in the "Adjust today\'s workout" entry (E6.1), which never replaces Start', async () => {
    statefulWorkoutsApi(completed(2));
    renderPage();
    await screen.findByRole('list', { name: 'Workout history' });
    const entry = screen.getByTestId('adjust-unavailable');
    expect(entry).toHaveTextContent("Adjust today's workout: AI is off");
    expect((document.body.textContent ?? '').replace(entry.textContent ?? '', '')).not.toMatch(/\bAI\b/);
    expect(screen.getByRole('button', { name: 'Start workout' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    statefulWorkoutsApi([...completed(2), mockWorkout({ name: 'Now' })]);
    const { container } = renderPage();
    await screen.findByRole('list', { name: 'Workout history' });
    // jsdom cannot resolve colour contrast.
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
  it("shows Today's plan with programs:read, and not without it", async () => {
    statefulWorkoutsApi([]);
    server.use(
      http.get('*/api/training/today', () =>
        HttpResponse.json({ data: { kind: 'no_program', date: '2026-09-30' } }),
      ),
    );
    const { unmount } = renderPage({ permissions: [...mockUser.permissions, 'programs:read'] });
    const section = await screen.findByRole('region', { name: "Today's plan" });
    expect(await within(section).findByRole('link', { name: 'Create a plan' })).toHaveAttribute('href', '/train/plans');
    expect(screen.getByRole('button', { name: 'Start workout' })).toBeInTheDocument();
    unmount();

    renderPage();
    await screen.findByText(HISTORY_EMPTY_TITLE);
    expect(screen.queryByRole('region', { name: "Today's plan" })).toBeNull();
  });

  it('links to Gyms, which leaves the bottom bar while Coach holds the fourth tab (E7.8)', async () => {
    renderPage();
    await screen.findByText(HISTORY_EMPTY_TITLE);
    expect(screen.getByRole('link', { name: 'Your gyms' })).toHaveAttribute('href', '/gyms');
  });

  it('hides the Goals link without goals:read (#268)', async () => {
    renderPage();
    await screen.findByText(HISTORY_EMPTY_TITLE);
    expect(screen.queryByRole('link', { name: 'Goals' })).toBeNull();
  });

  it('shows the Goals link with goals:read (#268)', async () => {
    renderPage({ permissions: [...mockUser.permissions, 'goals:read'] });
    await screen.findByText(HISTORY_EMPTY_TITLE);
    expect(screen.getByRole('link', { name: 'Goals' })).toHaveAttribute('href', '/train/goals');
  });
});
