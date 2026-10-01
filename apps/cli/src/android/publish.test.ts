import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ApiClient } from '../api-client.js';
import { ApiError } from '../errors.js';
import type { ApkMetadata } from './metadata.js';
import {
  buildPublishForm,
  downloadPageUrl,
  formatReleasesTable,
  listReleases,
  makeCurrent,
  publishRelease,
  type AndroidRelease,
} from './publish.js';

const META: ApkMetadata = {
  packageName: 'com.example.app',
  versionName: '1.0.1',
  versionCode: 2,
  signingSha256: 'ab'.repeat(32),
  fileSha256: 'cd'.repeat(32),
  sizeBytes: 4,
  builtAt: '2026-10-01T00:00:00.000Z',
  gitSha: null,
};

const RELEASE: AndroidRelease = {
  id: 'r1',
  packageName: 'com.example.app',
  versionName: '1.0.1',
  versionCode: 2,
  fileSha256: 'cd'.repeat(32),
  sizeBytes: 4,
  isCurrent: true,
  createdAt: '2026-10-01T10:00:00.000Z',
};

function apk(): string {
  const dir = mkdtempSync(join(tmpdir(), 'publish-'));
  const path = join(dir, 'app.apk');
  writeFileSync(path, 'PK\u0003\u0004');
  return path;
}

function client(fetch: typeof globalThis.fetch): ApiClient {
  return new ApiClient({ baseUrl: 'https://app.example.com/api', token: 'pat_x', fetch });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('buildPublishForm', () => {
  it('carries every field plus the apk file', async () => {
    const form = await buildPublishForm(apk(), META, { notes: 'Fixes', makeCurrent: true, force: false });
    expect(form.get('versionName')).toBe('1.0.1');
    expect(form.get('versionCode')).toBe('2');
    expect(form.get('packageName')).toBe('com.example.app');
    expect(form.get('signingSha256')).toBe(META.signingSha256);
    expect(form.get('notes')).toBe('Fixes');
    expect(form.get('makeCurrent')).toBe('true');
    expect(form.has('force')).toBe(false);
    const file = form.get('apk') as File;
    expect(file.name).toBe('app.apk');
    expect(file.size).toBe(4);
  });

  it('sends makeCurrent=false and force=true when asked, and omits empty notes', async () => {
    const form = await buildPublishForm(apk(), META, { notes: '', makeCurrent: false, force: true });
    expect(form.get('makeCurrent')).toBe('false');
    expect(form.get('force')).toBe('true');
    expect(form.has('notes')).toBe(false);
  });
});

describe('publishRelease', () => {
  it('POSTs multipart to the admin releases endpoint with the bearer token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(201, { data: RELEASE }));
    const release = await publishRelease(client(fetch), apk(), META, { makeCurrent: true, force: false });
    expect(release).toEqual(RELEASE);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://app.example.com/api/admin/android-app/releases');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer pat_x');
    // fetch sets the multipart boundary itself.
    expect(headers['Content-Type']).toBeUndefined();
  });

  it.each(['RELEASE_VERSION_EXISTS', 'RELEASE_VERSION_NOT_NEWER'])('maps %s to a bump suggestion', async (code) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json(409, { statusCode: 409, code, message: 'Conflict' }),
    );
    const error = await publishRelease(client(fetch), apk(), META, { makeCurrent: true, force: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    expect((error as ApiError).message).toMatch(/android version --bump patch/);
  });

  it('passes other errors through unchanged', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(403, { statusCode: 403, message: 'Missing permission' }));
    await expect(publishRelease(client(fetch), apk(), META, { makeCurrent: true, force: false })).rejects.toThrow(
      /403: Missing permission$/,
    );
  });
});

describe('releases', () => {
  it('lists `{ data: [] }` and rolls back via make-current', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith('/make-current') ? json(200, { data: RELEASE }) : json(200, { data: [RELEASE] }),
    );
    expect(await listReleases(client(fetch))).toEqual([RELEASE]);
    expect(await makeCurrent(client(fetch), 'r 1')).toEqual(RELEASE);
    expect(String(fetch.mock.calls[1]?.[0])).toBe('https://app.example.com/api/admin/android-app/releases/r%201/make-current');
  });

  it('renders a table marking the current release', () => {
    const table = formatReleasesTable([RELEASE, { ...RELEASE, id: 'r0', versionName: '1.0.0', versionCode: 1, isCurrent: false }]);
    expect(table).toMatch(/^\s+VERSION/);
    expect(table).toMatch(/\* {2}1\.0\.1 +2 /);
    expect(table).toContain('* = current release');
    expect(formatReleasesTable([])).toMatch(/No releases/);
  });

  it('builds the download page URL from a server or API URL', () => {
    expect(downloadPageUrl('https://app.example.com/')).toBe('https://app.example.com/settings/android-app');
    expect(downloadPageUrl('https://app.example.com/api')).toBe('https://app.example.com/settings/android-app');
  });
});
