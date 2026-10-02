import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatAndroidDoctorReport, runAndroidDoctor, sdkFixesNeeded, type AndroidCheck } from './doctor.js';
import type { ExecFn } from './exec.js';
import { ToolMissingError } from './exec.js';
import { saveCredentials } from '../config.js';
import { writeSigningConfig } from './keystore.js';

const FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':');

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'android-doctor-'));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'apps', 'android'), { recursive: true });
  writeFileSync(join(repo, 'apps', 'android', 'gradlew'), '#!/bin/sh\n');
  writeFileSync(join(repo, 'apps', 'android', 'version.properties'), 'versionName=1.0.0\nversionCode=3\n');
  mkdirSync(home, { recursive: true });
  return { base, home, repo };
}

/** `git` answers for the freshness check (#315): HEAD on main, tracking origin/main. */
type GitAnswers = { fetch?: { code: number; stderr?: string }; counts?: string; inside?: boolean };

function fakeGit(args: readonly string[], answers: GitAnswers) {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  if (args.includes('--is-inside-work-tree')) {
    return answers.inside === false ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' } : ok('true\n');
  }
  if (args.includes('@{u}')) return ok('origin/main\n');
  if (args.at(-1) === 'HEAD') return ok('main\n');
  if (args[0] === 'fetch') return { stdout: '', stderr: '', ...(answers.fetch ?? { code: 0 }) };
  if (args[0] === 'rev-list') return ok(`${answers.counts ?? '0\t0'}\n`);
  throw new Error(`unexpected git ${args.join(' ')}`);
}

function fakeExec(java: string | 'missing', keytoolOk = true, git: GitAnswers = {}): ExecFn {
  return async (command, args) => {
    if (command === 'git') return fakeGit(args, git);
    if (command.endsWith('java')) {
      if (java === 'missing') throw new ToolMissingError('`java` was not found.');
      return { code: 0, stdout: '', stderr: java };
    }
    if (command.endsWith('keytool')) {
      return keytoolOk
        ? { code: 0, stdout: `Certificate fingerprints:\n\t SHA256: ${FINGERPRINT}\n`, stderr: '' }
        : { code: 1, stdout: 'keytool error: java.io.IOException: keystore password was incorrect', stderr: '' };
    }
    throw new Error(`unexpected ${command}`);
  };
}

const byId = (checks: AndroidCheck[], id: string) => checks.find((check) => check.id === id);

describe('runAndroidDoctor', () => {
  it('passes everything on a complete setup', async () => {
    const { home, repo } = fixture();
    const sdk = join(home, 'sdk');
    const keystore = join(home, 'release.jks');
    writeFileSync(keystore, 'x');
    writeSigningConfig({ keystorePath: keystore, keyAlias: 'a', storePassword: 'p', keyPassword: 'p' }, { home });
    saveCredentials({ serverUrl: 'https://app.example.com', token: 'pat_x' }, { home, env: {} });

    const report = await runAndroidDoctor({
      exec: fakeExec('openjdk version "21.0.1" 2024'),
      env: { ANDROID_HOME: sdk, EVOPATHCLI_REPO_ROOT: repo },
      home,
      platform: 'linux',
      exists: () => true,
    });

    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(byId(report.checks, 'fingerprint')?.detail).toBe(FINGERPRINT);
    expect(byId(report.checks, 'version')?.detail).toBe('1.0.0 (3)');
  });

  it('fails an old JDK and a missing JDK with an install hint, without stopping', async () => {
    const { home, repo } = fixture();
    for (const java of ['java version "1.8.0_202"', 'missing'] as const) {
      const report = await runAndroidDoctor({
        exec: fakeExec(java),
        env: { EVOPATHCLI_REPO_ROOT: repo },
        home,
        platform: 'linux',
        exists: () => false,
      });
      expect(report.ok).toBe(false);
      expect(byId(report.checks, 'jdk')).toMatchObject({ status: 'fail' });
      expect(byId(report.checks, 'jdk')?.fix).toMatch(/JDK 21/);
      // Every other group still reported.
      expect(byId(report.checks, 'sdk')?.status).toBe('fail');
      expect(byId(report.checks, 'keystore')?.status).toBe('fail');
    }
  });

  it('reports each missing SDK piece and plans the fixes', async () => {
    const { home, repo } = fixture();
    const sdk = join(home, 'sdk');
    const report = await runAndroidDoctor({
      exec: fakeExec('openjdk version "17" 2021'),
      env: { ANDROID_HOME: sdk, EVOPATHCLI_REPO_ROOT: repo },
      home,
      platform: 'linux',
      exists: (path) => path === sdk || path.includes('cmdline-tools') || path.endsWith('gradlew'),
    });
    expect(byId(report.checks, 'sdk')?.status).toBe('pass');
    expect(byId(report.checks, 'cmdline-tools')?.status).toBe('pass');
    expect(byId(report.checks, 'platform')?.status).toBe('fail');
    expect(byId(report.checks, 'licenses')?.status).toBe('fail');
    expect(sdkFixesNeeded(report)).toEqual({ cmdlineTools: false, licenses: true, packages: true });
  });

  it('plans a full install when there is no SDK at all', async () => {
    const { home, repo } = fixture();
    const report = await runAndroidDoctor({
      exec: fakeExec('openjdk version "21" 2024'),
      env: { EVOPATHCLI_REPO_ROOT: repo },
      home,
      platform: 'linux',
      exists: (path) => path.endsWith('gradlew'),
    });
    expect(byId(report.checks, 'sdk')?.status).toBe('fail');
    expect(byId(report.checks, 'platform')?.status).toBe('skip');
    expect(sdkFixesNeeded(report)).toEqual({ cmdlineTools: true, licenses: true, packages: true });
  });

  it('fails the fingerprint when keytool rejects the password', async () => {
    const { home, repo } = fixture();
    const keystore = join(home, 'release.jks');
    writeFileSync(keystore, 'x');
    writeSigningConfig({ keystorePath: keystore, keyAlias: 'a', storePassword: 'wrong', keyPassword: 'wrong' }, { home });
    const report = await runAndroidDoctor({
      exec: fakeExec('openjdk version "21" 2024', false),
      env: { EVOPATHCLI_REPO_ROOT: repo },
      home,
      platform: 'linux',
      exists: () => true,
    });
    expect(byId(report.checks, 'keystore')?.status).toBe('pass');
    expect(byId(report.checks, 'fingerprint')?.status).toBe('fail');
  });

  it('warns on a missing version.properties and fails without a checkout', async () => {
    const { home, repo, base } = fixture();
    const noVersion = join(base, 'repo2');
    mkdirSync(join(noVersion, 'apps', 'android'), { recursive: true });
    const warned = await runAndroidDoctor({ exec: fakeExec('openjdk version "21" 2024'), env: { EVOPATHCLI_REPO_ROOT: noVersion }, home, exists: () => true });
    expect(byId(warned.checks, 'version')?.status).toBe('warn');

    const none = await runAndroidDoctor({ exec: fakeExec('openjdk version "21" 2024'), env: { EVOPATHCLI_REPO_ROOT: join(repo, 'nope') }, home, exists: () => true });
    expect(byId(none.checks, 'repo')?.status).toBe('fail');
    expect(byId(none.checks, 'gradlew')?.status).toBe('skip');
  });
});

