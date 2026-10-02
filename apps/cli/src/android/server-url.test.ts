import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { saveCredentials, SERVER_URL_ENV_VAR } from '../config.js';
import { builtForLine, NO_SERVER_URL_WARNING, publishServerWarning, resolveBuildServerUrl } from './server-url.js';

// =============================================================================
// Which server an APK is built for  (issue #318)
// =============================================================================

const home = () => mkdtempSync(join(tmpdir(), 'android-server-url-'));

describe('resolveBuildServerUrl', () => {
  it('prefers an explicit --server-url over the login', () => {
    const dir = home();
    saveCredentials({ serverUrl: 'https://login.example.com', token: 'pat_x' }, { home: dir, env: {} });
    expect(resolveBuildServerUrl('https://flag.example.com', { home: dir, env: {} })).toEqual({
      serverUrl: 'https://flag.example.com',
      source: 'flag',
    });
  });

  it('defaults to the stored login server', () => {
    const dir = home();
    saveCredentials({ serverUrl: 'https://login.example.com', token: 'pat_x' }, { home: dir, env: {} });
    expect(resolveBuildServerUrl(undefined, { home: dir, env: {} })).toEqual({ serverUrl: 'https://login.example.com', source: 'login' });
  });

  it('honours the server URL env override, like publish does', () => {
    expect(resolveBuildServerUrl(undefined, { home: home(), env: { [SERVER_URL_ENV_VAR]: 'https://ci.example.com' } })).toEqual({
      serverUrl: 'https://ci.example.com',
      source: 'login',
    });
  });

  it('is none when not logged in and no flag is given', () => {
    expect(resolveBuildServerUrl(undefined, { home: home(), env: {} })).toEqual({ serverUrl: undefined, source: 'none' });
    expect(resolveBuildServerUrl('  ', { home: home(), env: {} }).source).toBe('none');
  });
});

describe('builtForLine and the warning', () => {
  it('names the server, and says when it came from the login', () => {
    expect(builtForLine({ serverUrl: 'https://a.example.com', source: 'flag' })).toBe('Built for https://a.example.com');
    expect(builtForLine({ serverUrl: 'https://a.example.com', source: 'login' })).toBe(
      'Built for https://a.example.com (the logged-in server)',
    );
    expect(builtForLine({ serverUrl: undefined, source: 'none' })).toMatch(/^Built for no server/);
  });

  it('the no-server warning says what happens and how to fix it', () => {
    expect(NO_SERVER_URL_WARNING).toContain(
      'No server URL: this APK will not receive notifications as the app (Chrome will show them). Pass --server-url https://<server> or log in first',
    );
  });
});

describe('publishServerWarning', () => {
  it('is silent when the APK was built for the server it is published to', () => {
    expect(publishServerWarning({ serverUrl: 'https://a.example.com' }, 'https://a.example.com/')).toBeUndefined();
    expect(publishServerWarning({ serverUrl: 'https://A.example.com/api' }, 'https://a.example.com')).toBeUndefined();
  });

  it('is silent for metadata from builds that predate the field', () => {
    expect(publishServerWarning({}, 'https://a.example.com')).toBeUndefined();
  });

  it('warns on another server, and on an APK built without one', () => {
    expect(publishServerWarning({ serverUrl: 'https://b.example.com' }, 'https://a.example.com')).toMatch(
      /built for https:\/\/b\.example\.com, not https:\/\/a\.example\.com/,
    );
    expect(publishServerWarning({ serverUrl: null }, 'https://a.example.com')).toMatch(/built without a server URL/);
  });
});
