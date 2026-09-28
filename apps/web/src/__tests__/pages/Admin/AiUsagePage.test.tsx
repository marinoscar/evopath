/**
 * `/admin/settings/ai/usage` (issue #444, epic #420).
 *
 * `useAiUsage` and `usePermissions` are mocked: this suite is about what the
 * PAGE renders for each fixture state (loading, error, empty, data) and what
 * it asks the hook for. The network contract is
 * `AiUsagePage.wire.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { mockAiUsageEmpty, mockAiUsageReport } from '../../mocks/fixtures/ai';
import type { AiUsageQuery, AiUsageReport } from '../../../services/ai';

vi.mock('../../../hooks/useAiUsage', () => ({ useAiUsage: vi.fn(), useMyAiUsage: vi.fn() }));
vi.mock('../../../hooks/usePermissions', () => ({ usePermissions: vi.fn() }));

import { useAiUsage, type UseAiUsageReturn } from '../../../hooks/useAiUsage';
import { usePermissions } from '../../../hooks/usePermissions';
import AiUsagePage from '../../../pages/Admin/AiUsagePage';

const mockUseAiUsage = vi.mocked(useAiUsage);
const mockUsePermissions = vi.mocked(usePermissions);

type State = Partial<UseAiUsageReturn<AiUsageQuery['groupBy']>>;

/** Answer every grouping from `state(groupBy)`. */
function setUsage(state: (query: AiUsageQuery) => State) {
  mockUseAiUsage.mockImplementation((query) => ({
    report: null,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...state(query),
  }));
}

function withData(query: AiUsageQuery): State {
  // The fixture's own fixed range, so the day fill is deterministic.
  return { report: mockAiUsageReport(query.groupBy) as AiUsageReport };
}

function setPermissions(granted: string[]) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(['admin']),
    hasPermission: (permission: string) => granted.includes(permission),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: true,
  });
}

function renderPage() {
  const user = userEvent.setup();
  render(<AiUsagePage />, { wrapperOptions: { user: mockAdminUser } });
  return user;
}

function tile(label: string) {
  const tiles = screen.getByRole('group', { name: 'AI usage totals' });
  return within(tiles).getByText(label).parentElement as HTMLElement;
}

