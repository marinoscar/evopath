/** `useStorageStatus` (#204): fails open (null) while loading and on error; `skip` is inert. */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useStorageStatus } from '../../hooks/useStorageStatus';

describe('useStorageStatus', () => {
  it('is null while loading, then the configured flag', async () => {
    server.use(http.get('*/api/storage/status', () => HttpResponse.json({ data: { configured: false } })));
    const { result } = renderHook(() => useStorageStatus());
    expect(result.current).toEqual({ configured: null, isLoading: true });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.configured).toBe(false);
  });

  it('reports true when configured', async () => {
    const { result } = renderHook(() => useStorageStatus());
    await waitFor(() => expect(result.current.configured).toBe(true));
  });

  it('fails open: a failed read leaves configured null', async () => {
    server.use(
      http.get('*/api/storage/status', () =>
        HttpResponse.json({ statusCode: 500, code: 'INTERNAL', message: 'boom' }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useStorageStatus());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.configured).toBeNull();
  });

  it('treats a malformed body as unknown', async () => {
    server.use(http.get('*/api/storage/status', () => HttpResponse.json({ data: {} })));
    const { result } = renderHook(() => useStorageStatus());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.configured).toBeNull();
  });

  it('skip makes no request and stays null', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/storage/status', () => {
        calls += 1;
        return HttpResponse.json({ data: { configured: false } });
      }),
    );
    const { result } = renderHook(() => useStorageStatus({ skip: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toEqual({ configured: null, isLoading: false });
    expect(calls).toBe(0);
  });
});
