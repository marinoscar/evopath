import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PreconditionError } from '../errors.js';
import { extraGradleArgs, findRepoRoot, requireRepoRoot } from './paths.js';
import { needsShell, quoteWindowsArg } from './exec.js';
import { gradleArgs, gradlewPath } from './gradle.js';

describe('repository root', () => {
  const base = mkdtempSync(join(tmpdir(), 'repo-root-'));
  mkdirSync(join(base, 'apps', 'android'), { recursive: true });
  mkdirSync(join(base, 'apps', 'cli', 'src'), { recursive: true });

  it('walks up to the directory holding apps/android', () => {
    expect(findRepoRoot({ env: {}, cwd: join(base, 'apps', 'cli', 'src') })).toBe(base);
  });

  it('honours EVOPATHCLI_REPO_ROOT, and rejects one without apps/android', () => {
    expect(findRepoRoot({ env: { EVOPATHCLI_REPO_ROOT: base }, cwd: '/' })).toBe(base);
    expect(findRepoRoot({ env: { EVOPATHCLI_REPO_ROOT: join(base, 'apps') } })).toBeUndefined();
    expect(() => requireRepoRoot({ env: { EVOPATHCLI_REPO_ROOT: join(base, 'apps') } })).toThrow(PreconditionError);
  });
});

describe('gradle', () => {
  it('splits EVOPATHCLI_GRADLE_ARGS with quotes', () => {
    expect(extraGradleArgs({ EVOPATHCLI_GRADLE_ARGS: '-I "/a b/init.kts" --offline' })).toEqual(['-I', '/a b/init.kts', '--offline']);
    expect(extraGradleArgs({})).toEqual([]);
  });

  it('passes the version as -Pevopath.* properties', () => {
    expect(gradleArgs({ debug: false, versionName: '1.0.0', versionCode: 3, serverUrl: 'https://x', extra: ['--offline'] })).toEqual([
      'assembleRelease',
      '-Pevopath.versionName=1.0.0',
      '-Pevopath.versionCode=3',
      '-Pevopath.serverUrl=https://x',
      '--console=plain',
      '--offline',
    ]);
    expect(gradleArgs({ debug: true, versionName: '1.0.0', versionCode: 3 })[0]).toBe('assembleDebug');
  });

  it('uses gradlew.bat through a shell on Windows', () => {
    expect(gradlewPath('/p', 'win32')).toBe(join('/p', 'gradlew.bat'));
    expect(gradlewPath('/p', 'linux')).toBe(join('/p', 'gradlew'));
    expect(needsShell('C:\\p\\gradlew.bat', 'win32')).toBe(true);
    expect(needsShell('/p/gradlew', 'linux')).toBe(false);
    expect(needsShell('keytool.exe', 'win32')).toBe(false);
    expect(quoteWindowsArg('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
    expect(quoteWindowsArg('-Pa=b')).toBe('-Pa=b');
  });
});
