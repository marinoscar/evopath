/** `utils/twa.ts` (#283): TWA launch capture and detection. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TWA_SESSION_KEY, captureTwaLaunch, isRunningInTwa } from '../../utils/twa';

function setReferrer(value: string) {
  Object.defineProperty(document, 'referrer', { value, configurable: true });
}

describe('twa utils', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    setReferrer('');
  });

  afterEach(() => {
    window.sessionStorage.clear();
    setReferrer('');
  });

  it('is false in a plain browser tab', () => {
    captureTwaLaunch('?foo=bar');
    expect(isRunningInTwa()).toBe(false);
  });

  it('remembers a ?source=twa launch for the session', () => {
    captureTwaLaunch('?source=twa');
    expect(window.sessionStorage.getItem(TWA_SESSION_KEY)).toBe('1');
    // Later navigations carry no query string; the flag still answers.
    captureTwaLaunch('');
    expect(isRunningInTwa()).toBe(true);
  });

  it('ignores another source value', () => {
    captureTwaLaunch('?source=pwa');
    expect(isRunningInTwa()).toBe(false);
  });

  it('detects an android-app:// referrer without the flag', () => {
    setReferrer('android-app://com.evopath.android/');
    expect(isRunningInTwa()).toBe(true);
  });
});
