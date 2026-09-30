/**
 * TodayPlanCard (E5.7): every `GET /api/training/today` state, the start flow
 * into the logger (new, existing, plan updated), the refusals (another
 * workout in progress offers Resume, plan no longer active refetches, empty
 * workout), the Plan adjusted chip, `?date=` in the profile time zone, the
 * refetch on focus, and axe. Against MSW.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { act, fireEvent, render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import {
  PLAN_RESUME_NOTICE,
  PLAN_UPDATED_NOTICE,
  TodayPlanCard,
  type TodayPlanCardProps,
} from '../../../components/training/TodayPlanCard';
import type { TodaySession, TodaySessionExercise, TrainingToday } from '../../../services/programs';
import { mockHealthProfileEmpty, mockHealthProfileSaved } from '../../mocks/fixtures/health';

const PROGRAM = { id: '00000000-0000-4000-8000-b00000000001', name: 'Muscle gain' };
const PW_ID = '00000000-0000-4000-8000-b00000000002';
const NEXT_PW_ID = '00000000-0000-4000-8000-b00000000003';
const WORKOUT_ID = '00000000-0000-4000-8000-b00000000010';
const OTHER_WORKOUT_ID = '00000000-0000-4000-8000-b00000000011';
const DATE = '2026-09-30';

function exercise(overrides: Partial<TodaySessionExercise> = {}): TodaySessionExercise {
  return {
    programExerciseId: `pe-${Math.random().toString(36).slice(2)}`,
    exercise: {
      id: 'ex-bench',
      slug: 'bench-press',
      name: 'Bench press',
      trackingMode: 'weight_reps',
      isBodyweight: false,
      primaryMuscles: ['chest'],
    },
    isPriority: true,
    sets: 3,
    repMin: 8,
    repMax: 10,
    targetRpe: 8,
    restSeconds: 120,
    loadGuidance: 'fixed',
    targetLoadKg: 80,
    suggestedLoadKg: 80,
    rationale: 'Main press for chest growth.',
    lastTime: { performedOn: '2026-09-28', topSet: { weightKg: 77.5, reps: 9 } },
    availableAtGym: true,
    ...overrides,
  };
}

function session(overrides: Partial<TodaySession> = {}): TodaySession {
  return {
    programId: PROGRAM.id,
    programName: PROGRAM.name,
    programWorkoutId: PW_ID,
    name: 'Upper A',
    weekNumber: 2,
    totalWeeks: 8,
    isDeload: false,
    estimatedMinutes: 45,
    planVersion: 3,
    unseenChangeCount: 0,
    lastChange: null,
    exercises: [
      exercise(),
      exercise({
        exercise: {
          id: 'ex-row',
          slug: 'cable-row',
          name: 'Cable row',
          trackingMode: 'weight_reps',
          isBodyweight: false,
          primaryMuscles: ['back'],
        },
        repMin: 12,
        repMax: 12,
        targetRpe: null,
        loadGuidance: 'choose_start',
        targetLoadKg: null,
        suggestedLoadKg: null,
        rationale: null,
        lastTime: null,
        availableAtGym: false,
      }),
    ],
    ...overrides,
  };
}

function workoutDay(overrides: Partial<Extract<TrainingToday, { kind: 'workout' }>> = {}): TrainingToday {
  return {
    kind: 'workout',
    date: DATE,
    program: PROGRAM,
    programWorkout: { id: PW_ID, name: 'Upper A', weekday: 3, estimatedMinutes: 45 },
    weekNumber: 2,
    totalWeeks: 8,
    isDeload: false,
    done: false,
    completedWorkoutId: null,
    inProgressWorkoutId: null,
    session: session(),
    ...overrides,
  };
}

const REST_DAY: TrainingToday = {
  kind: 'rest_day',
  date: DATE,
  program: PROGRAM,
  weekNumber: 2,
  totalWeeks: 8,
  next: {
    date: '2026-10-02',
    weekNumber: 2,
    programWorkout: { id: NEXT_PW_ID, name: 'Lower A', weekday: 5, estimatedMinutes: 50 },
  },
};

function serveToday(answer: TrainingToday | (() => TrainingToday)) {
  const calls: string[] = [];
  server.use(
    http.get('*/api/training/today', ({ request }) => {
      calls.push(new URL(request.url).search);
      return HttpResponse.json({ data: typeof answer === 'function' ? answer() : answer });
    }),
  );
  return calls;
}

function serveStart(respond: (id: string, body: unknown) => Response) {
  const calls: { id: string; body: unknown }[] = [];
  server.use(
    http.post('*/api/program-workouts/:id/start', async ({ params, request }) => {
      const body = await request.json();
      calls.push({ id: String(params.id), body });
      return respond(String(params.id), body);
    }),
  );
  return calls;
}

