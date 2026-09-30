/**
 * `useAgentModels` against the MSW network.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useAgentModels } from '../../hooks/useAgentModels';
import { mockTrainingModelsView, mockTrainingRunEstimate } from '../mocks/fixtures/trainingAgents';

describe('useAgentModels', () => {
  it('loads the role states and the create-run estimate', async () => {
    let estimateBody: unknown;
    server.use(
      http.post('*/api/ai/training/estimate', async ({ request }) => {
        estimateBody = await request.json();
        return HttpResponse.json({ data: mockTrainingRunEstimate });
      }),
    );
    const { result } = renderHook(() => useAgentModels());
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.view).toEqual(mockTrainingModelsView);
    expect(result.current.estimate).toEqual(mockTrainingRunEstimate);
    expect(estimateBody).toEqual({ kind: 'create' });
    expect(result.current.error).toBeNull();
  });

  it('reports a failed estimate separately from the role states', async () => {
    server.use(
      http.post('*/api/ai/training/estimate', () =>
        HttpResponse.json({ code: 'INTERNAL', message: 'Estimate failed' }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useAgentModels());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.view).toEqual(mockTrainingModelsView);
    expect(result.current.estimate).toBeNull();
    expect(result.current.estimateError).toBeTruthy();
  });
});
