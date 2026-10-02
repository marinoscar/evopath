/**
 * `useCoachTimeline` (E7.8, #248): display order, the `before` cursor, the
 * opened signal at most once per id, optimistic feedback with revert, and the
 * stored-turn lookup after a cut-off chat stream.
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

  it('reset empties the timeline at once, drops the cursor, and re-reads the first page (#323)', async () => {
    let cleared = false;
    let resolveRead: (() => void) | null = null;
    server.use(
      http.get(`${API}/coach/messages`, async () => {
        if (!cleared) return HttpResponse.json({ data: { items: [c, b], nextCursor: b.id } });
        await new Promise<void>((resolve) => {
          resolveRead = resolve;
        });
        return HttpResponse.json({ data: { items: [], nextCursor: null } });
      }),
    );
    const { result } = renderHook(() => useCoachTimeline());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    cleared = true;
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.reset();
    });
    // Empty before the refetch answers.
    expect(result.current.items).toEqual([]);
    expect(result.current.hasMore).toBe(false);
    await waitFor(() => expect(resolveRead).not.toBeNull());
    await act(async () => {
      resolveRead?.();
      await done;
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
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

  it('finds a stored user turn on the latest page only when it is new and matches the text', async () => {
    const stored = mockCoachMessage({ id: coachMessageId(9), role: 'user', kind: 'chat', title: '', body: 'Motivate me', personaId: null });
    let latest = { items: [c, b], nextCursor: null as string | null };
    server.use(http.get(`${API}/coach/messages`, () => HttpResponse.json({ data: latest })));
    const { result } = renderHook(() => useCoachTimeline());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // No user row at all.
    await expect(result.current.findStoredUserTurn('Motivate me')).resolves.toBeNull();

    latest = { items: [stored, c, b], nextCursor: null };
    await expect(result.current.findStoredUserTurn('Motivate me')).resolves.toBe(stored.id);
    await expect(result.current.findStoredUserTurn('Something else')).resolves.toBeNull();
    // Nothing on screen changed.
    expect(result.current.items.map((m) => m.id)).toEqual([b.id, c.id]);

    // Already on screen: not the cut-off turn.
    act(() => result.current.append([stored]));
    await expect(result.current.findStoredUserTurn('Motivate me')).resolves.toBeNull();
  });

  it('answers null when the lookup fails', async () => {
    pages();
    const { result } = renderHook(() => useCoachTimeline());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    server.use(http.get(`${API}/coach/messages`, () => HttpResponse.json({ message: 'boom' }, { status: 500 })));
    await expect(result.current.findStoredUserTurn('Motivate me')).resolves.toBeNull();
  });
});
