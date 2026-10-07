/**
 * Telemetry Dashboard infrastructure sections (issue #602; API #601):
 * the six `/metrics` sections below the application panels, the Host filter
 * (sent to `/metrics` only), verdict reasons linking to their section, and
 * each section's "Open in Explorer" / "Ask assistant". Wire-level against MSW
 * with `mocks/fixtures/telemetryDashboard.ts`, where `pipeline` is not
 * available.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { Route, Routes, useLocation } from 'react-router-dom';
import { server } from '../../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../../setup';
import { render, mockAdminUser } from '../../utils/test-utils';
import {
  dashboardHandlers,
  mockDashboardMetricGroups,
  mockDashboardMetrics,
  mockDashboardSummary,
} from '../../mocks/fixtures/telemetryDashboard';
import TelemetryDashboardPage from '@marinoscar/platform-web/telemetry/ui/dashboard-page';

const API = '*/api/admin/telemetry/dashboard';
const DASHBOARD = '/admin/settings/telemetry/dashboard';
const EXPLORER = '/admin/settings/telemetry/explorer';

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{JSON.stringify({ search: location.search, state: location.state ?? null })}</output>;
}

function renderPage(options: { search?: string; aiEnabled?: boolean } = {}) {
  return render(
    <Routes>
      <Route
        path={DASHBOARD}
        element={
          <>
            <TelemetryDashboardPage />
            <Probe />
          </>
        }
      />
      <Route path={EXPLORER} element={<Probe />} />
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

function probe(): { search: string; state: { sql?: string } | null } {
  return JSON.parse(screen.getByTestId('location').textContent ?? '{}');
}

function recordRequests(): URL[] {
  const urls: URL[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.url.includes('/admin/telemetry/dashboard/')) urls.push(new URL(request.url));
  });
  return urls;
}

/**
 * The last section's table appears after two round trips (`/metric-groups`,
 * then its `/metrics`, #680) and six section renders: allow for a loaded runner.
 */
const SECTIONS_LOADED = { timeout: 5_000 };

const SECTION_TITLES = ['Infrastructure', 'Database', 'Job queue', 'Worker nodes', 'Uptime & dependencies'];

