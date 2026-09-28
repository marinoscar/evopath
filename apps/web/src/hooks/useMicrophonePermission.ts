/**
 * The browser's microphone permission, observed up front — and requested only
 * from a click.
 *
 * Issue #508. The Playground's Voice mode used to learn about a blocked
 * microphone only AFTER the user pressed Start: `getUserMedia` rejected with
 * `NotAllowedError` and a static "Microphone access was blocked" warning
 * appeared, with no way forward on a phone (Android Chrome in the report)
 * where the remedy lives two settings screens away. This hook lets the page
 * know BEFORE a session is attempted, so it can offer an explicit "Allow
 * microphone" button while the browser will still ask, and platform-specific
 * steps once it will not.
 *
 * MODELLED ON `useBrowserNotificationPermission.ts`, with one deliberate
 * difference: this hook DOES request, via `request()` — but only ever from a
 * user gesture (a click handler). Mobile browsers refuse or silently ignore a
 * gestureless `getUserMedia`, and prompting on page load would be exactly the
 * uninvited permission dialog users learn to dismiss.
 *
 * WHY STATE RATHER THAN A ONE-OFF READ
 * ------------------------------------
 * The value changes under the page: a user told "blocked — allow it in site
 * settings" goes to those settings and comes back. So it is re-read on:
 *
 *   1. The Permissions API's `change` event, where available — the precise,
 *     immediate signal.
 *   2. `visibilitychange` → visible, the fallback for a browser whose
 *     Permissions API does not know `microphone` (Firefox, older Safari), and
 *     precisely the moment a user returns from the OS or browser settings.
 *   3. Every `request()`, in a `finally`, whatever it resolved to.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Permission as the Voice mode needs to reason about it.
 *
 * - `'insecure'` — not a secure context (plain `http://`): browsers remove
 *   `navigator.mediaDevices` entirely, so no amount of "allow" can help; the
 *   remedy is HTTPS.
 * - `'unsupported'` — a secure context with no `getUserMedia` at all.
 * - `'unknown'` — capture exists but the browser will not say whether it is
 *   allowed (no Permissions API, or it does not know `microphone`). Not a
 *   problem: the browser simply asks when the microphone is requested.
 * - `'prompt'` / `'granted'` / `'denied'` — the Permissions API's own states.
 */
export type MicrophonePermission = 'unsupported' | 'insecure' | 'unknown' | 'prompt' | 'granted' | 'denied';

/** What `request()` resolved to. `no-mic`: allowed, but no input device exists. */
export type MicrophoneRequestResult = 'granted' | 'denied' | 'no-mic' | 'error';

/** The platform whose settings steps to show for a blocked microphone. */
export type MicPlatform = 'android' | 'ios' | 'desktop';

/**
 * Classify a user agent for the "how do I unblock it" copy — nothing else.
 *
 * iPadOS 13+ reports a desktop Safari UA ("Macintosh"); that case cannot be
 * told apart from a user agent string alone, and the desktop steps (site
 * settings in the address bar) are still a sensible answer there.
 */
export function detectMicPlatform(userAgent: string): MicPlatform {
  const ua = userAgent || '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return 'desktop';
}

/**
 * The part of the state that can be read synchronously. `null` means "capture
 * is available; ask the Permissions API".
 *
 * `isSecureContext === undefined` (jsdom, very old browsers) is treated as
 * secure — only an explicit `false` is the http:// case.
 */
function readCapability(): MicrophonePermission | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  try {
    if (window.isSecureContext === false) return 'insecure';
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return 'unsupported';
    return null;
  } catch {
    return 'unsupported';
  }
}

function mapState(state: PermissionState | string | undefined): MicrophonePermission {
  return state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unknown';
}

function isDeniedError(err: unknown): boolean {
  const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError';
}

function isNoMicError(err: unknown): boolean {
  const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
  return name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError';
}

export interface UseMicrophonePermissionResult {
  /** What the browser says right now. See `MicrophonePermission`. */
  permission: MicrophonePermission;
  /** True while `request()`'s `getUserMedia` is awaiting the user's answer. */
  requesting: boolean;
  /**
   * Ask for the microphone. MUST be called from a click handler. Opens and
   * immediately releases a stream — nothing is recorded — then re-queries.
   */
  request: () => Promise<MicrophoneRequestResult>;
  /** Force a re-read (e.g. after a Start that failed with `mic-denied`). */
  refresh: () => void;
}

export function useMicrophonePermission(): UseMicrophonePermissionResult {
  const [permission, setPermission] = useState<MicrophonePermission>(() => readCapability() ?? 'unknown');
  const [requesting, setRequesting] = useState(false);
  const mounted = useRef(true);
  // The live PermissionStatus, once the first query resolves; its `change`
  // listener is bound once and removed on unmount.
  const statusRef = useRef<PermissionStatus | null>(null);
  const onChangeRef = useRef<() => void>(() => undefined);
  // What the last `request()` learnt, for a browser whose Permissions API
  // cannot answer: re-querying there must not erase a known `denied` (or
  // `granted`) back to `unknown`.
  const learnt = useRef<'granted' | 'denied' | null>(null);

  const setIfMounted = useCallback((value: MicrophonePermission) => {
    if (mounted.current) setPermission(value);
  }, []);

  const refresh = useCallback(() => {
    const capability = readCapability();
    if (capability) {
      setIfMounted(capability);
      return;
    }
    // The `try` wraps the CALL, not just the promise: older WebKit throws a
    // synchronous TypeError for an unknown permission name. Either way the
    // answer is `unknown` — the browser will ask when the mic is requested.
    try {
      const query = navigator.permissions?.query({ name: 'microphone' as PermissionName });
      if (!query || typeof query.then !== 'function') {
        setIfMounted(learnt.current ?? 'unknown');
        return;
      }
      query
        .then((status) => {
          if (!mounted.current) return;
          if (statusRef.current !== status) {
            statusRef.current?.removeEventListener('change', onChangeRef.current);
            statusRef.current = status;
            status.addEventListener('change', onChangeRef.current);
          }
          setIfMounted(mapState(status.state));
        })
        .catch(() => setIfMounted(learnt.current ?? 'unknown'));
    } catch {
      setIfMounted(learnt.current ?? 'unknown');
    }
  }, [setIfMounted]);

  useEffect(() => {
    mounted.current = true;
    onChangeRef.current = () => {
      const status = statusRef.current;
      if (status && mounted.current) setPermission(mapState(status.state));
    };
    refresh();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      statusRef.current?.removeEventListener('change', onChangeRef.current);
      statusRef.current = null;
    };
  }, [refresh]);

  const request = useCallback(async (): Promise<MicrophoneRequestResult> => {
    const capability = readCapability();
    if (capability) {
      setIfMounted(capability);
      return 'error';
    }
    if (mounted.current) setRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Only the permission was wanted — release the device at once so the
      // browser's recording indicator does not stay lit.
      try {
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        // A stream we cannot stop is still a granted permission.
      }
      learnt.current = 'granted';
      setIfMounted('granted');
      return 'granted';
    } catch (err) {
      if (isDeniedError(err)) {
        learnt.current = 'denied';
        setIfMounted('denied');
        return 'denied';
      }
      return isNoMicError(err) ? 'no-mic' : 'error';
    } finally {
      if (mounted.current) setRequesting(false);
      // Re-query whatever happened: a dismissed prompt stays `prompt`, and a
      // Permissions API that disagrees with the request's outcome wins.
      refresh();
    }
  }, [refresh, setIfMounted]);

  return { permission, requesting, request, refresh };
}
