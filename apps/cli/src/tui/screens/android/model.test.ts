import { describe, expect, it } from 'vitest';

import type { AndroidRelease } from '../../../android/publish.js';
import type { ReleaseStatus } from '../../../android/release-status.js';
import {
  actionItems,
  itemLabel,
  loginRow,
  makeCurrentConfirmation,
  progressStep,
  publishConfirmation,
  releaseConfirmation,
  releaseLabel,
  remoteBlocker,
  rollbackWarning,
  statusRows,
  uploadProgressText,
} from './model.js';

// `ink-testing-library` is not a dependency (see status.test.ts), so the
// Android screen's tests assert the DATA it renders: which actions are open,
// why the others are not, and what each confirmation says.

const SERVER = 'https://app.example.com';

function release(code: number, overrides: Partial<AndroidRelease> = {}): AndroidRelease {
  return {
    id: `r${code}`,
    packageName: 'com.example.app',
    versionName: `1.0.${code}`,
    versionCode: code,
    fileSha256: 'cd'.repeat(32),
    sizeBytes: 12 * 1024 * 1024,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

function status(overrides: Partial<ReleaseStatus> = {}): ReleaseStatus {
  return {
    repoRoot: '/repo',
    targetServerUrl: SERVER,
    local: { versionName: '1.0.6', versionCode: 6 },
    keystore: { configured: true, sha256: 'AA:BB' },
    login: { state: 'logged_in', serverUrl: SERVER, canPublish: true, email: 'admin@example.com', source: 'file' },
    server: { current: release(5), reachable: true },
    newerLocally: true,
    ...overrides,
  };
}

const enabled = (s: ReleaseStatus | undefined) =>
  Object.fromEntries(actionItems(s).map((item) => [item.action, item.enabled]));

describe('the login row, per state', () => {
  it('logged in with the permission', () => {
    expect(loginRow(status())).toEqual({
      label: 'Login',
      value: `admin@example.com on ${SERVER} — can publish`,
      color: 'green',
    });
  });

  it('logged in without system_settings:write', () => {
    const row = loginRow(status({ login: { state: 'logged_in', serverUrl: SERVER, canPublish: false, email: 'u@example.com' } }));
    expect(row.value).toContain('lacks system_settings:write');
    expect(row.color).toBe('yellow');
  });

  it('logged out', () => {
    expect(loginRow(status({ login: { state: 'logged_out', canPublish: false } })).value).toBe('Not logged in');
  });

  it('expired', () => {
    const row = loginRow(status({ login: { state: 'expired', serverUrl: SERVER, canPublish: false } }));
    expect(row.value).toContain('Expired');
    expect(row.color).toBe('red');
  });

  it('another server', () => {
    const row = loginRow(
      status({ targetServerUrl: SERVER, login: { state: 'other_server', serverUrl: 'https://other.example.com', canPublish: false } }),
    );
    expect(row.value).toBe(`Logged in to https://other.example.com, not ${SERVER}`);
  });

  it('server unreachable while checking', () => {
    const row = loginRow(status({ login: { state: 'logged_in', serverUrl: SERVER, canPublish: false, error: 'fetch failed' } }));
    expect(row.value).toContain('could not check: fetch failed');
  });
});

describe('statusRows', () => {
  it('shows the local version, keystore, login, current release and newer', () => {
    const rows = statusRows(status());
    expect(rows.map((row) => row.label)).toEqual(['Local', 'Keystore', 'Login', 'Server', 'Newer']);
    expect(rows[0]?.value).toBe('1.0.6 (code 6)');
    expect(rows[1]?.value).toBe('AA:BB');
    expect(rows[3]?.value).toBe('Current 1.0.5 (code 5)');
    expect(rows[4]?.color).toBe('green');
  });

  it('says when nothing is published, and when the local build is not newer', () => {
    expect(statusRows(status({ server: { current: null, reachable: true } }))[3]?.value).toBe('No release published yet');
    const rows = statusRows(status({ newerLocally: false }));
    expect(rows[4]?.value).toContain('bump the version');
  });

  it('names the missing keystore fix and the unreachable server', () => {
    const rows = statusRows(status({ keystore: { configured: false }, server: { current: null, reachable: false, error: 'Not logged in.' } }));
    expect(rows[1]?.value).toContain('android keystore init');
    expect(rows.find((row) => row.label === 'Server')?.value).toBe('Not logged in.');
    expect(rows.some((row) => row.label === 'Newer')).toBe(false);
  });
});

describe('actionItems: remote actions are gated on the login', () => {
  it('everything is open when logged in with the permission, and no "Log in" entry', () => {
    expect(enabled(status())).toEqual({
      doctor: true,
      bump: true,
      build: true,
      publish: true,
      release: true,
      releases: true,
    });
  });

  it.each([
    ['logged_out', { state: 'logged_out' as const, canPublish: false }],
    ['expired', { state: 'expired' as const, serverUrl: SERVER, canPublish: false }],
    ['other_server', { state: 'other_server' as const, serverUrl: 'https://other.example.com', canPublish: false }],
  ])('%s: publish, release and releases are disabled and "Log in" is offered', (_name, login) => {
    const items = actionItems(status({ login }));
    for (const action of ['publish', 'release', 'releases']) {
      const item = items.find((entry) => entry.action === action);
      expect(item?.enabled, action).toBe(false);
      expect(item?.reason, action).toContain('Log in');
    }
    expect(items.find((entry) => entry.action === 'login')?.enabled).toBe(true);
    // Local actions stay open.
    expect(items.find((entry) => entry.action === 'build')?.enabled).toBe(true);
  });

  it('without system_settings:write: remote actions are disabled, with the permission named', () => {
    const items = actionItems(status({ login: { state: 'logged_in', serverUrl: SERVER, canPublish: false, email: 'u@example.com' } }));
    const publish = items.find((entry) => entry.action === 'publish');
    expect(publish?.enabled).toBe(false);
    expect(publish?.reason).toContain('system_settings:write');
    expect(itemLabel(publish!)).toContain('unavailable');
    expect(items.some((entry) => entry.action === 'login')).toBe(true);
  });

  it('a server that cannot be reached blocks remote actions without offering a pointless login', () => {
    const items = actionItems(status({ login: { state: 'logged_in', serverUrl: SERVER, canPublish: false, error: 'fetch failed' } }));
    expect(items.find((entry) => entry.action === 'publish')?.reason).toContain('Press r');
    expect(items.some((entry) => entry.action === 'login')).toBe(false);
  });

  it('no keystore disables build and release, not publish', () => {
    expect(enabled(status({ keystore: { configured: false } }))).toMatchObject({ build: false, release: false, publish: true });
  });

  it('no checkout disables every local action', () => {
    expect(enabled(status({ local: null, repoRoot: undefined }))).toMatchObject({
      doctor: true,
      bump: false,
      build: false,
      publish: false,
      release: false,
    });
  });

  it('while the status is loading only doctor is open', () => {
    expect(enabled(undefined)).toEqual({
      doctor: true,
      bump: false,
      build: false,
      publish: false,
      release: false,
      releases: false,
    });
  });

  it('remoteBlocker is undefined only for a usable login', () => {
    expect(remoteBlocker(status())).toBeUndefined();
    expect(remoteBlocker(status({ login: { state: 'logged_out', canPublish: false } }))).toBeDefined();
  });
});

describe('confirmations name the version, the code and the server', () => {
  it('publish', () => {
    const confirmation = publishConfirmation({ versionName: '1.0.6', versionCode: 6 }, SERVER, release(5), 'Faster sync');
    expect(confirmation.question).toBe(`Publish v1.0.6 (code 6) to ${SERVER}?`);
    expect(confirmation.lines).toContain('Notes: Faster sync');
    expect(confirmation.warning).toBeUndefined();
  });

  it('publish warns when the server already has that code or newer', () => {
    const confirmation = publishConfirmation({ versionName: '1.0.5', versionCode: 5 }, SERVER, release(5), '');
    expect(confirmation.warning).toContain('not newer');
  });

  it('release lists the four steps, bump first and commit last', () => {
    const confirmation = releaseConfirmation(
      { versionName: '1.0.6', versionCode: 6 },
      { versionName: '1.1.0', versionCode: 7 },
      SERVER,
      '',
    );
    expect(confirmation.question).toBe(`Release v1.1.0 (code 7) to ${SERVER}?`);
    expect(confirmation.lines[0]).toContain('1.0.6 (code 6) → 1.1.0 (code 7)');
    expect(confirmation.lines[3]).toContain('Commit');
  });
});

describe('make current / rollback', () => {
  const releases = [release(7, { isCurrent: true }), release(6), release(9)];

  it('warns when moving to a lower versionCode', () => {
    const confirmation = makeCurrentConfirmation(release(6), releases, SERVER);
    expect(confirmation.question).toBe(`Make v1.0.6 (code 6) the current release on ${SERVER}?`);
    expect(confirmation.warning).toContain('ROLLS BACK');
    expect(confirmation.yes).toBe('Yes, roll back');
  });

  it('does not warn when moving forward', () => {
    const confirmation = makeCurrentConfirmation(release(9), releases, SERVER);
    expect(confirmation.warning).toBeUndefined();
    expect(confirmation.yes).toBe('Yes, make it current');
  });

  it('does not warn when nothing is current', () => {
    expect(rollbackWarning(release(1), undefined)).toBeUndefined();
  });

  it('marks the current release in the list', () => {
    expect(releaseLabel(release(7, { isCurrent: true }))).toMatch(/^\* 1\.0\.7/);
    expect(releaseLabel(release(6))).toMatch(/^ {2}1\.0\.6/);
  });
});

describe('upload progress', () => {
  it('shows bytes and percent', () => {
    expect(uploadProgressText(6 * 1024 * 1024, 12 * 1024 * 1024)).toBe('Uploading 6.0 MB of 12.0 MB (50%)');
  });

  it('caps at 100% (the multipart framing is a little larger than the APK)', () => {
    expect(uploadProgressText(13 * 1024 * 1024, 12 * 1024 * 1024)).toContain('(100%)');
    expect(progressStep(13, 12)).toBe(100);
  });

  it('only steps when the shown percentage moves', () => {
    expect(progressStep(1, 1000)).toBe(progressStep(5, 1000));
    expect(progressStep(10, 1000)).toBe(1);
  });
});
