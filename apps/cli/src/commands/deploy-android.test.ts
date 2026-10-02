import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AndroidStepDeps } from '../deploy/android-step.js';
import * as installModule from '../deploy/install.js';
import { DEPLOY_STATE_VERSION, deployStatePath, type DeployState } from '../deploy/state.js';
import * as updateModule from '../deploy/update.js';
import { UsageError } from '../errors.js';
import { registerDeployCommand } from './deploy.js';

// =============================================================================
// `deploy install|update --with-android`  (issue #292)
// =============================================================================
//
// The pipelines are mocked: these assert what the COMMAND does around them —
// the flags are validated before anything runs, the Android step runs after
// a successful deploy with the deployment's URL, its outcome lands in the
// summary (and the JSON), and nothing it does can fail the command.
// The step's own decisions are covered by deploy/android-step.test.ts.
// =============================================================================

vi.mock('../deploy/install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deploy/install.js')>();
  return { ...actual, runInstall: vi.fn() };
});
vi.mock('../deploy/update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deploy/update.js')>();
  return { ...actual, runUpdate: vi.fn() };
});

const URL = 'https://app.example.test';

/** Step deps whose status says "logged in, newer locally" and whose actions are recorded. */
function stepDeps(publish: AndroidStepDeps['publish'] = async () => ({ release: { id: 'r-new' } as never, metadata: {} as never })) {
  const getReleaseStatus = vi.fn<AndroidStepDeps['getReleaseStatus']>(async (input) => ({
    repoRoot: input.repoRoot,
    targetServerUrl: input.serverUrl,
    local: { versionName: '1.0.6', versionCode: 6 },
    keystore: { configured: true },
    login: { state: 'logged_in', serverUrl: input.serverUrl, canPublish: true, email: 'a@example.test' },
    server: { current: null, reachable: true },
    newerLocally: true,
  }));
  const deps: AndroidStepDeps = {
    findRepoRoot: () => '/home/me/checkout',
    getReleaseStatus,
    previewBump: () => ({ before: { versionName: '1.0.6', versionCode: 6 }, after: { versionName: '1.0.7', versionCode: 7 }, created: false }),
    bumpVersionFile: () => ({ before: { versionName: '1.0.6', versionCode: 6 }, after: { versionName: '1.0.7', versionCode: 7 }, created: false }),
    doctor: async () => ({ checks: [], ok: true, sdk: {} as never, repoRoot: '/home/me/checkout' }),
    build: async () => ({
      apkPath: '/out/a.apk',
      metadataPath: '/out/a.json',
      verified: true,
      server: { serverUrl: 'https://app.example.com', source: 'flag' as const },
      metadata: { packageName: 'p', versionName: '1.0.6', versionCode: 6, signingSha256: '', fileSha256: '', sizeBytes: 1, builtAt: '', gitSha: null },
    }),
    publish,
    commit: async () => 'committed',
    credentials: () => ({ serverUrl: URL, token: 'pat_x' }),
  };
  return { deps, getReleaseStatus };
}

async function run(argv: readonly string[], deps?: AndroidStepDeps) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program, {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    isTty: false,
    ...(deps === undefined ? {} : { androidStepDeps: deps }),
  });
  let error: unknown;
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (caught) {
    error = caught;
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), error };
}

function recordedRoot(domain: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'deploy-android-'));
  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    bindPort: 3535,
    deployRoot: root,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
    ...(domain === undefined ? {} : { domain }),
  };
  writeFileSync(deployStatePath(root), JSON.stringify(state));
  return root;
}

beforeEach(() => {
  vi.mocked(installModule.runInstall).mockReset();
  vi.mocked(installModule.runInstall).mockResolvedValue({
    deployRoot: '/tmp/x',
    commitSha: 'b'.repeat(40),
    journalPath: '/tmp/x/logs/1.log',
    domain: 'app.example.test',
    nextStep: 'Log in.',
  });
  vi.mocked(updateModule.runUpdate).mockReset();
  vi.mocked(updateModule.runUpdate).mockResolvedValue({
    changed: true,
    previousSha: 'c'.repeat(40),
    commitSha: 'b'.repeat(40),
    journalPath: '/tmp/x/logs/1.log',
    durationMs: 1000,
  });
});

