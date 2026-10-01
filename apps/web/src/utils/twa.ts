/**
 * Is this page running inside the Android app's Trusted Web Activity?
 * Issue #283, epic #276.
 *
 * The TWA launcher opens `${server}/?source=twa`. The query string is gone
 * after the first in-app navigation, so `captureTwaLaunch()` runs once at
 * startup (`main.tsx`) and remembers it in `sessionStorage`, which lives
 * exactly as long as the TWA's browsing session. A TWA also reports its
 * referrer as `android-app://<package>`, which covers a launch the flag
 * missed.
 *
 * Presentation only: the answer decides whether to OFFER a deep link into the
 * native Health sync screen. It grants nothing.
 */

export const TWA_SESSION_KEY = 'evopath.twa';
export const TWA_SOURCE_PARAM = 'source';
export const TWA_SOURCE_VALUE = 'twa';

function readSession(): string | null {
  try {
    return window.sessionStorage.getItem(TWA_SESSION_KEY);
  } catch {
    return null;
  }
}

/** Remember a `?source=twa` launch for the rest of this session. Safe to call more than once. */
export function captureTwaLaunch(search: string = window.location.search): void {
  try {
    if (new URLSearchParams(search).get(TWA_SOURCE_PARAM) === TWA_SOURCE_VALUE) {
      window.sessionStorage.setItem(TWA_SESSION_KEY, '1');
    }
  } catch {
    // Storage blocked: fall back to the referrer check below.
  }
}

/** True inside the Android app's TWA (flag captured at launch, or an `android-app://` referrer). */
export function isRunningInTwa(): boolean {
  if (readSession() === '1') return true;
  return typeof document !== 'undefined' && document.referrer.startsWith('android-app://');
}