describe('TelemetryDashboardPage infrastructure sections (#602)', () => {
  beforeEach(() => {
    server.use(...dashboardHandlers());
  });

  afterEach(() => {
    server.events.removeAllListeners();
    act(() => resetViewportWidth());
  });

  it('renders one section per available group, below the application panels, in order', async () => {
    renderPage();
    for (const title of SECTION_TITLES) {
      expect(await screen.findByRole('region', { name: title })).toBeInTheDocument();
    }
    // Wait for every section's data, then check order against the events feed.
    await screen.findByRole('table', { name: 'Uptime targets' }, SECTIONS_LOADED);
    const regions = screen.getAllByRole('region').map((region) => region.getAttribute('data-testid'));
    const events = regions.indexOf('panel-events');
    expect(regions.slice(events + 1)).toEqual([
      'panel-metrics-host',
      'panel-metrics-database',
      'panel-metrics-queue',
      'panel-metrics-nodes',
      'panel-metrics-uptime',
    ]);
    // The pipeline group is not collected: its section is hidden, and one line says so.
    expect(screen.queryByRole('region', { name: 'Telemetry pipeline' })).not.toBeInTheDocument();
    expect(await screen.findByTestId('metrics-not-collected')).toHaveTextContent(
      'Not collected in this telemetry store: Telemetry pipeline.',
    );
  });

  it('fetches each group separately, with the window and filters', async () => {
    const urls = recordRequests();
    renderPage({ search: '?range=6h&service=my-app-api' });
    await screen.findByRole('table', { name: 'Uptime targets' }, SECTIONS_LOADED);
    const metrics = urls.filter((url) => url.pathname.endsWith('/metrics'));
    expect(new Set(metrics.map((url) => url.searchParams.get('group')))).toEqual(
      new Set(['host', 'database', 'queue', 'nodes', 'uptime', 'pipeline']),
    );
    for (const url of metrics) {
      expect(url.searchParams.get('range')).toBe('6h');
      expect(url.searchParams.get('service')).toBe('my-app-api');
    }
  });

  it('a failing group shows its own error and retries alone', async () => {
    let fail = true;
    server.use(
      http.get(`${API}/metrics`, ({ request }) => {
        if (new URL(request.url).searchParams.get('group') === 'database' && fail) {
          return HttpResponse.json(
            { code: 'BAD_GATEWAY', message: 'The metric statement failed', details: { reason: 'TELEMETRY_QUERY_FAILED' } },
            { status: 502 },
          );
        }
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderPage();
    const database = await screen.findByRole('region', { name: 'Database' });
    expect(await within(database).findByText('The metric statement failed')).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Job types' })).toBeInTheDocument();

    fail = false;
    await user.click(within(database).getByRole('button', { name: 'Retry' }));
    expect(await within(database).findByRole('table', { name: 'Largest tables' })).toBeInTheDocument();
  });

  describe('Host filter', () => {
    it('offers the /filters hosts and sends the choice to /metrics only', async () => {
      const urls = recordRequests();
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole('table', { name: 'Uptime targets' }, SECTIONS_LOADED);

      await user.click(screen.getByRole('combobox', { name: 'Host' }));
      await user.click(await screen.findByRole('option', { name: 'vps-2' }));
      await waitFor(() => expect(new URLSearchParams(probe().search).get('host')).toBe('vps-2'));

      await waitFor(() =>
        expect(urls.some((url) => url.pathname.endsWith('/metrics') && url.searchParams.get('host') === 'vps-2')).toBe(true),
      );
      const others = urls.filter((url) => !url.pathname.endsWith('/metrics'));
      expect(others.length).toBeGreaterThan(0);
      expect(others.every((url) => !url.searchParams.has('host'))).toBe(true);
    });

    it('reads the host from the URL', async () => {
      const urls = recordRequests();
      renderPage({ search: '?host=vps-1' });
      await screen.findByRole('table', { name: 'Uptime targets' }, SECTIONS_LOADED);
      const metrics = urls.filter((url) => url.pathname.endsWith('/metrics'));
      expect(metrics.every((url) => url.searchParams.get('host') === 'vps-1')).toBe(true);
      expect(screen.getByRole('combobox', { name: 'Host' })).toHaveTextContent('vps-1');
    });

    it('is not offered while the store has no host metrics', async () => {
      server.use(
        http.get(`${API}/filters`, () =>
          HttpResponse.json({
            data: { range: mockDashboardSummary.range, generatedAt: '', truncated: false, sql: [], services: [], instances: [], hosts: [] },
          }),
        ),
      );
      renderPage();
      await screen.findByRole('combobox', { name: 'Service' });
      expect(screen.queryByRole('combobox', { name: 'Host' })).not.toBeInTheDocument();
    });

    it('sits in the phone Filters dialog and applies with the draft', async () => {
      act(() => setViewportWidth(390));
      const user = userEvent.setup();
      renderPage();
      await screen.findByTestId('phone-filter-bar');
      // Wait for /filters to answer before opening the dialog.
      await screen.findByRole('table', { name: 'Uptime targets' }, SECTIONS_LOADED);
      await user.click(screen.getByRole('button', { name: 'Filters' }));
      const dialog = await screen.findByRole('dialog', { name: 'Filters' });
      await user.click(within(dialog).getByRole('combobox', { name: 'Host' }));
      await user.click(await screen.findByRole('option', { name: 'vps-1' }));
      expect(new URLSearchParams(probe().search).has('host')).toBe(false);
      await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
      await waitFor(() => expect(new URLSearchParams(probe().search).get('host')).toBe('vps-1'));
    });
  });

  describe('verdict reasons', () => {
    beforeEach(() => {
      server.use(
        http.get(`${API}/summary`, () =>
          HttpResponse.json({
            data: {
              ...mockDashboardSummary,
              verdict: {
                level: 'critical',
                reasons: [
                  '5xx rate 3.2% (> 2%)',
                  'Disk 91.2% full (≥ 85%) — mountpoint: /',
                  'Collector failed to export 12 points (3% of attempted) — exporter: otlphttp',
                ],
              },
            },
          }),
        ),
      );
    });

    it('link to the section they are about, when it is on screen', async () => {
      const user = userEvent.setup();
      renderPage();
      const verdict = await screen.findByTestId('verdict-banner');
      await screen.findByRole('table', { name: 'Filesystems' });
      const link = await within(verdict).findByRole('button', { name: 'Show Infrastructure' });
      // The traffic rule and the hidden pipeline section get no link.
      expect(within(verdict).getAllByRole('button', { name: /^Show / })).toHaveLength(1);

      await user.click(link);
      expect(screen.getByRole('region', { name: 'Infrastructure' })).toHaveFocus();
    });
  });

  describe('panel actions', () => {
    it('Open in Explorer hands over the group\'s first statement, loaded not run', async () => {
      const user = userEvent.setup();
      renderPage();
      const queue = await screen.findByRole('region', { name: 'Job queue' });
      const action = within(queue).getByRole('button', { name: 'Open in Explorer' });
      await waitFor(() => expect(action).toBeEnabled());
      await user.click(action);
      await waitFor(() => expect(probe().state?.sql).toBe(mockDashboardMetrics.queue.sql[0]));
    });

    it('Ask assistant prefills a question about the section', async () => {
      const user = userEvent.setup();
      renderPage({ aiEnabled: true, search: '?host=vps-1' });
      const uptime = await screen.findByRole('region', { name: 'Uptime & dependencies' });
      const ask = within(uptime).getByRole('button', { name: 'Ask assistant' });
      await waitFor(() => expect(ask).toBeEnabled());
      await user.click(ask);

      await screen.findByLabelText('Telemetry assistant');
      const question = (screen.getByRole('textbox', { name: 'Ask the assistant' }) as HTMLTextAreaElement).value;
      expect(question.split('\n')[0]).toBe('Investigate "Uptime & dependencies" for the last hour (host vps-1).');
      expect(question).toContain('https://app.example.com/ — Duration 84 ms');
    });
  });

  describe('sections from /metric-groups (#680)', () => {
    it('asks for the section list once, with the initial requests', async () => {
      const urls = recordRequests();
      renderPage();
      await screen.findByRole('table', { name: 'Uptime targets' }, SECTIONS_LOADED);
      expect(urls.filter((url) => url.pathname.endsWith('/metric-groups'))).toHaveLength(1);
    });

    it('renders an extra section for a seventh group, in its order, with its own title and request', async () => {
      server.use(
        http.get(`${API}/metric-groups`, () =>
          HttpResponse.json({
            data: [...mockDashboardMetricGroups, { id: 'coach', label: 'Coach', title: 'Coaching', order: 70 }],
          }),
        ),
        http.get(`${API}/metrics`, ({ request }) => {
          if (new URL(request.url).searchParams.get('group') !== 'coach') return undefined;
          return HttpResponse.json({
            data: {
              ...mockDashboardMetrics.queue,
              group: 'coach',
              sql: ['SELECT /* coach */ 1'],
              tiles: [{ ...mockDashboardMetrics.queue.tiles[0]!, key: 'coachNudges', label: 'Nudges sent' }],
              tables: [{ ...mockDashboardMetrics.queue.tables[0]!, key: 'coachPersonas', label: 'Personas' }],
            },
          });
        }),
      );
      const urls = recordRequests();
      renderPage();

      const coach = await screen.findByRole('region', { name: 'Coaching' });
      expect(coach).toHaveAttribute('id', 'telemetry-section-coach');
      expect(await within(coach).findByRole('table', { name: 'Personas' })).toBeInTheDocument();
      await screen.findByRole('table', { name: 'Uptime targets' }, SECTIONS_LOADED);

      const regions = screen.getAllByRole('region').map((region) => region.getAttribute('data-testid'));
      expect(regions.slice(regions.indexOf('panel-events') + 1)).toEqual([
        'panel-metrics-host',
        'panel-metrics-database',
        'panel-metrics-queue',
        'panel-metrics-nodes',
        'panel-metrics-uptime',
        'panel-metrics-coach',
      ]);
      expect(urls.some((url) => url.pathname.endsWith('/metrics') && url.searchParams.get('group') === 'coach')).toBe(true);
    });

    it('renders the sections in `order`, whatever order the list arrives in', async () => {
      server.use(
        http.get(`${API}/metric-groups`, () => HttpResponse.json({ data: [...mockDashboardMetricGroups].reverse() })),
      );
      renderPage();
      await screen.findByRole('table', { name: 'Uptime targets' }, SECTIONS_LOADED);
      const regions = screen.getAllByRole('region').map((region) => region.getAttribute('data-testid'));
      expect(regions.slice(regions.indexOf('panel-events') + 1)).toEqual([
        'panel-metrics-host',
        'panel-metrics-database',
        'panel-metrics-queue',
        'panel-metrics-nodes',
        'panel-metrics-uptime',
      ]);
    });

    it('shows the panel skeleton while the list loads', async () => {
      server.use(
        http.get(`${API}/metric-groups`, async () => {
          await delay(200);
          return HttpResponse.json({ data: mockDashboardMetricGroups });
        }),
      );
      renderPage();
      expect(await screen.findByTestId('panel-metric-groups-skeleton')).toBeInTheDocument();
      expect(await screen.findByRole('region', { name: 'Infrastructure' })).toBeInTheDocument();
      expect(screen.queryByTestId('panel-metric-groups')).not.toBeInTheDocument();
    });

    it('a failed list shows a panel error with Retry, and the rest of the dashboard stays', async () => {
      let fail = true;
      server.use(
        http.get(`${API}/metric-groups`, () =>
          fail
            ? HttpResponse.json({ code: 'INTERNAL_ERROR', message: 'Could not list the sections' }, { status: 500 })
            : HttpResponse.json({ data: mockDashboardMetricGroups }),
        ),
      );
      const user = userEvent.setup();
      renderPage();

      const panel = await screen.findByTestId('panel-metric-groups');
      expect(await within(panel).findByText('Could not list the sections')).toBeInTheDocument();
      expect(screen.getByTestId('panel-events')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Infrastructure' })).not.toBeInTheDocument();

      fail = false;
      await user.click(within(panel).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('region', { name: 'Infrastructure' })).toBeInTheDocument();
      expect(await screen.findByRole('table', { name: 'Uptime targets' }, SECTIONS_LOADED)).toBeInTheDocument();
    });
  });
});
