import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PreconditionError } from '../errors.js';
import { bumpVersionFile, previewBump, publishBuiltApk } from './operations.js';

function repo(properties?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'android-ops-'));
  mkdirSync(join(root, 'apps', 'android'), { recursive: true });
  if (properties !== undefined) writeFileSync(join(root, 'apps', 'android', 'version.properties'), properties);
  return root;
}

describe('previewBump / bumpVersionFile', () => {
  it('previews without writing, then writes the same change', () => {
    const root = repo('versionName=1.2.3\nversionCode=7\n');
    const file = join(root, 'apps', 'android', 'version.properties');

    const preview = previewBump(root, 'minor');
    expect(preview).toEqual({
      before: { versionName: '1.2.3', versionCode: 7 },
      after: { versionName: '1.3.0', versionCode: 8 },
      created: false,
    });
    expect(readFileSync(file, 'utf8')).toContain('versionCode=7');

    expect(bumpVersionFile(root, 'minor')).toEqual(preview);
    expect(readFileSync(file, 'utf8')).toContain('versionName=1.3.0');
    expect(readFileSync(file, 'utf8')).toContain('versionCode=8');
  });

  it('creates the file at the defaults when it is missing', () => {
    const bump = bumpVersionFile(repo(), 'patch');
    expect(bump.created).toBe(true);
    expect(bump.after).toEqual({ versionName: '0.1.0', versionCode: 1 });
  });
});

describe('publishBuiltApk', () => {
  it('refuses a missing APK with the build command', async () => {
    await expect(
      publishBuiltApk({ apkPath: '/nope/app.apk', credentials: { serverUrl: 'https://a.example.com', token: 't' }, makeCurrent: true }),
    ).rejects.toBeInstanceOf(PreconditionError);
  });

  it('uploads the APK with its metadata and reports progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'android-ops-apk-'));
    const apkPath = join(dir, 'app.apk');
    writeFileSync(apkPath, 'PK\u0003\u0004apk-bytes');
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        packageName: 'com.example.app',
        versionName: '1.0.1',
        versionCode: 2,
        signingSha256: 'ab'.repeat(32),
        fileSha256: 'cd'.repeat(32),
        sizeBytes: 13,
        builtAt: '2026-10-01T00:00:00.000Z',
        gitSha: null,
      }),
    );
    let sentBody = '';
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      sentBody = await new Response(init?.body as BodyInit).text();
      return new Response(JSON.stringify({ data: { id: 'r9', versionName: '1.0.1', versionCode: 2, isCurrent: true } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const progress: number[] = [];
    const result = await publishBuiltApk({
      apkPath,
      credentials: { serverUrl: 'https://a.example.com', token: 't' },
      notes: 'Fixes',
      makeCurrent: true,
      fetch,
      onUploadProgress: (sent) => progress.push(sent),
    });
    expect(result.release.id).toBe('r9');
    expect(result.metadata.versionCode).toBe(2);
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://a.example.com/api/admin/android-app/releases');
    expect(sentBody).toContain('apk-bytes');
    expect(sentBody).toContain('Fixes');
    expect(progress.at(-1)).toBe(Buffer.byteLength(sentBody));
  });
});
