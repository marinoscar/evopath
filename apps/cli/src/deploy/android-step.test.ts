import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { BuildResult } from '../android/build.js';
import type { AndroidDoctorReport } from '../android/doctor.js';
import type { PublishedApk, VersionBump } from '../android/operations.js';
import type { ReleaseStatus } from '../android/release-status.js';
import { UsageError } from '../errors.js';
import {
  androidOptionsFromFlags,
  androidReportLines,
  publicUrlFor,
  runDeployAndroidStep,
  type AndroidStepDeps,
  type AndroidStepInput,
} from './android-step.js';

const URL = 'https://app.example.com';
const REPO = '/home/me/checkout';

function status(overrides: Partial<ReleaseStatus> = {}): ReleaseStatus {
  return {
    repoRoot: REPO,
    targetServerUrl: URL,
    local: { versionName: '1.0.6', versionCode: 6 },
    keystore: { configured: true, sha256: 'AA' },
    login: { state: 'logged_in', serverUrl: URL, canPublish: true, email: 'admin@example.com' },
    server: {
      current: { id: 'r5', packageName: 'p', versionName: '1.0.5', versionCode: 5, fileSha256: 'x', sizeBytes: 1, createdAt: '' },
      reachable: true,
    },
    newerLocally: true,
    ...overrides,
  };
}

const okDoctor: AndroidDoctorReport = { checks: [], ok: true, sdk: { root: '/sdk', exists: true, source: 'default' } as never, repoRoot: REPO };

function built(versionName: string, versionCode: number): BuildResult {
  return {
    apkPath: `/out/${versionName}.apk`,
    metadataPath: `/out/${versionName}.json`,
    verified: true,
    metadata: {
      packageName: 'p',
      versionName,
      versionCode,
      signingSha256: 'ab',
      fileSha256: 'cd',
      sizeBytes: 1,
      builtAt: '',
      gitSha: null,
    },
  };
}

function deps(overrides: Partial<AndroidStepDeps> = {}) {
  const calls: string[] = [];
  const bump = (part: string): VersionBump => ({
    before: { versionName: '1.0.6', versionCode: 6 },
    after: part === 'minor' ? { versionName: '1.1.0', versionCode: 7 } : { versionName: '1.0.7', versionCode: 7 },
    created: false,
  });
  const base: AndroidStepDeps = {
    findRepoRoot: () => REPO,
    getReleaseStatus: vi.fn(async () => status()),
    previewBump: (_root, part) => bump(part),
    bumpVersionFile: (_root, part) => {
      calls.push(`bump:${part}`);
      return bump(part);
    },
    doctor: async () => {
      calls.push('doctor');
      return okDoctor;
    },
    build: async () => {
      calls.push('build');
      return built('1.0.6', 6);
    },
    publish: async (apkPath, _credentials, notes) => {
      calls.push(`publish:${apkPath}:${notes ?? ''}`);
      return { release: { id: 'r-new' } as PublishedApk['release'], metadata: built('1.0.6', 6).metadata };
    },
    commit: async () => {
      calls.push('commit');
      return 'committed abc123 "chore(android): release"';
    },
    credentials: () => ({ serverUrl: URL, token: 'pat_t' }),
  };
  return { calls, deps: { ...base, ...overrides } };
}

const input = (overrides: Partial<AndroidStepInput> = {}): AndroidStepInput => ({
  domain: 'app.example.com',
  deployRoot: '/opt/infra/apps/app',
  options: {},
  ...overrides,
});

