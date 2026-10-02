import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { render } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AndroidDoctorReport } from '../../../android/doctor.js';
import type { ReleaseStatus } from '../../../android/release-status.js';
import { readAndroidPreference, writeAndroidPreference } from '../../../deploy/preferences.js';
import { AndroidAppStep, type AndroidStepDeps } from './android-step.js';
import { UpdateScreen } from './update.js';

// =============================================================================
// The "Android app" step, rendered  (issue #315)
// =============================================================================
//
// ink-testing-library is not a dependency, so this renders with ink's own
// `render` into a PassThrough "terminal" (the android.test.tsx harness) and
// drives it with key bytes. The decisions are android-step-model.test.ts's;
// these prove the step and the Update screen wire them.
//
// ⚠ The select pointer glyph depends on TERM (figures falls back to `>`), so
// pointer assertions match /[>❯] /.
// =============================================================================

const DOWN = '\u001B[B';
const ENTER = '\r';
const ESC = '\u001B';
const URL = 'https://app.example.test';

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  frame: () => string;
  press: (...keys: string[]) => Promise<void>;
  type: (text: string) => Promise<void>;
  unmount: () => void;
}

async function mount(element: ReactElement): Promise<Harness> {
  const stdout = Object.assign(new PassThrough(), { columns: 140, rows: 80, isTTY: true });
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
  const app = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await settle(120);
  return {
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
    type: async (text) => {
      stdin.write(text);
      await settle();
    },
    unmount: () => app.unmount(),
  };
}

function releaseStatus(): ReleaseStatus {
  return {
    repoRoot: '/r',
    targetServerUrl: URL,
    local: null,
    keystore: { configured: true },
    login: { state: 'logged_in', serverUrl: URL, canPublish: true },
    server: {
      current: { id: 'r5', packageName: 'p', versionName: '1.0.5', versionCode: 5, fileSha256: 'x', sizeBytes: 1, createdAt: '' },
      reachable: true,
    },
    newerLocally: true,
  };
}

const failingDoctor: AndroidDoctorReport = {
  ok: false,
  repoRoot: '/r',
  sdk: {} as never,
  checks: [
    { id: 'repo', label: 'Repository', status: 'pass', detail: '/r' },
    { id: 'jdk', label: 'JDK 17+', status: 'fail', detail: 'not found', fix: 'Install a JDK 17.' },
  ],
};

function stepDeps(overrides: Partial<AndroidStepDeps> = {}): AndroidStepDeps {
  return {
    findOwnCheckout: () => undefined,
    doctor: async () => failingDoctor,
    getReleaseStatus: async () => releaseStatus(),
    ...overrides,
  };
}

/** A deploy root whose checkout carries apps/android at 1.0.6. */
function deployRootWithAndroid(): string {
  const root = mkdtempSync(join(tmpdir(), 'android-step-screen-'));
  mkdirSync(join(root, 'repo', 'apps', 'android'), { recursive: true });
  writeFileSync(join(root, 'repo', 'apps', 'android', 'version.properties'), 'versionName=1.0.6\nversionCode=6\n');
  return root;
}

let env: NodeJS.ProcessEnv;

