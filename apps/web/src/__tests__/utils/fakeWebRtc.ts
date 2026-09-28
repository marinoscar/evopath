/**
 * A scriptable stand-in for the browser's WebRTC and microphone APIs — for
 * the realtime voice tests (issue #449). jsdom has neither
 * `RTCPeerConnection` nor `navigator.mediaDevices`.
 *
 * `installFakeWebRtc()` stubs both globals and returns handles to what the
 * code under test created, so a test can open the data channel, push server
 * events, flip the connection state and assert cleanup. Undo with
 * `uninstallFakeWebRtc()` (or `vi.unstubAllGlobals()` plus the returned
 * `restore`).
 */
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

export class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  readonly sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly close = vi.fn(() => {
    this.readyState = 'closed';
  });

  constructor(readonly label: string) {}

  send(data: string) {
    this.sent.push(data);
  }

  /** The provider opened the channel. */
  open() {
    this.readyState = 'open';
    this.onopen?.(new Event('open'));
  }

  /** The provider sent one server event. */
  emit(event: Record<string, unknown>) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
  }
}

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = 'new';
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channel: FakeDataChannel | null = null;
  readonly addTrack = vi.fn();
  readonly createDataChannel = vi.fn((label: string) => {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  });
  readonly createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: FAKE_OFFER_SDP }));
  readonly setLocalDescription = vi.fn(async () => undefined);
  readonly setRemoteDescription = vi.fn(async () => undefined);
  readonly close = vi.fn(() => {
    this.connectionState = 'closed';
  });

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  /** The browser reported a new connection state. */
  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

export const FAKE_OFFER_SDP = 'v=0\r\no=- fake-offer\r\n';
export const FAKE_ANSWER_SDP = 'v=0\r\no=- fake-answer\r\n';
export const FAKE_CONNECT_URL = 'https://realtime.provider.test/v1/realtime/calls';
export const FAKE_CLIENT_SECRET = 'ek_test_EPHEMERAL_never_rendered';

export interface FakeMic {
  track: { kind: 'audio'; enabled: boolean; stop: ReturnType<typeof vi.fn> };
  stream: MediaStream;
}

export function fakeMic(): FakeMic {
  const track = { kind: 'audio' as const, enabled: true, stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

export interface FakeWebRtc {
  mic: FakeMic;
  getUserMedia: ReturnType<typeof vi.fn>;
  peer: () => FakePeerConnection;
  restore: () => void;
}

/** Stub `RTCPeerConnection` and `navigator.mediaDevices.getUserMedia`. */
export function installFakeWebRtc(options: { getUserMedia?: () => Promise<MediaStream> } = {}): FakeWebRtc {
  FakePeerConnection.instances = [];
  const mic = fakeMic();
  const getUserMedia = vi.fn(options.getUserMedia ?? (async () => mic.stream));
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  const previous = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  return {
    mic,
    getUserMedia,
    peer: () => {
      const last = FakePeerConnection.instances.at(-1);
      if (!last) throw new Error('No RTCPeerConnection was created');
      return last;
    },
    restore: () => {
      vi.unstubAllGlobals();
      if (previous) Object.defineProperty(navigator, 'mediaDevices', previous);
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    },
  };
}

/** A `DOMException`-shaped rejection, as `getUserMedia` produces. */
export function mediaError(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

export interface CapturedConnect {
  authorization: string | null;
  contentType: string | null;
  body: string;
}

/**
 * MSW handlers for the mint and the provider's SDP endpoint. `expiresAt`
 * defaults to a minute from now.
 */
export function mockRealtimeNetwork(
  options: { expiresAt?: string; connectStatus?: number; mintBody?: unknown; mintStatus?: number } = {},
) {
  const mints: unknown[] = [];
  const connects: CapturedConnect[] = [];
  server.use(
    http.post('*/api/ai/realtime/sessions', async ({ request }) => {
      mints.push(await request.json());
      if (options.mintBody !== undefined) {
        return HttpResponse.json(options.mintBody as Record<string, unknown>, { status: options.mintStatus ?? 403 });
      }
      return HttpResponse.json(
        {
          data: {
            provider: 'openai',
            model: 'gpt-realtime',
            voice: 'marin',
            clientSecret: FAKE_CLIENT_SECRET,
            expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
            connectUrl: FAKE_CONNECT_URL,
          },
        },
        { status: 201 },
      );
    }),
    http.post(FAKE_CONNECT_URL, async ({ request }) => {
      connects.push({
        authorization: request.headers.get('Authorization'),
        contentType: request.headers.get('Content-Type'),
        body: await request.text(),
      });
      if (options.connectStatus && options.connectStatus >= 400) {
        return new HttpResponse('nope', { status: options.connectStatus });
      }
      return new HttpResponse(FAKE_ANSWER_SDP, { status: 201, headers: { 'Content-Type': 'application/sdp' } });
    }),
  );
  return { mints, connects };
}
