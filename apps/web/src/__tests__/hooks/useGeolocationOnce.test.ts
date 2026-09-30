import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  GEOLOCATION_ERROR_MESSAGE,
  GEOLOCATION_OPTIONS,
  GeolocationRequestError,
  readGeolocationSupport,
  useGeolocationOnce,
} from '../../hooks/useGeolocationOnce';

/**
 * E3.5. One position, from a click: `getCurrentPosition` exactly once per
 * `request()` with the story's options, never `watchPosition`, and the three
 * browser error codes mapped to their messages.
 */

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');

type Success = (position: GeolocationPosition) => void;
type Failure = (error: GeolocationPositionError) => void;

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
}

function installGeolocation(behaviour: (success: Success, failure: Failure) => void) {
  const getCurrentPosition = vi.fn((success: Success, failure: Failure) => behaviour(success, failure));
  const watchPosition = vi.fn();
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition, watchPosition, clearWatch: vi.fn() },
  });
  return { getCurrentPosition, watchPosition };
}

function removeGeolocation() {
  // `delete` so that `'geolocation' in navigator` is false, not just undefined.
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
  delete (navigator as unknown as Record<string, unknown>).geolocation;
}

function position(latitude: number, longitude: number, accuracy: number): GeolocationPosition {
  return { coords: { latitude, longitude, accuracy }, timestamp: Date.now() } as unknown as GeolocationPosition;
}

function positionError(code: number): GeolocationPositionError {
  return { code, message: 'x', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError;
}

const originalPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');

/** A controllable PermissionStatus: `set(state)` mutates it and fires `change`. */
function installPermissions(initial: string) {
  const listeners = new Set<() => void>();
  const status = {
    state: initial,
    addEventListener: vi.fn((_type: string, fn: () => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_type: string, fn: () => void) => listeners.delete(fn)),
  };
  const query = vi.fn(() => Promise.resolve(status));
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } });
  return {
    query,
    status,
    listeners,
    set(state: string) {
      status.state = state;
      [...listeners].forEach((fn) => fn());
    },
  };
}

afterEach(() => {
  if (originalPermissions) Object.defineProperty(navigator, 'permissions', originalPermissions);
  else delete (navigator as unknown as Record<string, unknown>).permissions;
  if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
  else delete (window as unknown as Record<string, unknown>).isSecureContext;
  if (originalGeolocation) Object.defineProperty(navigator, 'geolocation', originalGeolocation);
  else delete (navigator as unknown as Record<string, unknown>).geolocation;
});

describe('readGeolocationSupport', () => {
  it('is supported in a secure context with navigator.geolocation', () => {
    setSecureContext(true);
    installGeolocation(() => undefined);
    expect(readGeolocationSupport()).toBe('supported');
  });

  it('is unsupported without navigator.geolocation', () => {
    setSecureContext(true);
    removeGeolocation();
    expect('geolocation' in navigator).toBe(false);
    expect(readGeolocationSupport()).toBe('unsupported');
  });

  it('is insecure outside a secure context, even with navigator.geolocation', () => {
    setSecureContext(false);
    installGeolocation(() => undefined);
    expect(readGeolocationSupport()).toBe('insecure');
  });
});

