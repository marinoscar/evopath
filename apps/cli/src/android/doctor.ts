import { existsSync } from 'node:fs';

import { CLI_NAME } from '../branding.js';
import { formatError } from '../errors.js';
import { exec as defaultExec, type ExecFn } from './exec.js';
import { describeFreshness, FALLBACK_REF, freshnessFix, checkGitFreshness, type GitFreshness } from './git-freshness.js';
import { gradlewPath } from './gradle.js';
import { MIN_JAVA_MAJOR, jdkBinary, jdkInstallHint, parseJavaVersion } from './java.js';
import { keystorePath, readCertificateSha256, readSigningConfig } from './keystore.js';
import { androidProjectDir, findRepoRoot, REPO_ROOT_ENV_VAR, versionPropertiesPath } from './paths.js';
import {
  BUILD_TOOLS_PACKAGE,
  SDK_PLATFORM_PACKAGE,
  resolveSdk,
  sdkLayout,
  type SdkLocation,
} from './sdk.js';
import { readVersion } from './version.js';

// =============================================================================
// `android doctor`  (issue #286, epic #276)
// =============================================================================
//
// Every check runs, whatever the others found — a doctor that stops at the
// first failure makes you run it once per problem. Each row carries its own
// fix; the SDK rows' fix is `--fix`, the JDK row's is OS-specific install
// instructions (the JDK is never installed for you).
// =============================================================================

export type AndroidCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export type AndroidCheckId =
  | 'repo'
  | 'repo.fresh'
  | 'gradlew'
  | 'version'
  | 'jdk'
  | 'sdk'
  | 'cmdline-tools'
  | 'platform'
  | 'build-tools'
  | 'licenses'
  | 'keystore'
  | 'fingerprint';

export interface AndroidCheck {
  id: AndroidCheckId;
  label: string;
  status: AndroidCheckStatus;
  detail: string;
  fix?: string | undefined;
}

export interface AndroidDoctorReport {
  checks: AndroidCheck[];
  ok: boolean;
  sdk: SdkLocation;
  repoRoot: string | undefined;
}

export interface AndroidDoctorContext {
  exec?: ExecFn | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  cwd?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  exists?: ((path: string) => boolean) | undefined;
}

const FIX = `Run \`${CLI_NAME} android doctor --fix\`.`;

