import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  deployPreferencesPath,
  readAndroidPreference,
  writeAndroidPreference,
} from './preferences.js';

// The Android step's remembered answer (#315): a convenience that must never
// throw, whatever state the file is in.

const home = () => mkdtempSync(join(tmpdir(), 'deploy-prefs-'));

describe('deploy preferences', () => {
  it('nothing stored → undefined', () => {
    expect(readAndroidPreference('/opt/apps/shop', { home: home() })).toBeUndefined();
  });

  it('remembers the answer per deployment', () => {
    const ctx = { home: home() };
    expect(writeAndroidPreference('/opt/apps/shop', true, ctx)).toBe(true);
    writeAndroidPreference('/opt/apps/blog', false, ctx);
    expect(readAndroidPreference('/opt/apps/shop', ctx)).toBe(true);
    expect(readAndroidPreference('/opt/apps/blog', ctx)).toBe(false);
    writeAndroidPreference('/opt/apps/shop', false, ctx);
    expect(readAndroidPreference('/opt/apps/shop', ctx)).toBe(false);
  });

  it('a malformed file reads as nothing stored, and is replaced on write', () => {
    const ctx = { home: home() };
    mkdirSync(dirname(deployPreferencesPath(ctx)), { recursive: true });
    writeFileSync(deployPreferencesPath(ctx), '{not json');
    expect(readAndroidPreference('/opt/apps/shop', ctx)).toBeUndefined();
    expect(writeAndroidPreference('/opt/apps/shop', true, ctx)).toBe(true);
    expect(readAndroidPreference('/opt/apps/shop', ctx)).toBe(true);
  });

  it('an unreadable path never throws: reads undefined, writes report false', () => {
    const ctx = { home: home() };
    // A DIRECTORY where the file should be: EISDIR on read and on rename.
    mkdirSync(deployPreferencesPath(ctx), { recursive: true });
    expect(() => readAndroidPreference('/opt/apps/shop', ctx)).not.toThrow();
    expect(readAndroidPreference('/opt/apps/shop', ctx)).toBeUndefined();
    expect(writeAndroidPreference('/opt/apps/shop', true, ctx)).toBe(false);
  });
});
