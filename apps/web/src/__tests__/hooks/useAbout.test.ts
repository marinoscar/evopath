/**
 * `useAbout` — issue #401, epic #397.
 *
 * The hook is deliberately the plainest fetch shape in this directory, so what
 * is worth asserting is small and specific:
 *
 *   - the three states (`isLoading` → `data`, and the error path);
 *   - `refresh` re-reads and adopts the NEW response, which is the only reason
 *     the function is exported at all — the API re-reads the deploy document
 *     from disk on every request, so a re-read genuinely picks up a deployment
 *     made since the page was opened;
 *   - ⚠ and the one that is a contract rather than plumbing: a deploy document
 *     that is absent, invalid, or written by a FAILED run is a successful read.
 *     `GET /api/admin/about` always answers 200, and a hook that turned any of
 *     those into `error` would hide from the page exactly the facts it exists
 *     to render.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { renderHook, waitFor, act } from '@testing-library/react';
import { server } from '../mocks/server';
import { useAbout } from '../../hooks/useAbout';
import { api } from '../../services/api';
import type { AboutResponse } from '../../types';

function aboutResponse(overrides: Partial<AboutResponse> = {}): AboutResponse {
  const base: AboutResponse = {
    api: { version: '2.4.1' },
    deployInfoStatus: 'ok',
    deployInfoPath: '/srv/app/deploy/info.json',
    deployInfoError: null,
    app: { name: 'App', version: '2.4.1', commitSha: 'abc1234', ref: 'main' },
    installedAt: '2026-01-04T09:12:00.000Z',
    updatedAt: '2026-08-30T18:40:00.000Z',
    deployedBy: { cli: 'appctl', version: '1.9.0' },
    domain: 'app.example.com',
    remote: { commitsBehind: 0, checkedAt: '2026-08-30T18:39:00.000Z' },
    run: { completed: ['pull', 'build'], failedStep: null, outcome: 'success' },
    database: { status: 'up', responseTime: '4ms' },
    databaseError: null,
  };
  return { ...base, ...overrides };
}

function serveAbout(value: AboutResponse) {
  server.use(http.get('*/api/admin/about', () => HttpResponse.json({ data: value })));
}

beforeEach(() => {
  api.setAccessToken(null);
});

describe('useAbout', () => {
  it('starts loading, with no data and no error', () => {
    serveAbout(aboutResponse());
    const { result } = renderHook(() => useAbout());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('resolves to the response and stops loading', async () => {
    serveAbout(aboutResponse());
    const { result } = renderHook(() => useAbout());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.api.version).toBe('2.4.1');
    expect(result.current.data?.app?.commitSha).toBe('abc1234');
    expect(result.current.error).toBeNull();
  });

  it('reports a failed request as an error message, not as a throw', async () => {
    server.use(
      http.get('*/api/admin/about', () =>
        HttpResponse.json({ message: 'Insufficient permissions' }, { status: 403 }),
      ),
    );
    const { result } = renderHook(() => useAbout());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Insufficient permissions');
    expect(result.current.data).toBeNull();
  });

  it('falls back to a readable message when the failure carries none', async () => {
    server.use(http.get('*/api/admin/about', () => HttpResponse.error()));
    const { result } = renderHook(() => useAbout());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Failed to load deployment information');
  });

  it('re-reads on refresh and adopts the new response', async () => {
    serveAbout(aboutResponse());
    const { result } = renderHook(() => useAbout());
    await waitFor(() => expect(result.current.data).not.toBeNull());

    serveAbout(
      aboutResponse({ app: { name: 'App', version: '2.5.0', commitSha: 'def5678', ref: 'main' } }),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.data?.app?.commitSha).toBe('def5678');
  });

  it('clears a previous error once a refresh succeeds', async () => {
    server.use(
      http.get('*/api/admin/about', () =>
        HttpResponse.json({ message: 'Boom' }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useAbout());
    await waitFor(() => expect(result.current.error).toBe('Boom'));

    serveAbout(aboutResponse());
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data).not.toBeNull();
  });

  describe('⚠ a 200 is a 200, whatever the deployment looks like', () => {
    it('treats an absent deploy document as data, never as an error', async () => {
      serveAbout(
        aboutResponse({
          deployInfoStatus: 'absent',
          app: null,
          run: null,
          remote: null,
          deployedBy: null,
        }),
      );
      const { result } = renderHook(() => useAbout());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.data?.deployInfoStatus).toBe('absent');
      // The path is what makes that answer actionable, so it must survive.
      expect(result.current.data?.deployInfoPath).toBe('/srv/app/deploy/info.json');
    });

    it('treats an invalid deploy document as data, never as an error', async () => {
      serveAbout(
        aboutResponse({ deployInfoStatus: 'invalid', deployInfoError: 'bad json', app: null }),
      );
      const { result } = renderHook(() => useAbout());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.data?.deployInfoError).toBe('bad json');
    });

    it('treats a failed deploy run as data, with every fact intact', async () => {
      serveAbout(
        aboutResponse({
          run: { completed: ['pull'], failedStep: 'migrate', outcome: 'failure' },
        }),
      );
      const { result } = renderHook(() => useAbout());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.data?.deployInfoStatus).toBe('ok');
      expect(result.current.data?.run?.failedStep).toBe('migrate');
      expect(result.current.data?.app?.commitSha).toBe('abc1234');
    });

    it('treats an unreachable database as data, never as an error', async () => {
      serveAbout(aboutResponse({ database: null, databaseError: 'ECONNREFUSED' }));
      const { result } = renderHook(() => useAbout());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.data?.database).toBeNull();
      expect(result.current.data?.databaseError).toBe('ECONNREFUSED');
    });
  });
});
