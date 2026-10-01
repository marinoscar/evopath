/**
 * "Log a walk / run" (#264) from the Today card: the happy path (POST
 * /api/workouts/quick-cardio, snackbar, the card and the plan refetched),
 * the minutes-or-distance rule, an API refusal shown in place, a bottom
 * sheet at phone width, and the pure checks (bounds, miles, "when" at most
 * 7 days back and never in the future). Against MSW.
 */
import { describe, it, expect, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { act, render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../../setup';
import { TodayWorkout } from '../../../components/today/TodayWorkout';
import { checkQuickCardio, type QuickCardioDraft } from '../../../components/today/QuickCardioSheet';
import type { WorkoutSummary } from '../../../services/workouts';
import type { TrainingToday } from '../../../services/programs';
import { mockWorkout } from '../../mocks/fixtures/workouts';
import { isoToLocalInput } from '../../../services/broadcasts';

const EMPTY: WorkoutSummary = {
  inProgress: null,
  last: null,
  thisWeek: { workoutCount: 0, weekStart: '2026-09-28' },
  daysSinceLast: null,
};

const NO_PROGRAM: TrainingToday = { kind: 'no_program', date: '2026-09-30' };

function serve(options: { respond?: (body: unknown) => Response } = {}) {
  const calls = { summary: 0, today: 0, posts: [] as unknown[] };
  server.use(
    http.get('*/api/workouts/summary', () => {
      calls.summary += 1;
      return HttpResponse.json({ data: EMPTY });
    }),
    http.get('*/api/training/today', () => {
      calls.today += 1;
      return HttpResponse.json({ data: NO_PROGRAM });
    }),
    http.post('*/api/workouts/quick-cardio', async ({ request }) => {
      const body = await request.json();
      calls.posts.push(body);
      if (options.respond) return options.respond(body);
      return HttpResponse.json(
        { data: { workout: mockWorkout({ status: 'completed' }), linkedProgramWorkoutId: null } },
        { status: 201 },
      );
    }),
  );
  return calls;
}

const USER = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'workouts:read', 'workouts:write'] };

function renderCard() {
  return render(
    <Routes>
      <Route path="/" element={<TodayWorkout />} />
    </Routes>,
    { wrapperOptions: { route: '/', user: USER } },
  );
}

async function openSheet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Log a walk / run' }));
  return screen.findByRole('dialog', { name: 'Log a walk / run' });
}

afterEach(() => {
  act(() => resetViewportWidth());
});

