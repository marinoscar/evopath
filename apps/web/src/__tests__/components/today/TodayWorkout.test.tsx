/**
 * The Today "Today's workout" card body (E4.6): loading, error with Retry,
 * empty, in progress (Resume), the last workout block in the Health Profile
 * unit, the Start flow into the logger, a refresh on window focus, `?today=`
 * in the profile time zone, and permission gating. Against MSW.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { act, fireEvent, render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { TodayWorkout } from '../../../components/today/TodayWorkout';
import { WORKOUTS_UNAVAILABLE, type WorkoutSummary } from '../../../services/workouts';
import { mockHealthProfileEmpty, mockHealthProfileSaved } from '../../mocks/fixtures/health';
import { mockEntry, mockSet, mockWorkout, statefulWorkoutsApi, WORKOUT_NOW } from '../../mocks/fixtures/workouts';
import { mockExercise } from '../../mocks/fixtures/exercises';

const GYM = { id: '00000000-0000-4000-8000-a00000000001', name: 'Home Gym' };
const bench = mockExercise({ name: 'Bench press' });
const squat = mockExercise({ name: 'Back squat' });

function WorkoutStandIn() {
  return <h1>Workout stand-in</h1>;
}

function renderCard(options: { permissions?: string[] } = {}) {
  const user = options.permissions ? { ...mockUser, permissions: options.permissions } : mockUser;
  return render(
    <Routes>
      <Route path="/" element={<TodayWorkout />} />
      <Route path="/train/workouts/:workoutId" element={<WorkoutStandIn />} />
    </Routes>,
    { wrapperOptions: { route: '/', user } },
  );
}

function serveProfile(profile = mockHealthProfileEmpty) {
  server.use(http.get('*/api/health-profile', () => HttpResponse.json({ data: profile })));
}

function serveSummary(summary: WorkoutSummary) {
  const calls: string[] = [];
  server.use(
    http.get('*/api/workouts/summary', ({ request }) => {
      calls.push(new URL(request.url).search);
      return HttpResponse.json({ data: summary });
    }),
  );
  return calls;
}

