import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useMicrophonePermission,
  detectMicPlatform,
} from '../../hooks/useMicrophonePermission';

/**
 * Issue #508. This hook OBSERVES the microphone permission up front (so the
 * Voice mode can offer an "Allow microphone" button and platform-specific
 * unblock steps before Start is pressed) and only ever REQUESTS it from
 * `request()`, which the component calls exclusively from a click handler.
 * See the hook's own extensive header for the full rationale.
 */

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const originalPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');

function setSecureContext(value: boolean | undefined) {
  if (value === undefined) {
    if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
    return;
  }
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
}

function setGetUserMedia(fn: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | undefined) {
  if (fn === undefined) {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    return;
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(fn) },
  });
}

/** A fake `PermissionStatus` the Permissions API mock hands back. */
class FakePermissionStatus {
  state: PermissionState;
  private listeners: Array<() => void> = [];

  constructor(state: PermissionState) {
    this.state = state;
  }

  addEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'change') this.listeners.push(listener);
  });

  removeEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'change') this.listeners = this.listeners.filter((l) => l !== listener);
  });

  /** Simulate the browser flipping the permission and firing `change`. */
  setState(state: PermissionState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

/**
 * Stub `navigator.permissions.query` to resolve with a fresh
 * `FakePermissionStatus`, or reject/be absent per the options.
 */
function setPermissionsApi(
  options: { state?: PermissionState; reject?: boolean; absent?: boolean } = {},
): FakePermissionStatus | null {
  if (options.absent) {
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
    return null;
  }
  if (options.reject) {
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(() => Promise.reject(new Error('no such permission'))) },
    });
    return null;
  }
  const status = new FakePermissionStatus(options.state ?? 'prompt');
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn(() => Promise.resolve(status)) },
  });
  return status;
}

function stream(track: { stop: ReturnType<typeof vi.fn> }): MediaStream {
  return { getTracks: () => [track] } as unknown as MediaStream;
}

function mediaError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

afterEach(() => {
  setSecureContext(undefined);
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  if (originalPermissions) Object.defineProperty(navigator, 'permissions', originalPermissions);
  else delete (navigator as { permissions?: unknown }).permissions;
  vi.restoreAllMocks();
});

