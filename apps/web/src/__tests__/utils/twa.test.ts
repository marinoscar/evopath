/** `utils/twa.ts` (#283): TWA launch capture and detection. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TWA_SESSION_KEY, captureTwaLaunch, getInstalledAppVersion, isRunningInTwa } from '../../utils/twa';
import { ANDROID_PACKAGE_NAME } from '../../utils/androidIdentity';

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
    setReferrer(`android-app://${ANDROID_PACKAGE_NAME}/`);
    expect(isRunningInTwa()).toBe(true);
  });

  it('captures the installed app version from the launch URL (#287)', () => {
    captureTwaLaunch('?source=twa&appVersion=0.1.0&appVersionCode=1');
    captureTwaLaunch('');
    expect(getInstalledAppVersion()).toEqual({ versionName: '0.1.0', versionCode: 1 });
  });

  it('has no installed version outside the TWA or without a code', () => {
    captureTwaLaunch('?appVersion=0.1.0&appVersionCode=1');
    expect(getInstalledAppVersion()).toBeNull();
    captureTwaLaunch('?source=twa&appVersion=0.1.0');
    expect(getInstalledAppVersion()).toBeNull();
  });

  it('ignores a malformed version code', () => {
    captureTwaLaunch('?source=twa&appVersionCode=abc');
    expect(getInstalledAppVersion()).toBeNull();
  });
});
