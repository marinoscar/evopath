/**
 * `useDashboardMetrics` (issue #127): one independent request per group on
 * the page's shared tick — keeps the last good result while refreshing, and
 * reports a failure (with the API's reason) without dropping that result.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useDashboardMetrics } from '../../hooks/useTelemetryDashboard';
import { mockDashboardMetrics } from '../mocks/fixtures/telemetryDashboard';
import type { DashboardMetricGroup, DashboardMetricsQuery } from '../../services/telemetryDashboard';

const METRICS = '*/api/admin/telemetry/dashboard/metrics';

function recordMetrics(respond?: (url: URL) => Response | undefined): URL[] {
  const urls: URL[] = [];
  server.use(
    http.get(METRICS, ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      const custom = respond?.(url);
      if (custom) return custom;
      const group = url.searchParams.get('group') as DashboardMetricGroup;
      return HttpResponse.json({ data: mockDashboardMetrics[group] });
    }),
  );
  return urls;
}

describe('useDashboardMetrics', () => {
  it('fetches its group with the query and reports the result', async () => {
    const urls = recordMetrics();
    const query: DashboardMetricsQuery = { range: '1h', host: 'vps-1' };
    const { result } = renderHook(() => useDashboardMetrics('database', query, 0));

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.group).toBe('database');
    expect(result.current.isLoading).toBe(false);
    expect(urls[0].searchParams.get('group')).toBe('database');
    expect(urls[0].searchParams.get('host')).toBe('vps-1');
  });

  it('refetches on a tick and keeps the last good data while refreshing', async () => {
    const urls = recordMetrics();
    const query: DashboardMetricsQuery = { range: '1h' };
    const { result, rerender } = renderHook(({ tick }) => useDashboardMetrics('host', query, tick), {
      initialProps: { tick: 0 },
    });
    await waitFor(() => expect(result.current.data).not.toBeNull());

    rerender({ tick: 1 });
    expect(result.current.isRefreshing).toBe(true);
    expect(result.current.data?.group).toBe('host');
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(urls).toHaveLength(2);
  });

  it('reports a failure with its reason and retries on reload', async () => {
    let fail = true;
    recordMetrics(() =>
      fail
        ? HttpResponse.json(
            { code: 'GATEWAY_TIMEOUT', message: 'The statement timed out', details: { reason: 'TELEMETRY_QUERY_TIMEOUT' } },
            { status: 504 },
          )
        : undefined,
    );
    const query: DashboardMetricsQuery = { range: '1h' };
    const { result } = renderHook(() => useDashboardMetrics('queue', query, 0));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.reason).toBe('TELEMETRY_QUERY_TIMEOUT');
    expect(result.current.data).toBeNull();

    fail = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data?.group).toBe('queue'));
    expect(result.current.error).toBeNull();
  });
});
