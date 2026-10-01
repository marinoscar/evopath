import { z } from 'zod';

// =============================================================================
// Android app trust and Digital Asset Links (issue #279, epic #276)
// =============================================================================
//
// The Android app is a Trusted Web Activity: Chrome only shows the site
// full-screen (no URL bar) when `/.well-known/assetlinks.json` on this origin
// names the app's package AND the SHA-256 fingerprint of the certificate it
// was signed with. Those two facts are deployment-specific (every fork signs
// with its own key, debug builds with a throwaway one), so they are RUNTIME
// configuration, never an environment variable: an administrator lists the
// trusted apps in Admin → Settings → Android app.
//
// STORAGE. Its own `system_settings` row (`key = 'android_app'`, value
// `{ trustedApps: [...] }`) rather than a namespace of the `global` row, the
// same choice `email` and `telemetry_connection` made: the list has its own
// lifecycle and audit trail, its own version counter, and a save of an
// unrelated setting can never clobber it (read `system-settings.service.ts`'s
// header for the failure that avoids).
// =============================================================================

/** `system_settings.key` of the row holding the trusted apps. */
export const ANDROID_APP_SETTINGS_KEY = 'android_app';

/** Audit action written on every save. */
export const ANDROID_APP_TRUSTED_APPS_UPDATED_ACTION = 'android_app.trusted_apps.updated';

/** The most trusted apps a deployment may list. Debug + release + a spare or two. */
export const MAX_TRUSTED_ANDROID_APPS = 10;

/** The relation Chrome checks for a TWA. */
export const ASSET_LINKS_RELATION = 'delegate_permission/common.handle_all_urls';

/**
 * An Android application id: at least two dot-separated segments, each
 * starting with a letter (the rule `aapt` enforces).
 */
export const ANDROID_PACKAGE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** A SHA-256 certificate fingerprint as `keytool` prints it: 32 colon-separated hex bytes, uppercase. */
export const SHA256_FINGERPRINT_PATTERN = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export const androidPackageNameSchema = z
  .string()
  .trim()
  .max(255)
  .regex(ANDROID_PACKAGE_NAME_PATTERN, 'packageName must be an Android application id such as com.example.app');

/**
 * Accepted in either case (keytool prints uppercase, some tools lowercase) and
 * NORMALISED TO UPPERCASE, so a fingerprint compares equal however it was
 * pasted and assetlinks.json always publishes one spelling.
 */
export const sha256FingerprintSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .regex(
        SHA256_FINGERPRINT_PATTERN,
        'sha256 must be a SHA-256 certificate fingerprint: 32 colon-separated hex bytes (AA:BB:…)',
      ),
  );

export const trustedAndroidAppSchema = z.object({
  packageName: androidPackageNameSchema,
  sha256: sha256FingerprintSchema,
});

export type TrustedAndroidApp = z.output<typeof trustedAndroidAppSchema>;

/** Drops repeated (packageName, sha256) pairs, keeping the first occurrence and the order. */
export function dedupeTrustedApps(apps: readonly TrustedAndroidApp[]): TrustedAndroidApp[] {
  const seen = new Set<string>();
  const result: TrustedAndroidApp[] = [];

  for (const app of apps) {
    const key = trustedAppKey(app.packageName, app.sha256);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ packageName: app.packageName, sha256: app.sha256 });
  }

  return result;
}

/** The list as submitted and as stored: at most ten, normalised, de-duplicated. */
export const trustedAndroidAppsSchema = z
  .array(trustedAndroidAppSchema)
  .max(MAX_TRUSTED_ANDROID_APPS, `At most ${MAX_TRUSTED_ANDROID_APPS} trusted apps`)
  .transform(dedupeTrustedApps);

/** The stored row's value. */
export const androidAppSettingsValueSchema = z.object({
  trustedApps: trustedAndroidAppsSchema,
});

export type AndroidAppSettingsValue = z.output<typeof androidAppSettingsValueSchema>;

/** One pair's identity for comparisons. Fingerprints compare case-insensitively. */
export function trustedAppKey(packageName: string, sha256: string): string {
  return `${packageName}\u0000${sha256.toUpperCase()}`;
}

/** One Digital Asset Links statement, exactly as Chrome reads it. */
export interface AssetLinkStatement {
  relation: string[];
  target: {
    namespace: 'android_app';
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

/**
 * The body of `/.well-known/assetlinks.json`: ONE statement per package, its
 * fingerprints grouped under it (a debug and a release key of the same app are
 * one statement with two fingerprints). Packages appear in the order they are
 * first listed; `[]` when nothing is trusted.
 */
export function buildAssetLinks(apps: readonly TrustedAndroidApp[]): AssetLinkStatement[] {
  const byPackage = new Map<string, string[]>();

  for (const app of apps) {
    const fingerprints = byPackage.get(app.packageName) ?? [];
    const sha256 = app.sha256.toUpperCase();
    if (!fingerprints.includes(sha256)) fingerprints.push(sha256);
    byPackage.set(app.packageName, fingerprints);
  }

  return [...byPackage.entries()].map(([packageName, fingerprints]) => ({
    relation: [ASSET_LINKS_RELATION],
    target: {
      namespace: 'android_app',
      package_name: packageName,
      sha256_cert_fingerprints: fingerprints,
    },
  }));
}
