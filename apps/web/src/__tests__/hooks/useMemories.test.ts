/**
 * `useMemories` (#325) against the MSW network: load, a write re-reads the
 * list, and a refusal comes back as `{ ok: false, message }`.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useMemories } from '../../hooks/useMemories';
import { mockMemoryListView } from '../mocks/fixtures/memories';

async function renderLoaded() {
  const hook = renderHook(() => useMemories());
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

describe('useMemories', () => {
  it('loads the list view', async () => {
    const { result } = await renderLoaded();
    expect(result.current.loadError).toBeNull();
    expect(result.current.view).toEqual(mockMemoryListView());
  });

  it('reports a load failure', async () => {
    server.use(http.get('*/api/memories', () => HttpResponse.json({ message: 'x' }, { status: 403 })));
    const { result } = await renderLoaded();
    expect(result.current.view).toBeNull();
    expect(result.current.loadError).toMatch(/Memory is switched off/);
  });

  it('re-reads the list after a successful write', async () => {
    let gets = 0;
    server.use(
      http.get('*/api/memories', () => {
        gets += 1;
        return HttpResponse.json({ data: mockMemoryListView() });
      }),
    );
    const { result } = await renderLoaded();
    expect(gets).toBe(1);
    let outcome: Awaited<ReturnType<typeof result.current.add>> | undefined;
    await act(async () => {
      outcome = await result.current.add({ content: 'New', category: 'other' });
    });
    expect(outcome?.ok).toBe(true);
    expect(gets).toBe(2);
  });

  it('maps a refusal using the loaded limit', async () => {
    server.use(
      http.post('*/api/memories', () =>
        HttpResponse.json({ code: 'CONFLICT', message: 'x', details: { code: 'MEMORY_LIMIT_REACHED' } }, { status: 409 }),
      ),
    );
    const { result } = await renderLoaded();
    let outcome: Awaited<ReturnType<typeof result.current.add>> | undefined;
    await act(async () => {
      outcome = await result.current.add({ content: 'New', category: 'other' });
    });
    expect(outcome).toEqual({ ok: false, message: expect.stringMatching(/limit of 200 memories/) });
    expect(result.current.isSaving).toBe(false);
  });
});
