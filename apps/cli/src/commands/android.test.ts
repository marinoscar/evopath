import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { apkFileName } from '../android/metadata.js';
import { registerAndroidCommand } from './android.js';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'android-cmd-'));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(repo, 'apps', 'android'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>();
  const env = {
    EVOPATHCLI_REPO_ROOT: repo,
    EVOPATHCLI_SERVER_URL: 'https://app.example.com',
    EVOPATHCLI_TOKEN: 'pat_test',
  };
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride();
    registerAndroidCommand(program, {
      stdout: { write: (chunk: string) => out.push(chunk) },
      stderr: { write: (chunk: string) => err.push(chunk) },
      env,
      home,
      fetch,
    });
    await program.parseAsync(['android', ...args], { from: 'user' });
  };
  return { repo, home, out, err, fetch, run };
}

describe('evopathcli android version', () => {
  it('shows the defaults, then creates and bumps version.properties', async () => {
    const t = setup();
    await t.run('version');
    expect(t.out.join('')).toBe('0.1.0 (1)\n');

    await t.run('version', '--set', '0.1.0');
    const file = join(t.repo, 'apps', 'android', 'version.properties');
    expect(readFileSync(file, 'utf8')).toBe('versionName=0.1.0\nversionCode=1\n');

    await t.run('version', '--bump', 'minor');
    expect(readFileSync(file, 'utf8')).toBe('versionName=0.2.0\nversionCode=2\n');

    await expect(t.run('version', '--code', '2')).rejects.toThrow(/not greater/);
  });
});

describe('evopathcli android publish', () => {
  it('uploads the default APK with its metadata and prints the release id', async () => {
    const t = setup();
    writeFileSync(join(t.repo, 'apps', 'android', 'version.properties'), 'versionName=1.0.0\nversionCode=5\n');
    const dist = join(t.repo, 'dist', 'android');
    mkdirSync(dist, { recursive: true });
    const apk = join(dist, apkFileName('1.0.0'));
    writeFileSync(apk, 'PK\u0003\u0004');
    writeFileSync(
      apk.replace(/\.apk$/, '.json'),
      JSON.stringify({ packageName: 'com.x', versionName: '1.0.0', versionCode: 5, signingSha256: 'ab', fileSha256: 'cd', sizeBytes: 4 }),
    );
    t.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { id: 'rel-1', versionName: '1.0.0', versionCode: 5, isCurrent: false, packageName: 'com.x', fileSha256: 'cd', sizeBytes: 4, createdAt: '' } }),
        { status: 201 },
      ),
    );

    await t.run('publish', '--no-current', '--notes', 'hello');

    expect(t.out.join('')).toBe('rel-1\n');
    const form = t.fetch.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get('makeCurrent')).toBe('false');
    expect(form.get('notes')).toBe('hello');
    expect(form.get('versionCode')).toBe('5');
    expect(t.err.join('')).toContain('https://app.example.com/settings/android-app');
  });

  it('warns when the APK was built for another server, and never sends serverUrl (#318)', async () => {
    const t = setup();
    writeFileSync(join(t.repo, 'apps', 'android', 'version.properties'), 'versionName=1.0.0\nversionCode=5\n');
    const dist = join(t.repo, 'dist', 'android');
    mkdirSync(dist, { recursive: true });
    const apk = join(dist, apkFileName('1.0.0'));
    writeFileSync(apk, 'PK\u0003\u0004');
    writeFileSync(
      apk.replace(/\.apk$/, '.json'),
      JSON.stringify({ packageName: 'com.x', versionName: '1.0.0', versionCode: 5, signingSha256: 'ab', fileSha256: 'cd', sizeBytes: 4, serverUrl: 'https://other.example.com' }),
    );
    t.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { id: 'rel-2', versionName: '1.0.0', versionCode: 5, isCurrent: true, packageName: 'com.x', fileSha256: 'cd', sizeBytes: 4, createdAt: '' } }),
        { status: 201 },
      ),
    );

    await t.run('publish');

    expect(t.err.join('')).toContain('built for https://other.example.com, not https://app.example.com');
    const form = t.fetch.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get('serverUrl')).toBeNull();
  });

  it('refuses when the APK has not been built', async () => {
    const t = setup();
    await expect(t.run('publish')).rejects.toThrow(/android build/);
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe('evopathcli android keystore', () => {
  it('show/secrets refuse without a configured keystore', async () => {
    const t = setup();
    await expect(t.run('keystore', 'show')).rejects.toThrow(/keystore init/);
    await expect(t.run('keystore', 'secrets')).rejects.toThrow(/keystore init/);
  });
});

// #315: `--require-up-to-date` turns "the checkout is behind" into an error
// exit before anything is built (or, for release, bumped).
describe('evopathcli android build|release --require-up-to-date', () => {
  function behindExec(calls: string[]) {
    return vi.fn(async (command: string, args: readonly string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command !== 'git') throw new Error(`unexpected ${command}`);
      if (args.includes('--is-inside-work-tree')) return { code: 0, stdout: 'true\n', stderr: '' };
      if (args.includes('@{u}')) return { code: 0, stdout: 'origin/main\n', stderr: '' };
      if (args.at(-1) === 'HEAD') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-list') return { code: 0, stdout: '0\t2\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
  }

  function setupBehind() {
    const base = mkdtempSync(join(tmpdir(), 'android-cmd-fresh-'));
    const repo = join(base, 'repo');
    const sdk = join(base, 'sdk');
    mkdirSync(join(repo, 'apps', 'android'), { recursive: true });
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(repo, 'apps', 'android', 'gradlew'), '#!/bin/sh\n');
    writeFileSync(join(repo, 'apps', 'android', 'version.properties'), 'versionName=1.0.6\nversionCode=6\n');
    const calls: string[] = [];
    const exec = behindExec(calls);
    const run = async (...args: string[]) => {
      const program = new Command().exitOverride();
      registerAndroidCommand(program, {
        stdout: { write: () => true },
        stderr: { write: () => true },
        env: { EVOPATHCLI_REPO_ROOT: repo, ANDROID_HOME: sdk, EVOPATHCLI_SERVER_URL: 'https://app.example.com', EVOPATHCLI_TOKEN: 'pat_test' },
        home: join(base, 'home'),
        exec,
      });
      await program.parseAsync(['android', ...args], { from: 'user' });
    };
    return { repo, calls, run };
  }

  it('build: exits with a precondition error naming the gap, before Gradle', async () => {
    const t = setupBehind();
    await expect(t.run('build', '--debug', '--require-up-to-date')).rejects.toThrow(
      /2 commits behind origin\/main .*Run: git pull .*--require-up-to-date/,
    );
    expect(t.calls.some((call) => call.includes('gradlew'))).toBe(false);
  });

  it('release: refuses before bumping version.properties', async () => {
    const t = setupBehind();
    const signingHome = join(t.repo, '..', 'home');
    mkdirSync(signingHome, { recursive: true });
    const { writeSigningConfig } = await import('../android/keystore.js');
    writeSigningConfig({ keystorePath: join(signingHome, 'k.jks'), keyAlias: 'a', storePassword: 'p', keyPassword: 'p' }, { home: signingHome });
    await expect(t.run('release', '--require-up-to-date')).rejects.toThrow(/refusing to release: --require-up-to-date/);
    expect(readFileSync(join(t.repo, 'apps', 'android', 'version.properties'), 'utf8')).toBe('versionName=1.0.6\nversionCode=6\n');
  });
});
