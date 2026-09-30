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
 * PERMISSION STATE (issue #121)
 * -----------------------------
 * `permission` mirrors the Permissions API (`navigator.permissions.query({
 * name: 'geolocation' })`): `'granted'`, `'prompt'`, `'denied'`, or
 * `'unknown'` where the API is missing or refuses (older Safari, jsdom). It is
 * read once on mount and kept current through the status's `change` event, so
 * a user who unblocks the site in the browser's settings sees the "blocked"
 * guidance go away without a reload. It is purely what the API reports; a
 * failed request's code is the separate `error`. Once a browser remembers a
 * block it never prompts again, so the page needs `permission` to explain how
 * to lift it. Reading the permission never asks the user anything.
 *
 * Nothing here stores or logs the position: it is handed to the caller, which
 * fills the form, and is saved only when the user presses "Save location".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type GeolocationSupport = 'supported' | 'unsupported' | 'insecure';

/** `request()`'s state: `asking` while the browser prompt or the fix is pending. */
export type GeolocationRequestState = 'idle' | 'asking' | 'error';

/** What the Permissions API reports for geolocation; `unknown` where it cannot tell. */
export type GeolocationPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

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

function toPermission(state: unknown): GeolocationPermission {
  return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unknown';
}

/** `navigator.permissions` when it has a callable `query`, else null. Never throws. */
function readPermissionsApi(): Permissions | null {
  try {
    if (typeof navigator === 'undefined') return null;
    const api = navigator.permissions;
    return api && typeof api.query === 'function' ? api : null;
  } catch {
    return null;
  }
}

export interface UseGeolocationOnceResult {
  support: GeolocationSupport;
  /** The browser's remembered geolocation permission for this site. */
  permission: GeolocationPermission;
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
  const [error, setErrorState] = useState<GeolocationRequestError | null>(null);
  const [permission, setPermission] = useState<GeolocationPermission>('unknown');
  // The current error, readable from the permission `change` listener.
  const errorRef = useRef<GeolocationRequestError | null>(null);
  const setError = useCallback((next: GeolocationRequestError | null) => {
    errorRef.current = next;
    setErrorState(next);
  }, []);
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

  // Read the remembered permission and follow its changes. Every step is
  // guarded: the API may be missing, `query` may throw or reject (Firefox
  // before 46, jsdom), and the status may lack `addEventListener`.
  useEffect(() => {
    const api = readPermissionsApi();
    if (!api) return undefined;
    let cancelled = false;
    let status: PermissionStatus | null = null;

    const apply = () => {
      if (cancelled || !status) return;
      const next = toPermission(status.state);
      setPermission(next);
      // The user lifted the block (in site settings): the "denied" failure no
      // longer describes the situation, so go back to idle.
      if ((next === 'granted' || next === 'prompt') && errorRef.current?.code === 'denied') {
        setError(null);
        setState((prev) => (prev === 'error' ? 'idle' : prev));
      }
    };

    let query: Promise<PermissionStatus>;
    try {
      query = api.query({ name: 'geolocation' as PermissionName });
    } catch {
      return undefined;
    }
    Promise.resolve(query)
      .then((result) => {
        if (cancelled || !result) return;
        status = result;
        apply();
        if (typeof result.addEventListener === 'function') result.addEventListener('change', apply);
      })
      .catch(() => {
        // Stays 'unknown'.
      });

    return () => {
      cancelled = true;
      if (status && typeof status.removeEventListener === 'function') {
        status.removeEventListener('change', apply);
      }
    };
  }, [setError]);

  const fail = useCallback(
    (code: GeolocationErrorCode) => {
      const failure = new GeolocationRequestError(code);
      if (mounted.current) {
        setError(failure);
        setState('error');
      }
      return failure;
    },
    [setError],
  );

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
  }, [fail, setError]);

  const reset = useCallback(() => {
    setError(null);
    setState((prev) => (prev === 'asking' ? prev : 'idle'));
  }, [setError]);

  return { support, permission, state, error, request, reset };
}
