/**
 * The Android app's identity as the web app names it (issue #276).
 *
 * Every value derives from `packages/shared/identity.json` through
 * `@app/shared`, the same rule the Android build, the API and the CLI apply,
 * so a renamed fork offers its own package, deep link and APK names with no
 * edit here:
 *
 *   - applicationId      `com.<repo name, lowercased, alphanumerics only>.android`
 *   - deep-link scheme   `<repo name, lowercased>-android`
 *   - app label          the product name
 *   - APK file names     `<repo name>-android-<versionName>.apk` (plus the
 *                        `.json` metadata the CLI writes beside it), and
 *                        `<repo name>-android.apk` on the GitHub release
 *
 * Browser storage keys for the Android surfaces are prefixed with the app slug
 * so two apps built from this template on one origin never share them.
 */
import { ANDROID_APK_STEM, ANDROID_DEEP_LINK_SCHEME, ANDROID_PACKAGE_NAME, APP_NAME, APP_SLUG } from '@app/shared';

export { ANDROID_PACKAGE_NAME, ANDROID_DEEP_LINK_SCHEME };

/** The name the app carries on the phone's launcher. */
export const ANDROID_APP_LABEL = APP_NAME;

/** The deep link `HealthSyncActivity` answers on the phone. */
export const ANDROID_HEALTH_SYNC_DEEP_LINK = `${ANDROID_DEEP_LINK_SCHEME}://health-sync`;

/** The APK asset on the rolling GitHub release. */
export const ANDROID_RELEASE_APK_ASSET = `${ANDROID_APK_STEM}.apk`;

/** A versioned APK, as the CLI builds it and the server serves it. */
export function androidApkFileName(versionName: string): string {
  return `${ANDROID_APK_STEM}-${versionName}.apk`;
}

/** The build metadata the CLI writes next to a versioned APK. */
export function androidMetadataFileName(versionName: string): string {
  return `${ANDROID_APK_STEM}-${versionName}.json`;
}

/** A browser storage key for an Android surface: `<app slug>.<name>`. */
export function androidStorageKey(name: string): string {
  return `${APP_SLUG}.${name}`;
}
