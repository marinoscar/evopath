import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PreconditionError } from '../errors.js';
import { runBuild } from './build.js';
import type { ExecFn } from './exec.js';
import { REPO_ROOT_ENV_VAR } from './paths.js';

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
