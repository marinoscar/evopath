/**
 * `useAiUsage` / `useMyAiUsage` (#444) against the MSW network.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useAiUsage, useMyAiUsage } from '../../hooks/useAiUsage';
import { mockAiUsageEmpty, mockAiUsageReport } from '../mocks/fixtures/ai';
import type { AiUsageQuery } from '../../services/ai';

const RANGE = { from: '2026-08-28', to: '2026-09-26' };

describe('useAiUsage', () => {
  it('starts loading, then holds the report for the grouping asked for', async () => {
    const { result } = renderHook(() => useAiUsage({ groupBy: 'user', ...RANGE }));
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.report).toEqual(mockAiUsageReport('user'));
    expect(result.current.error).toBeNull();
  });

  it('sends the range, the grouping and every filter as query parameters', async () => {
    const urls: URL[] = [];
    server.use(
      http.get('*/api/admin/ai/usage', ({ request }) => {
        urls.push(new URL(request.url));
        return HttpResponse.json({ data: mockAiUsageReport('model') });
      }),
    );
    const { result } = renderHook(() =>
      useAiUsage({ groupBy: 'model', ...RANGE, userId: 'user-dana', provider: 'openai', model: '' }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(urls).toHaveLength(1);
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({
      groupBy: 'model',
      from: '2026-08-28',
      to: '2026-09-26',
      userId: 'user-dana',
      provider: 'openai',
      // A blank filter is omitted, never sent as `model=`.
    });
  });

  it('reports a failure as the hook error and clears the report', async () => {
    server.use(
      http.get('*/api/admin/ai/usage', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'Insufficient permissions' }, { status: 403 }),
      ),
    );
    const { result } = renderHook(() => useAiUsage({ groupBy: 'day', ...RANGE }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Insufficient permissions');
    expect(result.current.report).toBeNull();
  });

  it('re-fetches when the query changes, not when an equal query object is re-created', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/admin/ai/usage', ({ request }) => {
        calls += 1;
        const groupBy = new URL(request.url).searchParams.get('groupBy') as 'day' | 'user';
        return HttpResponse.json({ data: mockAiUsageReport(groupBy) });
      }),
    );
    const { result, rerender } = renderHook((query: AiUsageQuery) => useAiUsage(query), {
      initialProps: { groupBy: 'day', ...RANGE },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(calls).toBe(1);

    rerender({ groupBy: 'day', ...RANGE });
    await act(async () => {});
    expect(calls).toBe(1);

    rerender({ groupBy: 'user', ...RANGE });
    await waitFor(() => expect(result.current.report?.groupBy).toBe('user'));
    expect(calls).toBe(2);
  });

  it('drops a slow earlier response that lands after a newer one', async () => {
    server.use(
      http.get('*/api/admin/ai/usage', async ({ request }) => {
        const from = new URL(request.url).searchParams.get('from');
        if (from === 'slow') {
          await delay(80);
          return HttpResponse.json({ data: mockAiUsageReport('day') });
        }
        return HttpResponse.json({ data: mockAiUsageEmpty('day') });
      }),
    );
    const { result, rerender } = renderHook((query: AiUsageQuery) => useAiUsage(query), {
      initialProps: { groupBy: 'day', from: 'slow', to: RANGE.to },
    });
    rerender({ groupBy: 'day', from: 'fast', to: RANGE.to });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await delay(120);
    });
    expect(result.current.report).toEqual(mockAiUsageEmpty('day'));
  });

  it('refresh re-reads the report', async () => {
    const { result } = renderHook(() => useAiUsage({ groupBy: 'day', ...RANGE }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    server.use(http.get('*/api/admin/ai/usage', () => HttpResponse.json({ data: mockAiUsageEmpty('day') })));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.report).toEqual(mockAiUsageEmpty('day'));
  });
});

describe('useMyAiUsage', () => {
  it('reads the caller-scoped route, never the admin one', async () => {
    const paths: string[] = [];
    server.use(
      http.get('*/api/ai/usage/me', ({ request }) => {
        const url = new URL(request.url);
        paths.push(`${url.pathname}?${url.searchParams.toString()}`);
        return HttpResponse.json({ data: mockAiUsageReport('model') });
      }),
      http.get('*/api/admin/ai/usage', () => {
        paths.push('admin');
        return HttpResponse.json({ data: mockAiUsageReport('model') });
      }),
    );
    const { result } = renderHook(() => useMyAiUsage({ groupBy: 'model', ...RANGE }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(paths).toEqual(['/api/ai/usage/me?groupBy=model&from=2026-08-28&to=2026-09-26']);
    expect(result.current.report?.series.map((row) => row.key)).toEqual(['gpt-5-mini', 'gpt-5']);
  });

  it('reports AI being switched off as the hook error', async () => {
    server.use(
      http.get('*/api/ai/usage/me', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'AI is disabled', details: { reason: 'AI_DISABLED' } },
          { status: 403 },
        ),
      ),
    );
    const { result } = renderHook(() => useMyAiUsage({ groupBy: 'model', ...RANGE }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('AI is disabled');
  });
});
