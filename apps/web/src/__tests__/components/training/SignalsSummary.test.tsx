/**
 * SignalsSummary (E5.9): every `GET /api/training/signals` state (loading,
 * no plan, no data in range, data, 404, error with Retry), the range
 * selector's `from`, the plan-changed note, the unit preference, the chart
 * data tables, and axe. Also the Train page's This week card. Against MSW.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import {
  NO_DATA_IN_RANGE,
  NO_PLAN_TITLE,
  SignalsSummary,
} from '../../../components/training/SignalsSummary';
import { ThisWeekCard } from '../../../components/training/ThisWeekCard';
import type { PlanSignals } from '../../../services/programs';
import { mockHealthProfileSaved } from '../../mocks/fixtures/health';

const PROGRAM_ID = '00000000-0000-4000-8000-c00000000001';

function emptySignals(overrides: Partial<PlanSignals> = {}): PlanSignals {
  return {
    range: { from: '2026-08-10', to: '2026-09-30' },
    asOf: '2026-09-30',
    programId: PROGRAM_ID,
    planVersion: 2,
    weeksInRange: 8,
    truncated: false,
    planChangedOn: null,
    adherence: {
      weeks: [],
      totals: {
        planned: 0,
        completed: 0,
        partialSessions: 0,
        missed: 0,
        extra: 0,
        adherencePct: null,
      },
      missedStreak: 0,
      completedStreak: 0,
    },
    frequency: { avgPerWeek: null, perWeek: [] },
    sessions: [],
    volume: [],
    performance: [],
    effort: { avgRpe: null, setsAtRpe9Plus: 0, rpeTrend: 'insufficient' },
    pain: [],
    readiness: { days: 0, avg: null, lowDays: 0, lowStreak: 0 },
    body: { weightKg: { latest: null, changePerWeek: null, points: 0 }, bodyFatPct: null },
    ...overrides,
  };
}

function fullSignals(overrides: Partial<PlanSignals> = {}): PlanSignals {
  return emptySignals({
    planChangedOn: '2026-09-14',
    adherence: {
      weeks: [
        {
          weekStart: '2026-09-21',
          planned: 3,
          completed: 2,
          partialSessions: 1,
          missed: 1,
          extra: 1,
          adherencePct: 66.7,
          partial: false,
        },
        {
          weekStart: '2026-09-28',
          planned: 2,
          completed: 2,
          partialSessions: 0,
          missed: 0,
          extra: 0,
          adherencePct: 100,
          partial: true,
        },
      ],
      totals: {
        planned: 5,
        completed: 4,
        partialSessions: 1,
        missed: 1,
        extra: 1,
        adherencePct: 80,
      },
      missedStreak: 0,
      completedStreak: 2,
    },
    frequency: {
      avgPerWeek: 3,
      perWeek: [
        { weekStart: '2026-09-21', sessions: 3 },
        { weekStart: '2026-09-28', sessions: 2 },
      ],
    },
    sessions: [
      {
        programWorkoutId: 'pw1',
        name: 'Upper A',
        plannedFor: '2026-09-28',
        status: 'done',
        workoutId: 'w1',
        setsPlanned: 9,
        setsDone: 9,
        completionPct: 100,
        avgRpe: 8,
      },
    ],
    volume: [
      {
        muscle: 'upper_back',
        weeks: [
          { weekStart: '2026-09-21', plannedSets: 6, hardSets: 5 },
          { weekStart: '2026-09-28', plannedSets: 6, hardSets: 6 },
        ],
        totalHardSets: 11,
        tonnageKg: 2000,
      },
    ],
    performance: [
      {
        exerciseId: 'ex-bench',
        slug: 'bench-press',
        name: 'Bench press',
        sessions: 4,
        best: { weightKg: 100, reps: 5, e1rmKg: 116.667 },
        lastTopSets: [{ date: '2026-09-28', weightKg: 100, reps: 5, rpe: 8.5 }],
        trend: 'up',
        trendPct: 3.4,
        prInRange: true,
      },
      {
        exerciseId: 'ex-row',
        slug: 'cable-row',
        name: 'Cable row',
        sessions: 2,
        best: { weightKg: 60, reps: 10, e1rmKg: 80 },
        lastTopSets: [],
        trend: 'insufficient',
        trendPct: null,
        prInRange: false,
      },
    ],
    effort: { avgRpe: 8.2, setsAtRpe9Plus: 3, rpeTrend: 'rising' },
    pain: [
      {
        exerciseId: 'ex-bench',
        slug: 'bench-press',
        name: 'Bench press',
        lastFlaggedOn: '2026-09-28',
        flaggedSessions28d: 2,
        consecutiveFlaggedSessions: 2,
      },
    ],
    readiness: {
      days: 5,
      avg: { energy: 3.4, sleepQuality: 4, soreness: 2, stress: 2.6 },
      lowDays: 1,
      lowStreak: 0,
    },
    body: {
      weightKg: { latest: 80, changePerWeek: -0.25, points: 6 },
      bodyFatPct: { latest: 18.5, points: 2 },
    },
    ...overrides,
  });
}

function serveSignals(answer: PlanSignals | ((url: URL) => Response | PlanSignals)) {
  const calls: URL[] = [];
  server.use(
    http.get('*/api/training/signals', ({ request }) => {
      const url = new URL(request.url);
      calls.push(url);
      const result = typeof answer === 'function' ? answer(url) : answer;
      return result instanceof Response ? result : HttpResponse.json({ data: result });
    })
  );
  return calls;
}

