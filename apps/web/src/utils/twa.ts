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
/** The launch URL also names the installed build (#287): `&appVersion=<name>&appVersionCode=<code>`. */
export const TWA_APP_VERSION_PARAM = 'appVersion';
export const TWA_APP_VERSION_CODE_PARAM = 'appVersionCode';
export const TWA_APP_VERSION_KEY = 'evopath.twa.appVersion';
export const TWA_APP_VERSION_CODE_KEY = 'evopath.twa.appVersionCode';

/** The Android app build this TWA was launched from. */
export interface InstalledAppVersion {
  versionName: string | null;
  versionCode: number;
}

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
    const params = new URLSearchParams(search);
    if (params.get(TWA_SOURCE_PARAM) === TWA_SOURCE_VALUE) {
      window.sessionStorage.setItem(TWA_SESSION_KEY, '1');
      const name = params.get(TWA_APP_VERSION_PARAM);
      const code = params.get(TWA_APP_VERSION_CODE_PARAM);
      if (name) window.sessionStorage.setItem(TWA_APP_VERSION_KEY, name.slice(0, 50));
      if (code && /^\d{1,10}$/.test(code)) window.sessionStorage.setItem(TWA_APP_VERSION_CODE_KEY, code);
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

/**
 * The installed app's version as its TWA launch URL reported it, or `null`
 * outside the TWA or for an older build that sends no `appVersionCode`.
 * Presentation only: it decides whether to SAY an update exists.
 */
export function getInstalledAppVersion(): InstalledAppVersion | null {
  if (!isRunningInTwa()) return null;
  try {
    const code = Number(window.sessionStorage.getItem(TWA_APP_VERSION_CODE_KEY));
    if (!Number.isInteger(code) || code <= 0) return null;
    return { versionName: window.sessionStorage.getItem(TWA_APP_VERSION_KEY), versionCode: code };
  } catch {
    return null;
  }
}
