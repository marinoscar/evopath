import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
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

afterEach(() => {
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
