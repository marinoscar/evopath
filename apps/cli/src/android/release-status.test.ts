import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { saveCredentials, SERVER_URL_ENV_VAR, TOKEN_ENV_VAR } from '../config.js';
import { writeSigningConfig } from './keystore.js';
import {
  credentialsForServer,
  getReleaseStatus,
  isNewerLocally,
  PUBLISH_PERMISSION,
  sameServer,
} from './release-status.js';

const SECRET = 'pat_release-status-secret-token-value';

function home(): string {
  return mkdtempSync(join(tmpdir(), 'release-status-home-'));
}

function repo(version?: { name: string; code: number }): string {
  const root = mkdtempSync(join(tmpdir(), 'release-status-repo-'));
  mkdirSync(join(root, 'apps', 'android'), { recursive: true });
  if (version !== undefined) {
    writeFileSync(join(root, 'apps', 'android', 'version.properties'), `versionName=${version.name}\nversionCode=${version.code}\n`);
  }
  return root;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function me(permissions: string[]) {
  return { id: 'u1', email: 'admin@example.com', displayName: null, isActive: true, roles: [], permissions };
}

const RELEASE = {
  id: 'r1',
  packageName: 'com.example.app',
  versionName: '1.0.0',
  versionCode: 5,
  fileSha256: 'cd'.repeat(32),
  sizeBytes: 10,
  createdAt: '2026-10-01T10:00:00.000Z',
};

/** A fetch that answers /auth/me and /android-app/releases/latest. */
function server(options: { permissions?: string[]; latest?: Response | 'no-release'; meStatus?: number } = {}) {
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/auth/me')) {
      if (options.meStatus !== undefined) return json(options.meStatus, { statusCode: options.meStatus, message: 'no' });
      return json(200, { data: me(options.permissions ?? [PUBLISH_PERMISSION]) });
    }
    if (url.endsWith('/android-app/releases/latest')) {
      if (options.latest === 'no-release') {
        return json(404, { statusCode: 404, code: 'NOT_FOUND', message: 'none', details: { reason: 'NO_RELEASE' } });
      }
      return options.latest ?? json(200, { data: RELEASE });
    }
    return json(404, { statusCode: 404, message: 'unexpected' });
  });
}

describe('sameServer', () => {
  it('treats the typed forms of one server as equal', () => {
    expect(sameServer('app.example.com', 'https://app.example.com/api/')).toBe(true);
    expect(sameServer('https://App.Example.com', 'https://app.example.com')).toBe(true);
  });

  it('distinguishes different hosts and schemes', () => {
    expect(sameServer('https://a.example.com', 'https://b.example.com')).toBe(false);
    expect(sameServer('http://app.example.com', 'https://app.example.com')).toBe(false);
  });
});

describe('isNewerLocally', () => {
  const local = { versionName: '1.0.1', versionCode: 6 };
  it('is true above the current code, or with nothing published', () => {
    expect(isNewerLocally(local, { current: { ...RELEASE }, reachable: true })).toBe(true);
    expect(isNewerLocally(local, { current: null, reachable: true })).toBe(true);
  });
  it('is false at or below the current code', () => {
    expect(isNewerLocally({ versionName: '1.0.0', versionCode: 5 }, { current: { ...RELEASE }, reachable: true })).toBe(false);
  });
  it('is false when the server could not be read, or nothing is local', () => {
    expect(isNewerLocally(local, { current: null, reachable: false })).toBe(false);
    expect(isNewerLocally(null, { current: null, reachable: true })).toBe(false);
  });
});

