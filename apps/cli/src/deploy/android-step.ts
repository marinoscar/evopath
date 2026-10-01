import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { runBuild, type BuildResult } from '../android/build.js';
import { runAndroidDoctor, type AndroidDoctorReport } from '../android/doctor.js';
import { exec } from '../android/exec.js';
import {
  bumpVersionFile,
  previewBump,
  publishBuiltApk,
  type PublishCredentials,
  type PublishedApk,
  type VersionBump,
} from '../android/operations.js';
import { ANDROID_APP_DIR, findRepoRoot } from '../android/paths.js';
import { commitVersionFile, runRelease, ReleaseStepError } from '../android/release.js';
import {
  credentialsForServer,
  getReleaseStatus,
  errorMessage,
  isNewerLocally,
  PUBLISH_PERMISSION,
  type ReleaseStatus,
  type ReleaseStatusInput,
} from '../android/release-status.js';
import type { AppVersion, BumpPart } from '../android/version.js';
import { CLI_NAME } from '../branding.js';
import { UsageError } from '../errors.js';
import { checkoutPathFor } from './version-step.js';

// =============================================================================
// `deploy install|update --with-android`  (issue #292, epic #290)
// =============================================================================
//
// After the deploy succeeded and the app is healthy: compare the local APK
// version with the deployment's current release (using the stored login for
// THAT deployment's URL), and when the local one is newer run the Android
// doctor, build and publish it as the current release.
//
// ⚠ THIS STEP NEVER FAILS THE DEPLOY. Every outcome — no toolchain, no login,
// no permission, a build or an upload failure — becomes an `AndroidStepOutcome`
// with a reason and the exact command that fixes it. `runDeployAndroidStep`
// does not throw, and the deploy command's exit code is decided before it
// runs. Most VPS hosts have no JDK; a deploy that failed for that would be
// worse than no integration at all.
//
// ⚠ IT NEVER PROMPTS, in any mode: every decision comes from the flags, so a
// `--non-interactive` (or cron) deploy cannot hang on it.
//
// WHICH CHECKOUT. The operator's own checkout (the directory the CLI runs in,
// or `<CLI>_REPO_ROOT`) first; otherwise the deployment's checkout, which
// holds the revision just deployed. `--android-bump` is refused in the
// deployment's checkout: an uncommitted version.properties there makes the
// next `deploy update` refuse a dirty tree. In the operator's checkout the
// bump goes through `runRelease`, so version.properties is committed only
// after the upload succeeded.
// =============================================================================

export const ANDROID_BUMP_PARTS: readonly BumpPart[] = ['patch', 'minor', 'major'];

export interface DeployAndroidOptions {
  bump?: BumpPart | undefined;
  notes?: string | undefined;
}

export type AndroidStepOutcome =
  | { status: 'published'; version: AppVersion; releaseId: string; serverUrl: string; commit?: string | undefined; detail: string }
  | { status: 'skipped'; reason: string; fix?: string | undefined }
  | { status: 'failed'; reason: string; fix?: string | undefined };

export interface AndroidStepInput {
  /** The deployment's public domain; none means there is no URL to publish to. */
  domain: string | undefined;
  deployRoot: string;
  options: DeployAndroidOptions;
}

export interface AndroidStepDeps {
  findRepoRoot: () => string | undefined;
  getReleaseStatus: (input: ReleaseStatusInput) => Promise<ReleaseStatus>;
  previewBump: (repoRoot: string, part: BumpPart) => VersionBump;
  bumpVersionFile: (repoRoot: string, part: BumpPart) => VersionBump;
  doctor: (repoRoot: string) => Promise<AndroidDoctorReport>;
  build: (repoRoot: string, serverUrl: string, log: (line: string) => void) => Promise<BuildResult>;
  publish: (apkPath: string, credentials: PublishCredentials, notes: string | undefined) => Promise<PublishedApk>;
  commit: (repoRoot: string, version: AppVersion) => Promise<string>;
  credentials: (serverUrl: string) => PublishCredentials | undefined;
}

export function defaultAndroidStepDeps(): AndroidStepDeps {
  return {
    findRepoRoot: () => findRepoRoot(),
    getReleaseStatus: (input) => getReleaseStatus(input),
    previewBump,
    bumpVersionFile,
    doctor: (repoRoot) => runAndroidDoctor({ cwd: repoRoot }),
    build: (repoRoot, serverUrl, log) => runBuild({ serverUrl }, { cwd: repoRoot, exec, log }),
    publish: (apkPath, credentials, notes) => publishBuiltApk({ apkPath, credentials, notes, makeCurrent: true }),
    commit: (repoRoot, version) => commitVersionFile(exec, repoRoot, version),
    credentials: (serverUrl) => credentialsForServer(serverUrl),
  };
}

