import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import {
  applyVersionChange,
  bumpSemver,
  parseBumpPart,
  parseProperties,
  readVersion,
  updateProperties,
  writeVersion,
} from './version.js';

describe('bumpSemver', () => {
  it('bumps each part and resets the lower ones', () => {
    expect(bumpSemver('1.2.3', 'patch')).toBe('1.2.4');
    expect(bumpSemver('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpSemver('1.2.3', 'major')).toBe('2.0.0');
    expect(bumpSemver('0.9.9', 'patch')).toBe('0.9.10');
  });

  it('refuses a non-semver name', () => {
    expect(() => bumpSemver('1.2', 'patch')).toThrow(UsageError);
    expect(() => bumpSemver('1.2.3-beta', 'patch')).toThrow(UsageError);
  });

  it('validates the bump part', () => {
    expect(parseBumpPart('minor')).toBe('minor');
    expect(() => parseBumpPart('build')).toThrow(UsageError);
  });
});

describe('properties parsing', () => {
  it('reads key=value and skips comments', () => {
    const props = parseProperties('# comment\nversionName=1.0.0\n\nversionCode = 7\r\n! other\n');
    expect(props.get('versionName')).toBe('1.0.0');
    expect(props.get('versionCode')).toBe('7');
    expect(props.size).toBe(2);
  });

  it('rewrites values in place, keeps comments, appends missing keys', () => {
    const out = updateProperties('# top\nversionName=1.0.0\nother=x\n', { versionName: '1.0.1', versionCode: '2' });
    expect(out).toBe('# top\nversionName=1.0.1\nother=x\nversionCode=2\n');
  });
});

describe('readVersion / writeVersion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'android-version-'));

  it('returns the defaults for a missing file', () => {
    expect(readVersion(join(dir, 'none.properties'))).toEqual({ versionName: '0.1.0', versionCode: 1, exists: false });
  });

  it('round-trips and creates the file', () => {
    const file = join(dir, 'version.properties');
    writeVersion(file, { versionName: '0.2.0', versionCode: 5 });
    expect(readFileSync(file, 'utf8')).toBe('versionName=0.2.0\nversionCode=5\n');
    expect(readVersion(file)).toEqual({ versionName: '0.2.0', versionCode: 5, exists: true });
  });

  it('rejects a malformed versionCode', () => {
    const file = join(dir, 'bad.properties');
    writeFileSync(file, 'versionName=1.0.0\nversionCode=abc\n');
    expect(() => readVersion(file)).toThrow(/versionCode/);
  });
});

describe('applyVersionChange', () => {
  const current = { versionName: '1.2.3', versionCode: 10, exists: true };

  it('returns undefined when nothing was asked', () => {
    expect(applyVersionChange(current, {})).toBeUndefined();
  });

  it('every bump or set increments versionCode by one', () => {
    expect(applyVersionChange(current, { bump: 'patch' })).toEqual({ versionName: '1.2.4', versionCode: 11 });
    expect(applyVersionChange(current, { set: '2.0.0' })).toEqual({ versionName: '2.0.0', versionCode: 11 });
  });

  it('honours an explicit --code that moves forward and refuses one that does not', () => {
    expect(applyVersionChange(current, { bump: 'minor', code: 20 })).toEqual({ versionName: '1.3.0', versionCode: 20 });
    expect(applyVersionChange(current, { code: 11 })).toEqual({ versionName: '1.2.3', versionCode: 11 });
    expect(() => applyVersionChange(current, { code: 10 })).toThrow(/not greater/);
  });

  it('refuses --bump with --set, and a non-semver --set', () => {
    expect(() => applyVersionChange(current, { bump: 'patch', set: '1.0.0' })).toThrow(UsageError);
    expect(() => applyVersionChange(current, { set: 'v1' })).toThrow(UsageError);
  });

  it('creates a missing file at 0.1.0 (1) on the first bump', () => {
    const missing = { versionName: '0.1.0', versionCode: 1, exists: false };
    expect(applyVersionChange(missing, { bump: 'patch' })).toEqual({ versionName: '0.1.0', versionCode: 1 });
    expect(applyVersionChange(missing, { set: '1.0.0' })).toEqual({ versionName: '1.0.0', versionCode: 1 });
  });
});
