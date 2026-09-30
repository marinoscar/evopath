/**
 * AgentUsagePanel (E6.3) against MSW: steps with role, model and whose key
 * paid (a keyless server is never "your key"), the totals row, the cap meter
 * as a progress bar with a text alternative, "limit reached" in words, the
 * purged and partial notes, "Tokens, not currency" (and no currency), the
 * refetch when the run settles, a 404, and axe.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within } from '../../../utils/test-utils';
import { server } from '../../../mocks/server';
import { AgentUsagePanel } from '../../../../components/training/usage';
import { mockRunUsage, usageNode, USAGE_RUN_ID } from '../../../mocks/fixtures/trainingUsage';
import type { TrainingRunUsage } from '../../../../services/trainingUsage';

function serveUsage(...answers: TrainingRunUsage[]) {
  let reads = 0;
  server.use(
    http.get(`*/api/ai/training/runs/${USAGE_RUN_ID}/usage`, () => {
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      return HttpResponse.json({ data: answer });
    }),
  );
  return { reads: () => reads };
}

describe('AgentUsagePanel', () => {
  it('shows each step with its role, model and key source, and a totals row', async () => {
    serveUsage(mockRunUsage());
    render(<AgentUsagePanel runId={USAGE_RUN_ID} />, { wrapperOptions: { aiEnabled: true } });

    expect(screen.getByLabelText('Loading the usage of this run')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Tokens by step' });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Step', 'Model and key', 'Requests', 'Input tokens', 'Output tokens', 'Duration']);

    const rows = screen.getAllByTestId('agent-usage-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Adapting');
    expect(rows[0]).toHaveTextContent('Planner');
    expect(rows[0]).toHaveTextContent('openai frontier-1');
    expect(rows[0]).toHaveTextContent('your key');
    expect(rows[0]).toHaveTextContent('1,200');
    expect(rows[0]).toHaveTextContent('300');
    expect(rows[0]).toHaveTextContent('4.2 s');
    expect(rows[1]).toHaveTextContent('Critic review');
    expect(rows[1]).toHaveTextContent('Critic');
    expect(rows[1]).toHaveTextContent('anthropic fast-1');
    expect(rows[1]).toHaveTextContent("the organisation's key");

    const total = screen.getByTestId('agent-usage-total');
    expect(within(total).getByRole('rowheader')).toHaveTextContent('Total');
    expect(total).toHaveTextContent('2,000');
    expect(total).toHaveTextContent('420');
    expect(total).toHaveTextContent('5.3 s');
  });

  it('labels a keyless server as such and the unattributed row as not one step', async () => {
    serveUsage(
      mockRunUsage({
        byNode: [
          usageNode({ keySource: 'none', provider: 'ollama', modelId: 'local-1', requests: 1 }),
          usageNode({ node: null, role: null, provider: 'ollama', modelId: 'local-1', keySource: 'none', requests: 1, failed: 1 }),
        ],
      }),
    );
    render(<AgentUsagePanel runId={USAGE_RUN_ID} />, { wrapperOptions: { aiEnabled: true } });
    const rows = await screen.findAllByTestId('agent-usage-row');
    expect(rows[0]).toHaveTextContent('keyless server');
    expect(rows[0]).not.toHaveTextContent('your key');
    expect(rows[1]).toHaveTextContent('Not attributed to one step');
    expect(rows[1]).toHaveTextContent('1 failed');
  });

  it('shows the cap as a labelled meter with text, and says when it was reached', async () => {
    serveUsage(mockRunUsage({ cap: { limitTokens: 20000, usedTokens: 20340, reached: true, reason: 'token_cap' } }));
    render(<AgentUsagePanel runId={USAGE_RUN_ID} />, { wrapperOptions: { aiEnabled: true } });

    const meter = await screen.findByRole('progressbar', { name: 'Your token limit per run' });
    expect(meter).toHaveAttribute('aria-valuenow', '100');
    expect(meter).toHaveAttribute('aria-valuetext', '20,340 of 20,000 tokens used (102%), limit reached');
    expect(screen.getByTestId('token-cap-text')).toHaveTextContent('limit reached');
  });

  it('says tokens, not currency, and never shows an amount of money', async () => {
    serveUsage(mockRunUsage());
    const { container } = render(<AgentUsagePanel runId={USAGE_RUN_ID} />, { wrapperOptions: { aiEnabled: true } });
    await screen.findByRole('table', { name: 'Tokens by step' });
    expect(screen.getByTestId('tokens-not-currency')).toHaveTextContent('Tokens, not currency');
    expect(screen.getByRole('button', { name: 'Why tokens, not currency' })).toHaveAccessibleDescription(/no price list/);
    expect(container.textContent).not.toMatch(/[$€£¥]|\bUSD\b|\bEUR\b|cost/i);
  });

  it('explains purged usage rows instead of failing', async () => {
    serveUsage(mockRunUsage({ retention: { purged: true, retentionDays: 180 } }));
    render(<AgentUsagePanel runId={USAGE_RUN_ID} />, { wrapperOptions: { aiEnabled: true } });
    expect(await screen.findByTestId('agent-usage-purged')).toHaveTextContent('removed after 180 days');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('marks a running run as partial and reads the final numbers when it settles', async () => {
    const api = serveUsage(
      mockRunUsage({ status: 'running', byNode: [usageNode({ requests: 1, inputTokens: 1200, outputTokens: 300 })] }),
      mockRunUsage(),
    );
    const { rerender } = render(<AgentUsagePanel runId={USAGE_RUN_ID} settled={false} />, {
      wrapperOptions: { aiEnabled: true },
    });
    expect(await screen.findByText(/these numbers are partial/)).toBeInTheDocument();
    expect(screen.getAllByTestId('agent-usage-row')).toHaveLength(1);

    rerender(<AgentUsagePanel runId={USAGE_RUN_ID} settled />);
    await waitFor(() => expect(screen.getAllByTestId('agent-usage-row')).toHaveLength(2));
    expect(api.reads()).toBe(2);
    expect(screen.queryByText(/these numbers are partial/)).not.toBeInTheDocument();
  });

  it("says the usage isn't available for another user's run (404)", async () => {
    server.use(
      http.get(`*/api/ai/training/runs/${USAGE_RUN_ID}/usage`, () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: 'Run not found' }, { status: 404 }),
      ),
    );
    render(<AgentUsagePanel runId={USAGE_RUN_ID} />, { wrapperOptions: { aiEnabled: true } });
    expect(await screen.findByText("The usage of this run isn't available.")).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    serveUsage(mockRunUsage({ cap: { limitTokens: 120000, usedTokens: 2420, reached: false } }));
    const { container } = render(<AgentUsagePanel runId={USAGE_RUN_ID} />, { wrapperOptions: { aiEnabled: true } });
    await screen.findByRole('table', { name: 'Tokens by step' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
