/**
 * Where agent usage (E6.3) appears, against MSW: the adaptation page (the
 * panel once the run settled, "Not reviewed by the critic: your token limit
 * (N) was reached", the cap failure with its numbers), the plan run view (the
 * panel once terminal, the cap failure), the adapt sheet's "Typically about N
 * tokens" hint, the review's `revision_skipped_token_cap` note, and the
 * monthly section as a section of `/settings/ai` under "Usage".
 */
import { describe, it, expect, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within, mockUser } from '../../../utils/test-utils';
import { server } from '../../../mocks/server';
import AdaptationReviewPage from '../../../../pages/AdaptationReviewPage';
import PlanRunPage from '../../../../pages/Train/PlanRunPage';
import UserAiKeysPage from '../../../../pages/UserAiKeysPage';
import { AdaptWorkoutSheet } from '../../../../components/training/adapt/AdaptWorkoutSheet';
import { AdaptationReview } from '../../../../components/training/adapt/AdaptationReview';
import { fakeRunStream } from '../../../utils/fakeRunStream';
import { mockRun, RUN_ID } from '../../../mocks/fixtures/programs';
import { ADAPTATION_ID, ADAPT_RUN_ID, mockAdaptation, mockPreview } from '../../../mocks/fixtures/adaptations';
import { mockMonthlyUsage, mockRunUsage } from '../../../mocks/fixtures/trainingUsage';
import type { AdaptationView } from '../../../../services/trainingAdaptation';
import type { TrainingRunView } from '../../../../services/trainingAgents';
import type { TrainingRunUsage } from '../../../../services/trainingUsage';

function serveRunUsage(runId: string, usage: Partial<TrainingRunUsage> = {}) {
  let reads = 0;
  server.use(
    http.get(`*/api/ai/training/runs/${runId}/usage`, () => {
      reads += 1;
      return HttpResponse.json({ data: mockRunUsage({ runId, ...usage }) });
    }),
  );
  return { reads: () => reads };
}

function renderAdaptationPage(adaptation: AdaptationView) {
  server.use(
    http.get(`*/api/ai/training/adaptations/${ADAPTATION_ID}`, () => HttpResponse.json({ data: adaptation })),
    http.get(`*/api/ai/training/runs/${ADAPT_RUN_ID}`, () =>
      HttpResponse.json({ data: mockRun({ id: ADAPT_RUN_ID, kind: 'adapt', status: 'running' }) }),
    ),
  );
  const stream = fakeRunStream();
  render(
    <Routes>
      <Route
        path="/train/adapt/:adaptationId"
        element={<AdaptationReviewPage runOptions={{ connect: stream.connect, pollMs: 0, reconnectDelayMs: 0 }} previewDelayMs={0} />}
      />
    </Routes>,
    { wrapperOptions: { route: `/train/adapt/${ADAPTATION_ID}`, aiEnabled: true } },
  );
  return stream;
}

describe('adaptation page', () => {
  it('shows the run usage under the review, and the critic skipped at the token limit with its number', async () => {
    const usage = serveRunUsage(ADAPT_RUN_ID, { cap: { limitTokens: 1500, usedTokens: 1500, reached: true, reason: 'token_cap' } });
    renderAdaptationPage(
      mockAdaptation({
        criticReport: { verdict: null, checks: null, issues: [], rounds: 0, skipped: 'token_cap' },
      }),
    );

    const skipped = await screen.findByTestId('critic-skipped-token-cap');
    await waitFor(() =>
      expect(skipped).toHaveTextContent('Not reviewed by the critic: your token limit (1,500) was reached'),
    );
    const panel = screen.getByRole('region', { name: 'Tokens used' });
    expect(within(panel).getByRole('progressbar', { name: 'Your token limit per run' })).toHaveAttribute(
      'aria-valuetext',
      '1,500 of 1,500 tokens used (100%), limit reached',
    );
    // The proposal stays usable.
    expect(screen.getByRole('button', { name: 'Use for today only' })).toBeInTheDocument();
    expect(usage.reads()).toBe(1);
  });

  it('words a run stopped at the cap with the limit and what was used', async () => {
    serveRunUsage(ADAPT_RUN_ID, { status: 'failed', cap: { limitTokens: 20000, usedTokens: 20340, reached: true, reason: 'token_cap' } });
    renderAdaptationPage(mockAdaptation({ status: 'failed', proposal: null, errorCode: 'TRAINING_RUN_BUDGET_EXCEEDED' }));

    const failed = await screen.findByTestId('adapt-failed');
    await waitFor(() =>
      expect(failed).toHaveTextContent('Stopped at your limit of 20,000 tokens per run (used 20,340). Raise it in AI settings.'),
    );
    expect(within(failed).getByRole('link', { name: 'Change the limit' })).toHaveAttribute('href', '/settings/ai/agents');
  });

  it('reads no usage while the run is still working', async () => {
    const usage = serveRunUsage(ADAPT_RUN_ID);
    const stream = renderAdaptationPage(mockAdaptation({ status: 'running', proposal: null }));
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    expect(screen.queryByRole('region', { name: 'Tokens used' })).not.toBeInTheDocument();
    expect(usage.reads()).toBe(0);
  });
});

