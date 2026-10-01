/**
 * `useHealthSummary` against the MSW network: load, no request when
 * disabled, consent and refresh replacing the view, a 409 reaching the
 * caller unchanged, and re-reading while a summary is being written.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useHealthSummary } from '../../hooks/useHealthSummary';
import { ApiError } from '../../services/api';
import { mockHealthSummaryEnabled, mockHealthSummaryView } from '../mocks/fixtures/healthSummary';

describe('useHealthSummary', () => {
  it('loads the view', async () => {
    const { result } = renderHook(() => useHealthSummary());
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.view).toEqual(mockHealthSummaryView());
    expect(result.current.error).toBeNull();
  });

  it('makes no request when disabled', async () => {
    let requested = false;
    server.use(
      http.get('*/api/ai/training/health-summary', () => {
        requested = true;
        return HttpResponse.json({ data: mockHealthSummaryView() });
      }),
    );
    const { result } = renderHook(() => useHealthSummary({ enabled: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.view).toBeNull();
    expect(requested).toBe(false);
  });

  it('reports a failed load', async () => {
    server.use(
      http.get('*/api/ai/training/health-summary', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'AI is off' }, { status: 403 }),
      ),
    );
    const { result } = renderHook(() => useHealthSummary());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('AI is off');
  });

  it('replaces the view with the consent answer', async () => {
    const { result } = renderHook(() => useHealthSummary({ pollMs: 60_000 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(() => result.current.setConsent(true));
    expect(result.current.view?.enabled).toBe(true);
  });

  it('rejects a refused refresh with the ApiError and its reason', async () => {
    server.use(
      http.post('*/api/ai/training/health-summary/refresh', () =>
        HttpResponse.json(
          { code: 'CONFLICT', message: 'No data', details: { reason: 'HEALTH_SUMMARY_NO_DATA' } },
          { status: 409 },
        ),
      ),
    );
    const { result } = renderHook(() => useHealthSummary());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const error = await result.current.refresh().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).details).toEqual({ reason: 'HEALTH_SUMMARY_NO_DATA' });
  });

  it('re-reads the view while a summary is pending, then stops', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/ai/training/health-summary', () => {
        reads += 1;
        return HttpResponse.json({
          data: reads < 2 ? mockHealthSummaryEnabled({ pending: true }) : mockHealthSummaryEnabled(),
        });
      }),
    );
    const { result } = renderHook(() => useHealthSummary({ pollMs: 20 }));
    await waitFor(() => expect(result.current.view?.pending).toBe(false));
    expect(reads).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reads).toBe(2);
  });
});
