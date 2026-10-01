import { describe, expect, it, vi } from 'vitest';

import type { AndroidStepDeps } from '../../../deploy/android-step.js';
import type { StepResult } from '../../../deploy/hooks.js';
import { publishAndroidAfterDeploy } from './android.js';

// The deploy screens' --with-android toggle (#292): one more step in the run
// frame, lines in the done frame, and never a throw.

function deps(publish: AndroidStepDeps['publish']): AndroidStepDeps {
  return {
    findRepoRoot: () => '/checkout',
    getReleaseStatus: async (input) => ({
      repoRoot: input.repoRoot,
      targetServerUrl: input.serverUrl,
      local: { versionName: '1.0.6', versionCode: 6 },
      keystore: { configured: true },
      login: { state: 'logged_in', serverUrl: input.serverUrl, canPublish: true },
      server: { current: null, reachable: true },
      newerLocally: true,
    }),
    previewBump: () => {
      throw new Error('not used');
    },
    bumpVersionFile: () => {
      throw new Error('not used');
    },
    doctor: async () => ({ checks: [], ok: true, sdk: {} as never, repoRoot: '/checkout' }),
    build: async () => ({
      apkPath: '/out/a.apk',
      metadataPath: '/out/a.json',
      verified: true,
      metadata: { packageName: 'p', versionName: '1.0.6', versionCode: 6, signingSha256: '', fileSha256: '', sizeBytes: 1, builtAt: '', gitSha: null },
    }),
    publish,
    commit: async () => '',
    credentials: (serverUrl) => ({ serverUrl, token: 't' }),
  };
}

describe('publishAndroidAfterDeploy', () => {
  it('is a no-op without the toggle', async () => {
    const onStepStart = vi.fn();
    expect(await publishAndroidAfterDeploy(new Set(), 'app.example.test', '/d', { onStepStart })).toEqual([]);
    expect(onStepStart).not.toHaveBeenCalled();
  });

  it('reports a published APK as an ok step', async () => {
    const results: StepResult[] = [];
    const lines = await publishAndroidAfterDeploy(
      new Set(['--with-android']),
      'app.example.test',
      '/d',
      { onStepResult: (result) => results.push(result) },
      deps(async () => ({ release: { id: 'r' } as never, metadata: {} as never })),
    );
    expect(results[0]).toMatchObject({ id: 'android', outcome: 'ok' });
    expect(lines).toContain('Android APK  published 1.0.6 (code 6) to https://app.example.test as the current release');
  });

  it('turns an upload failure into a failed step and lines, never a throw', async () => {
    const results: StepResult[] = [];
    const lines = await publishAndroidAfterDeploy(
      new Set(['--with-android']),
      'app.example.test',
      '/d',
      { onStepResult: (result) => results.push(result) },
      deps(async () => {
        throw new Error('413');
      }),
    );
    expect(results[0]?.outcome).toBe('failed');
    expect(lines.join('\n')).toContain('the deploy itself succeeded');
  });
});