describe('runDeployAndroidStep', () => {
  it('newer locally → doctor, build, publish to the deployment URL', async () => {
    const { calls, deps: d } = deps();
    const outcome = await runDeployAndroidStep(input({ options: { notes: 'Faster sync' } }), d);
    expect(calls).toEqual(['doctor', 'build', 'publish:/out/1.0.6.apk:Faster sync']);
    expect(outcome).toMatchObject({ status: 'published', version: { versionCode: 6 }, releaseId: 'r-new', serverUrl: URL });
    expect(d.getReleaseStatus).toHaveBeenCalledWith({ repoRoot: REPO, serverUrl: URL });
  });

  it('nothing published yet counts as newer', async () => {
    const { calls, deps: d } = deps({ getReleaseStatus: async () => status({ server: { current: null, reachable: true } }) });
    expect((await runDeployAndroidStep(input(), d)).status).toBe('published');
    expect(calls).toContain('build');
  });

  it('not newer → skips without building, and suggests --android-bump', async () => {
    const { calls, deps: d } = deps({
      getReleaseStatus: async () => status({ local: { versionName: '1.0.5', versionCode: 5 }, newerLocally: false }),
    });
    const outcome = await runDeployAndroidStep(input(), d);
    expect(outcome).toMatchObject({ status: 'skipped', fix: 'pass --android-bump patch to publish a new build' });
    expect(calls).toEqual([]);
  });

  it('--android-bump → doctor, then bump → build → publish → commit (commit last)', async () => {
    const { calls, deps: d } = deps({
      getReleaseStatus: async () => status({ local: { versionName: '1.0.6', versionCode: 6 } }),
    });
    const outcome = await runDeployAndroidStep(input({ options: { bump: 'minor' } }), d);
    expect(calls).toEqual(['doctor', 'bump:minor', 'build', 'publish:/out/1.0.6.apk:', 'commit']);
    expect(outcome).toMatchObject({ status: 'published', version: { versionName: '1.1.0', versionCode: 7 } });
    expect(androidReportLines(outcome)[1]).toContain('committed abc123');
  });

  it('--android-bump is compared AFTER the bump: a server at the old code is still published to', async () => {
    const { deps: d } = deps({
      getReleaseStatus: async () =>
        status({
          server: { current: { id: 'r6', packageName: 'p', versionName: '1.0.6', versionCode: 6, fileSha256: '', sizeBytes: 1, createdAt: '' }, reachable: true },
          newerLocally: false,
        }),
    });
    expect((await runDeployAndroidStep(input({ options: { bump: 'patch' } }), d)).status).toBe('published');
  });

  it('--android-bump in the deployment checkout is refused (it would dirty the next update)', async () => {
    const deployRoot = mkdtempSync(join(tmpdir(), 'android-step-deploy-'));
    mkdirSync(join(deployRoot, 'repo', 'apps', 'android'), { recursive: true });
    const { calls, deps: d } = deps({ findRepoRoot: () => undefined });
    const outcome = await runDeployAndroidStep(input({ deployRoot, options: { bump: 'patch' } }), d);
    expect(outcome.status).toBe('skipped');
    expect(calls).toEqual([]);
    expect(d.getReleaseStatus).not.toHaveBeenCalled();
  });

  it('falls back to the deployment checkout when not run from one', async () => {
    const deployRoot = mkdtempSync(join(tmpdir(), 'android-step-deploy-'));
    mkdirSync(join(deployRoot, 'repo', 'apps', 'android'), { recursive: true });
    const { deps: d } = deps({ findRepoRoot: () => undefined });
    await runDeployAndroidStep(input({ deployRoot }), d);
    expect(d.getReleaseStatus).toHaveBeenCalledWith({ repoRoot: join(deployRoot, 'repo'), serverUrl: URL });
  });

  it('no toolchain → warns with the doctor fix and does not build', async () => {
    const { calls, deps: d } = deps({
      doctor: async () => ({
        ...okDoctor,
        ok: false,
        checks: [{ id: 'jdk', label: 'JDK 17+', status: 'fail', detail: 'missing', fix: 'Install a JDK 17.' }],
      }),
    });
    const outcome = await runDeployAndroidStep(input(), d);
    expect(outcome).toEqual({ status: 'skipped', reason: 'the Android toolchain is not ready (JDK 17+)', fix: 'Install a JDK 17.' });
    expect(calls).toEqual([]);
  });

  it.each([
    ['logged_out', { state: 'logged_out' as const, canPublish: false }],
    ['expired', { state: 'expired' as const, serverUrl: URL, canPublish: false }],
    ['other_server', { state: 'other_server' as const, serverUrl: 'https://other.example.com', canPublish: false }],
  ])('%s → skipped with `login --server <url>`', async (_name, login) => {
    const { calls, deps: d } = deps({ getReleaseStatus: async () => status({ login }) });
    const outcome = await runDeployAndroidStep(input(), d);
    expect(outcome).toMatchObject({ status: 'skipped', fix: expect.stringMatching(/ login --server https:\/\/app\.example\.com$/) });
    expect(calls).toEqual([]);
  });

  it('without system_settings:write → skipped naming the permission', async () => {
    const { deps: d } = deps({
      getReleaseStatus: async () => status({ login: { state: 'logged_in', serverUrl: URL, canPublish: false, email: 'u@example.com' } }),
    });
    const outcome = await runDeployAndroidStep(input(), d);
    expect(outcome.status).toBe('skipped');
    expect(outcome.status === 'skipped' && outcome.reason).toContain('system_settings:write');
  });

  it('a publish error → failed with the publish command, never thrown', async () => {
    const { deps: d } = deps({
      publish: async () => {
        throw new Error('413 Request Entity Too Large');
      },
    });
    const outcome = await runDeployAndroidStep(input(), d);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'upload failed: 413 Request Entity Too Large' });
    expect(outcome.status === 'failed' && outcome.fix).toContain('android publish');
    expect(androidReportLines(outcome).at(-1)).toContain('the deploy itself succeeded');
  });

  it('a build error → failed with the build command', async () => {
    const { deps: d } = deps({
      build: async () => {
        throw new Error('gradle exploded');
      },
    });
    const outcome = await runDeployAndroidStep(input(), d);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'build failed: gradle exploded' });
    expect(outcome.status === 'failed' && outcome.fix).toContain(`android build --server-url ${URL}`);
  });

  it('an unexpected throw anywhere is still an outcome, not an exception', async () => {
    const { deps: d } = deps({
      getReleaseStatus: async () => {
        throw new Error('boom');
      },
    });
    await expect(runDeployAndroidStep(input(), d)).resolves.toMatchObject({ status: 'failed', reason: 'boom' });
  });

  it('no domain → skipped before touching anything', async () => {
    const { deps: d } = deps();
    const outcome = await runDeployAndroidStep(input({ domain: undefined }), d);
    expect(outcome.status).toBe('skipped');
    expect(d.getReleaseStatus).not.toHaveBeenCalled();
  });

  it('never asks a question: it completes with no input in every path (non-interactive safe)', async () => {
    // The deps carry no prompt at all; this pins that the step runs to an
    // outcome on its own, which is what --non-interactive and cron rely on.
    const { deps: d } = deps();
    const stdinRead = vi.spyOn(process.stdin, 'read');
    await runDeployAndroidStep(input(), d);
    expect(stdinRead).not.toHaveBeenCalled();
    stdinRead.mockRestore();
  });
});