describe('AiUsagePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(['ai_config:read']);
  });

  it('shows a spinner while the first report loads', () => {
    setUsage(() => ({ isLoading: true }));
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'AI Usage' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'AI usage totals' })).not.toBeInTheDocument();
  });

  it('shows the error when the report cannot be read', () => {
    setUsage(() => ({ error: 'Failed to load AI usage' }));
    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load AI usage');
    expect(screen.queryByRole('group', { name: 'AI usage totals' })).not.toBeInTheDocument();
  });

  it('says so when nothing was requested, with no invented failure rate', () => {
    setUsage((query) => ({ report: mockAiUsageEmpty(query.groupBy) as AiUsageReport }));
    renderPage();

    expect(screen.getByText('No AI requests were made in this range.')).toBeInTheDocument();
    expect(tile('Requests')).toHaveTextContent('0');
    expect(tile('Failure rate')).toHaveTextContent('—');
    expect(screen.getAllByText('No usage in this range.').length).toBeGreaterThan(0);
  });

  it('renders the totals tiles from the report', () => {
    setUsage(withData);
    renderPage();

    expect(tile('Requests')).toHaveTextContent('120');
    expect(tile('Requests')).toHaveTextContent('images: 4');
    expect(tile('Failure rate')).toHaveTextContent('5.0%');
    expect(tile('Failure rate')).toHaveTextContent('6 failed');
    expect(tile('Input tokens')).toHaveTextContent('48,000');
    expect(tile('Input tokens')).toHaveTextContent('9,000 cached');
    expect(tile('Output tokens')).toHaveTextContent('12,500');
    expect(tile('Reasoning tokens')).toHaveTextContent('3,200');
  });

  it('highlights what the organization key paid for', () => {
    setUsage(withData);
    renderPage();

    const org = screen.getByRole('region', { name: 'Paid by organization key' });
    expect(org).toHaveTextContent('30 requests');
    expect(org).toHaveTextContent('25.0% of all requests');
    expect(org).toHaveTextContent('11,000 input tokens');
    expect(org).toHaveTextContent('2,400 output tokens');
  });

  it('draws one bar per day of the range, gaps filled, with a text summary', () => {
    setUsage(withData);
    renderPage();

    const chart = screen.getByRole('img', { name: /Requests per day/ });
    expect(chart).toHaveAccessibleName(
      'Requests per day from Aug 28 to Sep 26: 120 in total, busiest Sep 26 with 80.',
    );
    const bars = within(chart).getAllByTestId('ai-usage-day-bar');
    expect(bars).toHaveLength(30);
    expect(bars.find((bar) => bar.dataset.day === '2026-09-25')?.dataset.requests).toBe('0');
    expect(bars.find((bar) => bar.dataset.day === '2026-09-26')?.dataset.requests).toBe('80');
  });

  it('offers the same numbers as a table — the chart is never the only view', async () => {
    setUsage(withData);
    const user = renderPage();

    await user.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.queryByRole('img', { name: /Requests per day/ })).not.toBeInTheDocument();
    const table = screen.getByTestId('admin-ai-usage-daily-table');
    expect(within(table).getByText('Sep 26')).toBeInTheDocument();
    expect(within(table).getByText('80')).toBeInTheDocument();
  });

  it('breaks usage down by user by default', () => {
    setUsage(withData);
    renderPage();

    expect(screen.getByRole('heading', { name: 'Usage by user' })).toBeInTheDocument();
    const table = screen.getByTestId('admin-ai-usage-breakdown-table');
    expect(within(table).getByText('dana@acme.test')).toBeInTheDocument();
    expect(within(table).getByText('lee@acme.test')).toBeInTheDocument();
    expect(mockUseAiUsage).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'user' }));
    expect(mockUseAiUsage).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'day' }));
  });

  it('switches the breakdown grouping, and names key sources in words', async () => {
    setUsage(withData);
    const user = renderPage();

    await user.click(screen.getByRole('combobox', { name: 'Group by' }));
    await user.click(screen.getByRole('option', { name: 'Model' }));
    expect(screen.getByRole('heading', { name: 'Usage by model' })).toBeInTheDocument();
    expect(within(screen.getByTestId('admin-ai-usage-breakdown-table')).getByText('gpt-5')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Group by' }));
    await user.click(screen.getByRole('option', { name: 'Key source' }));
    const table = screen.getByTestId('admin-ai-usage-breakdown-table');
    expect(within(table).getByText('Organization key')).toBeInTheDocument();
    expect(within(table).getByText("User's own key")).toBeInTheDocument();
    // #448: a keyless server's calls — `keySource: 'none'`.
    expect(within(table).getByText('No key (keyless server)')).toBeInTheDocument();
    expect(mockUseAiUsage).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'keySource' }));
  });

  it('asks for the chosen range on both reads (30 days by default)', async () => {
    setUsage(withData);
    const user = renderPage();

    const spanOf = (query: AiUsageQuery) =>
      (Date.parse(query.to ?? '') - Date.parse(query.from ?? '')) / 86_400_000 + 1;
    const lastCalls = () => mockUseAiUsage.mock.calls.slice(-2).map(([query]) => query);

    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(lastCalls().map(spanOf)).toEqual([30, 30]);

    await user.click(screen.getByRole('button', { name: '7 days' }));
    expect(lastCalls().map(spanOf)).toEqual([7, 7]);

    await user.click(screen.getByRole('button', { name: '90 days' }));
    expect(lastCalls().map(spanOf)).toEqual([90, 90]);
  });

  it('refresh re-reads both reports', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    setUsage((query) => ({ ...withData(query), refresh }));
    const user = renderPage();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('redirects away without ai_config:read', () => {
    setPermissions(['ai:use']);
    setUsage(withData);
    renderPage();

    expect(screen.queryByRole('heading', { level: 1, name: 'AI Usage' })).not.toBeInTheDocument();
  });

  describe('compact layout (360px)', () => {
    it('stacks the controls and renders every table as cards, never a wide grid', async () => {
      act(() => setViewportWidth(360));
      setUsage(withData);
      const user = renderPage();

      expect(screen.getByTestId('admin-ai-usage-breakdown-table')).toHaveAttribute('data-layout', 'mobile');
      await user.click(screen.getByRole('button', { name: 'Table' }));
      expect(screen.getByTestId('admin-ai-usage-daily-table')).toHaveAttribute('data-layout', 'mobile');
    });
  });
});
