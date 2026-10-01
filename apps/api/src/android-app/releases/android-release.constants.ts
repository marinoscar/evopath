import { ANDROID_APK_STEM, ANDROID_PACKAGE_NAME } from '@app/shared';

import { ANDROID_RELEASES_KEY_PREFIX } from '../../storage/storage-key-prefixes';

// =============================================================================
// Android APK releases (issue #285, epic #276) — constants
// =============================================================================
//
// The deployment hosts the Android app's APKs itself: an administrator (or
// `evopathcli android publish`) uploads a signed APK, users download it
// through a short-lived signed link, and paired devices learn whether an
// update is available. The bytes live in object storage under
// `android-releases/`; the `android_app_releases` row holds the key.
// =============================================================================

/** The largest APK accepted, in bytes (150 MiB). */
export const MAX_APK_BYTES = 150 * 1024 * 1024;

/** Android's own ceiling on `versionCode` is 2_100_000_000. */
export const MIN_VERSION_CODE = 1;
export const MAX_VERSION_CODE = 2_100_000_000;

export const MAX_VERSION_NAME_LENGTH = 50;
export const MAX_RELEASE_NOTES_LENGTH = 2000;

/** Every APK is a ZIP: local file header signature `PK\x03\x04`. */
export const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export const APK_MIME_TYPE = 'application/vnd.android.package-archive';

/** The multipart field carrying the APK. */
export const APK_FILE_FIELD = 'apk';

/** How long a download link works. */
export const DOWNLOAD_LINK_TTL_SECONDS = 10 * 60;

/** `deriveSigningKey` purpose of the download-link HMAC key. */
export const DOWNLOAD_TOKEN_KEY_PURPOSE = 'android-app-download';

/** Path (under `/api`) a download link points at. */
export const DOWNLOAD_ROUTE_PREFIX = '/api/android-app/download/';

/** The raw-SQL partial unique index: at most one current release. */
export const ONE_CURRENT_RELEASE_INDEX = 'android_app_releases_one_current_uniq_idx';

/** Refusal reasons, published under `details.reason`. */
export const ANDROID_RELEASE_REASONS = {
  VERSION_EXISTS: 'RELEASE_VERSION_EXISTS',
  VERSION_NOT_NEWER: 'RELEASE_VERSION_NOT_NEWER',
  IS_CURRENT: 'RELEASE_IS_CURRENT',
  CURRENT_CONFLICT: 'RELEASE_CURRENT_CONFLICT',
  NOT_FOUND: 'RELEASE_NOT_FOUND',
  NO_RELEASE: 'NO_RELEASE',
  NOT_AN_APK: 'RELEASE_NOT_AN_APK',
  TOO_LARGE: 'RELEASE_TOO_LARGE',
  INVALID_UPLOAD: 'RELEASE_INVALID_UPLOAD',
  LINK_INVALID: 'DOWNLOAD_LINK_INVALID',
  LINK_EXPIRED: 'DOWNLOAD_LINK_EXPIRED',
} as const;

/** Audit actions. */
export const ANDROID_RELEASE_AUDIT = {
  UPLOADED: 'android_app.release.uploaded',
  MADE_CURRENT: 'android_app.release.made_current',
  DELETED: 'android_app.release.deleted',
} as const;

/** The storage key of a release's APK. Server-chosen only (the release id). */
export function androidReleaseKey(releaseId: string): string {
  return `${ANDROID_RELEASES_KEY_PREFIX}${releaseId}.apk`;
}

/**
 * The Android app's applicationId as the identity derives it
 * (`com.<repo>.android`, from `@app/shared`). Documentation only: an upload
 * names its own package, and the server never assumes this one.
 */
export const DEFAULT_ANDROID_PACKAGE_NAME = ANDROID_PACKAGE_NAME;

/**
 * The download's file name, `<app slug>-android-<versionName>.apk` (the stem comes
 * from `@app/shared`, so a renamed fork serves its own name). `versionName` is
 * validated to `[0-9A-Za-z._+-]`.
 */
export function apkFileName(versionName: string): string {
  return `${ANDROID_APK_STEM}-${versionName}.apk`;
}
