/**
 * `useHealthProfile` (#47, E2.1) against MSW — the real `services/health`
 * client, so the `If-Match` it sends is the version it loaded.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useHealthProfile } from '../../hooks/useHealthProfile';
import { isHealthProfileConflict, type HealthProfileInput } from '../../services/health';
import { mockHealthProfileEmpty, mockHealthProfileSaved } from '../mocks/fixtures/health';

const INPUT: HealthProfileInput = {
  dateOfBirth: '1990-02-28',
  sexAtBirth: 'male',
  heightMm: 1778,
  unitSystem: 'imperial',
  timeZone: 'UTC',
  bio: null,
};

async function renderLoaded() {
  const hook = renderHook(() => useHealthProfile());
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

describe('useHealthProfile', () => {
  it('loads the profile', async () => {
    const { result } = await renderLoaded();
    expect(result.current.error).toBeNull();
    expect(result.current.profile).toEqual(mockHealthProfileEmpty);
  });

  it('reports a load failure as the hook error and no profile', async () => {
    server.use(
      http.get('*/api/health-profile', () =>
        HttpResponse.json({ message: 'Insufficient permissions' }, { status: 403 }),
      ),
    );
    const { result } = await renderLoaded();
    expect(result.current.error).toBe('Insufficient permissions');
    expect(result.current.profile).toBeNull();
  });

  it('save sends the loaded version as If-Match and adopts the saved row', async () => {
    server.use(
      http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })),
    );
    let ifMatch: string | null = null;
    server.use(
      http.put('*/api/health-profile', ({ request }) => {
        ifMatch = request.headers.get('If-Match');
        return HttpResponse.json({ data: { ...mockHealthProfileSaved, ...INPUT, version: 4 } });
      }),
    );
    const { result } = await renderLoaded();

    await act(async () => {
      await result.current.save(INPUT);
    });

    expect(ifMatch).toBe('3');
    expect(result.current.profile?.version).toBe(4);
    expect(result.current.profile?.sexAtBirth).toBe('male');
    expect(result.current.isSaving).toBe(false);
  });

  it('sends If-Match: 0 on the first save and then the new version', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.put('*/api/health-profile', async ({ request }) => {
        seen.push(request.headers.get('If-Match'));
        const body = (await request.json()) as object;
        return HttpResponse.json({
          data: { ...body, version: seen.length, updatedAt: '2026-09-29T00:00:00.000Z' },
        });
      }),
    );
    const { result } = await renderLoaded();

    await act(async () => {
      await result.current.save(INPUT);
    });
    await act(async () => {
      await result.current.save(INPUT);
    });

    expect(seen).toEqual(['0', '1']);
    expect(result.current.profile?.version).toBe(2);
  });

  it('a 409 rejects, keeps the loaded profile and does not refetch', async () => {
    let gets = 0;
    server.use(
      http.get('*/api/health-profile', () => {
        gets += 1;
        return HttpResponse.json({ data: mockHealthProfileSaved });
      }),
      http.put('*/api/health-profile', () =>
        HttpResponse.json({ message: 'Version mismatch' }, { status: 409 }),
      ),
    );
    const { result } = await renderLoaded();

    let caught: unknown;
    await act(async () => {
      caught = await result.current.save(INPUT).catch((e: unknown) => e);
    });

    expect(isHealthProfileConflict(caught)).toBe(true);
    expect(result.current.profile).toEqual(mockHealthProfileSaved);
    expect(result.current.error).toBeNull();
    expect(result.current.isSaving).toBe(false);
    expect(gets).toBe(1);
  });

  it('refresh reloads the profile', async () => {
    const { result } = await renderLoaded();
    server.use(
      http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })),
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.profile).toEqual(mockHealthProfileSaved);
  });
});
