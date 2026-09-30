/**
 * E5.8 plan adaptation components against MSW: the "Plan adjusted" banner
 * (Undo in one tap, Review and Dismiss mark seen), the proposal card
 * (approve, reject, expired, AI off), the autonomy control and its offer, the
 * paused-automation banner (reason copy, Resume after confirming), Re-evaluate
 * now (queued, cooldown, blocked), the change log (status chips, operation
 * lines, reviewed and undone entries), and axe.
 */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { mockProgram, PROGRAM_ID, RUN_ID } from '../../mocks/fixtures/programs';
import { useChangeLog } from '../../../hooks/useChangeLog';
import { PlanAdjustedBanner, UNDONE_MESSAGE } from '../../../components/training/PlanAdjustedBanner';
import { ProposalCard } from '../../../components/training/ProposalCard';
import { AutonomyControl } from '../../../components/training/AutonomyControl';
import { AutomationPausedBanner, PAUSE_REASON_COPY, RESUME_CONFIRM_MESSAGE } from '../../../components/training/AutomationPausedBanner';
import { ReEvaluateButton, EVALUATION_QUEUED_MESSAGE } from '../../../components/training/ReEvaluateButton';
import { ChangeLogList } from '../../../components/training/ChangeLogList';
import { WeeklyReviewCard } from '../../../components/training/WeeklyReviewCard';
import type { ChangeLogEntry } from '../../../services/programs';

const user = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };

export function entry(overrides: Partial<ChangeLogEntry> = {}): ChangeLogEntry {
  return {
    id: '00000000-0000-4000-8000-c0000000a001',
    kind: 'adapted',
    actor: 'ai',
    status: 'applied',
    fromVersion: 2,
    toVersion: 3,
    runId: RUN_ID,
    summary: 'Added a set to bench press after two strong weeks.',
    rationale: 'Bench press moved up three sessions in a row at RPE 7.',
    operations: [
      { op: 'set_prescription', description: 'Weeks 4-6, Bench press: 4 sets', fingerprint: 'f1' },
      { op: 'remove_exercise', description: 'Weeks 4-6: remove Leg extension', forced: true, fingerprint: 'f2' },
    ],
    citations: [
      { sourceId: 'S1', url: 'https://example.org/volume', title: 'Volume and growth', publisher: 'Journal', year: 2020, claimIds: ['E1'] },
    ],
    revertsLogId: null,
    seenAt: null,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    decidedAt: null,
    ...overrides,
  };
}

