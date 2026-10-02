import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { saveCredentials } from '../config.js';
import { PreconditionError } from '../errors.js';
import { runBuild } from './build.js';
import type { ExecFn } from './exec.js';
import { REPO_ROOT_ENV_VAR } from './paths.js';
import { BUILD_TOOLS_VERSION } from './sdk.js';
import { NO_SERVER_URL_WARNING } from './server-url.js';

// =============================================================================
// `runBuild`: the checkout-freshness gate before Gradle  (issue #315)
// =============================================================================
//
// Exec is faked: git answers "behind" or "up to date", and the Gradle call is
// recorded. Everything after Gradle (apksigner, metadata) is out of scope
// here, so a run that reaches Gradle is allowed to stop right after it.
// =============================================================================

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'android-build-'));
  const repo = join(base, 'repo');
  const sdk = join(base, 'sdk');
  mkdirSync(join(repo, 'apps', 'android'), { recursive: true });
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(repo, 'apps', 'android', 'gradlew'), '#!/bin/sh\n');
  writeFileSync(join(repo, 'apps', 'android', 'version.properties'), 'versionName=1.0.6\nversionCode=6\n');
  return { base, repo, env: { [REPO_ROOT_ENV_VAR]: repo, ANDROID_HOME: sdk } };
}

function fakeExec(counts: string, gradle: string[]): ExecFn {
  return async (command, args) => {
    if (command === 'git') {
      if (args.includes('--is-inside-work-tree')) return { code: 0, stdout: 'true\n', stderr: '' };
      if (args.includes('@{u}')) return { code: 0, stdout: 'origin/main\n', stderr: '' };
      if (args.at(-1) === 'HEAD') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-list') return { code: 0, stdout: `${counts}\n`, stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    }
    if (command.endsWith('gradlew')) {
      gradle.push(args.join(' '));
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected ${command}`);
  };
}

describe('runBuild: checkout freshness (#315)', () => {
  it('behind: warns before Gradle runs, then builds anyway', async () => {
    const { env, base } = fixture();
    const logs: string[] = [];
    const gradle: string[] = [];
    await expect(
      runBuild({ debug: true }, { env, home: base, platform: 'linux', exec: fakeExec('0\t3', gradle), log: (line) => logs.push(line) }),
    ).rejects.toThrow(/does not exist/); // stops after Gradle: no APK in this fixture
    const warning = '⚠ Your checkout is 3 commits behind origin/main — the APK will not include them. Run: git pull';
    expect(logs).toContain(warning);
    expect(gradle).toHaveLength(1);
    expect(logs.indexOf(warning)).toBeLessThan(logs.findIndex((line) => line.startsWith('Building debug')));
  });

  it('behind with --require-up-to-date: refuses before Gradle', async () => {
    const { env, base } = fixture();
    const gradle: string[] = [];
    const build = runBuild(
      { debug: true, requireUpToDate: true },
      { env, home: base, platform: 'linux', exec: fakeExec('0\t1', gradle), log: () => {} },
    );
    await expect(build).rejects.toBeInstanceOf(PreconditionError);
    await expect(build).rejects.toThrow(/1 commit behind origin\/main .*--require-up-to-date/);
    expect(gradle).toEqual([]);
  });

  it('up to date: no warning, and --require-up-to-date lets it through', async () => {
    const { env, base } = fixture();
    const logs: string[] = [];
    const gradle: string[] = [];
    await expect(
      runBuild(
        { debug: true, requireUpToDate: true },
        { env, home: base, platform: 'linux', exec: fakeExec('2\t0', gradle), log: (line) => logs.push(line) },
      ),
    ).rejects.toThrow(/does not exist/);
    expect(logs.some((line) => line.includes('behind'))).toBe(false);
    expect(gradle).toHaveLength(1);
  });
});

// =============================================================================
// The server the APK is tied to  (issue #318)
// =============================================================================
//
// Here Gradle "produces" the APK and apksigner answers, so the run completes
// and the metadata and the "Built for" line can be asserted.
// =============================================================================

const SHA = 'ab'.repeat(32);

function completingExec(repo: string, gradle: string[]): ExecFn {
  const behind = fakeExec('0\t0', gradle);
  return async (command, args, options) => {
    if (command.endsWith('gradlew')) {
      gradle.push(args.join(' '));
      const out = join(repo, 'apps', 'android', 'app', 'build', 'outputs', 'apk', 'debug');
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'app-debug.apk'), 'apk');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command.endsWith('apksigner')) return { code: 0, stdout: `Signer #1 certificate SHA-256 digest: ${SHA}\n`, stderr: '' };
    return await behind(command, args, options);
  };
}

function completingFixture() {
  const f = fixture();
  const tools = join(f.env.ANDROID_HOME, 'build-tools', BUILD_TOOLS_VERSION);
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, 'apksigner'), '#!/bin/sh\n');
  return f;
}

describe('runBuild: server URL (#318)', () => {
  it('defaults to the logged-in server, passes it to Gradle, records it and prints "Built for"', async () => {
    const { env, base, repo } = completingFixture();
    saveCredentials({ serverUrl: 'https://app.example.com', token: 'pat_x' }, { home: base, env: {} });
    const logs: string[] = [];
    const gradle: string[] = [];
    const result = await runBuild({ debug: true }, { env, home: base, platform: 'linux', exec: completingExec(repo, gradle), log: (line) => logs.push(line) });

    expect(gradle[0]).toContain('-Pevopath.serverUrl=https://app.example.com');
    expect(result.server).toEqual({ serverUrl: 'https://app.example.com', source: 'login' });
    expect(logs).toContain('Built for https://app.example.com (the logged-in server)');
    expect(logs).not.toContain(NO_SERVER_URL_WARNING);
    expect(JSON.parse(readFileSync(result.metadataPath, 'utf8')).serverUrl).toBe('https://app.example.com');
  });

  it('an explicit --server-url wins over the login', async () => {
    const { env, base, repo } = completingFixture();
    saveCredentials({ serverUrl: 'https://login.example.com', token: 'pat_x' }, { home: base, env: {} });
    const logs: string[] = [];
    const gradle: string[] = [];
    await runBuild(
      { debug: true, serverUrl: 'https://flag.example.com' },
      { env, home: base, platform: 'linux', exec: completingExec(repo, gradle), log: (line) => logs.push(line) },
    );
    expect(gradle[0]).toContain('-Pevopath.serverUrl=https://flag.example.com');
    expect(logs).toContain('Built for https://flag.example.com');
  });

  it('not logged in and no flag: warns before Gradle, builds anyway, records null', async () => {
    const { env, base, repo } = completingFixture();
    const logs: string[] = [];
    const gradle: string[] = [];
    const result = await runBuild({ debug: true }, { env, home: base, platform: 'linux', exec: completingExec(repo, gradle), log: (line) => logs.push(line) });

    expect(gradle).toHaveLength(1);
    expect(gradle[0]).not.toContain('serverUrl');
    expect(logs.indexOf(NO_SERVER_URL_WARNING)).toBeGreaterThanOrEqual(0);
    expect(logs.indexOf(NO_SERVER_URL_WARNING)).toBeLessThan(logs.findIndex((line) => line.startsWith('Building debug')));
    expect(logs.some((line) => line.startsWith('Built for no server'))).toBe(true);
    expect(JSON.parse(readFileSync(result.metadataPath, 'utf8')).serverUrl).toBeNull();
  });
});