export function parseAndroidBump(value: string): BumpPart {
  if ((ANDROID_BUMP_PARTS as readonly string[]).includes(value)) return value as BumpPart;
  throw new UsageError(`--android-bump must be patch, minor or major (got ${JSON.stringify(value)}).`);
}

/**
 * The `--android-*` flags, validated BEFORE the deploy starts: a typo must
 * not surface as a skipped step after a ten-minute deploy.
 */
export function androidOptionsFromFlags(flags: {
  withAndroid?: boolean | undefined;
  androidBump?: string | undefined;
  androidNotes?: string | undefined;
}): DeployAndroidOptions | undefined {
  if (flags.withAndroid !== true) {
    if (flags.androidBump !== undefined || flags.androidNotes !== undefined) {
      throw new UsageError('--android-bump and --android-notes need --with-android.');
    }
    return undefined;
  }
  return {
    ...(flags.androidBump === undefined ? {} : { bump: parseAndroidBump(flags.androidBump) }),
    ...(flags.androidNotes === undefined || flags.androidNotes.trim() === '' ? {} : { notes: flags.androidNotes.trim() }),
  };
}

/** `app.example.com` → `https://app.example.com`. */
export function publicUrlFor(domain: string | undefined): string | undefined {
  const trimmed = domain?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : `https://${trimmed.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
}

const label = (version: AppVersion) => `${version.versionName} (code ${version.versionCode})`;

export async function runDeployAndroidStep(
  input: AndroidStepInput,
  deps: AndroidStepDeps,
  log: (line: string) => void = () => {},
): Promise<AndroidStepOutcome> {
  try {
    return await decide(input, deps, log);
  } catch (error) {
    // Belt and braces: `decide` already turns every expected failure into an
    // outcome. Whatever else went wrong is still not the deploy's failure.
    return { status: 'failed', reason: errorMessage(error), fix: `${CLI_NAME} android doctor` };
  }
}

async function decide(input: AndroidStepInput, deps: AndroidStepDeps, log: (line: string) => void): Promise<AndroidStepOutcome> {
  const url = publicUrlFor(input.domain);
  if (url === undefined) {
    return {
      status: 'skipped',
      reason: 'the deployment has no public domain, so there is no server URL to publish to',
      fix: `${CLI_NAME} login --server <url> && ${CLI_NAME} android release`,
    };
  }
  const loginFix = `${CLI_NAME} login --server ${url}`;

  const deployCheckout = checkoutPathFor(input.deployRoot);
  const own = deps.findRepoRoot();
  const repoRoot = own ?? (existsSync(join(deployCheckout, ANDROID_APP_DIR)) ? deployCheckout : undefined);
  if (repoRoot === undefined) {
    return { status: 'skipped', reason: `no ${ANDROID_APP_DIR} checkout found`, fix: `cd <your checkout> && ${CLI_NAME} android release` };
  }
  const bump = input.options.bump;
  if (bump !== undefined && resolve(repoRoot) === resolve(deployCheckout)) {
    return {
      status: 'skipped',
      reason:
        `--android-bump is not applied in the deployment's own checkout (${repoRoot}): an uncommitted version.properties there ` +
        'would make the next `deploy update` refuse. Bump and commit in your own checkout instead',
      fix: `${CLI_NAME} android version --bump ${bump}`,
    };
  }

  log(`Checking the Android release on ${url}…`);
  const status = await deps.getReleaseStatus({ repoRoot, serverUrl: url });
  const { login } = status;
  switch (login.state) {
    case 'logged_out':
      return { status: 'skipped', reason: `not logged in to ${url}`, fix: loginFix };
    case 'expired':
      return { status: 'skipped', reason: `the stored login for ${url} has expired`, fix: loginFix };
    case 'other_server':
      return { status: 'skipped', reason: `logged in to ${login.serverUrl ?? 'another server'}, not ${url}`, fix: loginFix };
    case 'logged_in':
      break;
  }
  if (login.error !== undefined) {
    return { status: 'skipped', reason: `could not check the login on ${url}: ${login.error}`, fix: loginFix };
  }
  if (!login.canPublish) {
    return {
      status: 'skipped',
      reason: `${login.email ?? 'the logged-in account'} lacks ${PUBLISH_PERMISSION} on ${url}`,
      fix: `ask an administrator for ${PUBLISH_PERMISSION}, or ${loginFix} as an administrator`,
    };
  }
  if (!status.server.reachable) {
    return { status: 'skipped', reason: `could not read the current release: ${status.server.error ?? 'no answer'}`, fix: `${CLI_NAME} android releases` };
  }
  if (status.local === null) {
    return { status: 'skipped', reason: `could not read ${ANDROID_APP_DIR}/version.properties in ${repoRoot}` };
  }

  const candidate = bump === undefined ? status.local : deps.previewBump(repoRoot, bump).after;
  if (!isNewerLocally(candidate, status.server)) {
    const current = status.server.current;
    return {
      status: 'skipped',
      reason: `${url} already has ${current === null ? 'a release' : label(current)}; local is ${label(candidate)}`,
      fix: 'pass --android-bump patch to publish a new build',
    };
  }

  const report = await deps.doctor(repoRoot);
  if (!report.ok) {
    const failed = report.checks.filter((check) => check.status === 'fail');
    return {
      status: 'skipped',
      reason: `the Android toolchain is not ready (${failed.map((check) => check.label).join(', ')})`,
      fix: failed.find((check) => check.fix !== undefined)?.fix ?? `${CLI_NAME} android doctor --fix`,
    };
  }

  const credentials = deps.credentials(url);
  if (credentials === undefined) return { status: 'skipped', reason: `not logged in to ${url}`, fix: loginFix };

  const notes = input.options.notes;
  const publishFix = `cd ${repoRoot} && ${CLI_NAME} android publish`;
  const buildFix = `cd ${repoRoot} && ${CLI_NAME} android build --server-url ${url} && ${CLI_NAME} android publish`;

  if (bump !== undefined) {
    try {
      const outcome = await runRelease<BuildResult, PublishedApk>(
        { bump, commit: true },
        {
          bump: (part) => deps.bumpVersionFile(repoRoot, part).after,
          build: () => deps.build(repoRoot, url, log),
          publish: (built) => deps.publish(built.apkPath, credentials, notes),
          commit: (version) => deps.commit(repoRoot, version),
        },
        log,
      );
      return published(outcome.version, outcome.release, url, outcome.commit);
    } catch (error) {
      const message = errorMessage(error);
      const isBuild = error instanceof ReleaseStepError && message.startsWith('Build failed');
      return { status: 'failed', reason: message, fix: isBuild ? buildFix : publishFix };
    }
  }

  let built: BuildResult;
  try {
    built = await deps.build(repoRoot, url, log);
  } catch (error) {
    return { status: 'failed', reason: `build failed: ${errorMessage(error)}`, fix: buildFix };
  }
  try {
    const result = await deps.publish(built.apkPath, credentials, notes);
    return published(built.metadata, result, url, undefined);
  } catch (error) {
    return { status: 'failed', reason: `upload failed: ${errorMessage(error)}`, fix: publishFix };
  }
}

function published(version: AppVersion, result: PublishedApk, serverUrl: string, commit: string | undefined): AndroidStepOutcome {
  return {
    status: 'published',
    version: { versionName: version.versionName, versionCode: version.versionCode },
    releaseId: result.release.id,
    serverUrl,
    ...(commit === undefined ? {} : { commit }),
    detail: `published ${label(version)} to ${serverUrl} as the current release`,
  };
}

/** The deploy report's lines for the outcome: one summary line, then the fix. */
export function androidReportLines(outcome: AndroidStepOutcome): string[] {
  switch (outcome.status) {
    case 'published':
      return [
        `Android APK  ${outcome.detail}`,
        ...(outcome.commit === undefined ? [] : [`             version.properties: ${outcome.commit}`]),
      ];
    case 'skipped':
      return [`Android APK  skipped: ${outcome.reason}`, ...(outcome.fix === undefined ? [] : [`             fix: ${outcome.fix}`])];
    case 'failed':
      return [
        `Android APK  failed: ${outcome.reason.split('\n')[0] ?? outcome.reason}`,
        ...(outcome.fix === undefined ? [] : [`             fix: ${outcome.fix}`]),
        '             (the deploy itself succeeded)',
      ];
  }
}
