/**
 * `useCoachTimeline` (E7.8, #248): display order, the `before` cursor, the
 * opened signal at most once per id, optimistic feedback with revert.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useCoachTimeline } from '../../hooks/useCoachTimeline';
import { coachMessageId, mockCoachMessage } from '../mocks/fixtures/coach';

const API = '*/api';
const a = mockCoachMessage({ id: coachMessageId(1), body: 'a' });
const b = mockCoachMessage({ id: coachMessageId(2), body: 'b', openedAt: null });
const c = mockCoachMessage({ id: coachMessageId(3), body: 'c' });

function pages() {
  server.use(
    http.get(`${API}/coach/messages`, ({ request }) => {
      const before = new URL(request.url).searchParams.get('before');
      return HttpResponse.json({
        data: before ? { items: [a], nextCursor: null } : { items: [c, b], nextCursor: b.id },
      });
    }),
  );
}

describe('useCoachTimeline', () => {
  it('orders oldest first and prepends older pages', async () => {
    pages();
    const { result } = renderHook(() => useCoachTimeline());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((m) => m.body)).toEqual(['b', 'c']);
    expect(result.current.hasMore).toBe(true);

    await act(() => result.current.loadOlder());
    expect(result.current.items.map((m) => m.body)).toEqual(['a', 'b', 'c']);
    expect(result.current.hasMore).toBe(false);
  });

  it('posts opened at most once per id and records it', async () => {
    pages();
    let posts = 0;
    server.use(
      http.post(`${API}/coach/messages/:id/opened`, () => {
        posts += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { result } = renderHook(() => useCoachTimeline());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => {
      result.current.markOpened(b.id);
      result.current.markOpened(b.id);
    });
    await waitFor(() => expect(result.current.items.find((m) => m.id === b.id)?.openedAt).not.toBeNull());
    expect(posts).toBe(1);
  });

  it('reverts optimistic feedback when the post fails', async () => {
    pages();
    server.use(http.post(`${API}/coach/messages/:id/feedback`, () => HttpResponse.json({}, { status: 404 })));
    const { result } = renderHook(() => useCoachTimeline());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let ok = true;
    await act(async () => {
      ok = await result.current.setFeedback(c.id, 'up');
    });
    expect(ok).toBe(false);
    expect(result.current.items.find((m) => m.id === c.id)?.feedback).toBeNull();
  });

  it('appends finished chat turns at the bottom without duplicates', async () => {
    pages();
    const { result } = renderHook(() => useCoachTimeline());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const user = mockCoachMessage({ id: coachMessageId(10), role: 'user', body: 'u' });
    const coach = mockCoachMessage({ id: coachMessageId(11), body: 'r' });
    act(() => result.current.append([user, coach]));
    act(() => result.current.append([coach]));
    expect(result.current.items.map((m) => m.body)).toEqual(['b', 'c', 'u', 'r']);
  });
});
