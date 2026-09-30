/**
 * `useAgentRunUsage` / `useMonthlyAgentUsage` (E6.3) against the MSW network:
 * no read without a run or while disabled, one more read when the run
 * settles, and a slow answer for an older month never painted over a newer one.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useAgentRunUsage, useMonthlyAgentUsage } from '../../hooks/useAgentUsage';
import { mockMonthlyUsage, mockRunUsage } from '../mocks/fixtures/trainingUsage';

describe('useAgentRunUsage', () => {
  it('reads nothing without a run id', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/ai/training/runs/:runId/usage', () => {
        reads += 1;
        return HttpResponse.json({ data: mockRunUsage() });
      }),
    );
    const { result } = renderHook(() => useAgentRunUsage(null));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.usage).toBeNull();
    expect(reads).toBe(0);
  });

  it('reads once, and once more when the run settles', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/ai/training/runs/:runId/usage', () => {
        reads += 1;
        return HttpResponse.json({ data: mockRunUsage({ status: reads === 1 ? 'running' : 'succeeded' }) });
      }),
    );
    const { result, rerender } = renderHook(({ settled }) => useAgentRunUsage('run-1', { settled }), {
      initialProps: { settled: false },
    });
    await waitFor(() => expect(result.current.usage?.status).toBe('running'));
    rerender({ settled: true });
    await waitFor(() => expect(result.current.usage?.status).toBe('succeeded'));
    expect(reads).toBe(2);
  });

  it('flags a 404', async () => {
    server.use(
      http.get('*/api/ai/training/runs/:runId/usage', () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: 'Run not found' }, { status: 404 }),
      ),
    );
    const { result } = renderHook(() => useAgentRunUsage('run-x'));
    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.usage).toBeNull();
  });
});

describe('useMonthlyAgentUsage', () => {
  it('reads nothing while disabled', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/ai/training/usage', () => {
        reads += 1;
        return HttpResponse.json({ data: mockMonthlyUsage() });
      }),
    );
    const { result } = renderHook(() => useMonthlyAgentUsage(undefined, { enabled: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(reads).toBe(0);
  });

  it('drops a slow answer for a month that is no longer asked for', async () => {
    server.use(
      http.get('*/api/ai/training/usage', async ({ request }) => {
        const month = new URL(request.url).searchParams.get('month') ?? '';
        if (month === '2026-08') await delay(80);
        return HttpResponse.json({ data: mockMonthlyUsage({ month }) });
      }),
    );
    const { result, rerender } = renderHook(({ month }) => useMonthlyAgentUsage(month), {
      initialProps: { month: '2026-08' },
    });
    rerender({ month: '2026-07' });
    await waitFor(() => expect(result.current.report?.month).toBe('2026-07'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(result.current.report?.month).toBe('2026-07');
  });
});
