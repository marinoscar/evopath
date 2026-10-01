import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { managedSdkDir } from './paths.js';

// =============================================================================
// Android SDK location and layout  (issue #286, epic #276)
// =============================================================================

/** The platform the app compiles against (`compileSdk = 36`). */
export const SDK_PLATFORM = 'android-36';
export const SDK_PLATFORM_PACKAGE = `platforms;${SDK_PLATFORM}`;
export const BUILD_TOOLS_VERSION = '36.0.0';
export const BUILD_TOOLS_PACKAGE = `build-tools;${BUILD_TOOLS_VERSION}`;
export const PLATFORM_TOOLS_PACKAGE = 'platform-tools';

/** The cmdline-tools build `doctor --fix` downloads. */
export const CMDLINE_TOOLS_BUILD = '13114758';

export type SdkSource = 'ANDROID_HOME' | 'ANDROID_SDK_ROOT' | 'managed' | 'android-studio';

export interface SdkLocation {
  root: string;
  source: SdkSource;
  exists: boolean;
}

export interface SdkContext {
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  exists?: ((path: string) => boolean) | undefined;
}

/** Where Android Studio puts the SDK by default, per OS. */
export function androidStudioSdkDir(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  switch (platform) {
    case 'win32':
      return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'Android', 'Sdk');
    case 'darwin':
      return join(home, 'Library', 'Android', 'sdk');
    default:
      return join(home, 'Android', 'Sdk');
  }
}

/**
 * Every place an SDK may be, in precedence order: ANDROID_HOME,
 * ANDROID_SDK_ROOT (deprecated but still common), the CLI-managed
 * `~/.evopathcli/android-sdk`, then Android Studio's default.
 */
export function sdkCandidates(ctx?: SdkContext): SdkLocation[] {
  const env = ctx?.env ?? process.env;
  const home = ctx?.home ?? homedir();
  const platform = ctx?.platform ?? process.platform;
  const exists = ctx?.exists ?? existsSync;

  const out: Array<Omit<SdkLocation, 'exists'>> = [];
  const androidHome = env['ANDROID_HOME']?.trim();
  if (androidHome) out.push({ root: androidHome, source: 'ANDROID_HOME' });
  const sdkRoot = env['ANDROID_SDK_ROOT']?.trim();
  if (sdkRoot) out.push({ root: sdkRoot, source: 'ANDROID_SDK_ROOT' });
  out.push({ root: managedSdkDir({ home }), source: 'managed' });
  out.push({ root: androidStudioSdkDir(platform, home, env), source: 'android-studio' });

  return out.map((candidate) => ({ ...candidate, exists: exists(candidate.root) }));
}

/**
 * The SDK to use: the first candidate that exists. When none does, the place
 * `doctor --fix` would install to — ANDROID_HOME if the user set one (they
 * told us where they want it), else the managed directory — with
 * `exists: false`.
 */
export function resolveSdk(ctx?: SdkContext): SdkLocation {
  const candidates = sdkCandidates(ctx);
  const found = candidates.find((candidate) => candidate.exists);
  if (found !== undefined) return found;
  const explicit = candidates.find((c) => c.source === 'ANDROID_HOME' || c.source === 'ANDROID_SDK_ROOT');
  return explicit ?? (candidates.find((c) => c.source === 'managed') as SdkLocation);
}

function script(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.bat` : name;
}

/** Paths inside an SDK root. */
export function sdkLayout(root: string, platform: NodeJS.Platform = process.platform) {
  return {
    cmdlineToolsDir: join(root, 'cmdline-tools', 'latest'),
    sdkmanager: join(root, 'cmdline-tools', 'latest', 'bin', script('sdkmanager', platform)),
    platformDir: join(root, 'platforms', SDK_PLATFORM),
    buildToolsDir: join(root, 'build-tools', BUILD_TOOLS_VERSION),
    apksigner: join(root, 'build-tools', BUILD_TOOLS_VERSION, script('apksigner', platform)),
    platformToolsDir: join(root, 'platform-tools'),
    licenseFile: join(root, 'licenses', 'android-sdk-license'),
  };
}

/** The official cmdline-tools zip for this OS. */
export function cmdlineToolsUrl(platform: NodeJS.Platform = process.platform): string {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  return `https://dl.google.com/android/repository/commandlinetools-${os}-${CMDLINE_TOOLS_BUILD}_latest.zip`;
}
