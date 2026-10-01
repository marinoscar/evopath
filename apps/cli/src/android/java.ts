import { join } from 'node:path';

// =============================================================================
// JDK detection  (issue #286, epic #276)
// =============================================================================
//
// The Android Gradle plugin needs JDK 17 or newer. The JDK is NEVER installed
// for the user — which vendor, which package manager and whether it may touch
// the system Java are their decisions — so this module only finds one and
// reads its version, and `jdkInstallHint` says how to get one per OS.
// =============================================================================

export const MIN_JAVA_MAJOR = 17;

export interface JavaVersion {
  major: number;
  /** The quoted version string as printed, e.g. `21.0.11` or `1.8.0_202`. */
  raw: string;
}

/**
 * Parse `java -version` output (which goes to STDERR, and may be preceded by a
 * `Picked up JAVA_TOOL_OPTIONS` line).
 *
 * Handles every format in the wild:
 *   openjdk version "21.0.11" 2026-04-21      → 21
 *   openjdk version "17" 2021-09-14           → 17
 *   java version "1.8.0_202"                  → 8   (legacy 1.x scheme)
 *   openjdk version "22-ea"                   → 22
 */
export function parseJavaVersion(output: string): JavaVersion | undefined {
  const match = /version\s+"([^"]+)"/i.exec(output);
  const raw = match?.[1];
  if (raw === undefined) return undefined;

  const parts = raw.split(/[.\-_+]/);
  const first = Number.parseInt(parts[0] ?? '', 10);
  if (!Number.isFinite(first)) return undefined;

  if (first === 1) {
    const second = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(second)) return undefined;
    return { major: second, raw };
  }
  return { major: first, raw };
}

function exe(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/**
 * A JDK binary (`java`, `keytool`): from `JAVA_HOME/bin` when set, else bare on
 * PATH. Gradle itself honours JAVA_HOME, so preferring it keeps what doctor
 * checks and what the build uses the same JDK.
 */
export function jdkBinary(
  name: 'java' | 'keytool',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const javaHome = env['JAVA_HOME'];
  if (javaHome !== undefined && javaHome.trim() !== '') {
    return join(javaHome.trim(), 'bin', exe(name, platform));
  }
  return exe(name, platform);
}

/** How to install a JDK, per OS. Printed by `doctor`; never executed. */
export function jdkInstallHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'win32':
      return 'Install JDK 21: `winget install Microsoft.OpenJDK.21` (or Temurin from adoptium.net), then set JAVA_HOME.';
    case 'darwin':
      return 'Install JDK 21: `brew install --cask temurin@21` (or from adoptium.net), then set JAVA_HOME.';
    default:
      return 'Install JDK 21: `sudo apt install openjdk-21-jdk` (Debian/Ubuntu), `sudo dnf install java-21-openjdk-devel` (Fedora), or from adoptium.net; then set JAVA_HOME.';
  }
}
