/**
 * `useUsableAiModels` (#430) against the MSW network.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useUsableAiModels } from '../../hooks/useUsableAiModels';
import { mockUsableAiModels, mockUsableAiModelsMixed } from '../mocks/fixtures/ai';

describe('useUsableAiModels', () => {
  it('starts loading, then holds the usable models', async () => {
    const { result } = renderHook(() => useUsableAiModels());
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.models).toEqual(mockUsableAiModels);
    expect(result.current.error).toBeNull();
  });

  it('reports a failure as the hook error', async () => {
    server.use(
      http.get('*/api/ai/models', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'AI is disabled', details: { reason: 'AI_DISABLED' } },
          { status: 403 },
        ),
      ),
    );
    const { result } = renderHook(() => useUsableAiModels());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('AI is disabled');
    expect(result.current.models).toEqual([]);
  });

  it('refresh re-reads the list', async () => {
    const { result } = renderHook(() => useUsableAiModels());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: mockUsableAiModelsMixed })));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.models).toEqual(mockUsableAiModelsMixed);
  });
});
