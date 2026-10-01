import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VERSIONED_MANIFESTS } from '../../../deploy/app-version.js';
import type { DeployState } from '../../../deploy/state.js';
import type { UpdateOptions } from '../../../deploy/update.js';

// =============================================================================
// `updateFields`/`performUpdate`'s own logic (issue #226): the version-override
// field this screen adds to `deploy update`.
//
// `runUpdate` is mocked so `performUpdate` is exercised as a PURE translation
// from answers to the options object it hands over -- the pipeline itself
// (build, migrate, restart, ...) is `update.ts`'s own test file's job, not
// this screen's.
// =============================================================================
vi.mock('../../../deploy/update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deploy/update.js')>();
  return { ...actual, runUpdate: vi.fn() };
});

vi.mock('../../../deploy/android-step.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deploy/android-step.js')>();
  return { ...actual, runDeployAndroidStep: vi.fn() };
});

import { runDeployAndroidStep } from '../../../deploy/android-step.js';
import { runUpdate } from '../../../deploy/update.js';
import { performUpdate, updateFields } from './update.js';

const runUpdateMock = vi.mocked(runUpdate);

beforeEach(() => {
  runUpdateMock.mockReset();
  runUpdateMock.mockResolvedValue({
    changed: true,
    commitSha: 'a'.repeat(40),
    journalPath: '/tmp/evopathcli-update.log',
    durationMs: 1,
  });
});

/** A deploy root whose checkout carries every versioned manifest at `version`. */
function deployRootWithVersion(version: string): string {
  const deployRoot = mkdtempSync(join(tmpdir(), 'evopathcli-update-screen-'));
  for (const relative of VERSIONED_MANIFESTS) {
    const manifestPath = join(deployRoot, 'repo', relative);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ name: 'x', version }));
  }
  return deployRoot;
}

describe('updateFields', () => {
  it('returns exactly the __ref and __app_version fields, in that order', () => {
    const deployRoot = deployRootWithVersion('1.0.0');
    expect(updateFields(undefined, deployRoot).map((field) => field.key)).toEqual([
      '__ref',
      '__app_version',
    ]);
  });

  it('prefills __ref from the recorded state, as before', () => {
    const deployRoot = deployRootWithVersion('1.0.0');
    const state = { ref: 'release/9.0' } as unknown as DeployState;

    const refField = updateFields(state, deployRoot).find((field) => field.key === '__ref');

    expect(refField?.placeholder).toBe('release/9.0');
    expect(refField?.prefilled).toBe(true);
  });

  it('prefills __app_version with the suggested patch bump of the checkout\'s current version', () => {
    const deployRoot = deployRootWithVersion('2.3.4');

    const versionField = updateFields(undefined, deployRoot).find(
      (field) => field.key === '__app_version',
    );

    expect(versionField?.placeholder).toBe('2.3.5');
    expect(versionField?.prefilled).toBe(true);
    expect(versionField?.help).toContain('2.3.4');
  });

  describe('__app_version validate', () => {
    function versionField(version: string) {
      const deployRoot = deployRootWithVersion(version);
      const field = updateFields(undefined, deployRoot).find(
        (candidate) => candidate.key === '__app_version',
      );
      if (field?.validate === undefined) throw new Error('the __app_version field lost its validate');
      return field.validate;
    }

    it('validates an empty string - "keep the suggestion" - with no error', () => {
      expect(versionField('2.3.4')('')).toBeUndefined();
    });

    it('validates the suggested bump itself with no error', () => {
      expect(versionField('2.3.4')('2.3.5')).toBeUndefined();
    });

    it('validates anything that sorts above the current version with no error', () => {
      expect(versionField('2.3.4')('3.0.0')).toBeUndefined();
    });

    it('rejects a version that does not sort above the current one, with the backend\'s own message', () => {
      expect(versionField('2.3.4')('2.3.4')).toMatch(/does not sort above/);
      expect(versionField('2.3.4')('1.0.0')).toMatch(/does not sort above/);
    });

    it('rejects a malformed version outright', () => {
      expect(versionField('2.3.4')('not-a-version')).toMatch(/not a version/);
    });
  });
});

