import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// =============================================================================
// Gradle invocation for apps/android  (issue #286, epic #276)
// =============================================================================

export const DEFAULT_PACKAGE_NAME = 'com.evopath.android';

export function gradlewPath(projectDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(projectDir, platform === 'win32' ? 'gradlew.bat' : 'gradlew');
}

/** `applicationId = "…"` from app/build.gradle.kts, falling back to the known id. */
export function readApplicationId(projectDir: string): string {
  const file = join(projectDir, 'app', 'build.gradle.kts');
  if (!existsSync(file)) return DEFAULT_PACKAGE_NAME;
  const match = /applicationId\s*=\s*"([^"]+)"/.exec(readFileSync(file, 'utf8'));
  return match?.[1] ?? DEFAULT_PACKAGE_NAME;
}

export interface GradleArgsInput {
  debug: boolean;
  versionName: string;
  versionCode: number;
  serverUrl?: string | undefined;
  extra?: readonly string[] | undefined;
}

/**
 * Arguments for `gradlew`. The version is passed as `-Pevopath.*` explicitly
 * so the build carries version.properties' values even on a checkout whose
 * Gradle script does not read the file yet.
 */
export function gradleArgs(input: GradleArgsInput): string[] {
  return [
    input.debug ? 'assembleDebug' : 'assembleRelease',
    `-Pevopath.versionName=${input.versionName}`,
    `-Pevopath.versionCode=${input.versionCode}`,
    ...(input.serverUrl !== undefined ? [`-Pevopath.serverUrl=${input.serverUrl}`] : []),
    '--console=plain',
    ...(input.extra ?? []),
  ];
}

/** Where AGP writes the APK. */
export function builtApkPath(projectDir: string, debug: boolean): string {
  return debug
    ? join(projectDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
    : join(projectDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
}
