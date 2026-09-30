/**
 * PlanViewerPage, E5.8: the "Plan adjusted" banner with one-tap Undo (the plan
 * reloads), the open proposal, the paused-automation banner and Resume, the
 * autonomy control (PATCH), Re-evaluate now (only with AI on and ai:use, for
 * an active plan), the latest review, the offer after two undos, the Progress
 * link, and axe. Against MSW.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import PlanViewerPage from '../../../pages/Train/PlanViewerPage';
import { mockProgram, PROGRAM_ID, RUN_ID } from '../../mocks/fixtures/programs';
import { UNDONE_MESSAGE } from '../../../components/training/PlanAdjustedBanner';
import { PAUSE_REASON_COPY } from '../../../components/training/AutomationPausedBanner';
import type { ChangeLogEntry, Program } from '../../../services/programs';

const planUser = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };

function entry(overrides: Partial<ChangeLogEntry> = {}): ChangeLogEntry {
  return {
    id: '00000000-0000-4000-8000-c0000000b001',
    kind: 'adapted',
    actor: 'ai',
    status: 'applied',
    fromVersion: 1,
    toVersion: 2,
    runId: RUN_ID,
    summary: 'Lowered squat volume after a missed week.',
    rationale: null,
    operations: [{ op: 'set_prescription', description: 'Weeks 3-4, Back squat: 3 sets', fingerprint: 'f' }],
    citations: [],
    revertsLogId: null,
    seenAt: null,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    decidedAt: null,
    ...overrides,
  };
}

function serve(program: Program, log: ChangeLogEntry[] = []) {
  let current = program;
  let items = log;
  const calls = {
    patches: [] as unknown[],
    reverts: [] as Array<{ ifMatch: string | null; body: unknown }>,
    resumes: 0,
    decisions: [] as unknown[],
    programLoads: 0,
  };
  server.use(
    http.get(`*/api/programs/${PROGRAM_ID}`, () => {
      calls.programLoads += 1;
      return HttpResponse.json({ data: current });
    }),
    http.get('*/api/exercises', () => HttpResponse.json({ data: [] })),
    http.get(`*/api/programs/${PROGRAM_ID}/change-log`, () => HttpResponse.json({ data: { items, nextCursor: null } })),
    http.patch(`*/api/programs/${PROGRAM_ID}`, async ({ request }) => {
      const body = (await request.json()) as Partial<Program>;
      calls.patches.push(body);
      current = { ...current, ...body };
      return HttpResponse.json({ data: current });
    }),
    http.post(`*/api/programs/${PROGRAM_ID}/revert`, async ({ request }) => {
      calls.reverts.push({ ifMatch: request.headers.get('If-Match'), body: await request.json() });
      items = items.map((e) => ({ ...e, status: 'reverted' as const }));
      current = { ...current, currentVersion: current.currentVersion + 1 };
      return HttpResponse.json({ data: current });
    }),
    http.post(`*/api/programs/${PROGRAM_ID}/autonomy/resume`, () => {
      calls.resumes += 1;
      current = { ...current, autonomyPausedAt: null, autonomyPausedReason: null };
      return HttpResponse.json({ data: current });
    }),
    http.post(`*/api/ai/training/runs/${RUN_ID}/decision`, async ({ request }) => {
      calls.decisions.push(await request.json());
      items = items.map((e) => (e.status === 'proposed' ? { ...e, status: 'rejected' as const } : e));
      return HttpResponse.json({ data: { id: RUN_ID } }, { status: 202 });
    }),
  );
  return calls;
}

function renderViewer(opts: { aiEnabled?: boolean; permissions?: string[] } = {}) {
  return render(
    <Routes>
      <Route path="/train/plans/:programId" element={<PlanViewerPage />} />
    </Routes>,
    {
      wrapperOptions: {
        route: `/train/plans/${PROGRAM_ID}`,
        aiEnabled: opts.aiEnabled ?? true,
        user: { ...planUser, permissions: opts.permissions ?? planUser.permissions },
      },
    },
  );
}

const active = (overrides: Partial<Program> = {}) => mockProgram({ status: 'active', startDate: '2026-09-07', ...overrides });

describe('PlanViewerPage adaptation (E5.8)', () => {
  it('shows the banner and undoes the change in one tap, reloading the plan', async () => {
    const calls = serve(active(), [entry()]);
    renderViewer();
    const banner = await screen.findByTestId('plan-adjusted-banner');
    expect(within(banner).getByText('Weeks 3-4, Back squat: 3 sets')).toBeInTheDocument();
    const loadsBefore = calls.programLoads;
    await userEvent.click(within(banner).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText(UNDONE_MESSAGE)).toBeInTheDocument();
    expect(calls.reverts).toEqual([{ ifMatch: '2', body: { changeLogId: entry().id } }]);
    await waitFor(() => expect(calls.programLoads).toBeGreaterThan(loadsBefore));
    await waitFor(() => expect(screen.queryByTestId('plan-adjusted-banner')).toBeNull());
    expect(await screen.findByText('Version 3')).toBeInTheDocument();
  });

  it('shows the open proposal and decides it through its run', async () => {
    const calls = serve(active({ autonomy: 'ask_first' }), [entry({ status: 'proposed', toVersion: null })]);
    renderViewer();
    const card = await screen.findByTestId('proposal-card');
    expect(screen.getByRole('button', { name: 'Re-evaluate now' })).toHaveAccessibleDescription('Decide on the open suggestion first.');
    await userEvent.click(within(card).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(calls.decisions).toEqual([{ decision: 'reject' }]));
    await waitFor(() => expect(screen.queryByTestId('proposal-card')).toBeNull());
  });

  it('explains instead of Approve while AI is off, and hides Re-evaluate now', async () => {
    serve(active({ autonomy: 'ask_first' }), [entry({ status: 'proposed', toVersion: null })]);
    renderViewer({ aiEnabled: false });
    const card = await screen.findByTestId('proposal-card');
    expect(within(card).getByText(/AI is switched off/)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-evaluate now' })).toBeNull();
  });

  it('hides Re-evaluate now without ai:use', async () => {
    serve(active());
    renderViewer({ permissions: planUser.permissions.filter((p) => p !== 'ai:use') });
    await screen.findByTestId('autonomy-control');
    expect(screen.queryByRole('button', { name: 'Re-evaluate now' })).toBeNull();
  });

  it('shows the pause reason and resumes after confirming', async () => {
    const calls = serve(active({ autonomyPausedAt: '2026-09-20T10:00:00.000Z', autonomyPausedReason: 'safety_text' }));
    renderViewer();
    const paused = await screen.findByTestId('automation-paused');
    expect(within(paused).getByText(PAUSE_REASON_COPY.safety_text)).toBeInTheDocument();
    await userEvent.click(within(paused).getByRole('button', { name: 'Resume automatic adjustments' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resume automatic adjustments?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText('Automatic adjustments resumed.')).toBeInTheDocument();
    expect(calls.resumes).toBe(1);
    expect(screen.queryByTestId('automation-paused')).toBeNull();
  });

  it('changes the autonomy through PATCH', async () => {
    const calls = serve(active());
    renderViewer();
    await userEvent.click(await screen.findByRole('button', { name: 'Ask me first' }));
    await waitFor(() => expect(calls.patches).toEqual([{ autonomy: 'ask_first' }]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ask me first' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('offers Ask me first after two undos in 14 days', async () => {
    const decidedAt = new Date(Date.now() - 86_400_000).toISOString();
    serve(active(), [
      entry({ id: 'a', status: 'reverted', decidedAt, seenAt: decidedAt }),
      entry({ id: 'b', status: 'reverted', decidedAt, seenAt: decidedAt }),
    ]);
    renderViewer();
    expect(await screen.findByTestId('ask-first-offer')).toBeInTheDocument();
  });

  it('shows the latest review, when the coach last looked, and links to Progress', async () => {
    serve(active({ lastEvaluatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }), [
      entry({ kind: 'reviewed', summary: 'On track: keep going.', fromVersion: 2, toVersion: 2 }),
    ]);
    renderViewer();
    const review = await screen.findByTestId('weekly-review');
    expect(within(review).getByText('On track: keep going.')).toBeInTheDocument();
    expect(screen.getByTestId('last-evaluated')).toHaveTextContent(/^Last reviewed by your coach .*ago\.$/);
    expect(screen.getByRole('link', { name: 'Progress' })).toHaveAttribute('href', `/train/plans/${PROGRAM_ID}/progress`);
  });

  it('has no axe violations with the banner, proposal and pause shown', async () => {
    serve(active({ autonomyPausedAt: '2026-09-20T10:00:00.000Z', autonomyPausedReason: 'pain_pattern' }), [
      entry({ id: 'p', status: 'proposed', toVersion: null }),
      entry(),
    ]);
    const { container } = renderViewer();
    await screen.findByTestId('plan-adjusted-banner');
    await screen.findByTestId('proposal-card');
    await screen.findAllByTestId('plan-workout');
    expect(await axe(container)).toHaveNoViolations();
  });
});