describe('flag parsing', () => {
  it('nothing without --with-android', () => {
    expect(androidOptionsFromFlags({})).toBeUndefined();
  });

  it('bump and notes with --with-android', () => {
    expect(androidOptionsFromFlags({ withAndroid: true, androidBump: 'minor', androidNotes: '  Faster sync ' })).toEqual({
      bump: 'minor',
      notes: 'Faster sync',
    });
    expect(androidOptionsFromFlags({ withAndroid: true })).toEqual({});
  });

  it('refuses a bad bump part before the deploy starts', () => {
    expect(() => androidOptionsFromFlags({ withAndroid: true, androidBump: 'huge' })).toThrow(UsageError);
  });

  it('refuses --android-* without --with-android', () => {
    expect(() => androidOptionsFromFlags({ androidBump: 'patch' })).toThrow(/need --with-android/);
    expect(() => androidOptionsFromFlags({ androidNotes: 'x' })).toThrow(UsageError);
  });

  it('builds the public URL from the domain', () => {
    expect(publicUrlFor('app.example.com')).toBe(URL);
    expect(publicUrlFor('https://app.example.com/')).toBe(URL);
    expect(publicUrlFor(undefined)).toBeUndefined();
    expect(publicUrlFor(' ')).toBeUndefined();
  });
});
