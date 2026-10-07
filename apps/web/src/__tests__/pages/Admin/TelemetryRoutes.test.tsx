/**
 * The three admin telemetry routes render the PACKAGED pages
 * (`@marinoscar/platform-web/telemetry/ui`, marinoscar/EnterpriseAppBase#719)
 * inside this app's shell, through the real routes in `App.tsx`, the real
 * platform host and telemetry adapters, and the app's transport.
 *
 * The pages' own behaviour is tested in the package and, page by page, in
 * `Telemetry{Settings,Explorer,Dashboard}Page*.test.tsx`. What only this app
 * can prove is the binding: the routes, their permission and feature gates,
 * the shell around them, and that the dashboard draws this app's own `coach`
 * metric group (`apps/api/src/coach/telemetry/coach-metric-group.ts`) from
 * `/metric-groups` metadata alone: there is no coach dashboard component.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { mockAdminUser, mockUser } from '../../utils/test-utils';
import { mockTelemetryPublicConfigEnabled } from '../../mocks/fixtures/telemetry';
import {
  dashboardHandlers,
  mockDashboardMetricGroups,
  mockDashboardMetrics,
} from '../../mocks/fixtures/telemetryDashboard';
import App from '../../../App';

const API_BASE = '*/api';
const DASHBOARD_API = '*/api/admin/telemetry/dashboard';

/** The `coach` group exactly as `GET /metric-groups` lists it. */
const COACH_META = { id: 'coach', label: 'Coach', title: 'AI Coach', order: 70 };

function signInAs(user: typeof mockAdminUser) {
  server.use(http.get(`${API_BASE}/auth/me`, () => HttpResponse.json({ data: user })));
}

function telemetryOn() {
  server.use(http.get(`${API_BASE}/telemetry/config`, () => HttpResponse.json({ data: mockTelemetryPublicConfigEnabled })));
}

function serveDashboardWithCoach() {
  const coachRequests: URL[] = [];
  // Earlier handlers win: the coach overrides go before the fixture's set.
  server.use(
    http.get(`${DASHBOARD_API}/metric-groups`, () =>
      HttpResponse.json({ data: [...mockDashboardMetricGroups, COACH_META] }),
    ),
    http.get(`${DASHBOARD_API}/metrics`, ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('group') !== 'coach') return undefined;
      coachRequests.push(url);
      const tile = mockDashboardMetrics.queue.tiles[0]!;
      return HttpResponse.json({
        data: {
          ...mockDashboardMetrics.queue,
          group: 'coach',
          sql: ['SELECT /* coach */ 1'],
          tiles: [
            { ...tile, key: 'coachNudgesSent', label: 'Nudges sent', value: 12, previous: 9, unit: 'count' },
            { ...tile, key: 'coachGuardRejections', label: 'Content-guard rejections', value: 0.2, previous: 0, unit: 'per_min' },
          ],
          series: [],
          tables: [],
          skipped: ['coachFeedback'],
        },
      });
    }),
    ...dashboardHandlers(),
  );
  return coachRequests;
}

function visit(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const LOADED = { timeout: 8000 };

describe('the packaged telemetry pages in the app shell', () => {
  it('/admin/settings/telemetry renders the settings page inside the layout', async () => {
    signInAs(mockAdminUser);
    visit('/admin/settings/telemetry');

    const heading = await screen.findByRole('heading', { level: 1, name: 'Telemetry' }, LOADED);
    expect(screen.getByRole('main')).toContainElement(heading);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('/admin/settings/telemetry/explorer renders the explorer once telemetry is on', async () => {
    telemetryOn();
    signInAs(mockAdminUser);
    visit('/admin/settings/telemetry/explorer');

    const heading = await screen.findByRole('heading', { level: 1, name: 'Telemetry Explorer' }, LOADED);
    expect(screen.getByRole('main')).toContainElement(heading);
  });

  it('/admin/settings/telemetry/dashboard draws the coach group from metadata, after the platform sections', async () => {
    telemetryOn();
    signInAs(mockAdminUser);
    const coachRequests = serveDashboardWithCoach();
    visit('/admin/settings/telemetry/dashboard');

    const heading = await screen.findByRole('heading', { level: 1, name: 'Telemetry Dashboard' }, LOADED);
    expect(screen.getByRole('main')).toContainElement(heading);

    const coach = await screen.findByRole('region', { name: 'AI Coach' }, LOADED);
    expect(coach).toHaveAttribute('id', 'telemetry-section-coach');
    expect(await within(coach).findByText('Nudges sent', {}, LOADED)).toBeInTheDocument();
    expect(within(coach).getByText('Content-guard rejections')).toBeInTheDocument();
    expect(coachRequests.length).toBeGreaterThanOrEqual(1);
    expect(coachRequests[0]!.pathname).toBe('/api/admin/telemetry/dashboard/metrics');

    await waitFor(() => {
      const ids = screen
        .getAllByRole('region')
        .map((region) => region.getAttribute('data-testid'))
        .filter((id): id is string => id?.startsWith('panel-metrics-') ?? false);
      expect(ids.at(-1)).toBe('panel-metrics-coach');
    }, LOADED);
  });

  it('keeps a viewer without telemetry:query away from the dashboard', async () => {
    telemetryOn();
    signInAs(mockUser);
    const coachRequests = serveDashboardWithCoach();
    visit('/admin/settings/telemetry/dashboard');

    await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument(), LOADED);
    expect(screen.queryByRole('heading', { level: 1, name: 'Telemetry Dashboard' })).not.toBeInTheDocument();
    expect(coachRequests).toHaveLength(0);
  });
});
