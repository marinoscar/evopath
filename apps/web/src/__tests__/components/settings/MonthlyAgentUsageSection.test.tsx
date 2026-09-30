/**
 * "Agent usage" on `/settings/ai` (E6.3) against MSW: the current UTC month
 * by default, the month picker (current month and the 12 before it), totals,
 * by role, by kind and by key, the empty and partial-retention states, an
 * error kept inside the section, "Tokens, not currency", and axe.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { MonthlyAgentUsageSection } from '../../../components/settings/ai/MonthlyAgentUsageSection';
import { mockMonthlyUsage, mockMonthlyUsageEmpty } from '../../mocks/fixtures/trainingUsage';

const NOW = new Date('2026-09-15T12:00:00Z');

function serveMonths(answer: (month: string | null) => ReturnType<typeof mockMonthlyUsage>) {
  const asked: Array<string | null> = [];
  server.use(
    http.get('*/api/ai/training/usage', ({ request }) => {
      const month = new URL(request.url).searchParams.get('month');
      asked.push(month);
      return HttpResponse.json({ data: answer(month) });
    }),
  );
  return asked;
}

describe('MonthlyAgentUsageSection', () => {
  it('reads the current UTC month and renders totals, roles, kinds and key sources', async () => {
    const asked = serveMonths(() => mockMonthlyUsage());
    render(<MonthlyAgentUsageSection now={NOW} />);

    expect(screen.getByLabelText('Loading your agent usage')).toBeInTheDocument();
    const tiles = await screen.findByRole('group', { name: 'Agent usage totals for September 2026' });
    expect(within(tiles).getByText('12')).toBeInTheDocument();
    expect(within(tiles).getByText('30,000')).toBeInTheDocument();
    expect(screen.getByText(/4 of these requests used the organisation's key/)).toBeInTheDocument();

    const roles = screen.getByTestId('agent-usage-by-role');
    expect(within(roles).getByText('Planner')).toBeInTheDocument();
    expect(within(roles).getByText('Critic')).toBeInTheDocument();
    expect(within(roles).getByText('Not attributed to one role')).toBeInTheDocument();

    const kinds = screen.getByTestId('agent-usage-by-kind');
    expect(within(kinds).getByText('Workout adjustments (3 runs)')).toBeInTheDocument();
    expect(within(kinds).getByText('New plans (1 run)')).toBeInTheDocument();

    const keys = screen.getByTestId('agent-usage-by-key');
    expect(within(keys).getByText('Your key')).toBeInTheDocument();
    expect(within(keys).getByText("The organisation's key")).toBeInTheDocument();
    expect(within(keys).getByText('Keyless server')).toBeInTheDocument();

    expect(screen.getByTestId('tokens-not-currency')).toBeInTheDocument();
    expect(screen.getByText(/counted in UTC days/)).toBeInTheDocument();
    expect(asked).toEqual(['2026-09']);
  });

  it('offers the current month and the 12 before it, and reads the chosen month', async () => {
    const asked = serveMonths((month) => (month === '2026-03' ? mockMonthlyUsageEmpty('2026-03') : mockMonthlyUsage()));
    const user = userEvent.setup();
    render(<MonthlyAgentUsageSection now={NOW} />);
    await screen.findByTestId('agent-usage-by-role');

    await user.click(screen.getByRole('combobox', { name: 'Month' }));
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(13);
    expect(options[0]).toHaveTextContent('September 2026');
    expect(options[12]).toHaveTextContent('September 2025');

    await user.click(screen.getByRole('option', { name: 'March 2026' }));
    expect(await screen.findByTestId('monthly-agent-usage-empty')).toHaveTextContent(
      'Your agents made no requests in March 2026.',
    );
    expect(asked).toEqual(['2026-09', '2026-03']);
    expect(screen.queryByTestId('agent-usage-by-role')).not.toBeInTheDocument();
  });

  it('says part of an old month may be missing after retention', async () => {
    serveMonths(() => mockMonthlyUsage({ retention: { partial: true, retentionDays: 180 } }));
    render(<MonthlyAgentUsageSection now={NOW} />);
    expect(await screen.findByTestId('monthly-agent-usage-partial')).toHaveTextContent(
      'Usage older than 180 days is removed',
    );
  });

  it('keeps an error inside the section', async () => {
    server.use(
      http.get('*/api/ai/training/usage', () =>
        HttpResponse.json(
          { code: 'BAD_REQUEST', message: 'month is out of range', details: { reason: 'TRAINING_USAGE_MONTH_INVALID' } },
          { status: 400 },
        ),
      ),
    );
    render(<MonthlyAgentUsageSection now={NOW} />);
    const section = await screen.findByRole('region', { name: 'Agent usage' });
    expect(await within(section).findByRole('alert')).toHaveTextContent('month is out of range');
    // The picker stays usable after a failure.
    expect(within(section).getByRole('combobox', { name: 'Month' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    serveMonths(() => mockMonthlyUsage());
    const { container } = render(<MonthlyAgentUsageSection now={NOW} />);
    await screen.findByTestId('agent-usage-by-role');
    await waitFor(() => expect(screen.queryByLabelText('Loading your agent usage')).not.toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});
