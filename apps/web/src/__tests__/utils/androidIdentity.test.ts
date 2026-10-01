/**
 * The Android identity helper (issue #276): every value follows the shared
 * identity, so these assertions apply the rule to the live values rather than
 * pinning today's literals.
 */
import { describe, expect, it } from 'vitest';
import { ANDROID_APK_STEM, ANDROID_DEEP_LINK_SCHEME, APP_NAME, APP_SLUG } from '@app/shared';
import {
  ANDROID_APP_LABEL,
  ANDROID_HEALTH_SYNC_DEEP_LINK,
  ANDROID_PACKAGE_NAME,
  ANDROID_RELEASE_APK_ASSET,
  androidApkFileName,
  androidMetadataFileName,
  androidStorageKey,
} from '../../utils/androidIdentity';
import { ANDROID_PACKAGE_PATTERN } from '../../services/healthSync';

describe('androidIdentity', () => {
  it('names a valid Android package', () => {
    expect(ANDROID_PACKAGE_PATTERN.test(ANDROID_PACKAGE_NAME)).toBe(true);
    expect(ANDROID_PACKAGE_NAME).toMatch(/^com\.[a-z0-9]+\.android$/);
  });

  it('labels the app with the product name', () => {
    expect(ANDROID_APP_LABEL).toBe(APP_NAME);
  });

  it('builds the Health sync deep link from the scheme', () => {
    expect(ANDROID_HEALTH_SYNC_DEEP_LINK).toBe(`${ANDROID_DEEP_LINK_SCHEME}://health-sync`);
  });

  it('builds APK and metadata file names from the stem', () => {
    expect(ANDROID_RELEASE_APK_ASSET).toBe(`${ANDROID_APK_STEM}.apk`);
    expect(androidApkFileName('1.2.3')).toBe(`${ANDROID_APK_STEM}-1.2.3.apk`);
    expect(androidMetadataFileName('1.2.3')).toBe(`${ANDROID_APK_STEM}-1.2.3.json`);
  });

  it('prefixes storage keys with the app slug', () => {
    expect(androidStorageKey('twa')).toBe(`${APP_SLUG}.twa`);
  });
});
