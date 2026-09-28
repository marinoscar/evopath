/**
 * `useAiRealtimeSession` — issue #449.
 *
 * The network is MSW (the mint and the provider's SDP endpoint); WebRTC and
 * the microphone are the scriptable fakes in `utils/fakeWebRtc.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { aiErrorBody } from '../mocks/fixtures/ai';
import {
  AI_REALTIME_DATA_CHANNEL,
  AI_REALTIME_INPUT_TRANSCRIPTION_MODEL,
  formatRealtimeElapsed,
  useAiRealtimeSession,
} from '../../hooks/useAiRealtimeSession';
import {
  FAKE_ANSWER_SDP,
  FAKE_CLIENT_SECRET,
  FAKE_OFFER_SDP,
  FakePeerConnection,
  installFakeWebRtc,
  mediaError,
  mockRealtimeNetwork,
  type FakeWebRtc,
} from '../utils/fakeWebRtc';

let rtc: FakeWebRtc;

beforeEach(() => {
  rtc = installFakeWebRtc();
});

afterEach(() => {
  rtc.restore();
});

async function startConnected() {
  const network = mockRealtimeNetwork();
  const hook = renderHook(() => useAiRealtimeSession());
  await act(async () => {
    await hook.result.current.start({ provider: 'openai', model: 'gpt-realtime', voice: 'marin' });
  });
  expect(hook.result.current.status).toBe('connected');
  return { ...hook, network, pc: rtc.peer() };
}

describe('formatRealtimeElapsed', () => {
  it('formats mm:ss, and h:mm:ss past an hour', () => {
    expect(formatRealtimeElapsed(0)).toBe('00:00');
    expect(formatRealtimeElapsed(65)).toBe('01:05');
    expect(formatRealtimeElapsed(3_725)).toBe('1:02:05');
  });
});

describe('useAiRealtimeSession', () => {
  it('mints, offers, applies the answer and connects', async () => {
    const { result, network, pc } = await startConnected();

    expect(rtc.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(network.mints).toEqual([{ provider: 'openai', model: 'gpt-realtime', voice: 'marin' }]);
    expect(pc.addTrack).toHaveBeenCalledWith(rtc.mic.track, rtc.mic.stream);
    expect(pc.createDataChannel).toHaveBeenCalledWith(AI_REALTIME_DATA_CHANNEL);
    expect(pc.setLocalDescription).toHaveBeenCalledWith({ type: 'offer', sdp: FAKE_OFFER_SDP });

    // The offer goes straight to the provider with the EPHEMERAL secret.
    expect(network.connects).toEqual([
      { authorization: `Bearer ${FAKE_CLIENT_SECRET}`, contentType: 'application/sdp', body: FAKE_OFFER_SDP },
    ]);
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: FAKE_ANSWER_SDP });

    // What the session runs is exposed — the secret is not.
    expect(result.current.session).toEqual({ provider: 'openai', model: 'gpt-realtime', voice: 'marin' });
    expect(JSON.stringify(result.current)).not.toContain(FAKE_CLIENT_SECRET);
  });

  it('turns on input transcription when the channel opens, and appends both sides of the transcript', async () => {
    const { result, pc } = await startConnected();
    const channel = pc.channel!;

    act(() => channel.open());
    expect(JSON.parse(channel.sent[0])).toEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: { input: { transcription: { model: AI_REALTIME_INPUT_TRANSCRIPTION_MODEL } } },
      },
    });

    act(() => {
      // The user's item is created first; its transcription finishes later.
      channel.emit({ type: 'conversation.item.created', item: { id: 'item_u1', role: 'user' } });
      channel.emit({ type: 'response.output_audio_transcript.delta', item_id: 'item_a1', delta: 'Hello' });
      channel.emit({ type: 'response.output_audio_transcript.delta', item_id: 'item_a1', delta: ' there' });
      channel.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_u1',
        transcript: ' Hi! ',
      });
    });
    expect(result.current.transcript).toEqual([
      { id: 'item_u1', role: 'user', text: 'Hi!', final: true },
      { id: 'item_a1', role: 'assistant', text: 'Hello there', final: false },
    ]);

    act(() => {
      channel.emit({ type: 'response.output_audio_transcript.done', item_id: 'item_a1', transcript: 'Hello there!' });
      // The beta event names are read too.
      channel.emit({ type: 'response.audio_transcript.delta', item_id: 'item_a2', delta: 'Beta' });
      channel.emit({ type: 'not-json-interesting' });
    });
    expect(result.current.transcript.map((line) => [line.role, line.text, line.final])).toEqual([
      ['user', 'Hi!', true],
      ['assistant', 'Hello there!', true],
      ['assistant', 'Beta', false],
    ]);
  });

  it('shows a provider error event without ending the call', async () => {
    const { result, pc } = await startConnected();
    act(() => pc.channel!.emit({ type: 'error', error: { message: 'Invalid session.update' } }));
    expect(result.current.failure).toEqual({ kind: 'provider', message: 'Invalid session.update' });
    expect(result.current.status).toBe('connected');
  });

  it('counts elapsed time once connected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = await startConnected();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(result.current.elapsedSeconds).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('mutes by disabling the mic track', async () => {
    const { result } = await startConnected();
    act(() => result.current.setMuted(true));
    expect(result.current.muted).toBe(true);
    expect(rtc.mic.track.enabled).toBe(false);
    act(() => result.current.setMuted(false));
    expect(rtc.mic.track.enabled).toBe(true);
  });

  it('stop closes the channel and the connection and stops the mic', async () => {
    const { result, pc } = await startConnected();
    act(() => result.current.stop());

    expect(pc.channel!.close).toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalled();
    expect(rtc.mic.track.stop).toHaveBeenCalled();
    expect(result.current.status).toBe('ended');
  });

  it('cleans up on unmount', async () => {
    const { unmount, pc } = await startConnected();
    unmount();
    expect(pc.close).toHaveBeenCalled();
    expect(pc.channel!.close).toHaveBeenCalled();
    expect(rtc.mic.track.stop).toHaveBeenCalled();
  });

  it('reports a lost connection and tears down', async () => {
    const { result, pc } = await startConnected();
    act(() => pc.setConnectionState('failed'));
    expect(result.current.status).toBe('error');
    expect(result.current.failure).toEqual({ kind: 'connection-lost' });
    expect(pc.close).toHaveBeenCalled();
    expect(rtc.mic.track.stop).toHaveBeenCalled();
  });

  it('mic permission denied: never mints', async () => {
    rtc.restore();
    rtc = installFakeWebRtc({ getUserMedia: () => Promise.reject(mediaError('NotAllowedError')) });
    const network = mockRealtimeNetwork();
    const { result } = renderHook(() => useAiRealtimeSession());

    await act(async () => {
      await result.current.start({});
    });

    expect(result.current.status).toBe('error');
    expect(result.current.failure).toEqual({ kind: 'mic-denied' });
    expect(network.mints).toEqual([]);
    expect(FakePeerConnection.instances).toHaveLength(0);
  });

  it('no microphone: says so', async () => {
    rtc.restore();
    rtc = installFakeWebRtc({ getUserMedia: () => Promise.reject(mediaError('NotFoundError')) });
    const { result } = renderHook(() => useAiRealtimeSession());
    await act(async () => {
      await result.current.start({});
    });
    expect(result.current.failure).toEqual({ kind: 'no-mic' });
  });

  it('a browser without WebRTC is reported as unsupported', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    const { result } = renderHook(() => useAiRealtimeSession());
    await act(async () => {
      await result.current.start({});
    });
    expect(result.current.failure).toEqual({ kind: 'unsupported' });
    expect(rtc.getUserMedia).not.toHaveBeenCalled();
  });

  it('mint refused with 403 AI_REALTIME_DISABLED: surfaces the code and releases the mic', async () => {
    const network = mockRealtimeNetwork({
      mintBody: aiErrorBody('AI_REALTIME_DISABLED', 'Realtime sessions are disabled'),
      mintStatus: 403,
    });
    const { result } = renderHook(() => useAiRealtimeSession());

    await act(async () => {
      await result.current.start({ model: 'gpt-realtime' });
    });

    expect(network.mints).toHaveLength(1);
    expect(result.current.status).toBe('error');
    expect(result.current.failure).toMatchObject({
      kind: 'api',
      error: { code: 'AI_REALTIME_DISABLED', status: 403 },
    });
    expect(rtc.mic.track.stop).toHaveBeenCalled();
    expect(network.connects).toEqual([]);
  });

  it('SDP exchange refused by the provider', async () => {
    mockRealtimeNetwork({ connectStatus: 401 });
    const { result } = renderHook(() => useAiRealtimeSession());
    await act(async () => {
      await result.current.start({});
    });
    expect(result.current.failure).toMatchObject({ kind: 'sdp' });
    expect(rtc.peer().close).toHaveBeenCalled();
    expect(rtc.mic.track.stop).toHaveBeenCalled();
  });

  it('a secret that expired before connecting is never sent', async () => {
    const network = mockRealtimeNetwork({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const { result } = renderHook(() => useAiRealtimeSession());
    await act(async () => {
      await result.current.start({});
    });
    expect(result.current.failure).toEqual({ kind: 'expired' });
    expect(network.connects).toEqual([]);
    expect(rtc.mic.track.stop).toHaveBeenCalled();
  });
});