const EMPTY: WorkoutSummary = {
  inProgress: null,
  last: null,
  thisWeek: { workoutCount: 0, weekStart: '2026-09-28' },
  daysSinceLast: null,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('TodayWorkout', () => {
  it('shows a quiet skeleton while loading', () => {
    server.use(http.get('*/api/workouts/summary', () => new Promise(() => {})));
    renderCard();
    expect(screen.getByTestId('today-workout-skeleton')).toBeInTheDocument();
  });

  it('offers Start workout and "No workouts yet." for a new user', async () => {
    serveSummary(EMPTY);
    renderCard();
    expect(await screen.findByRole('button', { name: 'Start workout' })).toBeInTheDocument();
    expect(screen.getByText('No workouts yet.')).toBeInTheDocument();
    expect(screen.queryByText(/This week/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Resume workout' })).toBeNull();
  });

  it('says "Couldn\'t load training" on failure, and Retry loads it', async () => {
    let fail = true;
    server.use(
      http.get('*/api/workouts/summary', () =>
        fail
          ? HttpResponse.json({ statusCode: 500, message: 'Boom', error: 'Internal Server Error' }, { status: 500 })
          : HttpResponse.json({ data: EMPTY }),
      ),
    );
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByText("Couldn't load training")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No workouts yet.')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load training")).toBeNull();
  });

  it('shows the workout in progress with elapsed time, gym and sets done, and Resume links to it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T12:25:00Z'));
    serveSummary({
      ...EMPTY,
      inProgress: {
        id: '00000000-0000-4000-8000-000000000123',
        name: 'Morning lift',
        startedAt: WORKOUT_NOW,
        gym: GYM,
        exerciseCount: 2,
        completedSetCount: 4,
      },
    });
    renderCard();
    const resume = await screen.findByRole('link', { name: 'Resume workout' });
    expect(resume).toHaveAttribute('href', '/train/workouts/00000000-0000-4000-8000-000000000123');
    expect(screen.getByText('Workout in progress')).toBeInTheDocument();
    expect(screen.getByText('Morning lift')).toBeInTheDocument();
    expect(screen.getByText('25 min elapsed · Home Gym · 4 sets done')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start workout' })).toBeNull();
  });

  it('shows the last workout in the Health Profile unit, with top lifts and this week', async () => {
    serveProfile(mockHealthProfileSaved); // imperial
    serveSummary({
      inProgress: null,
      last: {
        id: '00000000-0000-4000-8000-000000000456',
        name: 'Push day',
        date: '2026-09-26',
        durationSeconds: 3900,
        gym: GYM,
        exerciseCount: 5,
        setCount: 17,
        volumeKg: 2830.42,
        topLifts: [
          { exerciseName: 'Back squat', weightKg: 140, reps: 5 },
          { exerciseName: 'Bench press', weightKg: 100, reps: 3 },
        ],
      },
      thisWeek: { workoutCount: 2, weekStart: '2026-09-28' },
      daysSinceLast: 3,
    });
    renderCard();
    const block = await screen.findByTestId('today-workout-last');
    expect(within(block).getByRole('link', { name: 'Push day' })).toHaveAttribute(
      'href',
      '/train/workouts/00000000-0000-4000-8000-000000000456',
    );
    expect(within(block).getByText('3 days ago · Home Gym · 1 h 05 min')).toBeInTheDocument();
    await waitFor(() => expect(within(block).getByText('5 exercises, 17 sets, 6,240 lb')).toBeInTheDocument());
    const lifts = within(within(block).getByRole('list', { name: 'Top lifts' })).getAllByRole('listitem');
    expect(lifts.map((l) => l.textContent)).toEqual(['Back squat: 308.6 lb × 5', 'Bench press: 220.5 lb × 3']);
    expect(screen.getByText('This week: 2 workouts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start workout' })).toBeInTheDocument();
    expect(screen.queryByText('No workouts yet.')).toBeNull();
  });

  it('reads a very old last workout in months', async () => {
    serveSummary({
      ...EMPTY,
      last: {
        id: '00000000-0000-4000-8000-000000000789',
        name: 'Old session',
        date: '2026-06-20',
        durationSeconds: null,
        gym: null,
        exerciseCount: 0,
        setCount: 0,
        volumeKg: 0,
        topLifts: [],
      },
      daysSinceLast: 101,
    });
    renderCard();
    expect(await screen.findByText('3 months ago')).toBeInTheDocument();
    expect(screen.getByText('0 exercises, 0 sets')).toBeInTheDocument();
    expect(screen.getByText('This week: 0 workouts')).toBeInTheDocument();
  });

  it('Start opens the dialog, creates the workout and lands on the logger', async () => {
    const api = statefulWorkoutsApi([]);
    const user = userEvent.setup();
    renderCard();
    const start = await screen.findByRole('button', { name: 'Start workout' });
    await user.click(start);
    const dialog = await screen.findByRole('dialog', { name: 'Start workout' });
    await user.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Workout stand-in' })).toBeInTheDocument();
    expect(api.workouts).toHaveLength(1);
    expect(api.workouts[0].status).toBe('in_progress');
  });

  it('refreshes on window focus: a workout finished in another tab shows Start and the new last workout', async () => {
    const running = mockWorkout({
      name: 'Evening lift',
      gym: GYM,
      exercises: [
        mockEntry(bench, { sets: [mockSet({ weightKg: 100, reps: 5, completed: true })] }),
        mockEntry(squat, { sets: [mockSet({ weightKg: 140, reps: 3, completed: true })] }),
      ],
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 29, 12, 0, 0));
    const api = statefulWorkoutsApi([running]);
    renderCard();
    expect(await screen.findByRole('link', { name: 'Resume workout' })).toBeInTheDocument();

    // Finished elsewhere.
    api.workouts[0].status = 'completed';
    api.workouts[0].durationSeconds = 1800;
    act(() => {
      fireEvent.focus(window);
    });

    expect(await screen.findByRole('button', { name: 'Start workout' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Resume workout' })).toBeNull();
    const block = screen.getByTestId('today-workout-last');
    expect(within(block).getByRole('link', { name: 'Evening lift' })).toBeInTheDocument();
    expect(within(block).getByText('Today · Home Gym · 30 min')).toBeInTheDocument();
    expect(within(block).getByText('2 exercises, 2 sets, 920 kg')).toBeInTheDocument();
    expect(screen.getByText('This week: 1 workout')).toBeInTheDocument();
  });

  it('sends ?today= in the Health Profile time zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 12:00 UTC is already the next day at UTC+14.
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
    serveProfile({ ...mockHealthProfileEmpty, timeZone: 'Pacific/Kiritimati' });
    const calls = serveSummary(EMPTY);
    renderCard();
    await screen.findByText('No workouts yet.');
    expect(calls).toEqual(['?today=2026-09-30']);
  });

  it('falls back to the browser day when the profile has no time zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 29, 12, 0, 0));
    const calls = serveSummary(EMPTY);
    renderCard();
    await screen.findByText('No workouts yet.');
    expect(calls).toEqual(['?today=2026-09-29']);
  });

  it('hides Start without workouts:write but still shows the summary', async () => {
    serveSummary(EMPTY);
    renderCard({ permissions: mockUser.permissions.filter((p) => p !== 'workouts:write') });
    expect(await screen.findByText('No workouts yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start workout' })).toBeNull();
  });

  it('says so without workouts:read, and asks nothing of the API', async () => {
    const calls = serveSummary(EMPTY);
    renderCard({ permissions: mockUser.permissions.filter((p) => !p.startsWith('workouts:')) });
    expect(screen.getByText(WORKOUTS_UNAVAILABLE)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it('says so when the API answers 403', async () => {
    server.use(
      http.get('*/api/workouts/summary', () =>
        HttpResponse.json({ statusCode: 403, message: 'Forbidden', error: 'Forbidden' }, { status: 403 }),
      ),
    );
    renderCard();
    expect(await screen.findByText(WORKOUTS_UNAVAILABLE)).toBeInTheDocument();
  });

  it('has no axe violations with a workout in progress and a last workout', async () => {
    serveSummary({
      inProgress: {
        id: '00000000-0000-4000-8000-000000000123',
        name: 'Morning lift',
        startedAt: WORKOUT_NOW,
        gym: null,
        exerciseCount: 1,
        completedSetCount: 1,
      },
      last: {
        id: '00000000-0000-4000-8000-000000000456',
        name: 'Push day',
        date: '2026-09-26',
        durationSeconds: 3600,
        gym: GYM,
        exerciseCount: 1,
        setCount: 3,
        volumeKg: 1500,
        topLifts: [{ exerciseName: 'Bench press', weightKg: 100, reps: 5 }],
      },
      thisWeek: { workoutCount: 1, weekStart: '2026-09-28' },
      daysSinceLast: 3,
    });
    const { container } = renderCard();
    await screen.findByRole('link', { name: 'Resume workout' });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
  describe('with the active plan (E5.7, programs:read)', () => {
    const withPrograms = [...mockUser.permissions, 'programs:read'];

    it('shows the planned session above the E4 content, keeping Start workout', async () => {
      serveSummary(EMPTY);
      server.use(
        http.get('*/api/training/today', () =>
          HttpResponse.json({
            data: {
              kind: 'rest_day',
              date: '2026-09-30',
              program: { id: 'p1', name: 'Muscle gain' },
              weekNumber: 1,
              totalWeeks: 4,
              next: null,
            },
          }),
        ),
      );
      renderCard({ permissions: withPrograms });
      expect(await screen.findByRole('heading', { name: 'Rest day' })).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Start workout' })).toBeInTheDocument();
      expect(screen.getByText('No workouts yet.')).toBeInTheDocument();
    });

    it("keeps E4.6's Resume workout when the planned session is in progress", async () => {
      serveSummary({
        ...EMPTY,
        inProgress: {
          id: '00000000-0000-4000-8000-000000000123',
          name: 'Upper A',
          startedAt: WORKOUT_NOW,
          gym: null,
          exerciseCount: 1,
          completedSetCount: 0,
        },
      });
      server.use(
        http.get('*/api/training/today', () =>
          HttpResponse.json({
            data: {
              kind: 'workout',
              date: '2026-09-30',
              program: { id: 'p1', name: 'Muscle gain' },
              programWorkout: { id: 'pw1', name: 'Upper A', weekday: 3, estimatedMinutes: null },
              weekNumber: 1,
              totalWeeks: 4,
              isDeload: false,
              done: false,
              completedWorkoutId: null,
              inProgressWorkoutId: '00000000-0000-4000-8000-000000000123',
              session: {
                programId: 'p1',
                programName: 'Muscle gain',
                programWorkoutId: 'pw1',
                name: 'Upper A',
                weekNumber: 1,
                totalWeeks: 4,
                isDeload: false,
                estimatedMinutes: null,
                planVersion: 1,
                unseenChangeCount: 0,
                lastChange: null,
                exercises: [],
              },
            },
          }),
        ),
      );
      renderCard({ permissions: withPrograms });
      expect(await screen.findByText('In progress')).toBeInTheDocument();
      expect(await screen.findByRole('link', { name: 'Resume workout' })).toHaveAttribute(
        'href',
        '/train/workouts/00000000-0000-4000-8000-000000000123',
      );
      expect(screen.queryByRole('button', { name: 'Start planned workout' })).toBeNull();
    });

    it('asks nothing of the plan API without programs:read', async () => {
      serveSummary(EMPTY);
      let asked = false;
      server.use(
        http.get('*/api/training/today', () => {
          asked = true;
          return HttpResponse.json({ data: { kind: 'no_program', date: '2026-09-30' } });
        }),
      );
      renderCard();
      await screen.findByText('No workouts yet.');
      expect(asked).toBe(false);
      expect(screen.queryByTestId('today-plan')).toBeNull();
    });
  });
});
