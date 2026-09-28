/**
 * `/admin/settings/telemetry/dashboard` (issue #578, epic #576).
 *
 * Wire-level against MSW, with the five #577 endpoints mocked to their
 * contract (`mocks/fixtures/telemetryDashboard.ts`). Charts render under
 * jsdom's zero-size layout, so assertions target the panels' own text,
 * labels and requests rather than SVG internals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useLocation } from 'react-router-dom';
import { server } from '../../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../../setup';
import { render, mockAdminUser } from '../../utils/test-utils';
import {
  dashboardHandlers,
  mockDashboardEventsPage1,
} from '../../mocks/fixtures/telemetryDashboard';
import TelemetryDashboardPage from '../../../pages/Admin/TelemetryDashboardPage';

const API = '*/api/admin/telemetry/dashboard';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function renderPage(search = '') {
  return render(
    <>
      <TelemetryDashboardPage />
      <LocationProbe />
    </>,
    {
      wrapperOptions: {
        user: mockAdminUser,
        telemetryEnabled: true,
        route: `/admin/settings/telemetry/dashboard${search}`,
      },
    },
  );
}

/** Record every dashboard request URL (after the default handlers answer). */
function recordRequests(): URL[] {
  const urls: URL[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.url.includes('/admin/telemetry/dashboard/')) urls.push(new URL(request.url));
  });
  return urls;
}

const eventRequests = (urls: URL[]) => urls.filter((url) => url.pathname.endsWith('/events'));
const params = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '');

