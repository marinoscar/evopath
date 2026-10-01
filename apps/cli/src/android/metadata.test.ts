import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ANDROID_APK_STEM } from '@app/shared';

import type { ExecFn } from './exec.js';
import { apkFileName, buildMetadata, fileSha256, metadataPathFor, readGitSha, readMetadata, writeMetadata } from './metadata.js';

describe('metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apk-meta-'));
  const apk = join(dir, apkFileName('1.2.3'));
  const bytes = Buffer.alloc(300_000, 7);
  writeFileSync(apk, bytes);

  it('names files after the app slug and version', () => {
    expect(apkFileName('1.2.3')).toBe(`${ANDROID_APK_STEM}-1.2.3.apk`);
    expect(metadataPathFor(apk)).toBe(join(dir, `${ANDROID_APK_STEM}-1.2.3.json`));
  });

  it('hashes by streaming', async () => {
    expect(await fileSha256(apk)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('builds, writes and reads back the metadata', async () => {
    const metadata = await buildMetadata({
      apkPath: apk,
      packageName: 'com.example.app',
      versionName: '1.2.3',
      versionCode: 4,
      signingSha256: 'AB:CD',
      gitSha: 'f'.repeat(40),
      now: new Date('2026-10-01T00:00:00Z'),
    });
    expect(metadata).toEqual({
      packageName: 'com.example.app',
      versionName: '1.2.3',
      versionCode: 4,
      signingSha256: 'abcd',
      fileSha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: 300_000,
      builtAt: '2026-10-01T00:00:00.000Z',
      gitSha: 'f'.repeat(40),
    });
    writeMetadata(metadataPathFor(apk), metadata);
    expect(readMetadata(metadataPathFor(apk))).toEqual(metadata);
  });

  it('refuses missing or incomplete metadata', () => {
    expect(() => readMetadata(join(dir, 'none.json'))).toThrow(/android build/);
    const partial = join(dir, 'partial.json');
    writeFileSync(partial, '{"versionName":"1.0.0"}');
    expect(() => readMetadata(partial)).toThrow(/packageName/);
  });

  it('reads the git sha, or null when git is unavailable', async () => {
    const ok: ExecFn = async () => ({ code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' });
    const notRepo: ExecFn = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
    const missing: ExecFn = async () => {
      throw new Error('ENOENT');
    };
    expect(await readGitSha(ok, dir)).toBe('a'.repeat(40));
    expect(await readGitSha(notRepo, dir)).toBeNull();
    expect(await readGitSha(missing, dir)).toBeNull();
  });
});