describe('useGeolocationOnce', () => {
  it('asks once with the fixed options and resolves the fix; never watchPosition', async () => {
    setSecureContext(true);
    const geo = installGeolocation((success) => success(position(9.934, -84.08, 25)));
    const { result } = renderHook(() => useGeolocationOnce());
    expect(result.current.support).toBe('supported');
    expect(result.current.state).toBe('idle');

    let fix: Awaited<ReturnType<typeof result.current.request>> | undefined;
    await act(async () => {
      fix = await result.current.request();
    });

    expect(fix).toEqual({ latitude: 9.934, longitude: -84.08, accuracy: 25 });
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(geo.getCurrentPosition.mock.calls[0]![2]).toEqual({
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 60000,
    });
    expect(GEOLOCATION_OPTIONS).toEqual({ enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('is asking while the prompt is open, and a second call joins the pending request', async () => {
    setSecureContext(true);
    let answer: Success | undefined;
    const geo = installGeolocation((success) => {
      answer = success;
    });
    const { result } = renderHook(() => useGeolocationOnce());

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.request();
    });
    expect(result.current.state).toBe('asking');
    act(() => {
      second = result.current.request();
    });
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer!(position(1, 2, 3));
      await Promise.all([first, second]);
    });
    expect(result.current.state).toBe('idle');
  });

  it.each([
    [1, 'denied', 'Location permission was denied. You can type coordinates instead.'],
    [2, 'unavailable', 'Your device could not determine a position.'],
    [3, 'timeout', 'Timed out. Try again or type coordinates.'],
  ] as const)('maps error code %i to %s', async (code, mapped, message) => {
    setSecureContext(true);
    installGeolocation((_success, failure) => failure(positionError(code)));
    const { result } = renderHook(() => useGeolocationOnce());

    let caught: unknown;
    await act(async () => {
      await result.current.request().catch((err: unknown) => {
        caught = err;
      });
    });

    expect(caught).toBeInstanceOf(GeolocationRequestError);
    expect((caught as GeolocationRequestError).code).toBe(mapped);
    expect(result.current.state).toBe('error');
    expect(result.current.error?.message).toBe(message);
    expect(GEOLOCATION_ERROR_MESSAGE[mapped]).toBe(message);

    act(() => result.current.reset());
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('rejects without asking when geolocation is absent', async () => {
    setSecureContext(true);
    removeGeolocation();
    const { result } = renderHook(() => useGeolocationOnce());
    expect(result.current.support).toBe('unsupported');

    let caught: unknown;
    await act(async () => {
      await result.current.request().catch((err: unknown) => {
        caught = err;
      });
    });
    expect((caught as GeolocationRequestError).code).toBe('unsupported');
  });

  it('never asks outside a secure context', async () => {
    setSecureContext(false);
    const geo = installGeolocation((success) => success(position(1, 2, 3)));
    const { result } = renderHook(() => useGeolocationOnce());
    expect(result.current.support).toBe('insecure');

    await act(async () => {
      await result.current.request().catch(() => undefined);
    });
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
  });
});

describe('useGeolocationOnce permission (issue #121)', () => {
  it.each(['granted', 'prompt', 'denied'] as const)('reports %s from the Permissions API', async (state) => {
    setSecureContext(true);
    installGeolocation(() => undefined);
    const perms = installPermissions(state);
    const { result } = renderHook(() => useGeolocationOnce());
    expect(result.current.permission).toBe('unknown');
    await waitFor(() => expect(result.current.permission).toBe(state));
    expect(perms.query).toHaveBeenCalledWith({ name: 'geolocation' });
  });

  it('is unknown without the Permissions API', () => {
    setSecureContext(true);
    installGeolocation(() => undefined);
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
    const { result } = renderHook(() => useGeolocationOnce());
    expect(result.current.permission).toBe('unknown');
  });

  it('is unknown when the state is not a known value', async () => {
    setSecureContext(true);
    installGeolocation(() => undefined);
    const perms = installPermissions('weird');
    const { result } = renderHook(() => useGeolocationOnce());
    await waitFor(() => expect(perms.status.addEventListener).toHaveBeenCalled());
    expect(result.current.permission).toBe('unknown');
  });

  it('stays unknown when query rejects', async () => {
    setSecureContext(true);
    installGeolocation(() => undefined);
    const query = vi.fn(() => Promise.reject(new TypeError('unsupported')));
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } });
    const { result } = renderHook(() => useGeolocationOnce());
    await waitFor(() => expect(query).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.permission).toBe('unknown');
  });

  it('stays unknown when query throws synchronously', () => {
    setSecureContext(true);
    installGeolocation(() => undefined);
    const query = vi.fn(() => {
      throw new Error('boom');
    });
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } });
    const { result } = renderHook(() => useGeolocationOnce());
    expect(query).toHaveBeenCalled();
    expect(result.current.permission).toBe('unknown');
  });

  it('follows change events', async () => {
    setSecureContext(true);
    installGeolocation(() => undefined);
    const perms = installPermissions('prompt');
    const { result } = renderHook(() => useGeolocationOnce());
    await waitFor(() => expect(result.current.permission).toBe('prompt'));

    act(() => perms.set('denied'));
    expect(result.current.permission).toBe('denied');
    act(() => perms.set('granted'));
    expect(result.current.permission).toBe('granted');
  });

  it('clears a denied error back to idle when the block is lifted', async () => {
    setSecureContext(true);
    installGeolocation((_s, failure) => failure(positionError(1)));
    const perms = installPermissions('denied');
    const { result } = renderHook(() => useGeolocationOnce());
    await waitFor(() => expect(result.current.permission).toBe('denied'));

    await act(async () => {
      await result.current.request().catch(() => undefined);
    });
    expect(result.current.state).toBe('error');
    expect(result.current.error?.code).toBe('denied');

    act(() => perms.set('prompt'));
    expect(result.current.permission).toBe('prompt');
    expect(result.current.error).toBeNull();
    expect(result.current.state).toBe('idle');
  });

  it('keeps a non-denied error when the permission changes', async () => {
    setSecureContext(true);
    installGeolocation((_s, failure) => failure(positionError(3)));
    const perms = installPermissions('prompt');
    const { result } = renderHook(() => useGeolocationOnce());
    await waitFor(() => expect(result.current.permission).toBe('prompt'));

    await act(async () => {
      await result.current.request().catch(() => undefined);
    });
    act(() => perms.set('granted'));
    expect(result.current.error?.code).toBe('timeout');
    expect(result.current.state).toBe('error');
  });

  it('keeps a denied error while the permission stays denied', async () => {
    setSecureContext(true);
    installGeolocation((_s, failure) => failure(positionError(1)));
    const perms = installPermissions('denied');
    const { result } = renderHook(() => useGeolocationOnce());
    await waitFor(() => expect(result.current.permission).toBe('denied'));
    await act(async () => {
      await result.current.request().catch(() => undefined);
    });
    act(() => perms.set('denied'));
    expect(result.current.error?.code).toBe('denied');
  });

  it('removes the change listener on unmount and never watches', async () => {
    setSecureContext(true);
    const geo = installGeolocation(() => undefined);
    const perms = installPermissions('prompt');
    const { result, unmount } = renderHook(() => useGeolocationOnce());
    await waitFor(() => expect(result.current.permission).toBe('prompt'));
    expect(perms.listeners.size).toBe(1);

    unmount();
    expect(perms.status.removeEventListener).toHaveBeenCalledTimes(1);
    expect(perms.listeners.size).toBe(0);
    expect(geo.watchPosition).not.toHaveBeenCalled();
  });
});
