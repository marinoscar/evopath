/**
 * One position from the browser, asked for once, from a click.
 *
 * E3.5: a gym may carry an optional GPS position. The app never tracks the
 * user: this hook calls `navigator.geolocation.getCurrentPosition` exactly
 * once per `request()` and never `watchPosition`. It is modelled on
 * `useMicrophonePermission.ts`: the capability is read synchronously up front
 * (so the page can hide the button where it cannot work), and the request
 * itself only ever runs from a user gesture.
 *
 * WHERE THE BUTTON IS HIDDEN
 * --------------------------
 * - `'insecure'`: not a secure context (a plain-HTTP LAN address). Browsers
 *   refuse geolocation there; `http://localhost` counts as secure.
 * - `'unsupported'`: no `navigator.geolocation` at all.
 *
 * The deployment's `Permissions-Policy` grants `geolocation=(self)`
 * (`infra/nginx/nginx.conf`); an empty allowlist would make every request fail
 * with `PERMISSION_DENIED`, whatever the user chose.
 *
 * Nothing here stores or logs the position: it is handed to the caller, which
 * fills the form, and is saved only when the user presses "Save location".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type GeolocationSupport = 'supported' | 'unsupported' | 'insecure';

/** `request()`'s state: `asking` while the browser prompt or the fix is pending. */
export type GeolocationRequestState = 'idle' | 'asking' | 'error';

/** Why a request failed. The first three map the browser's error codes 1..3. */
export type GeolocationErrorCode = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export interface GeolocationFix {
  latitude: number;
  longitude: number;
  /** Radius of the 95% confidence circle, in metres, as the browser reports it. */
  accuracy: number;
}

/** The options the story fixes: coarse, bounded, a recent cached fix is fine. */
export const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 10000,
  maximumAge: 60000,
};

export const GEOLOCATION_ERROR_MESSAGE: Record<GeolocationErrorCode, string> = {
  denied: 'Location permission was denied. You can type coordinates instead.',
  unavailable: 'Your device could not determine a position.',
  timeout: 'Timed out. Try again or type coordinates.',
  unsupported: 'This browser cannot share a location here. You can type coordinates instead.',
};

export class GeolocationRequestError extends Error {
  readonly code: GeolocationErrorCode;

  constructor(code: GeolocationErrorCode) {
    super(GEOLOCATION_ERROR_MESSAGE[code]);
    this.name = 'GeolocationRequestError';
    this.code = code;
  }
}

/**
 * Whether a one-shot position can be requested here.
 *
 * `isSecureContext === undefined` (jsdom, very old browsers) is treated as
 * secure; only an explicit `false` is the plain-HTTP case.
 */
export function readGeolocationSupport(): GeolocationSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  try {
    if (window.isSecureContext === false) return 'insecure';
    if (!('geolocation' in navigator) || !navigator.geolocation) return 'unsupported';
    if (typeof navigator.geolocation.getCurrentPosition !== 'function') return 'unsupported';
    return 'supported';
  } catch {
    return 'unsupported';
  }
}

/** `GeolocationPositionError.code`: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT. */
function mapErrorCode(err: unknown): GeolocationErrorCode {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code === 1) return 'denied';
  if (code === 3) return 'timeout';
  return 'unavailable';
}

export interface UseGeolocationOnceResult {
  support: GeolocationSupport;
  state: GeolocationRequestState;
  /** The last failure, or null. Cleared by the next `request()` or `reset()`. */
  error: GeolocationRequestError | null;
  /** Ask for one position. MUST be called from a click handler. */
  request: () => Promise<GeolocationFix>;
  /** Back to `idle` (e.g. once the user starts typing coordinates). */
  reset: () => void;
}

export function useGeolocationOnce(): UseGeolocationOnceResult {
  const [support] = useState<GeolocationSupport>(readGeolocationSupport);
  const [state, setState] = useState<GeolocationRequestState>('idle');
  const [error, setError] = useState<GeolocationRequestError | null>(null);
  const mounted = useRef(true);
  // A second click while the prompt is open joins the pending request instead
  // of asking the browser again.
  const inFlight = useRef<Promise<GeolocationFix> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fail = useCallback((code: GeolocationErrorCode) => {
    const failure = new GeolocationRequestError(code);
    if (mounted.current) {
      setError(failure);
      setState('error');
    }
    return failure;
  }, []);

  const request = useCallback((): Promise<GeolocationFix> => {
    if (inFlight.current) return inFlight.current;
    if (readGeolocationSupport() !== 'supported') return Promise.reject(fail('unsupported'));

    setError(null);
    setState('asking');
    const pending = new Promise<GeolocationFix>((resolve, reject) => {
      try {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            if (mounted.current) setState('idle');
            resolve({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
            });
          },
          (err) => reject(fail(mapErrorCode(err))),
          GEOLOCATION_OPTIONS,
        );
      } catch {
        reject(fail('unavailable'));
      }
    }).finally(() => {
      inFlight.current = null;
    });
    inFlight.current = pending;
    return pending;
  }, [fail]);

  const reset = useCallback(() => {
    setError(null);
    setState((prev) => (prev === 'asking' ? prev : 'idle'));
  }, []);

  return { support, state, error, request, reset };
}