describe('performUpdate: the __app_version passthrough', () => {
  const target = {
    name: { resolved: 'demo', display: 'demo' },
    settings: {
      deployRoot: '/tmp/evopathcli-update-screen-deploy',
      proxyRoot: '/tmp/evopathcli-update-screen-proxy',
      bindPort: 3535,
      proxyContainer: 'proxy-nginx',
      proxyMode: 'auto' as const,
    },
    state: undefined,
  };

  function answersWith(appVersion: string | undefined): ReadonlyMap<string, string> {
    const answers = new Map<string, string>([['__ref', '']]);
    if (appVersion !== undefined) answers.set('__app_version', appVersion);
    return answers;
  }

  async function run(appVersion: string | undefined): Promise<UpdateOptions> {
    await performUpdate(
      target,
      answersWith(appVersion),
      new Set(),
      new AbortController().signal,
      {},
    );
    const call = runUpdateMock.mock.calls.at(-1);
    if (call === undefined) throw new Error('runUpdate was not called');
    return call[0];
  }

  it('includes appVersion, exactly as typed, when the field was filled in', async () => {
    const options = await run('2.3.5');
    expect(options.appVersion).toBe('2.3.5');
  });

  it('omits appVersion entirely when the field was left empty - "the suggestion was fine"', async () => {
    const options = await run('');
    expect(options).not.toHaveProperty('appVersion');
  });

  it('omits appVersion when the field was never in the answers at all', async () => {
    const options = await run(undefined);
    expect(options).not.toHaveProperty('appVersion');
  });

  it('still passes ref the same way - unaffected by the new field', async () => {
    const answers = new Map([['__ref', 'v2.0.0']]);
    await performUpdate(target, answers, new Set(), new AbortController().signal, {});

    const call = runUpdateMock.mock.calls.at(-1);
    expect(call?.[0].ref).toBe('v2.0.0');
  });
});

// =============================================================================
// The "Publish the Android APK if newer" toggle (issue #292): not a pipeline
// option, it runs AFTER `runUpdate` and adds its line to the done frame.
// =============================================================================
describe('performUpdate: --with-android', () => {
  const target = {
    name: { resolved: 'demo', display: 'demo' },
    settings: {
      deployRoot: '/tmp/evopathcli-update-screen-android',
      proxyRoot: '/tmp/evopathcli-update-screen-proxy',
      bindPort: 3535,
      proxyContainer: 'proxy-nginx',
      proxyMode: 'auto' as const,
    },
    state: { domain: 'app.example.test' } as unknown as DeployState,
  };
  const androidMock = vi.mocked(runDeployAndroidStep);

  beforeEach(() => {
    androidMock.mockReset();
    androidMock.mockResolvedValue({
      status: 'published',
      version: { versionName: '1.0.6', versionCode: 6 },
      releaseId: 'r',
      serverUrl: 'https://app.example.test',
      detail: 'published 1.0.6 (code 6) to https://app.example.test as the current release',
    });
  });

  it('is not forwarded to runUpdate, runs after it, and reports in the summary', async () => {
    const summary = await performUpdate(target, new Map([['__ref', '']]), new Set(['--with-android']), new AbortController().signal, {});

    expect(runUpdateMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('withAndroid');
    expect(androidMock).toHaveBeenCalledTimes(1);
    expect(androidMock.mock.calls[0]?.[0]).toMatchObject({ domain: 'app.example.test', deployRoot: target.settings.deployRoot });
    expect(summary).toContain('Android APK  published 1.0.6 (code 6) to https://app.example.test as the current release');
  });

  it('does not run without the toggle', async () => {
    await performUpdate(target, new Map([['__ref', '']]), new Set(), new AbortController().signal, {});
    expect(androidMock).not.toHaveBeenCalled();
  });
});
