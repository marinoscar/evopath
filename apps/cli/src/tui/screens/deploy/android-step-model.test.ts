import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AndroidDoctorReport } from '../../../android/doctor.js';
import type { ReleaseStatus } from '../../../android/release-status.js';
import { CLI_NAME } from '../../../branding.js';
import {
  ANDROID_CHOICES,
  androidConfirmValue,
  checkoutVersionLine,
  defaultAndroidChoice,
  doctorLines,
  lookupReleaseLine,
  releaseLine,
  withAndroidChoice,
} from './android-step-model.js';
import { withFlags } from './fields.js';
import { labelFor } from './model.js';

// The deploy screens' "Android app" step (#315), as data.

const URL = 'https://app.example.test';

function deployRoot(withAndroid: boolean, version?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'android-step-model-'));
  if (withAndroid) {
    mkdirSync(join(root, 'repo', 'apps', 'android'), { recursive: true });
    if (version !== undefined) writeFileSync(join(root, 'repo', 'apps', 'android', 'version.properties'), version);
  }
  return root;
}

function status(overrides: Partial<ReleaseStatus> = {}): ReleaseStatus {
  return {
    repoRoot: '/r',
    targetServerUrl: URL,
    local: null,
    keystore: { configured: true },
    login: { state: 'logged_in', serverUrl: URL, canPublish: true },
    server: {
      current: { id: 'r5', packageName: 'p', versionName: '1.0.5', versionCode: 5, fileSha256: 'x', sizeBytes: 1, createdAt: '' },
      reachable: true,
    },
    newerLocally: false,
    ...overrides,
  };
}

describe('the choices', () => {
  it('are No (web app only) then Yes (also build and publish), labelled plainly', () => {
    expect(ANDROID_CHOICES.map((choice) => choice.label)).toEqual([
      'No — web app only',
      'Yes — also build and publish the Android APK (if its version is newer than the published one)',
    ]);
  });

  it('Yes sets --with-android and No clears it, leaving the other flags alone', () => {
    const yes = withAndroidChoice(new Set(['--no-cache']), true);
    expect([...yes]).toEqual(['--no-cache', '--with-android']);
    expect([...withAndroidChoice(yes, false)]).toEqual(['--no-cache']);
  });
});

describe('the default selection', () => {
  it('is No when the deployment checkout has no apps/android, whatever is remembered', () => {
    const read = vi.fn(() => true);
    expect(defaultAndroidChoice(deployRoot(false), read)).toBe(false);
  });

  it('is the remembered answer when the checkout has apps/android', () => {
    expect(defaultAndroidChoice(deployRoot(true), () => true)).toBe(true);
    expect(defaultAndroidChoice(deployRoot(true), () => false)).toBe(false);
  });

  it('is No when nothing is remembered', () => {
    expect(defaultAndroidChoice(deployRoot(true), () => undefined)).toBe(false);
  });

  it('tolerates a preference read that throws', () => {
    const read = () => {
      throw new Error('EACCES');
    };
    expect(defaultAndroidChoice(deployRoot(true), read)).toBe(false);
  });
});

describe('the confirm row', () => {
  it('reads "build and publish if newer" or "not included", labelled Android app', () => {
    expect(androidConfirmValue(new Set(['--with-android']))).toBe('build and publish if newer');
    expect(androidConfirmValue(new Set())).toBe('not included');
    expect(labelFor('__android')).toBe('Android app');
  });

  it('withFlags renders it as its own row, not as a raw flag', () => {
    const rows = withFlags(new Map([['__ref', 'main']]), new Set(['--no-cache', '--with-android']));
    expect(rows.get('__flags')).toBe('--no-cache');
    expect(rows.get('__android')).toBe('build and publish if newer');
    expect(withFlags(new Map(), new Set(['--with-android'])).get('__flags')).toBe('none');
    expect(withFlags(new Map(), new Set()).get('__android')).toBe('not included');
  });
});

describe('the context lines', () => {
  it('reads the checkout version, or says there is none', () => {
    expect(checkoutVersionLine(deployRoot(true, 'versionName=1.0.6\nversionCode=6\n'))).toBe('1.0.6 (code 6)');
    expect(checkoutVersionLine(deployRoot(false))).toMatch(/^no apps\/android in .*repo yet$/);
  });

  it('describes the published release for every login state', () => {
    expect(releaseLine(status(), URL)).toBe(`1.0.5 (code 5) on ${URL}`);
    expect(releaseLine(status({ server: { current: null, reachable: true } }), URL)).toBe(`nothing published yet on ${URL}`);
    expect(releaseLine(status({ login: { state: 'logged_out', canPublish: false } }), URL)).toBe(
      `not logged in to ${URL} — run \`${CLI_NAME} login --server ${URL}\``,
    );
    expect(releaseLine(status({ login: { state: 'logged_in', canPublish: true, error: 'ECONNREFUSED' } }), URL)).toBe(
      `${URL} unreachable (ECONNREFUSED)`,
    );
    expect(releaseLine(status({ login: { state: 'logged_in', serverUrl: URL, canPublish: false } }), URL)).toContain(
      'needs system_settings:write',
    );
  });

  it('a lookup that never answers reads "unreachable" after the timeout, and is aborted', async () => {
    let aborted = false;
    const line = await lookupReleaseLine('app.example.test', '/r', {
      timeoutMs: 20,
      getReleaseStatus: (_url, _root, signal) =>
        new Promise(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    });
    expect(line).toBe(`${URL} unreachable (no answer within 0s)`);
    expect(aborted).toBe(true);
  });

  it('a lookup that throws is a sentence, not an exception', async () => {
    const line = await lookupReleaseLine('app.example.test', '/r', {
      getReleaseStatus: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    });
    expect(line).toBe(`${URL} unreachable (getaddrinfo ENOTFOUND)`);
  });

  it('no domain: says so without asking anything', async () => {
    const getReleaseStatus = vi.fn();
    expect(await lookupReleaseLine(undefined, '/r', { getReleaseStatus })).toMatch(/no domain/);
    expect(getReleaseStatus).not.toHaveBeenCalled();
  });

  it('summarises the pre-flight, listing each failed check with its fix', () => {
    const report: AndroidDoctorReport = {
      ok: false,
      repoRoot: '/r',
      sdk: {} as never,
      checks: [
        { id: 'repo', label: 'Repository', status: 'pass', detail: '/r' },
        { id: 'jdk', label: 'JDK 17+', status: 'fail', detail: 'not found', fix: 'Install a JDK 17.' },
      ],
    };
    expect(doctorLines(report)).toEqual([
      '✖ 1 of 2 checks failed — publishing would be skipped',
      '  ✖ JDK 17+: not found',
      '    → Install a JDK 17.',
    ]);
    expect(doctorLines({ ...report, ok: true, checks: [report.checks[0]!] })).toEqual(['✔ all 1 checks passed']);
    const warned = { ...report, ok: true, checks: [report.checks[0]!, { id: 'repo.fresh' as const, label: 'Fresh', status: 'warn' as const, detail: '2 commits behind origin/main', fix: 'Run `git pull`.' }] };
    expect(doctorLines(warned)).toEqual([
      '✔ all 2 checks passed (1 with a warning)',
      '  ! Fresh: 2 commits behind origin/main',
      '    → Run `git pull`.',
    ]);
  });
});