function conflict(details: Record<string, unknown>) {
  return HttpResponse.json(
    { statusCode: 409, message: 'Conflict', error: 'Conflict', details },
    { status: 409 },
  );
}

function LoggerStandIn() {
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice ?? '';
  return (
    <div>
      <h1>Logger stand-in</h1>
      <p data-testid="logger-path">{location.pathname}</p>
      <p data-testid="logger-notice">{notice}</p>
    </div>
  );
}

function renderCard(props: Partial<TodayPlanCardProps> = {}) {
  const user = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };
  return render(
    <Routes>
      <Route path="/" element={<TodayPlanCard canStart {...props} />} />
      <Route path="/train/workouts/:workoutId" element={<LoggerStandIn />} />
      <Route path="/train/plans/:programId" element={<h1>Plan stand-in</h1>} />
    </Routes>,
    { wrapperOptions: { route: '/', user } },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TodayPlanCard', () => {
  it('shows a skeleton while loading', () => {
    server.use(http.get('*/api/training/today', () => new Promise(() => {})));
    renderCard();
    expect(screen.getByTestId('today-plan-skeleton')).toBeInTheDocument();
  });

  it('says it could not load, and Retry loads it', async () => {
    let fail = true;
    server.use(
      http.get('*/api/training/today', () =>
        fail
          ? HttpResponse.json({ statusCode: 500, message: 'Boom', error: 'Internal Server Error' }, { status: 500 })
          : HttpResponse.json({ data: { kind: 'no_program', date: DATE } }),
      ),
    );
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByText("Couldn't load your plan")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No training plan yet')).toBeInTheDocument();
  });

  it('renders nothing when the API answers 403', async () => {
    let asked = false;
    server.use(
      http.get('*/api/training/today', () => {
        asked = true;
        return HttpResponse.json({ statusCode: 403, message: 'Forbidden', error: 'Forbidden' }, { status: 403 });
      }),
    );
    renderCard();
    await waitFor(() => expect(asked).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('today-plan-skeleton')).toBeNull());
    expect(screen.queryByTestId('today-plan')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('no_program: offers Create a plan', async () => {
    serveToday({ kind: 'no_program', date: DATE });
    renderCard();
    expect(await screen.findByRole('heading', { name: 'No training plan yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a plan' })).toHaveAttribute('href', '/train/plans');
  });

  it('not_started: says when the plan starts', async () => {
    serveToday({ kind: 'not_started', date: DATE, program: PROGRAM, startsOn: '2026-10-05' });
    renderCard();
    expect(await screen.findByRole('heading', { name: /Your plan starts .*October 5/ })).toBeInTheDocument();
    expect(screen.getByText('Muscle gain')).toBeInTheDocument();
  });

  it('program_complete: offers Duplicate plan and Create a new plan; Duplicate opens the copy', async () => {
    serveToday({ kind: 'program_complete', date: DATE, program: PROGRAM });
    let duplicated = '';
    server.use(
      http.post('*/api/programs/:id/duplicate', ({ params }) => {
        duplicated = String(params.id);
        return HttpResponse.json({ data: { id: 'copy-1' } }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderCard({ canWritePrograms: true });
    expect(await screen.findByRole('heading', { name: 'Plan complete' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a new plan' })).toHaveAttribute('href', '/train/plans');
    await user.click(screen.getByRole('button', { name: 'Duplicate plan' }));
    expect(await screen.findByRole('heading', { name: 'Plan stand-in' })).toBeInTheDocument();
    expect(duplicated).toBe(PROGRAM.id);
  });

  it('program_complete: hides Duplicate plan without programs:write', async () => {
    serveToday({ kind: 'program_complete', date: DATE, program: PROGRAM });
    renderCard({ canWritePrograms: false });
    await screen.findByRole('heading', { name: 'Plan complete' });
    expect(screen.queryByRole('button', { name: 'Duplicate plan' })).toBeNull();
  });

  it('rest_day: shows the next session, and Do it anyway starts it with today\'s date', async () => {
    serveToday(REST_DAY);
    const calls = serveStart(() =>
      HttpResponse.json({ data: { workoutId: WORKOUT_ID, existing: false, planVersion: 3 } }, { status: 201 }),
    );
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByRole('heading', { name: 'Rest day' })).toBeInTheDocument();
    expect(screen.getByText(/Next: Lower A, .*October 2/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Do it anyway' }));
    expect(await screen.findByTestId('logger-path')).toHaveTextContent(`/train/workouts/${WORKOUT_ID}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(NEXT_PW_ID);
    expect(calls[0].body).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('rest_day with nothing ahead says so', async () => {
    serveToday({ ...REST_DAY, next: null } as TrainingToday);
    renderCard();
    expect(await screen.findByText('No sessions in the next two weeks.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Do it anyway' })).toBeNull();
  });

  it('workout: shows the week, minutes, exercises with prescription, load, last time and rationale', async () => {
    serveToday(workoutDay());
    renderCard();
    expect(await screen.findByRole('heading', { name: 'Upper A' })).toBeInTheDocument();
    expect(screen.getByText('Week 2 of 8 · about 45 min')).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Planned exercises' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Bench press')).toBeInTheDocument();
    expect(within(items[0]).getByText('3 × 8–10 @ RPE 8 · 80 kg')).toBeInTheDocument();
    expect(within(items[0]).getByText('Last time: 77.5 kg × 9')).toBeInTheDocument();
    expect(within(items[0]).getByText('Main press for chest growth.')).toBeInTheDocument();
    expect(within(items[1]).getByText('3 × 12 · Choose a starting load')).toBeInTheDocument();
    expect(within(items[1]).getByText('Not available at your gym')).toBeInTheDocument();
    expect(screen.queryByText('Deload')).toBeNull();
    expect(screen.queryByText('Plan adjusted')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start planned workout' })).toBeEnabled();
  });

  it('workout: loads read in the Health Profile unit', async () => {
    server.use(http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })));
    serveToday(workoutDay());
    renderCard();
    const items = within(await screen.findByRole('list', { name: 'Planned exercises' })).getAllByRole('listitem');
    await waitFor(() => expect(within(items[0]).getByText(/@ RPE 8 · 176\.4 lb/)).toBeInTheDocument());
  });

  it('workout: shows the Deload chip, and the Plan adjusted chip links to the plan history', async () => {
    serveToday(workoutDay({ isDeload: true, session: session({ unseenChangeCount: 2 }) }));
    renderCard();
    expect(await screen.findByText('Deload')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Plan adjusted' })).toHaveAttribute(
      'href',
      `/train/plans/${PROGRAM.id}/history`,
    );
  });

  it('workout: an unseen AI change shows the Plan adjusted banner with one-tap Undo (E5.8)', async () => {
    let items = [
      {
        id: '00000000-0000-4000-8000-b0000000c001',
        kind: 'adapted',
        actor: 'ai',
        status: 'applied',
        fromVersion: 2,
        toVersion: 3,
        runId: null,
        summary: 'Swapped leg extension for split squat.',
        rationale: null,
        operations: [],
        citations: [],
        revertsLogId: null,
        seenAt: null,
        createdAt: '2026-09-29T10:00:00.000Z',
        decidedAt: null,
      },
    ];
    const reverts: Array<string | null> = [];
    server.use(
      http.get(`*/api/programs/${PROGRAM.id}/change-log`, () => HttpResponse.json({ data: { items, nextCursor: null } })),
      http.post(`*/api/programs/${PROGRAM.id}/revert`, ({ request }) => {
        reverts.push(request.headers.get('If-Match'));
        items = items.map((e) => ({ ...e, status: 'reverted' }));
        return HttpResponse.json({ data: { id: PROGRAM.id, currentVersion: 4 } });
      }),
    );
    const calls = serveToday(workoutDay({ session: session({ unseenChangeCount: 1 }) }));
    renderCard({ canWritePrograms: true });
    const banner = await screen.findByTestId('plan-adjusted-banner');
    expect(within(banner).getByText('Swapped leg extension for split squat.')).toBeInTheDocument();
    expect(within(banner).getByRole('link', { name: 'Review' })).toHaveAttribute('href', `/train/plans/${PROGRAM.id}/history`);
    expect(screen.getByRole('button', { name: 'Start planned workout' })).toBeEnabled();
    const before = calls.length;
    await userEvent.click(within(banner).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Undone. Your coach will not suggest this again for 14 days.')).toBeInTheDocument();
    expect(reverts).toEqual(['3']);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('workout: an empty session says No exercises and disables Start', async () => {
    serveToday(workoutDay({ session: session({ exercises: [] }) }));
    renderCard();
    expect(await screen.findByText('No exercises')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start planned workout' })).toBeDisabled();
  });

  it('workout: hides Start without workouts:write', async () => {
    serveToday(workoutDay());
    renderCard({ canStart: false });
    await screen.findByRole('heading', { name: 'Upper A' });
    expect(screen.queryByRole('button', { name: 'Start planned workout' })).toBeNull();
  });

  it('workout in progress: marks it and leaves Resume to the host', async () => {
    serveToday(workoutDay({ inProgressWorkoutId: WORKOUT_ID }));
    renderCard();
    expect(await screen.findByText('In progress')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start planned workout' })).toBeNull();
  });

  it('done: shows the check and View workout', async () => {
    serveToday(workoutDay({ done: true, completedWorkoutId: WORKOUT_ID }));
    renderCard();
    expect(await screen.findByRole('heading', { name: 'Upper A: done' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View workout' })).toHaveAttribute('href', `/train/workouts/${WORKOUT_ID}`);
    expect(screen.queryByRole('button', { name: 'Start planned workout' })).toBeNull();
  });

  it('Start planned workout opens the logger on the new workout', async () => {
    serveToday(workoutDay());
    const calls = serveStart(() =>
      HttpResponse.json({ data: { workoutId: WORKOUT_ID, existing: false, planVersion: 3 } }, { status: 201 }),
    );
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Start planned workout' }));
    expect(await screen.findByTestId('logger-path')).toHaveTextContent(`/train/workouts/${WORKOUT_ID}`);
    expect(screen.getByTestId('logger-notice')).toHaveTextContent('');
    expect(calls).toEqual([{ id: PW_ID, body: { date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } }]);
  });

  it('Start on an existing session (another device) opens it with a notice', async () => {
    serveToday(workoutDay());
    serveStart(() => HttpResponse.json({ data: { workoutId: WORKOUT_ID, existing: true, planVersion: 3 } }));
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Start planned workout' }));
    expect(await screen.findByTestId('logger-notice')).toHaveTextContent(PLAN_RESUME_NOTICE);
  });

  it('Start after the plan changed says the plan was just updated', async () => {
    serveToday(workoutDay());
    serveStart(() =>
      HttpResponse.json({ data: { workoutId: WORKOUT_ID, existing: false, planVersion: 4 } }, { status: 201 }),
    );
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Start planned workout' }));
    expect(await screen.findByTestId('logger-notice')).toHaveTextContent(PLAN_UPDATED_NOTICE);
  });

  it('409 WORKOUT_IN_PROGRESS offers Resume for that workout', async () => {
    serveToday(workoutDay());
    serveStart(() => conflict({ reason: 'WORKOUT_IN_PROGRESS', workoutId: OTHER_WORKOUT_ID }));
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Start planned workout' }));
    expect(await screen.findByText(/Another workout is in progress/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Resume' })).toHaveAttribute('href', `/train/workouts/${OTHER_WORKOUT_ID}`);
  });

  it('409 PROGRAM_NOT_ACTIVE says so and refetches Today', async () => {
    let answer: TrainingToday = workoutDay();
    const calls = serveToday(() => answer);
    serveStart(() => {
      answer = { kind: 'no_program', date: DATE };
      return conflict({ reason: 'PROGRAM_NOT_ACTIVE', status: 'paused' });
    });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Start planned workout' }));
    expect(await screen.findByText('Your plan is no longer active.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'No training plan yet' })).toBeInTheDocument();
    expect(calls).toHaveLength(2);
  });

  it('409 PROGRAM_WORKOUT_EMPTY says the workout has no exercises', async () => {
    serveToday(workoutDay());
    serveStart(() => conflict({ reason: 'PROGRAM_WORKOUT_EMPTY' }));
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Start planned workout' }));
    expect(await screen.findByText('This planned workout has no exercises.')).toBeInTheDocument();
  });

  it('sends ?date= in the Health Profile time zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 12:00 UTC is already the next day at UTC+14.
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
    server.use(
      http.get('*/api/health-profile', () =>
        HttpResponse.json({ data: { ...mockHealthProfileEmpty, timeZone: 'Pacific/Kiritimati' } }),
      ),
    );
    const calls = serveToday({ kind: 'no_program', date: '2026-09-30' });
    renderCard();
    await screen.findByText('No training plan yet');
    expect(calls).toEqual(['?date=2026-09-30']);
  });

  it('refetches on window focus: a workout finished in the logger flips to Done', async () => {
    let answer: TrainingToday = workoutDay();
    serveToday(() => answer);
    renderCard();
    await screen.findByRole('button', { name: 'Start planned workout' });
    answer = workoutDay({ done: true, completedWorkoutId: WORKOUT_ID });
    act(() => {
      fireEvent.focus(window);
    });
    expect(await screen.findByRole('heading', { name: 'Upper A: done' })).toBeInTheDocument();
  });

  it('has no axe violations for a planned workout', async () => {
    serveToday(workoutDay({ isDeload: true, session: session({ unseenChangeCount: 1 }) }));
    const { container } = renderCard();
    await screen.findByRole('button', { name: 'Start planned workout' });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
