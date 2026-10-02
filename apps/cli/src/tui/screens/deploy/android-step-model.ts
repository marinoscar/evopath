import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AndroidDoctorReport } from '../../../android/doctor.js';
import { ANDROID_APP_DIR, versionPropertiesPath } from '../../../android/paths.js';
import type { ReleaseStatus } from '../../../android/release-status.js';
import { readVersion } from '../../../android/version.js';
import { CLI_NAME } from '../../../branding.js';
import { publicUrlFor } from '../../../deploy/android-step.js';
import { readAndroidPreference } from '../../../deploy/preferences.js';
import { checkoutPathFor } from '../../../deploy/version-step.js';
import { WITH_ANDROID_FLAG } from './flags-model.js';

// =============================================================================
// The deploy screens' "Android app" step, as data  (issue #315)
// =============================================================================
//
// Everything the step decides or shows, without ink: the two choices, the
// default (remembered per deployment), the confirm-row wording, and the
// context lines above the choice. Each context line is BEST EFFORT: a value
// that cannot be read becomes a sentence saying so, never an exception, and
// the network read is bounded by a timeout so the step never waits on it.
// =============================================================================

export const ANDROID_NO = 'no';
export const ANDROID_YES = 'yes';

export const ANDROID_CHOICES = [
  { key: ANDROID_NO, label: 'No — web app only', value: ANDROID_NO },
  {
    key: ANDROID_YES,
    label: 'Yes — also build and publish the Android APK (if its version is newer than the published one)',
    value: ANDROID_YES,
  },
] as const;

/** How long the published-release lookup may take before it reads "unreachable". */
export const RELEASE_LOOKUP_TIMEOUT_MS = 4000;

/** The confirm screen's row. */
export const ANDROID_CONFIRM_YES = 'build and publish if newer';
export const ANDROID_CONFIRM_NO = 'not included';

export function deploymentHasAndroid(deployRoot: string): boolean {
  try {
    return existsSync(join(checkoutPathFor(deployRoot), ANDROID_APP_DIR));
  } catch {
    return false;
  }
}

/**
 * The selection the step opens on: `No` when the deployment's checkout has no
 * apps/android, else the remembered answer, else `No`. A preference that
 * cannot be read is the same as none.
 */
export function defaultAndroidChoice(
  deployRoot: string,
  read: (deployRoot: string) => boolean | undefined = readAndroidPreference,
): boolean {
  if (!deploymentHasAndroid(deployRoot)) return false;
  try {
    return read(deployRoot) ?? false;
  } catch {
    return false;
  }
}

/** The chosen flags with `--with-android` set (yes) or cleared (no). */
export function withAndroidChoice(chosen: ReadonlySet<string>, yes: boolean): Set<string> {
  const next = new Set(chosen);
  if (yes) next.add(WITH_ANDROID_FLAG);
  else next.delete(WITH_ANDROID_FLAG);
  return next;
}

export function androidConfirmValue(chosen: ReadonlySet<string>): string {
  return chosen.has(WITH_ANDROID_FLAG) ? ANDROID_CONFIRM_YES : ANDROID_CONFIRM_NO;
}

const versionLabel = (version: { versionName: string; versionCode: number }) =>
  `${version.versionName} (code ${version.versionCode})`;

/** `1.0.6 (code 6)` from the deployment's checkout, or why there is none. */
export function checkoutVersionLine(deployRoot: string): string {
  const checkout = checkoutPathFor(deployRoot);
  if (!deploymentHasAndroid(deployRoot)) return `no ${ANDROID_APP_DIR} in ${checkout} yet`;
  try {
    return versionLabel(readVersion(versionPropertiesPath(checkout)));
  } catch {
    return `could not read ${join(ANDROID_APP_DIR, 'version.properties')} in ${checkout}`;
  }
}

/** The published-release line for a status computed against `url`. */
export function releaseLine(status: ReleaseStatus, url: string): string {
  const loginFix = `run \`${CLI_NAME} login --server ${url}\``;
  const { login, server } = status;
  switch (login.state) {
    case 'logged_out':
      return `not logged in to ${url} — ${loginFix}`;
    case 'expired':
      return `the stored login for ${url} has expired — ${loginFix}`;
    case 'other_server':
      return `logged in to ${login.serverUrl ?? 'another server'}, not ${url} — ${loginFix}`;
    case 'logged_in':
      break;
  }
  if (login.error !== undefined || !server.reachable) {
    return `${url} unreachable (${login.error ?? server.error ?? 'no answer'})`;
  }
  const published = server.current === null ? `nothing published yet on ${url}` : `${versionLabel(server.current)} on ${url}`;
  return login.canPublish ? published : `${published} — your login cannot publish (needs system_settings:write)`;
}

export interface ReleaseLookupDeps {
  getReleaseStatus: (url: string, repoRoot: string | undefined, signal: AbortSignal) => Promise<ReleaseStatus>;
  timeoutMs?: number | undefined;
}

/**
 * The published-release line for a deployment's domain. Never throws, and
 * never waits longer than the timeout: whatever has not answered by then is
 * reported as unreachable.
 */
export async function lookupReleaseLine(
  domain: string | undefined,
  repoRoot: string | undefined,
  deps: ReleaseLookupDeps,
  outer?: AbortSignal,
): Promise<string> {
  const url = publicUrlFor(domain);
  if (url === undefined) return 'no domain recorded for this deployment yet, so there is no server to ask';
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener('abort', abort, { once: true });
  const timeoutMs = deps.timeoutMs ?? RELEASE_LOOKUP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(`${url} unreachable (no answer within ${Math.round(timeoutMs / 1000)}s)`);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      deps
        .getReleaseStatus(url, repoRoot, controller.signal)
        .then((status) => releaseLine(status, url))
        .catch((error: unknown) => `${url} unreachable (${error instanceof Error ? error.message : String(error)})`),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener('abort', abort);
  }
}

/** The pre-flight's summary: one headline, then each failed check with its fix. */
export function doctorLines(report: AndroidDoctorReport): string[] {
  const failed = report.checks.filter((check) => check.status === 'fail');
  const warned = report.checks.filter((check) => check.status === 'warn');
  const head = report.ok
    ? `✔ all ${report.checks.length} checks passed` +
      (warned.length === 0 ? '' : ` (${warned.length} with a warning)`)
    : `✖ ${failed.length} of ${report.checks.length} checks failed — publishing would be skipped`;
  return [
    head,
    ...[...failed, ...warned].flatMap((check) => [
      `  ${check.status === 'fail' ? '✖' : '!'} ${check.label}: ${check.detail}`,
      ...(check.fix === undefined ? [] : [`    → ${check.fix}`]),
    ]),
  ];
}
