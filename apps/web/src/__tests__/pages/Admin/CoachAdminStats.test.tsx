/**
 * The Engagement panel of `/admin/settings/coach` (E7.11, #251):
 * `GET /api/admin/coach/stats`, rates by angle and persona, KPI tiles, the
 * empty state and a retry on error. Real hook, MSW for the network.
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import CoachAdminPage from '../../../pages/Admin/CoachAdminPage';
import { mockCoachStats } from '../../mocks/fixtures/coach';

const API = '*/api';

function useStats(body: unknown, status = 200) {
  const calls: string[] = [];
  server.use(
    http.get(`${API}/admin/coach/stats`, ({ request }) => {
      calls.push(new URL(request.url).search);
      if (status !== 200) return HttpResponse.json({ code: 'INTERNAL_SERVER_ERROR', message: 'Aggregation failed' }, { status });
      return HttpResponse.json({ data: body });
    }),
  );
  return calls;
}

async function renderPanel() {
  const result = render(<CoachAdminPage />, { wrapperOptions: { aiEnabled: true, user: mockAdminUser } });
  await screen.findByRole('switch', { name: 'Coach enabled' });
  return { panel: screen.getByTestId('coach-engagement-panel'), ...result };
}

describe('CoachAdminPage — Engagement panel (E7.11)', () => {
  it('asks for the last 30 days and shows the KPI tiles', async () => {
    const calls = useStats(mockCoachStats);
    const { panel } = await renderPanel();

    const kpis = await within(panel).findByRole('list', { name: 'Coach KPIs' });
    expect(calls[0]).toBe('?days=30');
    const tiles = within(kpis).getAllByRole('listitem');
    expect(tiles).toHaveLength(5);
    expect(within(kpis).getByText('Nudge open rate').parentElement).toHaveTextContent('60%');
    expect(within(kpis).getByText('Follow-through').parentElement).toHaveTextContent('30%');
    expect(within(kpis).getByText('Chat sessions per active user').parentElement).toHaveTextContent('1.5');
    expect(within(kpis).getByText('Photo cadence kept').parentElement).toHaveTextContent('50%');
    expect(within(kpis).getByText('Opt-out rate').parentElement).toHaveTextContent('10%');
    expect(within(panel).getByText(/Last 30 days, 40 messages sent/)).toBeInTheDocument();
  });

  it('shows rates by angle and by persona with readable labels', async () => {
    useStats(mockCoachStats);
    const { panel } = await renderPanel();

    const byAngle = await within(panel).findByRole('table', { name: 'By message angle' });
    const identity = within(byAngle).getByRole('rowheader', { name: 'Identity' }).closest('tr')!;
    expect(within(identity).getAllByRole('cell').map((c) => c.textContent)).toEqual(['25', '60%', '35%', '4', '0']);
    expect(within(byAngle).getByRole('rowheader', { name: 'Small challenge' })).toBeInTheDocument();

    const byPersona = within(panel).getByRole('table', { name: 'By persona' });
    expect(within(byPersona).getByRole('rowheader', { name: 'Sarge' })).toBeInTheDocument();
    expect(within(byPersona).getByRole('rowheader', { name: 'The Analyst' })).toBeInTheDocument();

    const byMoment = within(panel).getByRole('table', { name: 'By moment' });
    const pr = within(byMoment).getByRole('rowheader', { name: 'Personal record' }).closest('tr')!;
    expect(within(pr).getByLabelText('Not available')).toBeInTheDocument();
  });

  it('shows the empty state when nothing was sent (the default handler)', async () => {
    const { panel } = await renderPanel();
    expect(await within(panel).findByText('No engagement data yet')).toBeInTheDocument();
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error with a working Retry', async () => {
    useStats(null, 500);
    const user = userEvent.setup();
    const { panel } = await renderPanel();
    await within(panel).findByRole('alert');

    useStats(mockCoachStats);
    await user.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(await within(panel).findByRole('table', { name: 'By message angle' })).toBeInTheDocument();
  });

  it('has no axe violations with data', async () => {
    useStats(mockCoachStats);
    const { container, panel } = await renderPanel();
    await within(panel).findByRole('table', { name: 'By persona' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
