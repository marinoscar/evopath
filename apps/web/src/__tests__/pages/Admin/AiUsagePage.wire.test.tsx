/**
 * `/admin/settings/ai/usage` — the WIRE contract (issue #444, epic #420).
 *
 * Real hooks, real permissions, MSW for the network — the
 * `AiModelsPage.wire.test.tsx` approach. Pinned against #443's contract:
 *
 *   1. The page reads `GET /admin/ai/usage` twice — `groupBy=day` for totals
 *      and the series, and the breakdown grouping (`user` by default) — both
 *      over the same inclusive `YYYY-MM-DD` range, 30 days by default.
 *   2. The group-by selector and the range toggle reach the query string.
 *   3. The `{ data }` envelope is unwrapped and rendered.
 *   4. An API refusal is shown as the API's own message; an empty report as
 *      an empty state.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import AiUsagePage from '../../../pages/Admin/AiUsagePage';
import { mockAiUsageEmpty } from '../../mocks/fixtures/ai';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function spanDays(params: URLSearchParams): number {
  return (Date.parse(params.get('to') ?? '') - Date.parse(params.get('from') ?? '')) / 86_400_000 + 1;
}

async function renderLoaded() {
  const user = userEvent.setup();
  render(<AiUsagePage />, { wrapperOptions: { user: mockAdminUser } });
  await screen.findByRole('group', { name: 'AI usage totals' });
  return user;
}

describe('AiUsagePage — wire contract', () => {
  let captured: URLSearchParams[];

  beforeEach(() => {
    captured = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/api/admin/ai/usage')) captured.push(url.searchParams);
    });
  });

  afterEach(() => {
    server.events.removeAllListeners();
  });

  it('reads the day series and the user breakdown over one 30-day ISO-date range', async () => {
    await renderLoaded();
    await screen.findByText('dana@acme.test');

    expect(captured.map((params) => params.get('groupBy')).sort()).toEqual(['day', 'user']);
    for (const params of captured) {
      expect(params.get('from')).toMatch(ISO_DATE);
      expect(params.get('to')).toMatch(ISO_DATE);
      expect(spanDays(params)).toBe(30);
      expect(params.has('userId')).toBe(false);
    }
    expect(captured[0].get('from')).toBe(captured[1].get('from'));
    expect(captured[0].get('to')).toBe(captured[1].get('to'));
  });

  it('renders the unwrapped report', async () => {
    await renderLoaded();

    const tiles = screen.getByRole('group', { name: 'AI usage totals' });
    expect(within(tiles).getByText('120')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Paid by organization key' })).toHaveTextContent(
      '30 requests',
    );
    expect(await screen.findByText('lee@acme.test')).toBeInTheDocument();
  });

  it('sends the chosen grouping, and re-reads both reports for a new range', async () => {
    const user = await renderLoaded();
    captured = [];

    await user.click(screen.getByRole('combobox', { name: 'Group by' }));
    await user.click(screen.getByRole('option', { name: 'Provider' }));
    await waitFor(() => expect(captured.map((p) => p.get('groupBy'))).toEqual(['provider']));
    expect(await screen.findByText('OpenAI')).toBeInTheDocument();

    captured = [];
    await user.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(captured).toHaveLength(2));
    expect(captured.map((p) => p.get('groupBy')).sort()).toEqual(['day', 'provider']);
    expect(captured.map(spanDays)).toEqual([7, 7]);
  });

  it("shows the API's own message when the read is refused", async () => {
    server.use(
      http.get('*/api/admin/ai/usage', () =>
        HttpResponse.json({ code: 'BAD_REQUEST', message: 'Range may not exceed 90 days' }, { status: 400 }),
      ),
    );
    render(<AiUsagePage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByText('Range may not exceed 90 days')).toBeInTheDocument();
  });

  it('shows the empty state for a range with no usage', async () => {
    server.use(
      http.get('*/api/admin/ai/usage', ({ request }) => {
        const groupBy = new URL(request.url).searchParams.get('groupBy') as 'day';
        return HttpResponse.json({ data: mockAiUsageEmpty(groupBy) });
      }),
    );
    await renderLoaded();

    expect(screen.getByText('No AI requests were made in this range.')).toBeInTheDocument();
  });
});
