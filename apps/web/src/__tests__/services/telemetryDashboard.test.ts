/**
 * The dashboard's `/metrics` and `/filters` wire contract (issue #127, API
 * #126): the query each call sends, asserted against MSW.
 */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  dashboardSearchParams,
  getDashboardFilters,
  getDashboardMetrics,
} from '../../services/telemetryDashboard';
import { mockDashboardFilters, mockDashboardMetrics } from '../mocks/fixtures/telemetryDashboard';

const API = '*/api/admin/telemetry/dashboard';

function captureUrls(path: string, data: unknown): URL[] {
  const urls: URL[] = [];
  server.use(
    http.get(`${API}${path}`, ({ request }) => {
      urls.push(new URL(request.url));
      return HttpResponse.json({ data });
    }),
  );
  return urls;
}

describe('telemetry dashboard service — metrics (#127)', () => {
  it('GETs one metric group with the window, filters and host', async () => {
    const urls = captureUrls('/metrics', mockDashboardMetrics.host);
    const result = await getDashboardMetrics('host', {
      range: '6h',
      service: 'api',
      instance: 'node-1',
      host: 'vps-1',
      buckets: '30',
    });
    expect(result).toEqual(mockDashboardMetrics.host);
    const params = urls[0].searchParams;
    expect(urls[0].pathname).toBe('/api/admin/telemetry/dashboard/metrics');
    expect(params.get('group')).toBe('host');
    expect(params.get('range')).toBe('6h');
    expect(params.get('service')).toBe('api');
    expect(params.get('instance')).toBe('node-1');
    expect(params.get('host')).toBe('vps-1');
    expect(params.get('buckets')).toBe('30');
  });

  it('sends from/to for a zoomed window and leaves absent filters out', async () => {
    const urls = captureUrls('/metrics', mockDashboardMetrics.queue);
    await getDashboardMetrics('queue', { from: '2026-09-27T10:00:00.000Z', to: '2026-09-27T10:30:00.000Z' });
    const params = urls[0].searchParams;
    expect(params.get('group')).toBe('queue');
    expect(params.get('from')).toBe('2026-09-27T10:00:00.000Z');
    expect(params.has('range')).toBe(false);
    expect(params.has('host')).toBe(false);
    expect(params.has('service')).toBe(false);
  });

  it('never sends an empty host', () => {
    expect(dashboardSearchParams({ range: '1h', host: '' }).has('host')).toBe(false);
  });

  it('reads the hosts /filters reports', async () => {
    captureUrls('/filters', mockDashboardFilters);
    const filters = await getDashboardFilters({ range: '1h' });
    expect(filters.hosts).toEqual(['vps-1', 'vps-2']);
  });
});
