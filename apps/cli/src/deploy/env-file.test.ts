import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseEnvExample } from './env-spec.js';
import { readEnvFile, writeEnvContents, writeEnvFile } from './env-file.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-env-file-'));
}

/** A template exercising a section banner and more than one key, like the
 *  fixture in env-spec.test.ts, but local so this suite has no dependency on
 *  what .env.example happens to contain today. */
const TEMPLATE = [
  '# ------------------------------------------------------------',
  '# Application',
  '# ------------------------------------------------------------',
  'NODE_ENV=development',
  'APP_URL=http://localhost:3535',
  '',
  '# ------------------------------------------------------------',
  '# Database',
  '# ------------------------------------------------------------',
  'POSTGRES_HOST=localhost',
  'POSTGRES_PASSWORD=postgres',
].join('\n');

const SPECS = parseEnvExample(TEMPLATE);

function tmpFilesIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

describe('writeEnvFile - permissions', () => {
  it('writes a fresh file 0600', () => {
    const root = makeRoot();
    const path = join(root, '.env');

    writeEnvFile(path, new Map([['NODE_ENV', 'production']]), SPECS);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('forces 0600 even when a pre-existing file was 0644', () => {
    // The actual bug: passing `mode` to writeFileSync only applies when the
    // file is CREATED, so rewriting a pre-existing 0644 .env left it 0644.
    const root = makeRoot();
    const path = join(root, '.env');
    writeFileSync(path, 'NODE_ENV=old\n', { mode: 0o644 });
    expect(statSync(path).mode & 0o777).toBe(0o644);

    writeEnvFile(path, new Map([['NODE_ENV', 'production']]), SPECS);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('writeEnvFile / writeEnvContents - atomicity', () => {
  it('leaves no temp file behind after a successful write', () => {
    const root = makeRoot();
    const path = join(root, '.env');

    writeEnvFile(path, new Map([['NODE_ENV', 'production']]), SPECS);

    expect(tmpFilesIn(root)).toEqual([]);
    // And the real file is there under its real name.
    expect(existsSync(path)).toBe(true);
  });

  it('cleans up its temp file when the rename fails', () => {
    // Force renameSync to fail (EISDIR: renaming a file over an existing
    // directory) without touching env-file.ts itself, so the catch/unlink
    // path is exercised honestly rather than mocked.
    const root = makeRoot();
    const path = join(root, '.env');
    mkdirSync(path); // path is now a directory, not a file

    expect(() => writeEnvContents(path, 'NODE_ENV=production\n')).toThrow();

    expect(tmpFilesIn(root)).toEqual([]);
  });

  it('propagates the original error rather than swallowing it', () => {
    const root = makeRoot();
    const path = join(root, '.env');
    mkdirSync(path);

    expect(() => writeEnvContents(path, 'NODE_ENV=production\n')).toThrow(
      /EISDIR|directory/i,
    );
  });
});

describe('writeEnvFile / readEnvFile - round trip', () => {
  it('round-trips the same values written', () => {
    const root = makeRoot();
    const path = join(root, '.env');
    const values = new Map([
      ['NODE_ENV', 'production'],
      ['APP_URL', 'https://app.example.test'],
      ['POSTGRES_HOST', 'db.internal'],
      ['POSTGRES_PASSWORD', 'sup3rs3cret'],
    ]);

    writeEnvFile(path, values, SPECS);

    expect(readEnvFile(path)).toEqual(values);
  });

  it('keeps the template section banners and key order on disk', () => {
    const root = makeRoot();
    const path = join(root, '.env');

    writeEnvFile(
      path,
      new Map([
        ['POSTGRES_HOST', 'db.internal'],
        ['NODE_ENV', 'production'],
      ]),
      SPECS,
    );

    const contents = readFileSync(path, 'utf8');
    expect(contents.indexOf('# Application')).toBeGreaterThanOrEqual(0);
    expect(contents.indexOf('# Application')).toBeLessThan(contents.indexOf('# Database'));
    expect(contents.indexOf('NODE_ENV=')).toBeLessThan(contents.indexOf('POSTGRES_HOST='));
  });
});