describe('detectMicPlatform', () => {
  it('detects Android from its UA', () => {
    expect(detectMicPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile')).toBe(
      'android',
    );
  });

  it('detects iPhone from its UA', () => {
    expect(
      detectMicPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'),
    ).toBe('ios');
  });

  it('detects iPad from its UA', () => {
    expect(
      detectMicPlatform('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'),
    ).toBe('ios');
  });

  it('falls back to desktop for iPadOS 13+\'s desktop-Safari UA, which cannot be told apart from a UA string alone', () => {
    // The hook's own header documents this as a known, accepted limitation:
    // iPadOS 13+ reports "Macintosh" with no "iPad" token.
    expect(
      detectMicPlatform(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toBe('desktop');
  });

  it('detects desktop for an ordinary desktop UA', () => {
    expect(
      detectMicPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'),
    ).toBe('desktop');
  });

  it('falls back to desktop for an empty or missing UA', () => {
    expect(detectMicPlatform('')).toBe('desktop');
  });
});

describe('useMicrophonePermission', () => {
  describe('capability short-circuits (checked before the Permissions API)', () => {
    it('reads "insecure" when window.isSecureContext is false', () => {
      setSecureContext(false);
      setGetUserMedia(async () => stream({ stop: vi.fn() }));
      setPermissionsApi({ state: 'prompt' });

      const { result } = renderHook(() => useMicrophonePermission());

      expect(result.current.permission).toBe('insecure');
    });

    it('reads "unsupported" when getUserMedia does not exist', () => {
      setSecureContext(true);
      setGetUserMedia(undefined);
      setPermissionsApi({ state: 'prompt' });

      const { result } = renderHook(() => useMicrophonePermission());

      expect(result.current.permission).toBe('unsupported');
    });

    it('treats isSecureContext === undefined (jsdom) as secure, not insecure', () => {
      setSecureContext(undefined);
      setGetUserMedia(async () => stream({ stop: vi.fn() }));
      setPermissionsApi({ state: 'granted' });

      const { result } = renderHook(() => useMicrophonePermission());

      expect(result.current.permission).not.toBe('insecure');
    });
  });

  describe('mapping the Permissions API state', () => {
    it.each([
      ['granted', 'granted'],
      ['denied', 'denied'],
      ['prompt', 'prompt'],
    ] as const)('maps Permissions API state %s to %s', async (apiState, expected) => {
      setSecureContext(true);
      setGetUserMedia(async () => stream({ stop: vi.fn() }));
      setPermissionsApi({ state: apiState });

      const { result } = renderHook(() => useMicrophonePermission());

      await waitFor(() => expect(result.current.permission).toBe(expected));
    });

    it('maps an unrecognised Permissions API state to "unknown"', async () => {
      setSecureContext(true);
      setGetUserMedia(async () => stream({ stop: vi.fn() }));
      const status = new FakePermissionStatus('prompt');
      // Force an unrecognised value the type system wouldn't otherwise allow.
      (status as unknown as { state: string }).state = 'something-new';
      Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: { query: vi.fn(() => Promise.resolve(status)) },
      });

      const { result } = renderHook(() => useMicrophonePermission());

      await waitFor(() => expect(result.current.permission).toBe('unknown'));
    });

    it('updates on the Permissions API "change" event', async () => {
      setSecureContext(true);
      setGetUserMedia(async () => stream({ stop: vi.fn() }));
      const status = setPermissionsApi({ state: 'prompt' })!;

      const { result } = renderHook(() => useMicrophonePermission());
      await waitFor(() => expect(result.current.permission).toBe('prompt'));

      act(() => {
        status.setState('granted');
      });

      await waitFor(() => expect(result.current.permission).toBe('granted'));
    });
  });

  describe('"unknown" fallback when the Permissions API cannot answer', () => {
    it('reads "unknown" when navigator.permissions is missing', async () => {
      setSecureContext(true);
      setGetUserMedia(async () => stream({ stop: vi.fn() }));
      setPermissionsApi({ absent: true });

      const { result } = renderHook(() => useMicrophonePermission());

      await waitFor(() => expect(result.current.permission).toBe('unknown'));
    });

    it('reads "unknown" when query() rejects (e.g. an unknown permission name)', async () => {
      setSecureContext(true);
      setGetUserMedia(async () => stream({ stop: vi.fn() }));
      setPermissionsApi({ reject: true });

      const { result } = renderHook(() => useMicrophonePermission());

      await waitFor(() => expect(result.current.permission).toBe('unknown'));
    });
  });

  describe('re-querying on visibilitychange', () => {
    it('re-reads when the document becomes visible again', async () => {
      setSecureContext(true);
      setGetUserMedia(async () => stream({ stop: vi.fn() }));
      const status = setPermissionsApi({ state: 'prompt' })!;

      const { result } = renderHook(() => useMicrophonePermission());
      await waitFor(() => expect(result.current.permission).toBe('prompt'));

      status.setState('granted');
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await waitFor(() => expect(result.current.permission).toBe('granted'));
    });

    it('does not re-read when visibilitychange fires while hidden', async () => {
      setSecureContext(true);
      setGetUserMedia(async () => stream({ stop: vi.fn() }));
      const query = vi.fn(() => Promise.resolve(new FakePermissionStatus('prompt')));
      Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } });

      const { result } = renderHook(() => useMicrophonePermission());
      await waitFor(() => expect(result.current.permission).toBe('prompt'));
      const callsAfterMount = query.mock.calls.length;

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      expect(query.mock.calls.length).toBe(callsAfterMount);
    });
  });

  describe('request()', () => {
    it('resolves "granted" and stops the tracks it opened', async () => {
      setSecureContext(true);
      const track = { stop: vi.fn() };
      setGetUserMedia(async () => stream(track));
      // The mock Permissions API only learns of the grant once `refresh()`
      // re-queries after `getUserMedia` resolves - exactly as a real browser
      // would only report `granted` once the permission has actually changed.
      const query = vi
        .fn()
        .mockResolvedValueOnce(new FakePermissionStatus('prompt'))
        .mockResolvedValue(new FakePermissionStatus('granted'));
      Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } });

      const { result } = renderHook(() => useMicrophonePermission());
      await waitFor(() => expect(result.current.permission).toBe('prompt'));

      let outcome: string | undefined;
      await act(async () => {
        outcome = await result.current.request();
      });

      expect(outcome).toBe('granted');
      expect(track.stop).toHaveBeenCalled();
      await waitFor(() => expect(result.current.permission).toBe('granted'));
    });

    it('sets requesting=true while getUserMedia is pending, and false once it settles', async () => {
      setSecureContext(true);
      let resolveGetUserMedia: (s: MediaStream) => void;
      setGetUserMedia(
        () =>
          new Promise<MediaStream>((resolve) => {
            resolveGetUserMedia = resolve;
          }),
      );
      setPermissionsApi({ state: 'prompt' });

      const { result } = renderHook(() => useMicrophonePermission());
      await waitFor(() => expect(result.current.permission).toBe('prompt'));

      let requestPromise!: Promise<unknown>;
      act(() => {
        requestPromise = result.current.request();
      });

      await waitFor(() => expect(result.current.requesting).toBe(true));

      await act(async () => {
        resolveGetUserMedia!(stream({ stop: vi.fn() }));
        await requestPromise;
      });

      expect(result.current.requesting).toBe(false);
    });

    it('resolves "denied" for a NotAllowedError', async () => {
      setSecureContext(true);
      setGetUserMedia(async () => Promise.reject(mediaError('NotAllowedError')));
      // Same reasoning as the "granted" case above: the mock Permissions API
      // only reports `denied` once `refresh()` re-queries after the rejection.
      const query = vi
        .fn()
        .mockResolvedValueOnce(new FakePermissionStatus('prompt'))
        .mockResolvedValue(new FakePermissionStatus('denied'));
      Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } });

      const { result } = renderHook(() => useMicrophonePermission());
      await waitFor(() => expect(result.current.permission).toBe('prompt'));

      let outcome: string | undefined;
      await act(async () => {
        outcome = await result.current.request();
      });

      expect(outcome).toBe('denied');
      await waitFor(() => expect(result.current.permission).toBe('denied'));
    });

    it('resolves "no-mic" for a NotFoundError, without changing the reported permission to denied', async () => {
      setSecureContext(true);
      setGetUserMedia(async () => Promise.reject(mediaError('NotFoundError')));
      setPermissionsApi({ state: 'prompt' });

      const { result } = renderHook(() => useMicrophonePermission());
      await waitFor(() => expect(result.current.permission).toBe('prompt'));

      let outcome: string | undefined;
      await act(async () => {
        outcome = await result.current.request();
      });

      expect(outcome).toBe('no-mic');
    });

    it('resolves "error" for an unrecognised rejection', async () => {
      setSecureContext(true);
      setGetUserMedia(async () => Promise.reject(new Error('boom')));
      setPermissionsApi({ state: 'prompt' });

      const { result } = renderHook(() => useMicrophonePermission());
      await waitFor(() => expect(result.current.permission).toBe('prompt'));

      let outcome: string | undefined;
      await act(async () => {
        outcome = await result.current.request();
      });

      expect(outcome).toBe('error');
    });

    it('resolves "error" and does not call getUserMedia when the capability is insecure', async () => {
      setSecureContext(false);
      const getUserMedia = vi.fn(async () => stream({ stop: vi.fn() }));
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
      setPermissionsApi({ state: 'prompt' });

      const { result } = renderHook(() => useMicrophonePermission());

      let outcome: string | undefined;
      await act(async () => {
        outcome = await result.current.request();
      });

      expect(outcome).toBe('error');
      expect(getUserMedia).not.toHaveBeenCalled();
    });
  });

  it('refresh() forces a re-read', async () => {
    setSecureContext(true);
    setGetUserMedia(async () => stream({ stop: vi.fn() }));
    const status = setPermissionsApi({ state: 'prompt' })!;

    const { result } = renderHook(() => useMicrophonePermission());
    await waitFor(() => expect(result.current.permission).toBe('prompt'));

    status.setState('denied');
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.permission).toBe('denied'));
  });
});
