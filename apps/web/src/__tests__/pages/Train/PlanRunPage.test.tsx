/**
 * PlanRunPage (E5.6): stages, sources, drafts, repairs, critic scorecards
 * and usage from the event stream; leaving and returning replays without
 * duplicates; cancel; each terminal state (with a human sentence for every
 * documented errorCode); the stale-worker banner; Resume; and axe.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import PlanRunPage from '../../../pages/Train/PlanRunPage';
import { mockRun, PROGRAM_ID, RUN_ID } from '../../mocks/fixtures/programs';
import { runEvents } from '../../mocks/fixtures/runEvents';
import { fakeRunStream } from '../../utils/fakeRunStream';
import { runErrorCopy } from '../../../components/training/runErrors';
import type { TrainingRunEvent, TrainingRunView } from '../../../services/trainingAgents';

const user = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function serveRun(run: Partial<TrainingRunView> = {}) {
  let current = mockRun(run);
  server.use(
    http.get(`*/api/ai/training/runs/${RUN_ID}`, () => HttpResponse.json({ data: current })),
    http.post(`*/api/ai/training/runs/${RUN_ID}/cancel`, () => {
      current = { ...current, cancelRequested: true };
      return HttpResponse.json({ data: current });
    }),
    http.post(`*/api/ai/training/runs/${RUN_ID}/resume`, () => {
      current = { ...current, status: 'queued' };
      return HttpResponse.json({ data: current }, { status: 202 });
    }),
  );
  return { set: (next: Partial<TrainingRunView>) => (current = { ...current, ...next }) };
}

function renderRun(stream = fakeRunStream()) {
  const view = render(
    <Routes>
      <Route
        path="/train/plans/runs/:runId"
        element={<PlanRunPage runOptions={{ connect: stream.connect, pollMs: 0, reconnectDelayMs: 0 }} />}
      />
      <Route path="*" element={<Where />} />
    </Routes>,
    { wrapperOptions: { route: `/train/plans/runs/${RUN_ID}`, aiEnabled: true, user } },
  );
  return { ...view, stream };
}

describe('PlanRunPage live view', () => {
  it('renders stages, sources, drafts, repairs, critic rounds and usage as events arrive', async () => {
    serveRun();
    const { stream } = renderRun();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.open();
    const events = runEvents();

    stream.emit(...events.slice(0, 6));
    expect(screen.getByTestId('run-stage-context')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('run-stage-research')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('run-activity')).toHaveTextContent('Researcher (frontier-1) is searching the web.');

    stream.emit(...events.slice(6, 20));
    const rows = screen.getAllByTestId('source-row');
    expect(rows).toHaveLength(2);
    const link = within(rows[0]).getByRole('link', { name: 'ACSM stand' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('hypertrophy volume guidelines')).toBeInTheDocument();
    expect(screen.getByText(/2 sources could not be verified and were removed/)).toBeInTheDocument();
    expect(screen.getByText('Draft 1: 8 weeks, 32 workouts, 160 exercises')).toBeInTheDocument();
    expect(screen.getByText(/Swapped barbell-bench-press for dumbbell-bench-press/)).toBeInTheDocument();
    expect(screen.getByTestId('run-stage-critique')).toHaveTextContent('Critique (round 1)');

    const card = screen.getByTestId('critic-scorecard');
    const table = within(card).getByRole('table');
    expect(within(table).getAllByRole('rowheader')).toHaveLength(8);
    expect(within(table).getByRole('rowheader', { name: 'Progression' }).closest('tr')).toHaveTextContent('2 of 5');
    expect(within(card).getByText('Asked for changes')).toBeInTheDocument();
    expect(within(card).getByText(/Progression: No load progression/)).toBeInTheDocument();

    expect(screen.getByTestId('usage-researcher')).toHaveTextContent('Researcher: 1,200 tokens on openai frontier-1 (your key)');
    expect(screen.getByTestId('usage-total')).toHaveTextContent('of 400,000 tokens');
  });

  it('shows the ready state with Review plan and warnings', async () => {
    const run = serveRun();
    const { stream } = renderRun();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.emit(...runEvents());
    run.set({ status: 'succeeded', result: { programId: PROGRAM_ID, warnings: ['critic_open_notes'] } });
    stream.end('succeeded');
    expect(await screen.findByText('Your plan is ready')).toBeInTheDocument();
    expect(await screen.findByText(/Reviewed with open notes: The critic still had notes/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review plan' })).toHaveAttribute('href', `/train/plans/${PROGRAM_ID}`);
    expect(screen.getAllByTestId('critic-scorecard')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  });

  it('replays the same state after leaving and returning, without duplicates', async () => {
    serveRun();
    const first = renderRun();
    await waitFor(() => expect(first.stream.connections).toHaveLength(1));
    first.stream.emit(...runEvents().slice(0, 20));
    const before = screen.getAllByTestId('source-row').length;
    first.unmount();

    const second = renderRun();
    await waitFor(() => expect(second.stream.connections).toHaveLength(1));
    expect(second.stream.connections[0].after).toBe(0);
    // A reload replays everything, and a reconnect overlaps a little.
    second.stream.emit(...runEvents().slice(0, 20), ...runEvents().slice(15, 20));
    expect(screen.getAllByTestId('source-row')).toHaveLength(before);
    expect(screen.getAllByTestId('draft-row')).toHaveLength(1);
    expect(screen.getAllByTestId('critic-scorecard')).toHaveLength(1);
  });

  it('cancels after a confirm and shows cancelled', async () => {
    serveRun();
    const { stream } = renderRun();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.emit(...runEvents().slice(0, 5));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop the run' }));
    expect(await screen.findByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    stream.emit({ seq: 6, type: 'run.cancelled', data: {} });
    expect(await screen.findByText('Run cancelled')).toBeInTheDocument();
    expect(screen.getByTestId('run-status')).toHaveTextContent('Cancelled');
  });

  it('shows the reconnecting indicator', async () => {
    serveRun();
    const { stream } = renderRun();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.open();
    stream.state('reconnecting');
    expect(await screen.findByTestId('run-reconnecting')).toBeInTheDocument();
  });

  it('warns when the worker heartbeat is stale', async () => {
    serveRun({ status: 'running', heartbeatAt: new Date(Date.now() - 4 * 60_000).toISOString() });
    renderRun();
    expect(await screen.findByTestId('worker-stale')).toHaveTextContent('Waiting for the worker to recover');
  });

  it('offers Resume when interrupted', async () => {
    let resumed = false;
    serveRun({ status: 'interrupted' });
    server.use(
      http.post(`*/api/ai/training/runs/${RUN_ID}/resume`, () => {
        resumed = true;
        return HttpResponse.json({ data: mockRun({ status: 'queued' }) }, { status: 202 });
      }),
    );
    const { stream } = renderRun();
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(resumed).toBe(true));
    await waitFor(() => expect(stream.connections.length).toBeGreaterThanOrEqual(2));
  });

  it('shows blocked_safety and awaiting_approval', async () => {
    serveRun({ status: 'blocked_safety' });
    const { unmount } = renderRun();
    expect(await screen.findByText('Stopped for safety', { selector: '.MuiAlertTitle-root' })).toBeInTheDocument();
    unmount();

    serveRun({ status: 'awaiting_approval', programId: PROGRAM_ID });
    renderRun();
    expect(await screen.findByRole('link', { name: 'Open the proposal' })).toHaveAttribute('href', `/train/plans/${PROGRAM_ID}`);
  });

  it('shows a 404 as not found', async () => {
    server.use(http.get(`*/api/ai/training/runs/${RUN_ID}`, () => HttpResponse.json({ message: 'nope' }, { status: 404 })));
    renderRun();
    expect(await screen.findByText('This run does not exist, or it is not yours.')).toBeInTheDocument();
  });

  it('never renders anything but the event vocabulary (no prompt text)', async () => {
    serveRun();
    const { stream, container } = renderRun();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.emit({ seq: 1, type: 'agent.call', data: { prompt: 'SECRET PROMPT TEXT', instructions: 'SYSTEM' } });
    expect(container.textContent).not.toContain('SECRET PROMPT TEXT');
    expect(container.textContent).not.toContain('SYSTEM');
  });

  it('has no axe violations mid-run', async () => {
    serveRun();
    const { stream, container } = renderRun();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.emit(...runEvents().slice(0, 22));
    expect(await axe(container)).toHaveNoViolations();
  });
});

/** The fixture stream with the research brief's basis replaced; `dropSources` removes every source event. */
function eventsWithBasis(basis: string, dropSources: boolean, extra: Record<string, unknown> = {}): TrainingRunEvent[] {
  return runEvents()
    .filter((event) => !(dropSources && event.type === 'research.source'))
    .map((event) => (event.type === 'research.brief' ? { ...event, data: { ...event.data, basis, ...extra } } : event))
    .map((event, i) => ({ ...event, seq: i + 1 }));
}

describe('PlanRunPage research basis', () => {
  it('shows the training-principles note instead of "No sources yet." when no source could be verified', async () => {
    const run = serveRun();
    const { stream } = renderRun();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    const events = eventsWithBasis('model_knowledge', true, { sourceCount: 0 });
    const briefAt = events.findIndex((event) => event.type === 'research.brief');
    stream.emit(...events.slice(0, briefAt));
    expect(screen.getByText('No sources yet.')).toBeInTheDocument();

    stream.emit(...events.slice(briefAt));
    run.set({ status: 'succeeded', result: { programId: PROGRAM_ID, warnings: [] } });
    stream.end('succeeded');
    expect(await screen.findByText('Your plan is ready')).toBeInTheDocument();
    const note = screen.getByTestId('research-basis-note');
    expect(note).toHaveClass('MuiAlert-root');
    expect(note).toHaveTextContent(
      'No web sources could be verified for this plan, so it was built from established training principles.',
    );
    expect(screen.queryByText('No sources yet.')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('source-row')).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Review plan' })).toHaveAttribute('href', `/train/plans/${PROGRAM_ID}`);
  });

  it('lists the sources with a short note when only some guidance is verified', async () => {
    serveRun();
    const { stream } = renderRun();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.emit(...eventsWithBasis('web_partial', false).slice(0, 20));
    expect(screen.getAllByTestId('source-row')).toHaveLength(2);
    expect(screen.getByTestId('research-basis-note')).toHaveTextContent(
      'Some guidance comes from established training principles rather than a verified source.',
    );
  });

  it('shows no basis note for a fully verified (or older) run', async () => {
    serveRun();
    const { stream } = renderRun();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.emit(...runEvents().slice(0, 20));
    expect(screen.getAllByTestId('source-row')).toHaveLength(2);
    expect(screen.queryByTestId('research-basis-note')).not.toBeInTheDocument();
  });
});

describe('PlanRunPage failures', () => {
  const CODES = [
    'AI_KEY_INVALID',
    'AI_MODEL_NOT_REACHABLE',
    'AI_TOOL_DISABLED',
    'TRAINING_RESEARCH_INSUFFICIENT',
    'TRAINING_PLAN_REJECTED',
    'TRAINING_RUN_BUDGET_EXCEEDED',
    'TRAINING_STALE_PLAN',
    'TRAINING_RUN_LOST',
    'TRAINING_CONTEXT_TOO_LARGE',
    'TRAINING_ROLE_UNAVAILABLE',
    'TRAINING_GYM_NOT_FOUND',
    'INTERNAL_ERROR',
  ];

  it.each(CODES)('maps %s to a human sentence', (code) => {
    const copy = runErrorCopy(code);
    expect(copy.title).not.toBe('The run failed');
    expect(copy.body).not.toContain(code);
    expect(copy.body.length).toBeGreaterThan(10);
  });

  it('shows the failure with Try again, which opens the wizard', async () => {
    serveRun({ status: 'failed', errorCode: 'TRAINING_RESEARCH_INSUFFICIENT' });
    renderRun();
    const alert = await screen.findByTestId('run-failed');
    expect(alert).toHaveTextContent("Research step didn't finish");
    expect(alert).toHaveTextContent('Try again');
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/train/plans/new');
  });
});