describe('the repo.fresh check (#315)', () => {
  async function freshCheck(git: GitAnswers) {
    const { home, repo } = fixture();
    const report = await runAndroidDoctor({
      exec: fakeExec('openjdk version "21" 2024', true, git),
      env: { ANDROID_HOME: join(home, 'sdk'), EVOPATHCLI_REPO_ROOT: repo },
      home,
      platform: 'linux',
      exists: () => true,
    });
    return { report, check: byId(report.checks, 'repo.fresh') };
  }

  it('passes when up to date with origin/main, right after the checkout row', async () => {
    const { report, check } = await freshCheck({});
    expect(check).toMatchObject({ status: 'pass', label: 'Checkout up to date with origin/main', detail: 'Up to date with origin/main' });
    expect(report.checks.map((c) => c.id).slice(0, 2)).toEqual(['repo', 'repo.fresh']);
  });

  it('warns when behind, with `git pull` as the fix -- and never fails the doctor', async () => {
    const { report, check } = await freshCheck({ counts: '0\t4' });
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/^4 commits behind origin\/main/);
    expect(check?.fix).toBe('Run `git pull`.');
    expect(byId(report.checks, 'jdk')?.status).toBe('pass');
    expect(report.checks.filter((c) => c.status === 'fail').map((c) => c.id)).not.toContain('repo.fresh');
  });

  it('warns, explaining, when the fetch failed', async () => {
    const { check } = await freshCheck({ fetch: { code: 128, stderr: 'fatal: unable to access: Could not resolve host' } });
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/could not fetch: fatal: unable to access/);
    expect(check?.detail).toMatch(/may be stale/);
  });

  it('warns, explaining, when the checkout is not a git clone', async () => {
    const { check } = await freshCheck({ inside: false });
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/^Not a git checkout/);
  });

  it('is skipped when there is no checkout at all', async () => {
    const { home, repo } = fixture();
    const report = await runAndroidDoctor({
      exec: fakeExec('openjdk version "21" 2024'),
      env: { EVOPATHCLI_REPO_ROOT: join(repo, 'nope') },
      home,
      exists: () => true,
    });
    expect(byId(report.checks, 'repo.fresh')?.status).toBe('skip');
  });
});

describe('formatAndroidDoctorReport', () => {
  it('renders symbols, fixes and the verdict, with colour only on request', async () => {
    const report = {
      ok: false,
      repoRoot: undefined,
      sdk: { root: '/s', source: 'managed' as const, exists: false },
      checks: [
        { id: 'jdk' as const, label: 'JDK 17+', status: 'pass' as const, detail: 'Java 21' },
        { id: 'version' as const, label: 'version.properties', status: 'warn' as const, detail: 'Missing', fix: 'create it' },
        { id: 'sdk' as const, label: 'Android SDK', status: 'fail' as const, detail: 'none', fix: 'run --fix' },
        { id: 'platform' as const, label: 'platform', status: 'skip' as const, detail: 'No SDK' },
      ],
    };
    const plain = formatAndroidDoctorReport(report, { colour: false });
    expect(plain).toContain('✓ JDK 17+');
    expect(plain).toContain('⚠ version.properties');
    expect(plain).toContain('✗ Android SDK');
    expect(plain).toContain('→ run --fix');
    expect(plain).toContain('At least one check failed.');
    expect(plain).not.toContain('\u001B[');
    expect(formatAndroidDoctorReport(report, { colour: true })).toContain('\u001B[31m✗');
  });
});