beforeEach(() => {
  env = { ...process.env };
  const home = mkdtempSync(join(tmpdir(), 'android-step-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env = env;
});

describe('AndroidAppStep', () => {
  it('renders both choices with the context lines, No selected by default', async () => {
    const root = deployRootWithAndroid();
    const screen = await mount(
      <AndroidAppStep
        title="Update — shop · Android app"
        deployRoot={root}
        domain="app.example.test"
        initialYes={false}
        versionNote="as checked out now; the update may bring a newer one"
        onChoose={() => {}}
        onBack={() => {}}
        deps={stepDeps()}
      />,
    );
    try {
      const frame = screen.frame();
      expect(frame).toContain('Update — shop · Android app');
      expect(frame).toContain('Include the Android app in this deploy?');
      expect(frame).toMatch(/[>❯] No — web app only/);
      expect(frame).toContain('Yes — also build and publish the Android APK (if its version is newer than the published one)');
      expect(frame).toContain('checkout  1.0.6 (code 6)');
      expect(frame).toContain('the update may bring a newer one');
      expect(frame).toContain(`published 1.0.5 (code 5) on ${URL}`);
      expect(frame).toContain("✖ 1 of 2 checks failed for the deployment's checkout");
      expect(frame).toContain('JDK 17+: not found');
      expect(frame).toContain('→ Install a JDK 17.');
    } finally {
      screen.unmount();
    }
  });

  it('opens on Yes when told to, and selecting it chooses yes', async () => {
    const onChoose = vi.fn();
    const screen = await mount(
      <AndroidAppStep
        title="t"
        deployRoot={deployRootWithAndroid()}
        domain={undefined}
        initialYes
        versionNote="n"
        onChoose={onChoose}
        onBack={() => {}}
        deps={stepDeps()}
      />,
    );
    try {
      expect(screen.frame()).toMatch(/[>❯] Yes — also build/);
      expect(screen.frame()).toContain('no domain recorded');
      await screen.press(ENTER);
      expect(onChoose).toHaveBeenCalledWith(true);
    } finally {
      screen.unmount();
    }
  });

  it('can be answered while the pre-flight is still checking; Esc goes back', async () => {
    const onChoose = vi.fn();
    const onBack = vi.fn();
    const screen = await mount(
      <AndroidAppStep
        title="t"
        deployRoot={deployRootWithAndroid()}
        domain="app.example.test"
        initialYes={false}
        versionNote="n"
        onChoose={onChoose}
        onBack={onBack}
        deps={stepDeps({ doctor: () => new Promise(() => {}), getReleaseStatus: () => new Promise(() => {}) })}
      />,
    );
    try {
      expect(screen.frame()).toContain('checking the Android toolchain…');
      expect(screen.frame()).toContain('published checking…');
      await screen.press(ESC);
      expect(onBack).toHaveBeenCalledTimes(1);
      await screen.press(ENTER);
      expect(onChoose).toHaveBeenCalledWith(false);
    } finally {
      screen.unmount();
    }
  });

  it('a pre-flight that throws is a line, not a crash', async () => {
    const screen = await mount(
      <AndroidAppStep
        title="t"
        deployRoot={deployRootWithAndroid()}
        domain={undefined}
        initialYes={false}
        versionNote="n"
        onChoose={() => {}}
        onBack={() => {}}
        deps={stepDeps({
          doctor: async () => {
            throw new Error('spawn java ENOENT');
          },
        })}
      />,
    );
    try {
      expect(screen.frame()).toContain('could not run the Android doctor: spawn java ENOENT');
    } finally {
      screen.unmount();
    }
  });
});

// =============================================================================
// The step inside Deploy → Update: after the options, before Confirm.
// =============================================================================

/** Walk the Update screen to its options step, with the deploy root moved to `root`. */
async function updateToOptions(root: string): Promise<Harness> {
  const screen = await mount(<UpdateScreen onDone={() => {}} located="shop" androidStepDeps={stepDeps()} />);
  await screen.press(ENTER); // name: shop
  await screen.press(DOWN, ENTER); // advanced: "Change them…"
  await screen.type(root);
  await screen.press(ENTER, ENTER, ENTER); // root, proxy container, proxy mode
  await screen.press(ENTER, ENTER); // ref, version: keep
  expect(screen.frame()).toContain('Options. Nothing here is required');
  return screen;
}

/** From the options step, to the Android step (Continue is the last row). */
async function optionsToAndroid(screen: Harness): Promise<void> {
  const rows = (screen.frame().match(/\[[ x]\]/g) ?? []).length;
  for (let i = 0; i < rows; i += 1) await screen.press(DOWN);
  await screen.press(ENTER);
  expect(screen.frame()).toContain('Update — shop · Android app');
}

describe('Deploy → Update: the Android app step', () => {
  it('sits between the options and Confirm; the options no longer list --with-android', async () => {
    const root = deployRootWithAndroid();
    const screen = await updateToOptions(root);
    try {
      expect(screen.frame()).not.toContain('--with-android');
      await optionsToAndroid(screen);

      // Esc goes back to the options.
      await screen.press(ESC);
      expect(screen.frame()).toContain('Options. Nothing here is required');

      await optionsToAndroid(screen);
      await screen.press(DOWN, ENTER); // Yes
      const confirm = screen.frame();
      expect(confirm).toContain('About to update on this server:');
      expect(confirm).toMatch(/Android app\s+build and publish if newer/);
      expect(confirm).toMatch(/flags\s+none/);
      expect(readAndroidPreference(root)).toBe(true);

      // "No, go back" returns to the Android step, which reopens on Yes.
      await screen.press(ENTER);
      expect(screen.frame()).toMatch(/[>❯] Yes — also build/);
      await screen.press(DOWN, ENTER); // wraps to No
      expect(screen.frame()).toMatch(/Android app\s+not included/);
      expect(readAndroidPreference(root)).toBe(false);
    } finally {
      screen.unmount();
    }
  });

  it('opens on the remembered answer for this deployment', async () => {
    const root = deployRootWithAndroid();
    writeAndroidPreference(root, true);
    const screen = await updateToOptions(root);
    try {
      await optionsToAndroid(screen);
      expect(screen.frame()).toMatch(/[>❯] Yes — also build/);
    } finally {
      screen.unmount();
    }
  });

  it('defaults to No when the deployment checkout has no apps/android, whatever is remembered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'android-step-screen-bare-'));
    writeAndroidPreference(root, true);
    const screen = await updateToOptions(root);
    try {
      await optionsToAndroid(screen);
      expect(screen.frame()).toMatch(/[>❯] No — web app only/);
    } finally {
      screen.unmount();
    }
  });
});