describe('TelemetryDashboardPage', () => {
  beforeEach(() => {
    server.use(...dashboardHandlers());
  });

  afterEach(() => {
    server.events.removeAllListeners();
    act(() => resetViewportWidth());
  });

  it('renders every panel from the API', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { level: 1, name: 'Telemetry Dashboard' })).toBeInTheDocument();
    const verdict = await screen.findByTestId('verdict-banner');
    expect(verdict).toHaveAttribute('role', 'status');
    expect(verdict).toHaveTextContent('Degraded');
    expect(verdict).toHaveTextContent('5xx rate 3.2% on GET /api/users/:id');

    expect(await screen.findByTestId('tile-requestsPerMin')).toHaveTextContent('12.5');
    expect(screen.getByTestId('tile-heapUsedBytes')).toHaveTextContent('128');
    // Change vs previous: 1.6 → 3.2 is up 100%, and up is bad for the 5xx rate.
    expect(within(screen.getByTestId('tile-errorRatePct')).getByLabelText('Up 100% vs previous window')).toBeInTheDocument();

    expect(await screen.findByRole('img', { name: /API requests per bucket/ })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /Log records per bucket by severity \(Error, Warn\)/ })).toBeInTheDocument();

    const routes = await screen.findByRole('table', { name: 'Top routes' });
    expect(within(routes).getByText('/api/users/:id')).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Top errors' })).toHaveTextContent('Database connection refused');

    const events = await screen.findByRole('table', { name: 'Recent events' });
    expect(within(events).getByText('Event number 0')).toBeInTheDocument();
    expect(within(events).getAllByText('Error').length).toBeGreaterThan(0);

    // The filter bar offers the services `/filters` reported.
    await userEvent.setup().click(screen.getByRole('combobox', { name: 'Service' }));
    expect(await screen.findByRole('option', { name: 'my-app-worker' })).toBeInTheDocument();
  });

  it('reads its state from the URL and writes changes back to it', async () => {
    const urls = recordRequests();
    const user = userEvent.setup();
    renderPage('?range=6h&service=my-app-api&sev=info,error&q=boom&refresh=off');

    await screen.findByRole('table', { name: 'Recent events' });
    const summary = urls.find((url) => url.pathname.endsWith('/summary'));
    expect(summary?.searchParams.get('range')).toBe('6h');
    expect(summary?.searchParams.get('service')).toBe('my-app-api');
    const events = eventRequests(urls)[0];
    expect(events.searchParams.get('severity')).toBe('error,info');
    expect(events.searchParams.get('q')).toBe('boom');
    expect(screen.getByRole('switch', { name: 'Auto-refresh' })).not.toBeChecked();
    expect(screen.getByRole('searchbox', { name: 'Search messages' })).toHaveValue('boom');

    await user.click(screen.getByRole('button', { name: 'Last 24 hours' }));
    await waitFor(() => expect(params().get('range')).toBe('24h'));
    // Everything else survives the round trip.
    expect(params().get('service')).toBe('my-app-api');
    expect(params().get('sev')).toBe('error,info');
    expect(params().get('q')).toBe('boom');
    expect(params().get('refresh')).toBe('off');
  });

  it('falls back to the defaults for invalid URL values', async () => {
    const urls = recordRequests();
    renderPage('?range=2y&sev=nope&from=not-a-date&to=2026-01-01T00:00:00Z');

    await screen.findByTestId('verdict-banner');
    const summary = urls.find((url) => url.pathname.endsWith('/summary'));
    expect(summary?.searchParams.get('range')).toBe('1h');
    expect(summary?.searchParams.has('from')).toBe(false);
    await waitFor(() => expect(eventRequests(urls)[0]?.searchParams.get('severity')).toBe('error,warn'));
  });

  it('shows a Reset zoom chip for a zoomed window and clears it', async () => {
    const urls = recordRequests();
    const user = userEvent.setup();
    const from = new Date(Date.now() - 20 * 60_000).toISOString();
    const to = new Date(Date.now() - 10 * 60_000).toISOString();
    renderPage(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

    await screen.findByTestId('verdict-banner');
    const summary = urls.find((url) => url.pathname.endsWith('/summary'));
    expect(summary?.searchParams.get('from')).toBe(from);
    expect(summary?.searchParams.has('range')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Reset zoom' }));
    await waitFor(() => expect(params().has('from')).toBe(false));
    expect(params().has('to')).toBe(false);
  });

  it('refetches events when a severity chip is toggled', async () => {
    const urls = recordRequests();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Recent events' });
    const before = eventRequests(urls).length;

    const chips = screen.getByRole('group', { name: 'Event severity filter' });
    const info = within(chips).getByRole('button', { name: 'Info' });
    expect(info).toHaveAttribute('aria-pressed', 'false');
    await user.click(info);

    await waitFor(() => expect(eventRequests(urls).length).toBeGreaterThan(before));
    expect(eventRequests(urls).at(-1)?.searchParams.get('severity')).toBe('error,warn,info');
    expect(params().get('sev')).toBe('error,warn,info');
    // The log timeline follows the same filter.
    expect(await screen.findByRole('img', { name: /severity \(Error, Warn, Info, Other\)/ })).toBeInTheDocument();
  });

  it('never lets the last severity be deselected', async () => {
    const user = userEvent.setup();
    renderPage('?sev=error');
    const chips = await screen.findByRole('group', { name: 'Event severity filter' });
    await user.click(within(chips).getByRole('button', { name: 'Error' }));
    expect(within(chips).getByRole('button', { name: 'Error' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('debounces the search before refetching', async () => {
    const urls = recordRequests();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Recent events' });
    const before = eventRequests(urls).length;

    await user.type(screen.getByRole('searchbox', { name: 'Search messages' }), 'timeout');
    // Typing alone fires nothing …
    expect(eventRequests(urls).length).toBe(before);
    // … one request with the whole term follows the pause.
    await waitFor(() => expect(eventRequests(urls).length).toBe(before + 1), { timeout: 2000 });
    expect(eventRequests(urls).at(-1)?.searchParams.get('q')).toBe('timeout');
    expect(params().get('q')).toBe('timeout');
  });

  it('appends the next page on Load more, passing the cursor', async () => {
    const urls = recordRequests();
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole('table', { name: 'Recent events' });
    expect(within(table).getAllByRole('button')).toHaveLength(mockDashboardEventsPage1.items.length);

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await within(table).findByText('Event number 2')).toBeInTheDocument();
    expect(within(table).getByText('Event number 0')).toBeInTheDocument();
    expect(eventRequests(urls).at(-1)?.searchParams.get('cursor')).toBe('cursor-2');
    // `nextCursor: null` — the last page.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('opens an event in a dialog and returns focus on close', async () => {
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole('table', { name: 'Recent events' });
    const row = within(table).getByRole('button', { name: 'Open event: Event number 1' });
    await user.click(row);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('event-body')).toHaveTextContent('Event number 1');
    expect(dialog).toHaveTextContent('trace-1');
    expect(dialog).toHaveTextContent('span-1');

    await user.click(within(dialog).getByRole('button', { name: 'Close event' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(row).toHaveFocus());
  });

  it('keeps every other panel working when one endpoint fails, and retries it alone', async () => {
    let fail = true;
    server.use(
      http.get(`${API}/top`, ({ request }) => {
        if (new URL(request.url).searchParams.get('kind') === 'routes' && fail) {
          return HttpResponse.json(
            { code: 'GATEWAY_TIMEOUT', message: 'The statement timed out', details: { reason: 'TELEMETRY_QUERY_TIMEOUT' } },
            { status: 504 },
          );
        }
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderPage();

    const routesPanel = await screen.findByTestId('panel-top-routes');
    expect(await within(routesPanel).findByText('The statement timed out')).toBeInTheDocument();
    expect(within(routesPanel).getByText('TELEMETRY_QUERY_TIMEOUT')).toBeInTheDocument();

    // Everything else rendered.
    expect(await screen.findByTestId('verdict-banner')).toHaveTextContent('Degraded');
    expect(await screen.findByRole('table', { name: 'Top errors' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Recent events' })).toBeInTheDocument();

    fail = false;
    await user.click(within(routesPanel).getByRole('button', { name: 'Retry' }));
    expect(await within(routesPanel).findByRole('table', { name: 'Top routes' })).toBeInTheDocument();
  });

  it('replaces the page with one Alert when the telemetry store is unreachable', async () => {
    server.use(
      http.get(`${API}/summary`, () =>
        HttpResponse.json(
          { code: 'SERVICE_UNAVAILABLE', message: 'GreptimeDB did not answer', details: { reason: 'TELEMETRY_UNREACHABLE' } },
          { status: 503 },
        ),
      ),
    );
    renderPage();

    const alert = await screen.findByTestId('telemetry-unavailable');
    expect(alert).toHaveTextContent('Telemetry store unreachable');
    expect(within(alert).getByRole('link', { name: 'Telemetry settings' })).toHaveAttribute(
      'href',
      '/admin/settings/telemetry',
    );
    expect(screen.queryByTestId('panel-events')).not.toBeInTheDocument();
  });

  describe('at phone width', () => {
    beforeEach(() => {
      act(() => setViewportWidth(390));
    });

    it('asks for 30 buckets and collapses the verdict to one expandable line', async () => {
      const urls = recordRequests();
      const user = userEvent.setup();
      renderPage();

      const verdict = await screen.findByTestId('verdict-banner');
      const toggle = within(verdict).getByRole('button', { expanded: false });
      expect(toggle).toHaveTextContent('Degraded · 5xx rate 3.2%');
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(within(verdict).getByText('p95 latency 1.4 s')).toBeVisible();

      const timeseries = urls.filter((url) => url.pathname.endsWith('/timeseries'));
      expect(timeseries.length).toBeGreaterThan(0);
      expect(timeseries.every((url) => url.searchParams.get('buckets') === '30')).toBe(true);
    });

    it('moves the filters into a full-screen dialog applied on Apply', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByTestId('phone-filter-bar');
      expect(screen.queryByRole('group', { name: 'Time range' })).not.toBeInTheDocument();

      const opener = screen.getByRole('button', { name: 'Filters' });
      await user.click(opener);
      const dialog = await screen.findByRole('dialog', { name: 'Filters' });

      await user.click(within(dialog).getByRole('combobox', { name: 'Range' }));
      await user.click(await screen.findByRole('option', { name: 'Last 7 days' }));
      // A draft: nothing is applied yet.
      expect(params().has('range')).toBe(false);

      await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
      await waitFor(() => expect(params().get('range')).toBe('7d'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(opener).toHaveFocus());
    });

    it('shows top problems as one card list with a Routes/Errors toggle', async () => {
      const user = userEvent.setup();
      renderPage();

      const panel = await screen.findByTestId('panel-top');
      expect(screen.queryByRole('table', { name: 'Top routes' })).not.toBeInTheDocument();
      expect(await within(panel).findByRole('list', { name: 'Top routes' })).toHaveTextContent('/api/users/:id');

      await user.click(within(panel).getByRole('button', { name: 'Errors' }));
      expect(await within(panel).findByRole('list', { name: 'Top errors' })).toHaveTextContent(
        'Database connection refused',
      );
    });

    it('shows events as a list whose rows open a full-screen detail', async () => {
      const user = userEvent.setup();
      renderPage();

      const list = await screen.findByRole('list', { name: 'Recent events' });
      expect(screen.queryByRole('table', { name: 'Recent events' })).not.toBeInTheDocument();
      await user.click(within(list).getByText('Event number 0'));

      const dialog = await screen.findByRole('dialog');
      expect(dialog.className).toMatch(/fullScreen/i);
      expect(dialog).toHaveTextContent('trace-0');
    });
  });

  describe('at tablet width', () => {
    it('hides the service column and moves filters into a popover', async () => {
      act(() => setViewportWidth(820));
      const user = userEvent.setup();
      renderPage();

      const table = await screen.findByRole('table', { name: 'Recent events' });
      expect(within(table).queryByRole('columnheader', { name: 'Service' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Filters' }));
      const popover = await screen.findByRole('dialog', { name: 'Filters' });
      expect(within(popover).getByRole('combobox', { name: 'Instance' })).toBeInTheDocument();
    });
  });
});
