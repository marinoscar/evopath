/**
 * The "Usage" section of `/settings/ai` (issue #444) against the MSW network:
 * what it asks `GET /api/ai/usage/me` for, and each fixture state.
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { MyAiUsageSection } from '../../../components/settings/ai/MyAiUsageSection';
import { mockAiUsageEmpty, mockAiUsageReport } from '../../mocks/fixtures/ai';

describe('MyAiUsageSection', () => {
  it('asks for the last 30 days by model and renders totals and a model table', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get('*/api/ai/usage/me', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({ data: mockAiUsageReport('model') });
      }),
    );
    render(<MyAiUsageSection />);

    expect(screen.getByLabelText('Loading your AI usage')).toBeInTheDocument();
    const tiles = await screen.findByRole('group', { name: 'Your AI usage totals' });
    expect(within(tiles).getByText('120')).toBeInTheDocument();
    expect(within(tiles).getByText('5.0%')).toBeInTheDocument();
    expect(screen.getByText(/30 of these requests used your organization/)).toBeInTheDocument();

    const table = screen.getByTestId('my-ai-usage-table');
    expect(within(table).getByText('gpt-5-mini')).toBeInTheDocument();
    expect(within(table).getByText('gpt-5')).toBeInTheDocument();

    expect(seen).toHaveLength(1);
    expect(seen[0].get('groupBy')).toBe('model');
    const span =
      (Date.parse(seen[0].get('to') ?? '') - Date.parse(seen[0].get('from') ?? '')) / 86_400_000 + 1;
    expect(span).toBe(30);
  });

  it('says so when there is no usage', async () => {
    server.use(http.get('*/api/ai/usage/me', () => HttpResponse.json({ data: mockAiUsageEmpty('model') })));
    render(<MyAiUsageSection />);

    expect(
      await screen.findByText("You haven't made any AI requests in the last 30 days."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('my-ai-usage-table')).not.toBeInTheDocument();
  });

  it('shows a refusal as an error inside the section only', async () => {
    server.use(
      http.get('*/api/ai/usage/me', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'AI is disabled' }, { status: 403 }),
      ),
    );
    render(<MyAiUsageSection />);

    const section = await screen.findByRole('region', { name: 'Usage' });
    expect(await within(section).findByRole('alert')).toHaveTextContent('AI is disabled');
  });
});
