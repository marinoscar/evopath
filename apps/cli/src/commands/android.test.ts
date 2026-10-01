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