export async function runAndroidDoctor(ctx: AndroidDoctorContext = {}): Promise<AndroidDoctorReport> {
  const exec = ctx.exec ?? defaultExec;
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const exists = ctx.exists ?? existsSync;
  const paths = { env, ...(ctx.home !== undefined ? { home: ctx.home } : {}), ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}) };
  const checks: AndroidCheck[] = [];

  // ---- The repository --------------------------------------------------------
  const repoRoot = findRepoRoot(paths);
  if (repoRoot === undefined) {
    checks.push({
      id: 'repo',
      label: 'apps/android checkout',
      status: 'fail',
      detail: 'Not found in this directory or any parent',
      fix: `Run from inside the repository, or set ${REPO_ROOT_ENV_VAR}.`,
    });
    checks.push({ id: 'repo.fresh', label: `Checkout up to date with ${FALLBACK_REF}`, status: 'skip', detail: 'No checkout' });
    checks.push({ id: 'gradlew', label: 'Gradle wrapper', status: 'skip', detail: 'No checkout' });
  } else {
    checks.push({ id: 'repo', label: 'apps/android checkout', status: 'pass', detail: androidProjectDir(repoRoot) });
    checks.push(freshnessCheck(await checkGitFreshness(repoRoot, { exec, env })));
    const wrapper = gradlewPath(androidProjectDir(repoRoot), platform);
    checks.push(
      exists(wrapper)
        ? { id: 'gradlew', label: 'Gradle wrapper', status: 'pass', detail: wrapper }
        : { id: 'gradlew', label: 'Gradle wrapper', status: 'fail', detail: `${wrapper} is missing`, fix: 'Restore it from git.' },
    );
    try {
      const version = readVersion(versionPropertiesPath(repoRoot));
      checks.push(
        version.exists
          ? { id: 'version', label: 'version.properties', status: 'pass', detail: `${version.versionName} (${version.versionCode})` }
          : {
              id: 'version',
              label: 'version.properties',
              status: 'warn',
              detail: 'Missing; builds default to 0.1.0 (1)',
              fix: `Create it with \`${CLI_NAME} android version --set 0.1.0\`.`,
            },
      );
    } catch (error) {
      checks.push({ id: 'version', label: 'version.properties', status: 'fail', detail: formatError(error) });
    }
  }

  // ---- The JDK ----------------------------------------------------------------
  const java = jdkBinary('java', env, platform);
  try {
    const result = await exec(java, ['-version'], { env });
    const parsed = parseJavaVersion(`${result.stderr}\n${result.stdout}`);
    if (parsed === undefined) {
      checks.push({ id: 'jdk', label: `JDK ${MIN_JAVA_MAJOR}+`, status: 'fail', detail: `Could not read the version from \`${java} -version\``, fix: jdkInstallHint(platform) });
    } else if (parsed.major < MIN_JAVA_MAJOR) {
      checks.push({ id: 'jdk', label: `JDK ${MIN_JAVA_MAJOR}+`, status: 'fail', detail: `Found ${parsed.raw} (Java ${parsed.major})`, fix: jdkInstallHint(platform) });
    } else {
      checks.push({ id: 'jdk', label: `JDK ${MIN_JAVA_MAJOR}+`, status: 'pass', detail: `Java ${parsed.major} (${parsed.raw})` });
    }
  } catch {
    checks.push({ id: 'jdk', label: `JDK ${MIN_JAVA_MAJOR}+`, status: 'fail', detail: `\`${java}\` was not found`, fix: jdkInstallHint(platform) });
  }

  // ---- The SDK ----------------------------------------------------------------
  const sdk = resolveSdk({ env, platform, exists, ...(ctx.home !== undefined ? { home: ctx.home } : {}) });
  const layout = sdkLayout(sdk.root, platform);
  if (!sdk.exists) {
    checks.push({ id: 'sdk', label: 'Android SDK', status: 'fail', detail: `No SDK found (would install to ${sdk.root})`, fix: FIX });
    for (const [id, label] of [
      ['cmdline-tools', 'cmdline-tools'],
      ['platform', SDK_PLATFORM_PACKAGE],
      ['build-tools', BUILD_TOOLS_PACKAGE],
      ['licenses', 'SDK licences accepted'],
    ] as const) {
      checks.push({ id, label, status: 'skip', detail: 'No SDK' });
    }
  } else {
    checks.push({ id: 'sdk', label: 'Android SDK', status: 'pass', detail: `${sdk.root} (${sdk.source})` });
    const present = (id: AndroidCheckId, label: string, path: string): AndroidCheck =>
      exists(path)
        ? { id, label, status: 'pass', detail: path }
        : { id, label, status: 'fail', detail: `${path} is missing`, fix: FIX };
    checks.push(present('cmdline-tools', 'cmdline-tools', layout.sdkmanager));
    checks.push(present('platform', SDK_PLATFORM_PACKAGE, layout.platformDir));
    checks.push(present('build-tools', BUILD_TOOLS_PACKAGE, layout.buildToolsDir));
    checks.push(present('licenses', 'SDK licences accepted', layout.licenseFile));
  }

  // ---- Signing ------------------------------------------------------------------
  let signing;
  try {
    signing = readSigningConfig(paths);
  } catch (error) {
    checks.push({ id: 'keystore', label: 'Release keystore', status: 'fail', detail: formatError(error) });
  }
  if (signing === undefined) {
    if (!checks.some((check) => check.id === 'keystore')) {
      checks.push({
        id: 'keystore',
        label: 'Release keystore',
        status: 'fail',
        detail: `Not configured (expected ${keystorePath(paths)})`,
        fix: `Run \`${CLI_NAME} android keystore init\`, or \`${CLI_NAME} android keystore import <file>\`.`,
      });
    }
    checks.push({ id: 'fingerprint', label: 'Signing fingerprint', status: 'skip', detail: 'No keystore' });
  } else if (!exists(signing.keystorePath)) {
    checks.push({
      id: 'keystore',
      label: 'Release keystore',
      status: 'fail',
      detail: `${signing.keystorePath} is missing`,
      fix: `Restore it from your backup and run \`${CLI_NAME} android keystore import <file>\`.`,
    });
    checks.push({ id: 'fingerprint', label: 'Signing fingerprint', status: 'skip', detail: 'No keystore' });
  } else {
    checks.push({ id: 'keystore', label: 'Release keystore', status: 'pass', detail: `${signing.keystorePath} (alias ${signing.keyAlias})` });
    try {
      const sha = await readCertificateSha256(signing, { exec, env, platform });
      checks.push({ id: 'fingerprint', label: 'Signing fingerprint', status: 'pass', detail: sha });
    } catch (error) {
      checks.push({
        id: 'fingerprint',
        label: 'Signing fingerprint',
        status: 'fail',
        detail: formatError(error).split('\n')[0] ?? 'keytool failed',
        fix: 'Check the alias and passwords: re-run `android keystore import` with the right ones.',
      });
    }
  }

  return { checks, ok: checks.every((check) => check.status !== 'fail'), sdk, repoRoot };
}

