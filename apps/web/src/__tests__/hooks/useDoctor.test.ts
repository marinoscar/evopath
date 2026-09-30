/**
 * `useDoctor` — issue #634.
 *
 * The house fetch-hook contract, plus the Doctor's one contract of its own:
 * a report whose verdict is `fail` is a SUCCESSFUL read, never `error`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { renderHook, waitFor, act } from '@testing-library/react';
import { server } from '../mocks/server';
import { useDoctor } from '../../hooks/useDoctor';
import { api } from '../../services/api';
import type { DoctorReport } from '../../services/doctor';

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    verdict: 'pass',
    generatedAt: '2026-09-30T12:00:00.000Z',
    durationMs: 120,
    checks: [
      {
        id: 'core.database',
        category: 'core',
        label: 'Database',
        settingsPath: null,
        status: 'pass',
        detail: 'PostgreSQL answered in 3 ms',
        remedy: null,
        error: null,
        data: null,
        durationMs: 3,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  api.setAccessToken(null);
});

describe('useDoctor', () => {
  it('loads on mount without refresh, and resolves to the report', async () => {
    const urls: URL[] = [];
    server.use(
      http.get('*/api/admin/doctor', ({ request }) => {
        urls.push(new URL(request.url));
        return HttpResponse.json({ data: report() });
      }),
    );
    const { result } = renderHook(() => useDoctor());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.report).toBeNull();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.report?.checks).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(urls).toHaveLength(1);
    expect(urls[0].searchParams.get('refresh')).toBeNull();
  });

  it('treats a failing verdict as data, not as an error', async () => {
    server.use(
      http.get('*/api/admin/doctor', () =>
        HttpResponse.json({ data: report({ verdict: 'fail' }) }),
      ),
    );
    const { result } = renderHook(() => useDoctor());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.report?.verdict).toBe('fail');
    expect(result.current.error).toBeNull();
  });

  it('names a 403 explicitly', async () => {
    server.use(
      http.get('*/api/admin/doctor', () =>
        HttpResponse.json({ message: 'Insufficient permissions' }, { status: 403 }),
      ),
    );
    const { result } = renderHook(() => useDoctor());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('You do not have permission to run the Doctor');
    expect(result.current.report).toBeNull();
  });

  it('falls back to a readable message on a network failure', async () => {
    server.use(http.get('*/api/admin/doctor', () => HttpResponse.error()));
    const { result } = renderHook(() => useDoctor());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Failed to run the Doctor checks');
  });

  it('reruns with refresh=true, adopts the new report and clears a previous error', async () => {
    server.use(
      http.get('*/api/admin/doctor', () => HttpResponse.json({ message: 'Boom' }, { status: 500 })),
    );
    const { result } = renderHook(() => useDoctor());
    await waitFor(() => expect(result.current.error).toBe('Boom'));

    const urls: URL[] = [];
    server.use(
      http.get('*/api/admin/doctor', ({ request }) => {
        urls.push(new URL(request.url));
        return HttpResponse.json({ data: report({ verdict: 'warn' }) });
      }),
    );
    await act(async () => {
      await result.current.rerun();
    });

    expect(urls[0].searchParams.get('refresh')).toBe('true');
    expect(result.current.report?.verdict).toBe('warn');
    expect(result.current.error).toBeNull();
  });
});