describe('plan run view', () => {
  const user = { ...mockUser, permissions: [...mockUser.permissions, 'programs:read', 'programs:write'] };

  function renderRun(run: Partial<TrainingRunView>) {
    server.use(http.get(`*/api/ai/training/runs/${RUN_ID}`, () => HttpResponse.json({ data: mockRun(run) })));
    const stream = fakeRunStream();
    render(
      <Routes>
        <Route
          path="/train/plans/runs/:runId"
          element={<PlanRunPage runOptions={{ connect: stream.connect, pollMs: 0, reconnectDelayMs: 0 }} />}
        />
      </Routes>,
      { wrapperOptions: { route: `/train/plans/runs/${RUN_ID}`, aiEnabled: true, user } },
    );
  }

  it('adds the usage by step once the run is over, and not while it runs', async () => {
    const usage = serveRunUsage(RUN_ID, { kind: 'create' });
    renderRun({ status: 'succeeded' });
    expect(await screen.findByRole('heading', { name: 'By step' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Tokens by step' })).toBeInTheDocument();
    expect(screen.getByTestId('usage-total')).toBeInTheDocument();
    expect(usage.reads()).toBe(1);
  });

  it('hides the usage by step while the run is going', async () => {
    const usage = serveRunUsage(RUN_ID);
    renderRun({ status: 'running' });
    expect(await screen.findByTestId('usage-total')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'By step' })).not.toBeInTheDocument();
    expect(usage.reads()).toBe(0);
  });

  it('words a run stopped at the cap with its numbers', async () => {
    serveRunUsage(RUN_ID, { status: 'failed' });
    renderRun({
      status: 'failed',
      errorCode: 'TRAINING_RUN_BUDGET_EXCEEDED',
      cap: { limitTokens: 20000, usedTokens: 20340, reached: true, reason: 'token_cap' },
    });
    const alert = await screen.findByTestId('run-failed');
    expect(alert).toHaveTextContent('Stopped at your token limit');
    expect(alert).toHaveTextContent('Stopped at your limit of 20,000 tokens per run (used 20,340). Raise it in AI settings.');
  });
});

describe('adapt sheet', () => {
  function renderSheet() {
    server.use(http.post('*/api/ai/training/adaptations/context-preview', () => HttpResponse.json({ data: mockPreview() })));
    render(<AdaptWorkoutSheet open onClose={() => {}} previewDelayMs={0} />, { wrapperOptions: { aiEnabled: true } });
  }

  it('says how many tokens an adjustment typically takes, from history', async () => {
    server.use(
      http.get('*/api/ai/training/usage', () =>
        HttpResponse.json({
          data: mockMonthlyUsage({ typical: { create: null, revise: null, evaluate: null, adapt: { runs: 7, medianTokens: 8400 } } }),
        }),
      ),
    );
    renderSheet();
    expect(await screen.findByTestId('adapt-typical-tokens')).toHaveTextContent('Typically about 8,400 tokens');
    expect(screen.getByRole('button', { name: 'Adjust workout' })).toHaveAccessibleDescription('Typically about 8,400 tokens');
  });

  it('says nothing without enough history', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/ai/training/usage', () => {
        reads += 1;
        return HttpResponse.json({ data: mockMonthlyUsage() });
      }),
    );
    renderSheet();
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByTestId('adapt-typical-tokens')).not.toBeInTheDocument();
    expect(screen.queryByText(/Over your per-run limit/)).not.toBeInTheDocument();
  });
});

describe('adaptation review', () => {
  it('explains a revision the token limit could not pay for', () => {
    render(
      <AdaptationReview
        adaptation={mockAdaptation({
          guardrailReport: { ...mockAdaptation().guardrailReport!, warnings: ['revision_skipped_token_cap'] },
          criticReport: { verdict: 'revise', checks: null, issues: [], rounds: 1, skipped: 'token_cap' },
        })}
        planned={null}
        canApplyWorkout
        canApplyPlan
        onApplyWorkout={vi.fn()}
        onApplyPlan={vi.fn()}
        onDiscard={vi.fn()}
        onAdjustAgain={vi.fn()}
        onStartPlanned={vi.fn()}
        onCopyExercises={vi.fn()}
        onRefetch={vi.fn()}
      />,
      { wrapperOptions: { aiEnabled: true } },
    );
    expect(screen.getByText(/your token limit was reached, so the first checked version was kept/)).toBeInTheDocument();
    // Without the run's usage, the limit is not invented.
    expect(screen.getByTestId('critic-skipped-token-cap')).toHaveTextContent(
      'Not reviewed by the critic: your token limit was reached',
    );
  });
});

describe('/settings/ai', () => {
  it('adds agent usage as a section under Usage, not a card or tab', async () => {
    render(<UserAiKeysPage />, { wrapperOptions: { aiEnabled: true } });
    const agent = await screen.findByRole('region', { name: 'Agent usage' });
    const usage = screen.getByRole('region', { name: 'Usage' });
    expect(usage.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('keeps a failed agent usage read inside its section', async () => {
    server.use(
      http.get('*/api/ai/training/usage', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'AI is disabled' }, { status: 403 }),
      ),
    );
    render(<UserAiKeysPage />, { wrapperOptions: { aiEnabled: true } });
    const agent = await screen.findByRole('region', { name: 'Agent usage' });
    expect(await within(agent).findByRole('alert')).toHaveTextContent('AI is disabled');
    expect(screen.getByRole('heading', { level: 1, name: 'AI Keys' })).toBeInTheDocument();
    expect(await screen.findByTestId('my-ai-usage-table')).toBeInTheDocument();
  });
});
