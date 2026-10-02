import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { PreconditionError } from '../errors.js';
import { exec as defaultExec, execChecked, type ExecFn } from './exec.js';
import { behindWarning, checkGitFreshness, describeFreshness } from './git-freshness.js';
import { builtApkPath, gradleArgs, gradlewPath, readApplicationId } from './gradle.js';
import { fingerprintToHex, readCertificateSha256, readSigningConfig, signingEnv } from './keystore.js';
import { apkFileName, buildMetadata, metadataPathFor, readGitSha, writeMetadata, type ApkMetadata } from './metadata.js';
import { androidProjectDir, distDir, extraGradleArgs, requireRepoRoot, versionPropertiesPath } from './paths.js';
import { resolveSdk, sdkLayout } from './sdk.js';
import { readVersion } from './version.js';

// =============================================================================
// `android build`  (issue #286, epic #276)
// =============================================================================

export interface BuildOptions {
  serverUrl?: string | undefined;
  debug?: boolean | undefined;
  /** Refuse to build from a checkout behind its remote (#315); by default that is a warning. */
  requireUpToDate?: boolean | undefined;
}

export interface BuildContext {
  exec?: ExecFn | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  cwd?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  log: (line: string) => void;
}

export interface BuildResult {
  apkPath: string;
  metadataPath: string;
  metadata: ApkMetadata;
  verified: boolean;
}

/** `Signer #1 certificate SHA-256 digest: <hex>` from `apksigner verify --print-certs`. */
export function parseApksignerSha256(output: string): string | undefined {
  const match = /Signer #1 certificate SHA-256 digest:\s*([0-9a-f]{64})/i.exec(output);
  return match?.[1]?.toLowerCase();
}

export async function runBuild(options: BuildOptions, ctx: BuildContext): Promise<BuildResult> {
  const exec = ctx.exec ?? defaultExec;
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const paths = { env, ...(ctx.home !== undefined ? { home: ctx.home } : {}), ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}) };
  const debug = options.debug === true;

  const repoRoot = requireRepoRoot(paths);
  const projectDir = androidProjectDir(repoRoot);
  const version = readVersion(versionPropertiesPath(repoRoot));
  if (!version.exists) {
    ctx.log(`version.properties not found; building ${version.versionName} (${version.versionCode}).`);
  }

  const sdk = resolveSdk({ env, platform, ...(ctx.home !== undefined ? { home: ctx.home } : {}) });
  if (!sdk.exists) {
    throw new PreconditionError(`No Android SDK found. Run \`${CLI_NAME} android doctor --fix\`.`);
  }

  const signing = readSigningConfig(paths);
  if (!debug && signing === undefined) {
    throw new PreconditionError(
      `No release keystore is configured. Run \`${CLI_NAME} android keystore init\` (or \`keystore import <file>\`), or build with --debug.`,
    );
  }

  const wrapper = gradlewPath(projectDir, platform);
  if (!existsSync(wrapper)) throw new PreconditionError(`${wrapper} is missing.`);

  // ⚠ Before Gradle, not after: a checkout behind its remote builds an APK
  // without the commits it is missing (#315). A warning by default, an error
  // with --require-up-to-date; never a pull.
  const freshness = await checkGitFreshness(repoRoot, { exec, env });
  const behind = behindWarning(freshness);
  if (behind !== undefined) {
    if (options.requireUpToDate === true) {
      throw new PreconditionError(`${behind.replace(/^⚠ /, '')} (refusing to build: --require-up-to-date)`);
    }
    ctx.log(behind);
  } else if (freshness.state !== 'up_to_date' || freshness.fetchError !== undefined) {
    ctx.log(`Note: ${describeFreshness(freshness)}.`);
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ANDROID_HOME: sdk.root,
    ANDROID_SDK_ROOT: sdk.root,
    ...(debug || signing === undefined ? {} : signingEnv(signing)),
  };

  const args = gradleArgs({
    debug,
    versionName: version.versionName,
    versionCode: version.versionCode,
    serverUrl: options.serverUrl,
    extra: extraGradleArgs(env),
  });
  ctx.log(`Building ${debug ? 'debug' : 'release'} ${version.versionName} (${version.versionCode}) with Gradle…`);
  await execChecked(exec, wrapper, args, {
    cwd: projectDir,
    env: childEnv,
    platform,
    missingHint: 'Restore apps/android/gradlew from git (and make it executable).',
    onLine: (line) => ctx.log(`  ${line}`),
  });

  const output = builtApkPath(projectDir, debug);
  if (!existsSync(output)) {
    throw new PreconditionError(`Gradle finished but ${output} does not exist.`);
  }

  // The certificate the APK must carry: the configured keystore's, for release.
  const expected =
    !debug && signing !== undefined
      ? fingerprintToHex(signing.certSha256 ?? (await readCertificateSha256(signing, { exec, env, platform })))
      : undefined;

  let actual: string | undefined;
  const apksigner = sdkLayout(sdk.root, platform).apksigner;
  if (existsSync(apksigner)) {
    const verify = await execChecked(exec, apksigner, ['verify', '--print-certs', output], { env: childEnv, platform });
    actual = parseApksignerSha256(verify.stdout);
    if (expected !== undefined && actual !== undefined && actual !== expected) {
      throw new PreconditionError(
        `The APK is signed by ${actual}, not by the configured keystore (${expected}). Was the release built unsigned or with another key?`,
      );
    }
    ctx.log(`apksigner: signature verified${actual !== undefined ? ` (${actual})` : ''}.`);
  } else {
    ctx.log(`apksigner not found at ${apksigner}; skipping signature verification.`);
  }

  const signingSha256 = actual ?? expected;
  if (signingSha256 === undefined) {
    throw new PreconditionError('Could not determine the signing certificate. Install build-tools (`android doctor --fix`).');
  }

  const dist = distDir(repoRoot);
  mkdirSync(dist, { recursive: true });
  const name = apkFileName(version.versionName).replace(/\.apk$/, debug ? '-debug.apk' : '.apk');
  const apkPath = join(dist, name);
  copyFileSync(output, apkPath);

  const metadata = await buildMetadata({
    apkPath,
    packageName: readApplicationId(projectDir),
    versionName: version.versionName,
    versionCode: version.versionCode,
    signingSha256,
    gitSha: await readGitSha(exec, repoRoot),
  });
  const metadataPath = metadataPathFor(apkPath);
  writeMetadata(metadataPath, metadata);

  return { apkPath, metadataPath, metadata, verified: actual !== undefined };
}