describe('deploy install --with-android', () => {
  it('publishes to https://<domain> after the install and reports it in the summary', async () => {
    const { deps, getReleaseStatus } = stepDeps();
    const result = await run(['deploy', 'install', '--root', '/tmp/x', '--domain', 'app.example.test', '--with-android'], deps);
    expect(result.error).toBeUndefined();
    expect(getReleaseStatus).toHaveBeenCalledWith({ repoRoot: '/home/me/checkout', serverUrl: URL });
    expect(result.stderr).toContain('Installed.');
    expect(result.stderr).toContain(`Android APK  published 1.0.6 (code 6) to ${URL} as the current release`);
  });

  it('a failed upload is a warning: the command still succeeds', async () => {
    const { deps } = stepDeps(async () => {
      throw new Error('503 Service Unavailable');
    });
    const result = await run(['deploy', 'install', '--root', '/tmp/x', '--domain', 'app.example.test', '--with-android'], deps);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('Android APK  failed: upload failed: 503 Service Unavailable');
    expect(result.stderr).toContain('the deploy itself succeeded');
  });

  it('carries the outcome in --json', async () => {
    const { deps } = stepDeps();
    const result = await run(['deploy', 'install', '--root', '/tmp/x', '--domain', 'app.example.test', '--with-android', '--json'], deps);
    const parsed = JSON.parse(result.stdout) as { android?: { status: string } };
    expect(parsed.android?.status).toBe('published');
  });

  it('does nothing Android-related without the flag', async () => {
    const { deps, getReleaseStatus } = stepDeps();
    const result = await run(['deploy', 'install', '--root', '/tmp/x', '--domain', 'app.example.test'], deps);
    expect(getReleaseStatus).not.toHaveBeenCalled();
    expect(result.stderr).not.toContain('Android APK');
  });

  it('refuses a bad --android-bump BEFORE the install runs', async () => {
    const { deps } = stepDeps();
    const result = await run(['deploy', 'install', '--root', '/tmp/x', '--with-android', '--android-bump', 'huge'], deps);
    expect(result.error).toBeInstanceOf(UsageError);
    expect(installModule.runInstall).not.toHaveBeenCalled();
  });

  it('refuses --android-notes without --with-android', async () => {
    const result = await run(['deploy', 'install', '--root', '/tmp/x', '--android-notes', 'x']);
    expect(result.error).toBeInstanceOf(UsageError);
    expect(installModule.runInstall).not.toHaveBeenCalled();
  });

  it('a failed deploy never reaches the Android step', async () => {
    vi.mocked(installModule.runInstall).mockRejectedValue(new Error('build failed'));
    const { deps, getReleaseStatus } = stepDeps();
    const result = await run(['deploy', 'install', '--root', '/tmp/x', '--with-android'], deps);
    expect(result.error).toBeInstanceOf(Error);
    expect(getReleaseStatus).not.toHaveBeenCalled();
  });
});

describe('deploy update --with-android', () => {
  it('uses the recorded domain and passes --android-bump/--android-notes through', async () => {
    const root = recordedRoot('app.example.test');
    const publish = vi.fn<AndroidStepDeps['publish']>(async () => ({ release: { id: 'r' } as never, metadata: {} as never }));
    const { deps, getReleaseStatus } = stepDeps(publish);
    const result = await run(
      ['deploy', 'update', '--root', root, '--with-android', '--android-bump', 'patch', '--android-notes', 'Faster sync'],
      deps,
    );
    expect(result.error).toBeUndefined();
    expect(getReleaseStatus).toHaveBeenCalledWith({ repoRoot: '/home/me/checkout', serverUrl: URL });
    expect(publish).toHaveBeenCalledWith('/out/a.apk', { serverUrl: URL, token: 'pat_x' }, 'Faster sync');
    expect(result.stderr).toContain('Updated.');
    expect(result.stderr).toContain('Android APK  published 1.0.7 (code 7)');
  });

  it('builds from the deployment checkout (the revision just deployed) when it holds apps/android (#315)', async () => {
    const root = recordedRoot('app.example.test');
    mkdirSync(join(root, 'repo', 'apps', 'android'), { recursive: true });
    const { deps, getReleaseStatus } = stepDeps();
    const result = await run(['deploy', 'update', '--root', root, '--with-android'], deps);
    expect(result.error).toBeUndefined();
    expect(getReleaseStatus).toHaveBeenCalledWith({ repoRoot: join(root, 'repo'), serverUrl: URL });
    expect(result.stderr).toContain(`built from the deployment's checkout (${join(root, 'repo')})`);
  });

  it('runs even when the revision did not move', async () => {
    vi.mocked(updateModule.runUpdate).mockResolvedValue({ changed: false, commitSha: 'b'.repeat(40), journalPath: '/l', durationMs: 0 });
    const { deps } = stepDeps();
    const result = await run(['deploy', 'update', '--root', recordedRoot('app.example.test'), '--with-android'], deps);
    expect(result.stderr).toContain('Nothing to do.');
    expect(result.stderr).toContain('Android APK  published');
  });

  it('no recorded domain → skipped with a reason, exit unchanged', async () => {
    const { deps, getReleaseStatus } = stepDeps();
    const result = await run(['deploy', 'update', '--root', recordedRoot(undefined), '--with-android', '--non-interactive'], deps);
    expect(result.error).toBeUndefined();
    expect(getReleaseStatus).not.toHaveBeenCalled();
    expect(result.stderr).toContain('Android APK  skipped: the deployment has no public domain');
  });

  it('not logged in → skipped with `login --server <url>`', async () => {
    const { deps } = stepDeps();
    deps.getReleaseStatus = async (input) => ({
      repoRoot: input.repoRoot,
      targetServerUrl: input.serverUrl,
      local: { versionName: '1.0.6', versionCode: 6 },
      keystore: { configured: true },
      login: { state: 'logged_out', canPublish: false },
      server: { current: null, reachable: false },
      newerLocally: false,
    });
    const result = await run(['deploy', 'update', '--root', recordedRoot('app.example.test'), '--with-android'], deps);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain(`fix: `);
    expect(result.stderr).toContain(`login --server ${URL}`);
  });
});
