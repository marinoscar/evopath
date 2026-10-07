/**
 * Telemetry Dashboard drill-down (issue #579, epic #576): the panel actions
 * ("Open in Explorer", "Ask assistant"), the events' "View trace" link and
 * the cross-links. Wire-level against MSW with the #577 fixtures; the explorer
 * route is a probe that shows what the dashboard handed it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { server } from '../../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../../setup';
import { render, mockAdminUser } from '../../utils/test-utils';
import {
  dashboardHandlers,
  mockDashboardApiSeries,
  mockDashboardEvent,
  mockDashboardEventsPage1,
  mockDashboardSummary,
  mockDashboardTopErrors,
  mockDashboardTopRoutes,
  mockUnknownRoutesTopSql,
} from '../../mocks/fixtures/telemetryDashboard';
import TelemetryDashboardPage from '@marinoscar/platform-web/telemetry/ui/dashboard-page';
import { http, HttpResponse } from 'msw';

const DASHBOARD = '/admin/settings/telemetry/dashboard';
const EXPLORER = '/admin/settings/telemetry/explorer';

function ExplorerProbe() {
  const location = useLocation();
  return (
    <output data-testid="explorer-probe">{JSON.stringify({ search: location.search, state: location.state ?? null })}</output>
  );
}

function handedSql(): string | null {
  const probe = JSON.parse(screen.getByTestId('explorer-probe').textContent ?? '{}') as {
    state: { sql?: string } | null;
  };
  return probe.state?.sql ?? null;
}

function renderPage(options: { aiEnabled?: boolean; search?: string } = {}) {
  return render(
    <Routes>
      <Route path={DASHBOARD} element={<TelemetryDashboardPage />} />
      <Route path={EXPLORER} element={<ExplorerProbe />} />
    </Routes>,
    {
      wrapperOptions: {
        user: mockAdminUser,
        telemetryEnabled: true,
        aiEnabled: options.aiEnabled ?? false,
        route: `${DASHBOARD}${options.search ?? ''}`,
      },
    },
  );
}

describe('TelemetryDashboardPage drill-down (#579)', () => {
  beforeEach(() => {
    server.use(...dashboardHandlers());
  });

  afterEach(() => {
    act(() => resetViewportWidth());
  });

  describe('Open in Explorer', () => {
    it.each([
      ['panel-tiles', (mockDashboardSummary.sql as string[])[0]],
      ['panel-api', mockDashboardApiSeries.sql as string],
      ['panel-top-routes', mockDashboardTopRoutes.sql as string],
      ['panel-top-errors', mockDashboardTopErrors.sql as string],
      ['panel-events', mockDashboardEventsPage1.sql as string],
      // #650: `unknownRoutes.sql[0]` (the per-route list), not the summary's primary.
      ['panel-unknown-routes', mockUnknownRoutesTopSql],
    ])('%s hands its API-reported SQL to the explorer', async (panelId, expected) => {
      const user = userEvent.setup();
      renderPage();
      const panel = await screen.findByTestId(panelId);
      const action = within(panel).getByRole('button', { name: 'Open in Explorer' });
      await waitFor(() => expect(action).toBeEnabled());

      await user.click(action);
      expect(await screen.findByTestId('explorer-probe')).toBeInTheDocument();
      expect(handedSql()).toBe(expected);
    });

    it('the log timeline hands over its SQL too', async () => {
      const user = userEvent.setup();
      renderPage();
      const panel = await screen.findByTestId('panel-logs');
      const action = within(panel).getByRole('button', { name: 'Open in Explorer' });
      await waitFor(() => expect(action).toBeEnabled());
      await user.click(action);
      expect(handedSql()).toBe('SELECT /* logs */ 1');
    });

    it('is disabled on the unknown-routes panel when the API sends no `unknownRoutes.sql`', async () => {
      const { sql: _absent, ...olderBlock } = mockDashboardSummary.unknownRoutes!;
      server.use(
        http.get('*/api/admin/telemetry/dashboard/summary', () =>
          HttpResponse.json({ data: { ...mockDashboardSummary, unknownRoutes: olderBlock } }),
        ),
      );
      renderPage();
      const panel = await screen.findByTestId('panel-unknown-routes');
      // The summary's own `sql` still lists the statements: they are never picked out of it.
      expect(within(panel).getByRole('button', { name: 'Open in Explorer' })).toBeDisabled();
    });

    it('is disabled until the panel has SQL to hand over', async () => {
      server.use(http.get('*/api/admin/telemetry/dashboard/timeseries', () => new Promise(() => {})));
      renderPage();
      const panel = await screen.findByTestId('panel-api');
      expect(within(panel).getByRole('button', { name: 'Open in Explorer' })).toBeDisabled();
    });

    it('on phones sits in the ⋮ menu of the active Top problems view', async () => {
      act(() => setViewportWidth(390));
      const user = userEvent.setup();
      renderPage();
      const panel = await screen.findByTestId('panel-top');
      await within(panel).findByRole('list', { name: 'Top routes' });
      await user.click(within(panel).getByRole('button', { name: 'Errors' }));
      await within(panel).findByRole('list', { name: 'Top errors' });

      await user.click(within(panel).getByRole('button', { name: 'Top problems actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Open in Explorer' }));
      expect(await screen.findByTestId('explorer-probe')).toBeInTheDocument();
      expect(handedSql()).toBe(mockDashboardTopErrors.sql);
    });
  });

  describe('Ask assistant', () => {
    function recordAssistantCalls(): string[] {
      const seen: string[] = [];
      server.events.on('request:start', ({ request }) => {
        if (request.url.includes('/admin/telemetry/assistant')) seen.push(request.url);
      });
      return seen;
    }

    afterEach(() => {
      server.events.removeAllListeners();
    });

    const question = () => screen.getByRole('textbox', { name: 'Ask the assistant' }) as HTMLTextAreaElement;

    it('is not offered while AI is off', async () => {
      renderPage({ aiEnabled: false });
      const panel = await screen.findByTestId('panel-api');
      expect(within(panel).getByRole('button', { name: 'Open in Explorer' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Ask assistant' })).not.toBeInTheDocument();
      expect(await screen.findByTestId('verdict-banner')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Explain this' })).not.toBeInTheDocument();
    });

    it('on desktop opens the docked drawer with the panel question prefilled, not sent', async () => {
      const calls = recordAssistantCalls();
      const user = userEvent.setup();
      renderPage({ aiEnabled: true });
      const panel = await screen.findByTestId('panel-top-errors');
      const ask = within(panel).getByRole('button', { name: 'Ask assistant' });
      await waitFor(() => expect(ask).toBeEnabled());

      await user.click(ask);
      const drawer = await screen.findByLabelText('Telemetry assistant');
      // Docked: a persistent drawer, not a modal dialog.
      expect(drawer).not.toHaveAttribute('role', 'dialog');
      expect(question().value.split('\n')).toEqual([
        'Investigate "Top errors" for the last hour (all services).',
        'Current state: "Database connection refused" (9).',
        'What is most likely causing this, and what should I check next?',
      ]);
      expect(calls).toHaveLength(0);

      // Asking about another panel re-seeds the question.
      await user.click(within(screen.getByTestId('panel-top-routes')).getByRole('button', { name: 'Ask assistant' }));
      await waitFor(() => expect(question().value).toContain('Investigate "Top failing routes"'));

      await user.click(within(drawer).getByRole('button', { name: 'Close assistant' }));
      await waitFor(() =>
        expect(within(screen.getByTestId('panel-top-routes')).getByRole('button', { name: 'Ask assistant' })).toHaveFocus(),
      );
      expect(calls).toHaveLength(0);
    });

    it('"Explain this" on the verdict prefills the verdict and its reasons', async () => {
      const user = userEvent.setup();
      renderPage({ aiEnabled: true, search: '?service=my-app-api' });
      const verdict = await screen.findByTestId('verdict-banner');
      await user.click(within(verdict).getByRole('button', { name: 'Explain this' }));

      await screen.findByLabelText('Telemetry assistant');
      expect(question().value.split('\n').slice(0, 2)).toEqual([
        'Investigate "Verdict" for the last hour (service my-app-api).',
        'Current state: Degraded — 5xx rate 3.2% on GET /api/users/:id; p95 latency 1.4 s; ' +
          '3 requests to unknown API routes (GET /api/coach/messages).',
      ]);
    });

    it('on tablets opens an overlay drawer that returns focus when dismissed', async () => {
      act(() => setViewportWidth(820));
      const user = userEvent.setup();
      renderPage({ aiEnabled: true });
      const panel = await screen.findByTestId('panel-api');
      const ask = within(panel).getByRole('button', { name: 'Ask assistant' });
      await waitFor(() => expect(ask).toBeEnabled());

      await user.click(ask);
      const drawer = await screen.findByRole('dialog', { name: 'Telemetry assistant' });
      expect((within(drawer).getByRole('textbox', { name: 'Ask the assistant' }) as HTMLTextAreaElement).value).toContain('Investigate "API requests"');

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Telemetry assistant' })).not.toBeInTheDocument());
      await waitFor(() => expect(ask).toHaveFocus());
    });

    it('on phones opens a full-screen dialog from the ⋮ menu and returns focus to ⋮', async () => {
      act(() => setViewportWidth(390));
      const user = userEvent.setup();
      renderPage({ aiEnabled: true });
      const panel = await screen.findByTestId('panel-top');
      await within(panel).findByRole('list', { name: 'Top routes' });

      const menuButton = within(panel).getByRole('button', { name: 'Top problems actions' });
      await user.click(menuButton);
      await user.click(await screen.findByRole('menuitem', { name: 'Ask assistant' }));

      const dialog = await screen.findByRole('dialog', { name: 'Assistant' });
      expect(dialog.className).toMatch(/fullScreen/i);
      expect((within(dialog).getByRole('textbox', { name: 'Ask the assistant' }) as HTMLTextAreaElement).value).toContain('Investigate "Top failing routes"');

      await user.click(within(dialog).getByRole('button', { name: 'Close assistant' }));
      // The page also renders the infrastructure sections (#602): under a
      // loaded full-suite run the exit transition can outlast the 1 s default.
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant' })).not.toBeInTheDocument(), {
        timeout: 5000,
      });
      await waitFor(() => expect(menuButton).toHaveFocus());
    });
  });

  describe('View trace', () => {
    const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

    beforeEach(() => {
      server.use(
        http.get('*/api/admin/telemetry/dashboard/events', () =>
          HttpResponse.json({
            data: {
              ...mockDashboardEventsPage1,
              items: [
                mockDashboardEvent(0, { traceId: TRACE, body: 'Traced event' }),
                mockDashboardEvent(1, { traceId: 'trace-1', body: 'Odd id event' }),
                mockDashboardEvent(2, { traceId: null, body: 'Untraced event' }),
              ],
              nextCursor: null,
            },
          }),
        ),
      );
    });

    it('opens the trace in the explorer with the one browser-built statement', async () => {
      const user = userEvent.setup();
      renderPage();
      const table = await screen.findByRole('table', { name: 'Recent events' });
      await user.click(within(table).getByRole('button', { name: 'Open event: Traced event' }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'View trace' }));
      expect(await screen.findByTestId('explorer-probe')).toBeInTheDocument();
      expect(handedSql()).toBe(
        `SELECT * FROM opentelemetry_traces WHERE trace_id = '${TRACE}' ORDER BY "timestamp" LIMIT 1000`,
      );
    });

    it.each(['Odd id event', 'Untraced event'])('offers no link for %s', async (body) => {
      const user = userEvent.setup();
      renderPage();
      const table = await screen.findByRole('table', { name: 'Recent events' });
      await user.click(within(table).getByRole('button', { name: `Open event: ${body}` }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('event-body')).toHaveTextContent(body);
      expect(within(dialog).queryByRole('button', { name: 'View trace' })).not.toBeInTheDocument();
    });
  });

  describe('Explorer cross-link', () => {
    it('links to the Telemetry Explorer from the header', async () => {
      const user = userEvent.setup();
      renderPage();
      const link = await screen.findByRole('link', { name: 'Explorer' });
      expect(link).toHaveAttribute('href', EXPLORER);
      await user.click(link);
      // A plain navigation: nothing handed over.
      expect(await screen.findByTestId('explorer-probe')).toBeInTheDocument();
      expect(handedSql()).toBeNull();
    });

    it('is a labelled 44px icon link on phones', async () => {
      act(() => setViewportWidth(390));
      renderPage();
      const link = await screen.findByRole('link', { name: 'Open Telemetry Explorer' });
      expect(link).toHaveAttribute('href', EXPLORER);
      expect(link).toHaveStyle({ width: '44px', height: '44px' });
    });
  });
});
