/**
 * What the Android screen shows and allows, as DATA  (issue #291, epic #290)
 *
 * Pure: no ink, no React, no filesystem, no network. `android.tsx` holds the
 * state and renders; this decides which actions are open, why the others are
 * not, and what every confirmation says. The tests assert these shapes, since
 * ink-testing-library is not a dependency of this package (see
 * status.test.ts).
 *
 * =============================================================================
 * ⚠ EVERY REMOTE ACTION CONFIRMS, AND SAYS WHERE IT GOES
 * =============================================================================
 *
 * Publish, Release and Make current all change what every user of a server
 * is offered. Each confirmation names the version, the code and the SERVER,
 * because the most expensive mistake here is a correct APK published to the
 * wrong deployment. Rolling back to a lower versionCode carries an extra
 * warning: Android refuses downgrades, so devices that already installed the
 * newer build are never offered the older one.
 * =============================================================================
 */
import { CLI_NAME } from '../../../branding.js';
import { PUBLISH_PERMISSION, type ReleaseStatus } from '../../../android/release-status.js';
import { formatBytes, type AndroidRelease } from '../../../android/publish.js';
import type { AppVersion, BumpPart } from '../../../android/version.js';

export type AndroidAction = 'doctor' | 'bump' | 'build' | 'publish' | 'release' | 'releases' | 'login';

export interface ActionItem {
  action: AndroidAction;
  label: string;
  /** False: selecting it shows `reason` instead of acting. */
  enabled: boolean;
  reason?: string | undefined;
}

export interface StatusRow {
  label: string;
  value: string;
  color?: 'green' | 'yellow' | 'red' | undefined;
}

export function versionLabel(version: AppVersion): string {
  return `${version.versionName} (code ${version.versionCode})`;
}

/** The login row, one sentence per state. */
export function loginRow(status: ReleaseStatus): StatusRow {
  const { login } = status;
  const server = login.serverUrl ?? '(no server)';
  switch (login.state) {
    case 'logged_out':
      return { label: 'Login', value: 'Not logged in', color: 'red' };
    case 'expired':
      return { label: 'Login', value: `Expired for ${server} — log in again`, color: 'red' };
    case 'other_server':
      return {
        label: 'Login',
        value: `Logged in to ${server}, not ${status.targetServerUrl ?? '(target)'}`,
        color: 'red',
      };
    case 'logged_in': {
      const who = `${login.email ?? 'signed in'} on ${server}`;
      if (login.error !== undefined) return { label: 'Login', value: `${who} — could not check: ${login.error}`, color: 'yellow' };
      return login.canPublish
        ? { label: 'Login', value: `${who} — can publish`, color: 'green' }
        : { label: 'Login', value: `${who} — lacks ${PUBLISH_PERMISSION}`, color: 'yellow' };
    }
  }
}

/** The status panel's rows. */
export function statusRows(status: ReleaseStatus): StatusRow[] {
  const rows: StatusRow[] = [];
  rows.push(
    status.local === null
      ? { label: 'Local', value: 'No apps/android checkout here', color: 'red' }
      : { label: 'Local', value: versionLabel(status.local) },
  );
  rows.push(
    status.keystore.configured
      ? { label: 'Keystore', value: status.keystore.sha256 ?? 'configured (fingerprint not cached)', color: 'green' }
      : {
          label: 'Keystore',
          value: status.keystore.error ?? `Not configured — run \`${CLI_NAME} android keystore init\``,
          color: 'red',
        },
  );
  rows.push(loginRow(status));
  if (!status.server.reachable) {
    rows.push({ label: 'Server', value: status.server.error ?? 'Not checked', color: 'yellow' });
  } else {
    rows.push({
      label: 'Server',
      value: status.server.current === null ? 'No release published yet' : `Current ${versionLabel(status.server.current)}`,
    });
    rows.push(
      status.newerLocally
        ? { label: 'Newer', value: 'Yes — the local version can be published', color: 'green' }
        : { label: 'Newer', value: 'No — bump the version before publishing', color: 'yellow' },
    );
  }
  return rows;
}

/**
 * Why the server actions (publish, release, releases) are not available, or
 * `undefined` when they are. Each sentence names its fix.
 */
export function remoteBlocker(status: ReleaseStatus): string | undefined {
  const { login } = status;
  switch (login.state) {
    case 'logged_out':
      return 'Not logged in. Choose "Log in".';
    case 'expired':
      return `The login for ${login.serverUrl ?? 'the server'} has expired. Choose "Log in".`;
    case 'other_server':
      return `Logged in to ${login.serverUrl ?? 'another server'}, not ${status.targetServerUrl ?? 'this one'}. Choose "Log in".`;
    case 'logged_in':
      if (login.error !== undefined) return `Could not reach the server: ${login.error}. Press r to retry.`;
      if (!login.canPublish) {
        return `${login.email ?? 'This account'} lacks ${PUBLISH_PERMISSION}. Ask an administrator, or choose "Log in" as another user.`;
      }
      return undefined;
  }
}

const NO_CHECKOUT = `No apps/android checkout found. Run ${CLI_NAME} from inside the repository.`;
const NO_KEYSTORE = `No release keystore. Run \`${CLI_NAME} android keystore init\` (or \`keystore import <file>\`).`;

