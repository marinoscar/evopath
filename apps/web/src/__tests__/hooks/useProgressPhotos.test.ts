/**
 * The progress-photo hooks (E7.9, #249) against MSW: paging through
 * `nextCursor`, a pose change starting over, a 403 marked forbidden, the
 * latest photo of a pose for the ghost overlay, and every photo of a pose for
 * the compare picker.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useAllProgressPhotos, useLatestProgressPhoto, useProgressPhotos } from '../../hooks/useProgressPhotos';
import type { ProgressPhotoPose } from '../../services/progressPhotos';
import { mockProgressPhoto, mockProgressPhotoSet, progressPhotosApi } from '../mocks/fixtures/progressPhotos';

describe('useProgressPhotos', () => {
  it('loads the first page, appends the next, and starts over on a pose change', async () => {
    const calls = progressPhotosApi(mockProgressPhotoSet(), { pageSize: 3 });
    const { result, rerender } = renderHook(({ pose }: { pose: ProgressPhotoPose | null }) => useProgressPhotos(pose), {
      initialProps: { pose: null as ProgressPhotoPose | null },
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.photos).toHaveLength(3);
    expect(result.current.hasMore).toBe(true);

    await act(() => result.current.loadMore());
    expect(result.current.photos).toHaveLength(4);
    expect(result.current.hasMore).toBe(false);

    rerender({ pose: 'side' });
    await waitFor(() => expect(result.current.photos).toHaveLength(1));
    expect(calls.lists).toEqual(['limit=30', 'limit=30&cursor=3', 'pose=side&limit=30']);

    act(() => result.current.removeLocal(result.current.photos[0].id));
    expect(result.current.photos).toEqual([]);
  });

  it('marks a 403 as forbidden', async () => {
    server.use(
      http.get('*/api/progress-photos', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'Missing health_data:read' }, { status: 403 }),
      ),
    );
    const { result } = renderHook(() => useProgressPhotos(null));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.forbidden).toBe(true);
    expect(result.current.error).toBe('Missing health_data:read');
  });
});

describe('useLatestProgressPhoto', () => {
  it('asks for one photo of the pose, and nothing for a null pose', async () => {
    const calls = progressPhotosApi(mockProgressPhotoSet());
    const { result, rerender } = renderHook(({ pose }: { pose: ProgressPhotoPose | null }) => useLatestProgressPhoto(pose), {
      initialProps: { pose: null as ProgressPhotoPose | null },
    });
    expect(result.current.photo).toBeNull();
    expect(calls.lists).toEqual([]);

    rerender({ pose: 'front' });
    await waitFor(() => expect(result.current.photo?.localDate).toBe('2026-09-28'));
    rerender({ pose: 'back' });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.photo).toBeNull();
    expect(calls.lists).toEqual(['pose=front&limit=1', 'pose=back&limit=1']);
  });

  it('treats a failed read as no overlay', async () => {
    server.use(http.get('*/api/progress-photos', () => HttpResponse.json({ message: 'boom' }, { status: 500 })));
    const { result } = renderHook(() => useLatestProgressPhoto('front'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.photo).toBeNull();
  });
});

describe('useAllProgressPhotos', () => {
  it('reads every page of the pose, and nothing while disabled', async () => {
    const photos = Array.from({ length: 5 }, (_, i) => mockProgressPhoto({ localDate: `2026-09-0${9 - i}` }));
    const calls = progressPhotosApi(photos, { pageSize: 2 });
    const { result, rerender } = renderHook(({ enabled }) => useAllProgressPhotos('front', enabled), {
      initialProps: { enabled: false },
    });
    expect(calls.lists).toEqual([]);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.photos).toHaveLength(5));
    expect(calls.lists).toEqual(['pose=front&limit=100', 'pose=front&limit=100&cursor=2', 'pose=front&limit=100&cursor=4']);
  });
});