/**
 * `repo.fresh` (#315): an APK built from a checkout behind its remote leaves
 * out the commits it is missing. NEVER `fail`: being behind is a reason to
 * pull, not proof the toolchain is broken, and offline machines must still
 * pass the doctor.
 */
export function freshnessCheck(freshness: GitFreshness): AndroidCheck {
  const label = `Checkout up to date with ${freshness.ref ?? FALLBACK_REF}`;
  const detail = describeFreshness(freshness);
  switch (freshness.state) {
    case 'up_to_date':
      return freshness.fetchError === undefined
        ? { id: 'repo.fresh', label, status: 'pass', detail }
        : { id: 'repo.fresh', label, status: 'warn', detail, fix: 'Check the network or your git credentials, then re-run the doctor.' };
    case 'behind':
      return { id: 'repo.fresh', label, status: 'warn', detail: `${detail} — an APK built now leaves them out`, fix: `Run \`${freshnessFix(freshness)}\`.` };
    case 'detached':
      return { id: 'repo.fresh', label, status: 'warn', detail, fix: `Check out a branch: \`git checkout ${FALLBACK_REF.split('/')[1] ?? 'main'}\`.` };
    case 'not_git':
      return { id: 'repo.fresh', label, status: 'warn', detail, fix: 'Build from a git clone so the APK can be traced to a commit.' };
    case 'unknown':
      return { id: 'repo.fresh', label, status: 'warn', detail };
  }
}

/** Which SDK fixes a report calls for. */
export function sdkFixesNeeded(report: AndroidDoctorReport): { cmdlineTools: boolean; licenses: boolean; packages: boolean } {
  const failed = (id: AndroidCheckId) => report.checks.some((check) => check.id === id && check.status === 'fail');
  const noSdk = failed('sdk');
  return {
    cmdlineTools: noSdk || failed('cmdline-tools'),
    licenses: noSdk || failed('licenses'),
    packages: noSdk || failed('platform') || failed('build-tools'),
  };
}

const SYMBOL: Record<AndroidCheckStatus, string> = { pass: '✓', warn: '⚠', fail: '✗', skip: '·' };
const COLOUR: Record<AndroidCheckStatus, string> = {
  pass: '\u001B[32m',
  warn: '\u001B[33m',
  fail: '\u001B[31m',
  skip: '\u001B[90m',
};
const RESET = '\u001B[0m';

/** The report as a table. Human output — stderr. */
export function formatAndroidDoctorReport(report: AndroidDoctorReport, options: { colour: boolean }): string {
  const width = Math.max(...report.checks.map((check) => check.label.length));
  const paint = (status: AndroidCheckStatus, text: string) => (options.colour ? `${COLOUR[status]}${text}${RESET}` : text);
  const lines: string[] = [''];
  for (const check of report.checks) {
    lines.push(`  ${paint(check.status, SYMBOL[check.status])} ${check.label.padEnd(width)}  ${check.detail}`);
    if (check.fix !== undefined && check.status !== 'pass') lines.push(`  ${' '.repeat(width + 4)}→ ${check.fix}`);
  }
  lines.push('', report.ok ? 'Ready to build Android releases.' : 'At least one check failed.');
  return `${lines.join('\n')}\n`;
}