const user = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read'] };

function renderSummary(node = <SignalsSummary programId={PROGRAM_ID} chartWidth={320} />) {
  return render(node, { wrapperOptions: { route: '/', user } });
}

describe('SignalsSummary', () => {
  it('shows a skeleton while loading', () => {
    server.use(http.get('*/api/training/signals', () => new Promise(() => {})));
    renderSummary();
    expect(screen.getByTestId('signals-skeleton')).toBeInTheDocument();
  });

  it('links to /train/plans when there is no plan', async () => {
    serveSignals(emptySignals({ programId: null, planVersion: null }));
    renderSummary(<SignalsSummary chartWidth={320} />);
    expect(await screen.findByRole('heading', { name: NO_PLAN_TITLE })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a plan' })).toHaveAttribute(
      'href',
      '/train/plans'
    );
  });

  it('explains an empty range instead of drawing empty charts', async () => {
    serveSignals(emptySignals());
    renderSummary();
    expect(await screen.findByText(NO_DATA_IN_RANGE)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Adherence' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('No check-ins in the last 7 days.')).toBeInTheDocument();
  });

  it('shows every section with the data, and sends programId, asOf and an 8-week range', async () => {
    const calls = serveSignals(fullSignals());
    renderSummary();

    expect(await screen.findByRole('heading', { name: 'Adherence' })).toBeInTheDocument();
    const call = calls[0];
    expect(call.searchParams.get('programId')).toBe(PROGRAM_ID);
    const asOf = call.searchParams.get('asOf')!;
    expect(call.searchParams.get('to')).toBe(asOf);
    const from = new Date(`${call.searchParams.get('from')}T00:00:00Z`);
    expect(from.getUTCDay()).toBe(1);
    const days = (Date.parse(`${asOf}T00:00:00Z`) - from.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(49);
    expect(days).toBeLessThan(56);

    const kpis = screen.getByRole('region', { name: 'Key numbers' });
    expect(within(kpis).getByText('80%')).toBeInTheDocument();
    expect(within(kpis).getByText('4 of 5 planned')).toBeInTheDocument();
    expect(within(kpis).getByText('3')).toBeInTheDocument();

    expect(screen.getByText(/The plan changed on .*September 14/)).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /4 of 5 completed, 1 missed, adherence 80%/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upper back' })).toBeInTheDocument();
    expect(screen.getByText('Trending up +3.4%')).toBeInTheDocument();
    expect(screen.getByText('Not enough sessions yet')).toBeInTheDocument();
    expect(screen.getByText('PR in range')).toBeInTheDocument();
    expect(screen.getByText('Trend: Rising: sessions feel harder')).toBeInTheDocument();

    const pain = screen.getByRole('region', { name: 'Where it hurt' });
    expect(within(pain).getByText('Bench press')).toBeInTheDocument();
    expect(
      within(pain).getByText(/2 sessions flagged in 28 days, the last 2 in a row/)
    ).toBeInTheDocument();

    expect(screen.getByText(/Energy 3.4 of 5/)).toBeInTheDocument();
    expect(screen.getByText('Latest 80 kg')).toBeInTheDocument();
    expect(screen.getByText(/Trend −0.25 kg per week over 6 weigh-ins/)).toBeInTheDocument();
    expect(screen.getByText('Body fat 18.5%')).toBeInTheDocument();
  });

  it('shows weights in the Health Profile unit', async () => {
    server.use(
      http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved }))
    );
    serveSignals(fullSignals());
    renderSummary();
    expect(await screen.findByText('Latest 176.4 lb')).toBeInTheDocument();
    expect(screen.getByText(/best 220\.5 lb × 5/)).toBeInTheDocument();
  });

  it('toggles a data table with the same numbers as the chart', async () => {
    serveSignals(fullSignals());
    renderSummary();
    const adherence = await screen.findByRole('region', { name: 'Adherence' });
    const toggle = within(adherence).getByRole('button', { name: 'Show data table' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const table = within(adherence).getByRole('table', { name: 'Weekly adherence' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1])
        .getAllByRole('cell')
        .map((c) => c.textContent)
    ).toEqual(['3', '2', '1', '1', '67%']);
    expect(within(rows[2]).getByRole('rowheader')).toHaveTextContent('(partial week)');
    await userEvent.click(within(adherence).getByRole('button', { name: 'Hide data table' }));
    expect(within(adherence).queryByRole('table')).not.toBeInTheDocument();
  });

  it('refetches with a wider range when another range is picked', async () => {
    const calls = serveSignals(fullSignals());
    renderSummary();
    await screen.findByRole('heading', { name: 'Adherence' });
    await userEvent.click(screen.getByRole('button', { name: '26 weeks' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    const second = calls[1];
    const days =
      (Date.parse(`${second.searchParams.get('to')}T00:00:00Z`) -
        Date.parse(`${second.searchParams.get('from')}T00:00:00Z`)) /
      86_400_000;
    expect(days + 1).toBeLessThanOrEqual(26 * 7);
    expect(days).toBeGreaterThanOrEqual(25 * 7);
    expect(screen.getByRole('button', { name: '26 weeks' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('says the plan was not found on 404', async () => {
    serveSignals(() =>
      HttpResponse.json(
        { statusCode: 404, message: 'Not Found', error: 'Not Found' },
        { status: 404 }
      )
    );
    renderSummary();
    expect(await screen.findByText('This plan was not found.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Train' })).toHaveAttribute('href', '/train');
  });

  it('offers Retry after a failure', async () => {
    let fail = true;
    serveSignals(() =>
      fail
        ? HttpResponse.json(
            { statusCode: 500, message: 'Boom', error: 'Internal Server Error' },
            { status: 500 }
          )
        : fullSignals()
    );
    renderSummary();
    expect(await screen.findByText("Couldn't load your progress")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Adherence' })).toBeInTheDocument();
  });

  it('has no axe violations with data and with the tables open', async () => {
    serveSignals(fullSignals());
    const { container } = renderSummary();
    await screen.findByRole('heading', { name: 'Adherence' });
    for (const button of screen.getAllByRole('button', { name: 'Show data table' }))
      await userEvent.click(button);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations when empty', async () => {
    serveSignals(emptySignals({ programId: null }));
    const { container } = renderSummary();
    await screen.findByRole('heading', { name: NO_PLAN_TITLE });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ThisWeekCard', () => {
  it('shows sessions done of this week and links to the progress view', async () => {
    const calls = serveSignals(
      fullSignals({
        sessions: [
          {
            programWorkoutId: 'a',
            name: 'A',
            plannedFor: '2026-09-28',
            status: 'done',
            workoutId: 'w',
            setsPlanned: 9,
            setsDone: 9,
            completionPct: 100,
            avgRpe: null,
          },
          {
            programWorkoutId: 'b',
            name: 'B',
            plannedFor: '2026-09-30',
            status: 'upcoming',
            workoutId: null,
            setsPlanned: 9,
            setsDone: 0,
            completionPct: null,
            avgRpe: null,
          },
        ],
      })
    );
    renderSummary(<ThisWeekCard />);
    expect(await screen.findByText('1 of 2 planned sessions done')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See progress' })).toHaveAttribute(
      'href',
      `/train/plans/${PROGRAM_ID}/progress`
    );
    const call = calls[0];
    expect(call.searchParams.get('programId')).toBeNull();
    const to = new Date(`${call.searchParams.get('to')}T00:00:00Z`);
    expect(to.getUTCDay()).toBe(0);
  });

  it('renders nothing without an active plan', async () => {
    const calls = serveSignals(emptySignals({ programId: null }));
    const { container } = renderSummary(<ThisWeekCard />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('this-week-skeleton')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });
});