export function actionItems(status: ReleaseStatus | undefined): ActionItem[] {
  const loading = 'Still reading the status…';
  const local = status === undefined ? loading : status.local === null ? NO_CHECKOUT : undefined;
  const keystore = status === undefined ? loading : status.keystore.configured ? undefined : NO_KEYSTORE;
  const remote = status === undefined ? loading : remoteBlocker(status);
  const item = (action: AndroidAction, label: string, ...reasons: Array<string | undefined>): ActionItem => {
    const reason = reasons.find((entry) => entry !== undefined);
    return { action, label, enabled: reason === undefined, ...(reason === undefined ? {} : { reason }) };
  };

  const items: ActionItem[] = [
    item('doctor', 'Run doctor  (toolchain check)'),
    item('bump', 'Bump version', local),
    item('build', 'Build  (signed release APK)', local, keystore),
    item('publish', 'Publish  (upload the built APK)', local, remote),
    item('release', 'Release  (bump → build → publish → commit)', local, keystore, remote),
    item('releases', 'Releases  (list, make current, roll back)', remote),
  ];
  const needsLogin =
    status !== undefined && (status.login.state !== 'logged_in' || (status.login.error === undefined && !status.login.canPublish));
  if (needsLogin) items.push(item('login', 'Log in'));
  return items;
}

/** The label a disabled action is shown with: annotated, not hidden (the menu's convention). */
export function itemLabel(item: ActionItem): string {
  return item.enabled ? item.label : `${item.label}  — unavailable`;
}

export const BUMP_PARTS: readonly BumpPart[] = ['patch', 'minor', 'major'];

export function bumpLabel(part: BumpPart, before: AppVersion, after: AppVersion): string {
  return `${part.padEnd(5)}  ${versionLabel(before)} → ${versionLabel(after)}`;
}

export interface Confirmation {
  title: string;
  question: string;
  lines: string[];
  /** Shown in yellow above the choice. */
  warning?: string | undefined;
  yes: string;
}

export function publishConfirmation(version: AppVersion, serverUrl: string, current: AndroidRelease | null, notes: string): Confirmation {
  const notNewer = current !== null && version.versionCode <= current.versionCode ? current : undefined;
  return {
    title: 'Publish',
    question: `Publish v${version.versionName} (code ${version.versionCode}) to ${serverUrl}?`,
    lines: [
      `It becomes the current release: users are offered it on the download page and paired devices are told to update.`,
      ...(notes === '' ? [] : [`Notes: ${notes}`]),
    ],
    ...(notNewer !== undefined
      ? {
          warning: `The server's current release is ${versionLabel(notNewer)}; the server refuses an upload that is not newer. Bump the version and build again.`,
        }
      : {}),
    yes: 'Yes, publish',
  };
}

export function releaseConfirmation(before: AppVersion, after: AppVersion, serverUrl: string, notes: string): Confirmation {
  return {
    title: 'Release',
    question: `Release v${after.versionName} (code ${after.versionCode}) to ${serverUrl}?`,
    lines: [
      `1. Bump version.properties ${versionLabel(before)} → ${versionLabel(after)}`,
      '2. Build and sign the release APK',
      `3. Publish it to ${serverUrl} as the current release`,
      '4. Commit version.properties (only that file)',
      ...(notes === '' ? [] : [`Notes: ${notes}`]),
      'A failed build or upload leaves the bump uncommitted, so nothing claims a release that does not exist.',
    ],
    yes: 'Yes, release',
  };
}

/**
 * The extra warning for a make-current that moves BACKWARDS.
 *
 * Android never installs a lower versionCode over a higher one, so a rollback
 * only reaches new installs and devices still below it.
 */
export function rollbackWarning(target: AndroidRelease, current: AndroidRelease | undefined): string | undefined {
  if (current === undefined || target.versionCode >= current.versionCode) return undefined;
  return (
    `This ROLLS BACK from ${versionLabel(current)} to a lower versionCode. Android refuses downgrades: ` +
    `devices that installed ${current.versionName} keep it and are not offered ${target.versionName}. Only new installs get it.`
  );
}

export function makeCurrentConfirmation(
  target: AndroidRelease,
  releases: readonly AndroidRelease[],
  serverUrl: string,
): Confirmation {
  const current = releases.find((release) => release.isCurrent === true);
  const warning = rollbackWarning(target, current);
  return {
    title: 'Make current',
    question: `Make v${target.versionName} (code ${target.versionCode}) the current release on ${serverUrl}?`,
    lines: [current === undefined ? 'No release is current now.' : `Current now: ${versionLabel(current)}.`],
    ...(warning === undefined ? {} : { warning }),
    yes: warning === undefined ? 'Yes, make it current' : 'Yes, roll back',
  };
}

/** One row of the releases list. */
export function releaseLabel(release: AndroidRelease): string {
  const marker = release.isCurrent === true ? '*' : ' ';
  const when = release.createdAt.slice(0, 16).replace('T', ' ');
  return `${marker} ${release.versionName.padEnd(10)} code ${String(release.versionCode).padEnd(6)} ${formatBytes(release.sizeBytes).padStart(9)}  ${when}`;
}

/** "Uploading 12.0 MB of 40.0 MB (30%)", with the total from the build metadata. */
export function uploadProgressText(sent: number, total: number): string {
  if (total <= 0) return `Uploading ${formatBytes(sent)}…`;
  const percent = Math.min(100, Math.floor((sent / total) * 100));
  return `Uploading ${formatBytes(sent)} of ${formatBytes(total)} (${percent}%)`;
}

/** Only re-render when the shown percentage moves: a 150 MB body arrives in thousands of chunks. */
export function progressStep(sent: number, total: number): number {
  return total <= 0 ? Math.floor(sent / (1024 * 1024)) : Math.min(100, Math.floor((sent / total) * 100));
}