describe('getReleaseStatus', () => {
  it('reports logged_out with no stored login and makes no request', async () => {
    const fetch = server();
    const status = await getReleaseStatus({ repoRoot: repo({ name: '1.0.1', code: 6 }) }, { home: home(), env: {}, fetch });
    expect(status.login).toMatchObject({ state: 'logged_out', canPublish: false });
    expect(status.server.reachable).toBe(false);
    expect(status.newerLocally).toBe(false);
    expect(status.local).toEqual({ versionName: '1.0.1', versionCode: 6 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports logged_in with canPublish, the current release and newerLocally', async () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SECRET }, { home: h });
    const status = await getReleaseStatus({ repoRoot: repo({ name: '1.0.1', code: 6 }) }, { home: h, env: {}, fetch: server() });
    expect(status.login).toMatchObject({ state: 'logged_in', canPublish: true, email: 'admin@example.com', source: 'file' });
    expect(status.server).toMatchObject({ reachable: true, current: { versionCode: 5 } });
    expect(status.newerLocally).toBe(true);
    expect(status.targetServerUrl).toBe('https://app.example.com');
  });

  it('canPublish is false without system_settings:write', async () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SECRET }, { home: h });
    const status = await getReleaseStatus(
      { repoRoot: repo({ name: '1.0.1', code: 6 }) },
      { home: h, env: {}, fetch: server({ permissions: ['system_settings:read'] }) },
    );
    expect(status.login).toMatchObject({ state: 'logged_in', canPublish: false });
  });

  it('treats 404 NO_RELEASE as reachable with nothing published', async () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SECRET }, { home: h });
    const status = await getReleaseStatus(
      { repoRoot: repo({ name: '0.1.0', code: 1 }) },
      { home: h, env: {}, fetch: server({ latest: 'no-release' }) },
    );
    expect(status.server).toEqual({ current: null, reachable: true });
    expect(status.newerLocally).toBe(true);
  });

  it('is not newer when the server already has the same code', async () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SECRET }, { home: h });
    const status = await getReleaseStatus({ repoRoot: repo({ name: '1.0.0', code: 5 }) }, { home: h, env: {}, fetch: server() });
    expect(status.newerLocally).toBe(false);
  });

  it('reports other_server when the login is for a different server, without sending the token', async () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://other.example.com', token: SECRET }, { home: h });
    const fetch = server();
    const status = await getReleaseStatus(
      { repoRoot: repo({ name: '1.0.1', code: 6 }), serverUrl: 'https://app.example.com' },
      { home: h, env: {}, fetch },
    );
    expect(status.login).toMatchObject({ state: 'other_server', serverUrl: 'https://other.example.com', canPublish: false });
    expect(status.targetServerUrl).toBe('https://app.example.com');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports expired from the stored expiry without a request', async () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SECRET, expiresAt: '2020-01-01T00:00:00Z' }, { home: h });
    const fetch = server();
    const status = await getReleaseStatus({ repoRoot: undefined }, { home: h, env: {}, fetch });
    expect(status.login.state).toBe('expired');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports expired when the server rejects the token', async () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SECRET }, { home: h });
    const status = await getReleaseStatus({ repoRoot: undefined }, { home: h, env: {}, fetch: server({ meStatus: 401 }) });
    expect(status.login.state).toBe('expired');
    expect(status.server.reachable).toBe(false);
  });

  it('keeps logged_in but marks the server unreachable on a network error', async () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SECRET }, { home: h });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const status = await getReleaseStatus({ repoRoot: undefined }, { home: h, env: {}, fetch });
    expect(status.login).toMatchObject({ state: 'logged_in', canPublish: false });
    expect(status.login.error).toBeDefined();
    expect(status.server.reachable).toBe(false);
  });

  it('prefers the environment override over the stored login', async () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://file.example.com', token: 'pat_file-token-value-xxxx' }, { home: h });
    const fetch = server();
    const status = await getReleaseStatus(
      { repoRoot: undefined, serverUrl: 'https://ci.example.com' },
      { home: h, env: { [SERVER_URL_ENV_VAR]: 'https://ci.example.com', [TOKEN_ENV_VAR]: SECRET }, fetch },
    );
    expect(status.login).toMatchObject({ state: 'logged_in', source: 'env', serverUrl: 'https://ci.example.com' });
    const auth = new Headers((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).get('authorization');
    expect(auth).toBe(`Bearer ${SECRET}`);
  });

  it('reports the keystore fingerprint and never carries the token', async () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SECRET }, { home: h });
    writeSigningConfig(
      { keystorePath: '/k.jks', keyAlias: 'a', storePassword: 'storepass', keyPassword: 'storepass', certSha256: 'AA:BB' },
      { home: h },
    );
    const status = await getReleaseStatus({ repoRoot: repo() }, { home: h, env: {}, fetch: server() });
    expect(status.keystore).toEqual({ configured: true, sha256: 'AA:BB' });
    // No version.properties: the defaults, like `android build`.
    expect(status.local).toEqual({ versionName: '0.1.0', versionCode: 1 });
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(JSON.stringify(status)).not.toContain('storepass');
  });

  it('has no local version without a checkout', async () => {
    const status = await getReleaseStatus({ repoRoot: undefined }, { home: home(), env: {} });
    expect(status.local).toBeNull();
    expect(status.keystore.configured).toBe(false);
  });
});

describe('credentialsForServer', () => {
  it('returns the stored credentials only for their own server', () => {
    const h = home();
    saveCredentials({ serverUrl: 'https://app.example.com', token: SECRET }, { home: h });
    expect(credentialsForServer('app.example.com', { home: h, env: {} })).toEqual({
      serverUrl: 'https://app.example.com',
      token: SECRET,
    });
    expect(credentialsForServer('https://other.example.com', { home: h, env: {} })).toBeUndefined();
    expect(credentialsForServer(undefined, { home: h, env: {} })?.token).toBe(SECRET);
    expect(credentialsForServer(undefined, { home: home(), env: {} })).toBeUndefined();
  });
});