function serveLog(items: ChangeLogEntry[]) {
  let current = items;
  const calls = { reverts: [] as Array<{ ifMatch: string | null; body: unknown }>, seen: [] as unknown[] };
  server.use(
    http.get(`*/api/programs/${PROGRAM_ID}/change-log`, () => HttpResponse.json({ data: { items: current, nextCursor: null } })),
    http.post(`*/api/programs/${PROGRAM_ID}/revert`, async ({ request }) => {
      calls.reverts.push({ ifMatch: request.headers.get('If-Match'), body: await request.json() });
      current = current.map((e) => (e.status === 'applied' ? { ...e, status: 'reverted' as const } : e));
      return HttpResponse.json({ data: mockProgram({ currentVersion: 4 }) });
    }),
    http.post(`*/api/programs/${PROGRAM_ID}/change-log/seen`, async ({ request }) => {
      calls.seen.push(await request.json());
      return HttpResponse.json({ data: { updated: 1 } });
    }),
  );
  return calls;
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function BannerHarness({ canWrite = true, onUndone }: { canWrite?: boolean; onUndone?: () => void }) {
  const changeLog = useChangeLog(PROGRAM_ID);
  return (
    <Routes>
      <Route
        path="/plan"
        element={<PlanAdjustedBanner programId={PROGRAM_ID} changeLog={changeLog} canWrite={canWrite} showOperations onUndone={onUndone} />}
      />
      <Route path="*" element={<Where />} />
    </Routes>
  );
}

function renderBanner(props: { canWrite?: boolean; onUndone?: () => void } = {}) {
  return render(<BannerHarness {...props} />, { wrapperOptions: { route: '/plan', user } });
}

describe('PlanAdjustedBanner', () => {
  it('shows the latest unseen AI change with its operations', async () => {
    serveLog([entry()]);
    renderBanner();
    const banner = await screen.findByTestId('plan-adjusted-banner');
    expect(within(banner).getByText('Your plan was adjusted')).toBeInTheDocument();
    expect(within(banner).getByText('Added a set to bench press after two strong weeks.')).toBeInTheDocument();
    expect(within(banner).getAllByTestId('operation-line')).toHaveLength(2);
  });

  it('renders nothing for a seen change, a manual edit or a proposal', async () => {
    serveLog([
      entry({ id: 'a', seenAt: '2026-09-01T00:00:00.000Z' }),
      entry({ id: 'b', actor: 'user', kind: 'edited' }),
      entry({ id: 'c', status: 'proposed', toVersion: null }),
    ]);
    const { container } = renderBanner();
    await waitFor(() => expect(container.querySelector('[data-testid="plan-adjusted-banner"]')).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('plan-adjusted-banner')).toBeNull();
  });

  it('undoes in one tap with If-Match and says the coach will not suggest it again', async () => {
    const calls = serveLog([entry()]);
    const onUndone = vi.fn();
    renderBanner({ onUndone });
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText(UNDONE_MESSAGE)).toBeInTheDocument();
    expect(calls.reverts).toEqual([{ ifMatch: '3', body: { changeLogId: entry().id } }]);
    expect(onUndone).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('plan-adjusted-banner')).toBeNull());
  });

  it('explains when the change is no longer the latest', async () => {
    serveLog([entry()]);
    server.use(
      http.post(`*/api/programs/${PROGRAM_ID}/revert`, () =>
        HttpResponse.json({ message: 'Conflict', details: { reason: 'NOT_LATEST' } }, { status: 409 }),
      ),
    );
    renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A newer change came after this one');
  });

  it('offers no Undo when a newer applied change exists', async () => {
    serveLog([entry({ id: 'newer', actor: 'user', kind: 'edited', toVersion: 4 }), entry()]);
    renderBanner();
    await screen.findByTestId('plan-adjusted-banner');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('dismiss marks the change seen', async () => {
    const calls = serveLog([entry()]);
    renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByTestId('plan-adjusted-banner')).toBeNull());
    expect(calls.seen).toEqual([{ upToId: entry().id }]);
  });

  it('review goes to the history and marks the change seen', async () => {
    const calls = serveLog([entry()]);
    renderBanner();
    await userEvent.click(await screen.findByRole('link', { name: 'Review' }));
    expect(await screen.findByTestId('where')).toHaveTextContent(`/train/plans/${PROGRAM_ID}/history`);
    await waitFor(() => expect(calls.seen).toEqual([{ upToId: entry().id }]));
  });

  it('without programs:write shows only Review', async () => {
    serveLog([entry()]);
    renderBanner({ canWrite: false });
    await screen.findByTestId('plan-adjusted-banner');
    expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('has no axe violations', async () => {
    serveLog([entry()]);
    const { container } = renderBanner();
    await screen.findByTestId('plan-adjusted-banner');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ProposalCard', () => {
  const proposal = entry({ status: 'proposed', toVersion: null });

  it('shows the suggestion, its operations, sources and expiry, and approves', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ProposalCard entry={proposal} aiVisible canWrite onDecide={onDecide} />);
    expect(screen.getByRole('heading', { name: 'Your coach suggests a change' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Suggested changes' })).toHaveTextContent('Weeks 4-6, Bench press: 4 sets');
    expect(screen.getByRole('link', { name: 'Volume and growth' })).toHaveAttribute('href', 'https://example.org/volume');
    expect(screen.getByTestId('proposal-expiry')).toHaveTextContent(/^Open until /);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenCalledWith('approve');
    expect(await screen.findByText('Approved. Your plan is being updated.')).toBeInTheDocument();
  });

  it('rejects', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ProposalCard entry={proposal} aiVisible canWrite onDecide={onDecide} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDecide).toHaveBeenCalledWith('reject');
    expect(await screen.findByText('Rejected. Your plan stays as it is.')).toBeInTheDocument();
  });

  it('says an expired suggestion has expired and offers no decision', () => {
    const old = entry({ status: 'proposed', toVersion: null, createdAt: new Date(Date.now() - 15 * 86_400_000).toISOString() });
    render(<ProposalCard entry={old} aiVisible canWrite onDecide={vi.fn()} />);
    expect(screen.getByTestId('proposal-expiry')).toHaveTextContent('This suggestion has expired.');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('explains instead of offering a decision while AI is off', () => {
    render(<ProposalCard entry={proposal} aiVisible={false} canWrite onDecide={vi.fn()} />);
    expect(screen.getByText(/AI is switched off/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('shows a refusal in place', async () => {
    const { ApiError } = await import('../../../services/api');
    const onDecide = vi
      .fn()
      .mockRejectedValue(new ApiError('Conflict', 409, 'CONFLICT', { reason: 'TRAINING_RUN_NOT_AWAITING_DECISION' }));
    render(<ProposalCard entry={proposal} aiVisible canWrite onDecide={onDecide} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This suggestion was already decided or has expired.')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ProposalCard entry={proposal} aiVisible canWrite onDecide={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('AutonomyControl', () => {
  it('switches to Ask me first', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<AutonomyControl value="autonomous" canWrite onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Adapt automatically' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Ask me first' }));
    expect(onChange).toHaveBeenCalledWith('ask_first');
  });

  it('is read-only without programs:write', () => {
    render(<AutonomyControl value="ask_first" canWrite={false} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Ask me first' })).toBeDisabled();
  });

  it('offers Ask me first after undos, and not when already asking', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<AutonomyControl value="autonomous" canWrite onChange={onChange} suggestAskFirst />);
    const offer = screen.getByTestId('ask-first-offer');
    await userEvent.click(within(offer).getByRole('button', { name: 'Ask me first' }));
    expect(onChange).toHaveBeenCalledWith('ask_first');
    rerender(<AutonomyControl value="ask_first" canWrite onChange={onChange} suggestAskFirst />);
    expect(screen.queryByTestId('ask-first-offer')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<AutonomyControl value="autonomous" canWrite onChange={vi.fn()} suggestAskFirst />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('AutomationPausedBanner', () => {
  it('shows the reason copy and resumes after confirming', async () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    render(<AutomationPausedBanner reason="pain_pattern" canWrite onResume={onResume} />);
    expect(screen.getByText(PAUSE_REASON_COPY.pain_pattern)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume automatic adjustments' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resume automatic adjustments?' });
    expect(within(dialog).getByText(RESUME_CONFIRM_MESSAGE)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('hides Resume without programs:write', () => {
    render(<AutomationPausedBanner reason="safety_text" canWrite={false} onResume={vi.fn()} />);
    expect(screen.getByText(PAUSE_REASON_COPY.safety_text)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume automatic adjustments' })).toBeNull();
  });

  it('never tells anyone to push through', () => {
    for (const text of [...Object.values(PAUSE_REASON_COPY), RESUME_CONFIRM_MESSAGE]) {
      expect(text.toLowerCase()).not.toContain('push through');
    }
  });

  it('has no axe violations', async () => {
    const { container } = render(<AutomationPausedBanner reason="safety_text" canWrite onResume={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ReEvaluateButton', () => {
  it('starts a manual evaluation of the plan', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('*/api/ai/training/runs', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ data: { runId: RUN_ID, jobId: 'j1', status: 'queued' } }, { status: 202 });
      }),
    );
    const onStarted = vi.fn();
    render(<ReEvaluateButton programId={PROGRAM_ID} blocker={null} onStarted={onStarted} />, { wrapperOptions: { user } });
    await userEvent.click(screen.getByRole('button', { name: 'Re-evaluate now' }));
    expect(await screen.findByText(EVALUATION_QUEUED_MESSAGE)).toBeInTheDocument();
    expect(bodies).toEqual([{ kind: 'evaluate', programId: PROGRAM_ID, trigger: 'manual' }]);
    expect(onStarted).toHaveBeenCalledWith(RUN_ID);
  });

  it('disables itself with the wait during the cooldown', async () => {
    server.use(
      http.post('*/api/ai/training/runs', () =>
        HttpResponse.json(
          { message: 'Cooldown', details: { reason: 'TRAINING_EVALUATION_COOLDOWN', retryAfterSeconds: 1500 } },
          { status: 409 },
        ),
      ),
    );
    render(<ReEvaluateButton programId={PROGRAM_ID} blocker={null} />, { wrapperOptions: { user } });
    await userEvent.click(screen.getByRole('button', { name: 'Re-evaluate now' }));
    expect(await screen.findByText('You can ask again in 25 minutes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-evaluate now' })).toBeDisabled();
  });

  it('is disabled with the blocker and its fix', () => {
    render(
      <ReEvaluateButton
        programId={PROGRAM_ID}
        blocker={{ message: 'The coach agent needs an AI key.', fix: { label: 'Add a key', to: '/settings/ai' } }}
      />,
      { wrapperOptions: { user } },
    );
    expect(screen.getByRole('button', { name: 'Re-evaluate now' })).toBeDisabled();
    expect(screen.getByText(/The coach agent needs an AI key/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a key' })).toHaveAttribute('href', '/settings/ai');
  });

  it('is disabled with the host reason', () => {
    render(<ReEvaluateButton programId={PROGRAM_ID} blocker={null} disabledReason="Decide on the open suggestion first." />, {
      wrapperOptions: { user },
    });
    expect(screen.getByRole('button', { name: 'Re-evaluate now' })).toHaveAccessibleDescription('Decide on the open suggestion first.');
  });
});

describe('ChangeLogList (E5.8)', () => {
  const entries: ChangeLogEntry[] = [
    entry({ id: 'undo', kind: 'reverted', actor: 'user', status: 'applied', toVersion: 4, revertsLogId: 'adapt', operations: [], citations: [], rationale: null, summary: 'Undid the coach change' }),
    entry({ id: 'adapt', status: 'reverted' }),
    entry({ id: 'review', kind: 'reviewed', status: 'applied', fromVersion: 2, toVersion: 2, operations: [], citations: [], summary: 'On track this week.' }),
    entry({ id: 'prop', status: 'proposed', toVersion: null }),
    entry({ id: 'sup', status: 'superseded', toVersion: null }),
    entry({ id: 'rej', status: 'rejected', toVersion: null }),
    entry({ id: 'exp', status: 'expired', toVersion: null }),
    entry({ id: 'stop', kind: 'reviewed', actor: 'system', operations: [], citations: [], summary: 'Safety stop' }),
  ];

  it('shows status chips, operation lines, sources and undo markers', () => {
    render(<ChangeLogList entries={entries} />);
    const items = screen.getAllByTestId('change-log-entry');
    const chip = (i: number) => within(items[i]).getByTestId('change-status');
    expect(chip(0)).toHaveTextContent('Applied');
    expect(chip(1)).toHaveTextContent('Undone');
    expect(chip(2)).toHaveTextContent('Reviewed');
    expect(chip(3)).toHaveTextContent('Proposed');
    expect(chip(4)).toHaveTextContent('Superseded');
    expect(chip(5)).toHaveTextContent('Rejected');
    expect(chip(6)).toHaveTextContent('Expired');
    expect(within(items[7]).getByText('Safety')).toBeInTheDocument();
    expect(within(items[0]).getByTestId('reverts-marker')).toHaveTextContent('Undid: Added a set to bench press');
    expect(within(items[1]).getByTestId('reverted-marker')).toHaveTextContent(/^Undone/);
    expect(within(items[1]).getAllByTestId('operation-line').map((l) => l.textContent)).toEqual([
      'Weeks 4-6, Bench press: 4 sets',
      'Weeks 4-6: remove Leg extension (safety)',
    ]);
    expect(within(items[1]).getByRole('link', { name: 'Volume and growth' })).toBeInTheDocument();
    expect(within(items[2]).queryByText(/version 2/)).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ChangeLogList entries={entries} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('WeeklyReviewCard', () => {
  it('shows the latest review', async () => {
    const { container } = render(
      <WeeklyReviewCard entry={entry({ kind: 'reviewed', summary: 'On track: keep going.', rationale: 'Adherence 100%.' })} />,
    );
    expect(screen.getByRole('heading', { name: 'Latest review' })).toBeInTheDocument();
    expect(screen.getByText('On track: keep going.')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