describe('QuickCardioSheet on Today', () => {
  it('logs a run, says so, and refreshes the card and the plan', async () => {
    const calls = serve();
    const user = userEvent.setup();
    renderCard();
    const sheet = await openSheet(user);
    await waitFor(() => expect(calls.summary).toBe(1));
    const todayBefore = calls.today;

    expect(within(sheet).getByRole('radio', { name: 'Walk' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(sheet).getByRole('radio', { name: 'Run' }));
    expect(within(sheet).getByRole('radio', { name: 'Run' })).toHaveAttribute('aria-checked', 'true');
    await user.type(within(sheet).getByRole('textbox', { name: 'Minutes' }), '30');
    await user.type(within(sheet).getByRole('textbox', { name: 'Distance in km (optional)' }), '5.2');
    await user.type(within(sheet).getByRole('textbox', { name: 'Note (optional)' }), 'Easy pace');
    await user.click(within(sheet).getByRole('button', { name: 'Log it' }));

    expect(await screen.findByText('Run logged.')).toBeInTheDocument();
    expect(calls.posts).toEqual([{ exerciseKey: 'outdoor_run', durationSeconds: 1800, distanceMeters: 5200, note: 'Easy pace' }]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Log a walk / run' })).toBeNull());
    await waitFor(() => expect(calls.summary).toBe(2));
    await waitFor(() => expect(calls.today).toBeGreaterThan(todayBefore));
  });

  it('says when the walk counted toward the plan', async () => {
    serve({
      respond: () =>
        HttpResponse.json(
          { data: { workout: mockWorkout({ status: 'completed' }), linkedProgramWorkoutId: 'pw-1' } },
          { status: 201 },
        ),
    });
    const user = userEvent.setup();
    renderCard();
    const sheet = await openSheet(user);
    await user.type(within(sheet).getByRole('textbox', { name: 'Distance in km (optional)' }), '3');
    await user.click(within(sheet).getByRole('button', { name: 'Log it' }));
    expect(await screen.findByText("Walk logged. It counts toward today's plan.")).toBeInTheDocument();
  });

  it('requires the minutes or the distance, and sends nothing until then', async () => {
    const calls = serve();
    const user = userEvent.setup();
    renderCard();
    const sheet = await openSheet(user);
    await user.click(within(sheet).getByRole('button', { name: 'Log it' }));
    expect(within(sheet).getByRole('alert')).toHaveTextContent('Enter the minutes or the distance.');
    await user.type(within(sheet).getByRole('textbox', { name: 'Minutes' }), '0.5');
    await user.click(within(sheet).getByRole('button', { name: 'Log it' }));
    expect(within(sheet).getByText('Minutes: 1 to 600.')).toBeInTheDocument();
    expect(calls.posts).toEqual([]);
  });

  it('shows an API refusal in place and keeps the sheet open', async () => {
    serve({
      respond: () =>
        HttpResponse.json(
          { statusCode: 400, message: 'performedAt is out of range', error: 'Bad Request' },
          { status: 400 },
        ),
    });
    const user = userEvent.setup();
    renderCard();
    const sheet = await openSheet(user);
    await user.type(within(sheet).getByRole('textbox', { name: 'Minutes' }), '20');
    await user.click(within(sheet).getByRole('button', { name: 'Log it' }));
    expect(await within(sheet).findByText('performedAt is out of range')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Log a walk / run' })).toBeInTheDocument();
    expect(screen.queryByText('Walk logged.')).toBeNull();
  });

  it('is a bottom sheet at phone width', async () => {
    act(() => setViewportWidth(360));
    serve();
    const user = userEvent.setup();
    renderCard();
    const sheet = await openSheet(user);
    expect(sheet.closest('.MuiDrawer-root')).not.toBeNull();
    expect(sheet.closest('.MuiDialog-root')).toBeNull();
  });

  it('is offered only with workouts:write', async () => {
    serve();
    render(<TodayWorkout />, { wrapperOptions: { user: { ...mockUser, permissions: ['workouts:read'] } } });
    expect(await screen.findByText('No workouts yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log a walk / run' })).toBeNull();
  });
});

describe('checkQuickCardio', () => {
  const NOW = new Date('2026-09-30T12:00:00Z');
  const draft = (overrides: Partial<QuickCardioDraft> = {}): QuickCardioDraft => ({
    exerciseKey: 'outdoor_walk',
    minutes: '',
    distance: '',
    when: '',
    whenTouched: false,
    note: '',
    ...overrides,
  });

  it('builds the body in metres and seconds, distance in miles converted', () => {
    expect(checkQuickCardio(draft({ minutes: '45' }), 'km', NOW)).toEqual({
      ok: true,
      input: { exerciseKey: 'outdoor_walk', durationSeconds: 2700 },
    });
    expect(checkQuickCardio(draft({ exerciseKey: 'hike', distance: '2' }), 'mi', NOW)).toEqual({
      ok: true,
      input: { exerciseKey: 'hike', distanceMeters: 3218.69 },
    });
  });

  it('refuses out-of-range values', () => {
    expect(checkQuickCardio(draft({ minutes: '601' }), 'km', NOW)).toMatchObject({ ok: false, problems: { minutes: 'Minutes: 1 to 600.' } });
    expect(checkQuickCardio(draft({ distance: '101' }), 'km', NOW)).toMatchObject({ ok: false, problems: { distance: 'At most 100 km.' } });
    expect(checkQuickCardio(draft({ distance: '63' }), 'mi', NOW)).toMatchObject({ ok: false, problems: { distance: 'At most 62.13 mi.' } });
    expect(checkQuickCardio(draft({ minutes: 'abc' }), 'km', NOW)).toMatchObject({ ok: false, problems: { minutes: 'Enter a number of minutes.' } });
  });

  it('takes "when" within the last 7 days, never the future', () => {
    const at = (iso: string) => isoToLocalInput(iso);
    const ok = checkQuickCardio(draft({ minutes: '30', when: at('2026-09-28T07:30:00Z'), whenTouched: true }), 'km', NOW);
    expect(ok).toEqual({
      ok: true,
      input: { exerciseKey: 'outdoor_walk', durationSeconds: 1800, performedAt: '2026-09-28T07:30:00.000Z' },
    });
    expect(
      checkQuickCardio(draft({ minutes: '30', when: at('2026-09-22T11:00:00Z'), whenTouched: true }), 'km', NOW),
    ).toMatchObject({ ok: false, problems: { when: 'At most 7 days back.' } });
    expect(
      checkQuickCardio(draft({ minutes: '30', when: at('2026-09-30T14:00:00Z'), whenTouched: true }), 'km', NOW),
    ).toMatchObject({ ok: false, problems: { when: 'That is in the future.' } });
    // Untouched "when" means now: the API defaults it.
    expect(checkQuickCardio(draft({ minutes: '30', when: 'garbage' }), 'km', NOW)).toMatchObject({ ok: true });
  });
});
