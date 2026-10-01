/**
 * `useCoachMessageAudio` (#259): audio only on request, ready at once or
 * polled while pending, replay without a request, failures classified, and
 * polling that stops on unmount.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useCoachMessageAudio } from '../../hooks/useCoachMessageAudio';
import {
  COACH_AUDIO_OBJECT_ID,
  mockCoachAudioPending,
  mockCoachAudioReady,
  mockCoachMessage,
} from '../mocks/fixtures/coach';
import { COACH_AUDIO_MESSAGES } from '../../services/coach';

const API = '*/api';
const FAST = { pollIntervalMs: 10, maxPollMs: 2000 };

function recordAudio(
  post: () => Response = () => HttpResponse.json({ data: mockCoachAudioPending() }, { status: 202 }),
  get: (n: number) => Response = () => HttpResponse.json({ data: mockCoachAudioReady() }),
) {
  const calls = { posts: 0, gets: 0 };
  server.use(
    http.post(`${API}/coach/messages/:id/audio`, () => {
      calls.posts += 1;
      return post();
    }),
    http.get(`${API}/coach/messages/:id/audio`, () => {
      calls.gets += 1;
      return get(calls.gets);
    }),
  );
  return calls;
}

describe('useCoachMessageAudio', () => {
  it('does nothing until asked', async () => {
    const calls = recordAudio();
    const { result } = renderHook(() => useCoachMessageAudio(mockCoachMessage(), FAST));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(result.current.state.status).toBe('idle');
    expect(calls.posts).toBe(0);
    expect(calls.gets).toBe(0);
  });

  it('posts, polls while pending, then is ready with one play request', async () => {
    const calls = recordAudio(undefined, (n) =>
      HttpResponse.json({ data: n < 2 ? { status: 'pending', runId: 'r' } : mockCoachAudioReady() }),
    );
    const { result } = renderHook(() => useCoachMessageAudio(mockCoachMessage(), FAST));
    act(() => result.current.listen());
    expect(result.current.state.status).toBe('requesting');
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toEqual({ status: 'ready', storageObjectId: COACH_AUDIO_OBJECT_ID, voice: 'coral' });
    expect(result.current.playRequest).toBe(1);
    expect(calls.posts).toBe(1);
    expect(calls.gets).toBe(2);

    // Replay: no new request.
    act(() => result.current.listen());
    expect(result.current.playRequest).toBe(2);
    expect(calls.posts).toBe(1);
  });

  it('is ready at once on a 200 ready answer, without polling', async () => {
    const calls = recordAudio(() => HttpResponse.json({ data: mockCoachAudioReady('obj-1', 'alloy') }));
    const { result } = renderHook(() => useCoachMessageAudio(mockCoachMessage(), FAST));
    act(() => result.current.listen());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toMatchObject({ storageObjectId: 'obj-1', voice: 'alloy' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.gets).toBe(0);
  });

  it('plays audio the timeline already has without any request', () => {
    const calls = recordAudio();
    const { result } = renderHook(() =>
      useCoachMessageAudio(
        mockCoachMessage({ audioStatus: 'ready', audioStorageObjectId: 'existing', voice: 'sage' }),
        FAST,
      ),
    );
    act(() => result.current.listen());
    expect(result.current.state).toEqual({ status: 'ready', storageObjectId: 'existing', voice: 'sage' });
    expect(result.current.playRequest).toBe(1);
    expect(calls.posts).toBe(0);
  });

  it('ignores a second press while the request is under way', async () => {
    const calls = recordAudio(undefined, () => HttpResponse.json({ data: { status: 'pending', runId: 'r' } }));
    const { result, unmount } = renderHook(() => useCoachMessageAudio(mockCoachMessage(), FAST));
    act(() => result.current.listen());
    act(() => result.current.listen());
    await waitFor(() => expect(result.current.state.status).toBe('pending'));
    act(() => result.current.listen());
    expect(calls.posts).toBe(1);
    unmount();
  });

  it('reports a failed generation, and a retry posts again', async () => {
    const calls = recordAudio(undefined, () => HttpResponse.json({ data: { status: 'failed' } }));
    const { result } = renderHook(() => useCoachMessageAudio(mockCoachMessage(), FAST));
    act(() => result.current.listen());
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: 'error', kind: 'failed', message: COACH_AUDIO_MESSAGES.failed }),
    );
    act(() => result.current.listen());
    await waitFor(() => expect(calls.posts).toBe(2));
  });

  it('gives up after the polling window', async () => {
    recordAudio(undefined, () => HttpResponse.json({ data: { status: 'pending', runId: 'r' } }));
    const { result } = renderHook(() => useCoachMessageAudio(mockCoachMessage(), { pollIntervalMs: 10, maxPollMs: 40 }));
    act(() => result.current.listen());
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'error', kind: 'failed' }));
  });

  it.each([
    [403, { code: 'COACH_AUDIO_DISABLED' }, 'disabled', COACH_AUDIO_MESSAGES.disabled],
    [409, { reason: 'NO_SPEECH_MODEL' }, 'unavailable', COACH_AUDIO_MESSAGES.unavailable],
    [429, { code: 'COACH_AUDIO_RATE_LIMITED' }, 'rate_limited', COACH_AUDIO_MESSAGES.rateLimited],
    [404, { code: 'COACH_MESSAGE_NOT_FOUND' }, 'not_found', COACH_AUDIO_MESSAGES.notFound],
    [500, {}, 'other', COACH_AUDIO_MESSAGES.failed],
  ])('classifies a %s refusal', async (status, details, kind, message) => {
    recordAudio(() => HttpResponse.json({ message: 'nope', details }, { status }));
    const onDisabled = vi.fn();
    const { result } = renderHook(() => useCoachMessageAudio(mockCoachMessage(), { ...FAST, onDisabled }));
    act(() => result.current.listen());
    await waitFor(() => expect(result.current.state).toEqual({ status: 'error', kind, message }));
    expect(onDisabled).toHaveBeenCalledTimes(kind === 'disabled' ? 1 : 0);
  });

  it('stops polling on unmount', async () => {
    const calls = recordAudio(undefined, () => HttpResponse.json({ data: { status: 'pending', runId: 'r' } }));
    const { result, unmount } = renderHook(() => useCoachMessageAudio(mockCoachMessage(), FAST));
    act(() => result.current.listen());
    await waitFor(() => expect(calls.gets).toBeGreaterThan(0));
    unmount();
    const after = calls.gets;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.gets).toBeLessThanOrEqual(after + 1);
    const settled = calls.gets;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.gets).toBe(settled);
  });
});
