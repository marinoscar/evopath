import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { jdkBinary, jdkInstallHint, parseJavaVersion } from './java.js';

describe('parseJavaVersion', () => {
  it('reads a modern JDK 21 banner, past a JAVA_TOOL_OPTIONS line', () => {
    const output =
      'Picked up JAVA_TOOL_OPTIONS: -Dfoo=bar\nopenjdk version "21.0.11" 2026-04-21\nOpenJDK Runtime Environment (build 21.0.11+10)\n';
    expect(parseJavaVersion(output)).toEqual({ major: 21, raw: '21.0.11' });
  });

  it('reads a bare major ("17")', () => {
    expect(parseJavaVersion('openjdk version "17" 2021-09-14\n')).toEqual({ major: 17, raw: '17' });
  });

  it('reads the legacy 1.x scheme as its real major', () => {
    expect(parseJavaVersion('java version "1.8.0_202"\nJava(TM) SE Runtime')).toEqual({ major: 8, raw: '1.8.0_202' });
  });

  it('reads early-access builds', () => {
    expect(parseJavaVersion('openjdk version "22-ea" 2024-03-19')?.major).toBe(22);
  });

  it('returns undefined for unrelated output', () => {
    expect(parseJavaVersion('command not found')).toBeUndefined();
  });
});

describe('jdkBinary', () => {
  it('prefers JAVA_HOME/bin, with .exe on Windows', () => {
    expect(jdkBinary('java', { JAVA_HOME: '/jdk' }, 'linux')).toBe(join('/jdk', 'bin', 'java'));
    expect(jdkBinary('keytool', { JAVA_HOME: 'C:\\jdk' }, 'win32')).toBe(join('C:\\jdk', 'bin', 'keytool.exe'));
  });

  it('falls back to PATH', () => {
    expect(jdkBinary('java', {}, 'darwin')).toBe('java');
    expect(jdkBinary('keytool', {}, 'win32')).toBe('keytool.exe');
  });

  it('gives OS-specific install hints', () => {
    expect(jdkInstallHint('win32')).toMatch(/winget/);
    expect(jdkInstallHint('darwin')).toMatch(/brew/);
    expect(jdkInstallHint('linux')).toMatch(/apt/);
  });
});
