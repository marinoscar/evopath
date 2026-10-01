import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { render } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apkFileName } from '../../android/metadata.js';
import { REPO_ROOT_ENV_VAR } from '../../android/paths.js';
import { saveCredentials, SERVER_URL_ENV_VAR, TOKEN_ENV_VAR } from '../../config.js';
import { AndroidScreen } from './android.js';

// =============================================================================
// The Android screen, rendered  (issue #291)
// =============================================================================
//
// ink-testing-library is not a dependency, so this renders with ink's own
// `render` into a PassThrough "terminal" and drives it with key bytes. The
// logic is covered by android/model.test.ts; these prove the screen wires it:
// the status per login state, the "Log in" route, disabled actions explaining
// themselves, and that nothing is uploaded before the confirmation.
// =============================================================================

const SERVER = 'https://app.example.com';
const DOWN = '\u001B[B';
const ENTER = '\r';

interface Harness {
  frame: () => string;
  press: (...keys: string[]) => Promise<void>;
  unmount: () => void;
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(props: { onDone?: () => void; onLogin?: () => void } = {}): Promise<Harness> {
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 60, isTTY: true });
  let output = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  });
  const app = render(<AndroidScreen onDone={props.onDone ?? (() => {})} onLogin={props.onLogin ?? (() => {})} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await settle(200);
  return {
    // debug mode writes every frame in full; the last one is what is on screen.
    frame: () => {
      const marker = output.lastIndexOf('╭');
      return marker === -1 ? output : output.slice(marker);
    },
    press: async (...keys) => {
      for (const key of keys) {
        stdin.write(key);
        await settle();
      }
    },
    unmount: () => app.unmount(),
  };
}

let env: NodeJS.ProcessEnv;
let home: string;
let repo: string;

beforeEach(() => {
  env = { ...process.env };
  home = mkdtempSync(join(tmpdir(), 'android-screen-home-'));
  repo = mkdtempSync(join(tmpdir(), 'android-screen-repo-'));
  mkdirSync(join(repo, 'apps', 'android'), { recursive: true });
  writeFileSync(join(repo, 'apps', 'android', 'version.properties'), 'versionName=1.0.6\nversionCode=6\n');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env[REPO_ROOT_ENV_VAR] = repo;
  delete process.env[SERVER_URL_ENV_VAR];
  delete process.env[TOKEN_ENV_VAR];
});

afterEach(() => {
  process.env = env;
  vi.unstubAllGlobals();
});

function stubServer(permissions: string[], uploads: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/auth/me')) {
        return json(200, { data: { id: 'u', email: 'admin@example.com', displayName: null, isActive: true, roles: [], permissions } });
      }
      if (url.endsWith('/android-app/releases/latest')) {
        return json(200, {
          data: { id: 'r5', packageName: 'p', versionName: '1.0.5', versionCode: 5, fileSha256: 'x', sizeBytes: 1, createdAt: '2026-10-01T00:00:00Z' },
        });
      }
      if (url.endsWith('/admin/android-app/releases') && init?.method === 'POST') {
        uploads.push(url);
        return json(201, { data: { id: 'r6', versionName: '1.0.6', versionCode: 6, isCurrent: true } });
      }
      return json(404, { statusCode: 404, message: 'unexpected' });
    }),
  );
}

describe('AndroidScreen', () => {
  it('logged out: shows the state, disables remote actions with a reason, and routes "Log in"', async () => {
    const onLogin = vi.fn();
    const screen = await mount({ onLogin });
    try {
      expect(screen.frame()).toContain('Local     1.0.6 (code 6)');
      expect(screen.frame()).toContain('Not logged in');
      expect(screen.frame()).toContain('Publish  (upload the built APK)  — unavailable');

      await screen.press(DOWN, DOWN, DOWN, ENTER); // Publish
      expect(screen.frame()).toContain('Not logged in. Choose "Log in".');

      await screen.press(DOWN, DOWN, DOWN, ENTER); // Log in (last row)
      expect(onLogin).toHaveBeenCalledTimes(1);
    } finally {
      screen.unmount();
    }
  });

  it('logged in without system_settings:write: says so and keeps publish disabled', async () => {
    saveCredentials({ serverUrl: SERVER, token: 'pat_screen-test-token-xxxxxxxx' });
    stubServer(['system_settings:read'], []);
    const screen = await mount();
    try {
      expect(screen.frame()).toContain('lacks system_settings:write');
      expect(screen.frame()).toContain('Publish  (upload the built APK)  — unavailable');
      expect(screen.frame()).toContain('Log in');
    } finally {
      screen.unmount();
    }
  });

  it('publish asks for confirmation naming version, code and server, and "No" uploads nothing', async () => {
    saveCredentials({ serverUrl: SERVER, token: 'pat_screen-test-token-xxxxxxxx' });
    const uploads: unknown[] = [];
    stubServer(['system_settings:write'], uploads);
    const dist = join(repo, 'dist', 'android');
    mkdirSync(dist, { recursive: true });
    const apk = join(dist, apkFileName('1.0.6'));
    writeFileSync(apk, 'PK\u0003\u0004');
    writeFileSync(
      apk.replace(/\.apk$/, '.json'),
      JSON.stringify({
        packageName: 'p',
        versionName: '1.0.6',
        versionCode: 6,
        signingSha256: 'ab'.repeat(32),
        fileSha256: 'cd'.repeat(32),
        sizeBytes: 4,
        builtAt: '2026-10-01T00:00:00Z',
        gitSha: null,
      }),
    );

    const screen = await mount();
    try {
      expect(screen.frame()).toContain('admin@example.com on https://app.example.com — can publish');
      expect(screen.frame()).toContain('Current 1.0.5 (code 5)');

      await screen.press(DOWN, DOWN, DOWN, ENTER); // Publish → notes
      expect(screen.frame()).toContain('Release notes');
      await screen.press(ENTER); // no notes → confirm
      expect(screen.frame()).toContain(`Publish v1.0.6 (code 6) to ${SERVER}?`);
      // ink-select-input draws figures.pointer: '>' on a Linux console (TERM=linux), '❯' elsewhere.
      expect(screen.frame()).toMatch(/[>❯] No, go back/);
      expect(uploads).toEqual([]);

      await screen.press(ENTER); // "No" is selected by default
      expect(uploads).toEqual([]);
      expect(screen.frame()).toContain('Android app');

      await screen.press(DOWN, DOWN, DOWN, ENTER, ENTER, DOWN, ENTER); // confirm "Yes"
      await settle(200);
      expect(uploads).toHaveLength(1);
      expect(screen.frame()).toContain('Published 1.0.6 (code 6) — now the current release.');
    } finally {
      screen.unmount();
    }
  });
});
