/**
 * `useCoachChat` (E7.8, #248): retry after a failure never stores the user's
 * turn twice. A turn the server stored (an `error` frame's `userMessageId`, or
 * a cut-off stream found on the latest page) is retried with `retryOf`; a turn
 * refused before the stream is re-sent as plain text.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useCoachChat } from '../../hooks/useCoachChat';
import {
  coachMessageId,
  coachSseBody,
  mockCoachChatFrames,
  mockCoachChatStoredErrorFrames,
  mockCoachChatUnstoredErrorFrames,
} from '../mocks/fixtures/coach';

const API = '*/api';

/** Answers each chat request with the next script (the last one repeats). */
function chatScripts(...scripts: Array<Array<[string, unknown]> | { status: number; body: unknown }>) {
  const bodies: unknown[] = [];
  server.use(
    http.post(`${API}/coach/chat/stream`, async ({ request }) => {
      bodies.push(await request.json());
      const script = scripts[Math.min(bodies.length - 1, scripts.length - 1)];
      if (!Array.isArray(script)) return HttpResponse.json(script.body, { status: script.status });
      return new HttpResponse(coachSseBody(script), { headers: { 'Content-Type': 'text/event-stream' } });
    }),
  );
  return bodies;
}

describe('useCoachChat', () => {
  it('retries a stored turn with retryOf and completes it under the stored id', async () => {
    const bodies = chatScripts(mockCoachChatStoredErrorFrames, mockCoachChatFrames);
    const onComplete = vi.fn();
    const { result } = renderHook(() => useCoachChat({ onComplete }));

    act(() => result.current.send('Motivate me'));
    await waitFor(() => expect(result.current.pending?.status).toBe('failed'));
    expect(result.current.pending?.storedUserMessageId).toBe(coachMessageId(900));
    expect(result.current.pending?.failure?.message).toBe('The provider failed.');

    act(() => result.current.retry());
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(bodies).toEqual([{ text: 'Motivate me' }, { text: 'Motivate me', retryOf: coachMessageId(900) }]);
    expect(onComplete.mock.calls[0][0][0]).toMatchObject({ id: coachMessageId(900), role: 'user' });
  });

  it('re-sends plain text when the error frame says nothing was stored', async () => {
    const bodies = chatScripts(mockCoachChatUnstoredErrorFrames, mockCoachChatFrames);
    const { result } = renderHook(() => useCoachChat({ onComplete: vi.fn() }));

    act(() => result.current.send('Motivate me'));
    await waitFor(() => expect(result.current.pending?.status).toBe('failed'));
    expect(result.current.pending?.storedUserMessageId).toBeNull();

    act(() => result.current.retry());
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ text: 'Motivate me' });
  });

  it('keeps retryOf when a retry of a stored turn is itself refused before the stream', async () => {
    const bodies = chatScripts(mockCoachChatStoredErrorFrames, { status: 429, body: { message: 'Too many' } }, mockCoachChatFrames);
    const { result } = renderHook(() => useCoachChat({ onComplete: vi.fn() }));

    act(() => result.current.send('Motivate me'));
    await waitFor(() => expect(result.current.pending?.status).toBe('failed'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.pending?.failure?.kind).toBe('rate_limited'));
    expect(result.current.pending?.storedUserMessageId).toBe(coachMessageId(900));
    act(() => result.current.retry());
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]).toEqual({ text: 'Motivate me', retryOf: coachMessageId(900) });
  });

  it('looks a cut-off turn up after frames arrived, and uses what it finds', async () => {
    const bodies = chatScripts([['delta', { text: 'Half' }]], mockCoachChatFrames);
    const findStoredTurn = vi.fn().mockResolvedValue(coachMessageId(77));
    const { result } = renderHook(() => useCoachChat({ onComplete: vi.fn(), findStoredTurn }));

    act(() => result.current.send('Motivate me'));
    await waitFor(() => expect(result.current.pending?.status).toBe('failed'));
    expect(findStoredTurn).toHaveBeenCalledWith('Motivate me');
    expect(result.current.pending?.failure?.message).toMatch(/cut off/);
    expect(result.current.pending?.storedUserMessageId).toBe(coachMessageId(77));

    act(() => result.current.retry());
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ text: 'Motivate me', retryOf: coachMessageId(77) });
  });

  it('does not look up a stream that ended before any frame, nor a refusal', async () => {
    const findStoredTurn = vi.fn().mockResolvedValue(coachMessageId(77));
    chatScripts([]);
    const { result } = renderHook(() => useCoachChat({ onComplete: vi.fn(), findStoredTurn }));
    act(() => result.current.send('Motivate me'));
    await waitFor(() => expect(result.current.pending?.status).toBe('failed'));
    expect(result.current.pending?.storedUserMessageId).toBeNull();

    chatScripts({ status: 500, body: { message: 'boom' } });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.pending?.failure?.message).toBe('boom'));
    expect(result.current.pending?.storedUserMessageId).toBeNull();
    expect(findStoredTurn).not.toHaveBeenCalled();
  });
});
