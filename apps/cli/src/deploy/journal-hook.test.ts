import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { runCommand } from './executor.js';
import type { DeployHooks } from './hooks.js';
import { runInstall } from './install.js';
import { DEPLOY_STATE_VERSION, writeState } from './state.js';
import { runUpdate } from './update.js';

// =============================================================================
// `DeployHooks.onJournal`: the journal path, while the run is going (#393)
// =============================================================================
//
// The journal path is the single most useful thing to show after a failed
// deploy -- and before this hook a screen learned it only from the RESULT,
// which is to say only on success. These assert it arrives once, names a file
// that exists, and arrives BEFORE the first step, so a run that fails in its
// very first step still has a journal to point at.
// =============================================================================

/** Refuses to run any subprocess; the pipelines fail cleanly at their first step. */
const noSubprocess: typeof runCommand = async () => {
  throw new Error('this test must not spawn a real subprocess');
};

function recorder(): { hooks: DeployHooks; events: string[]; paths: string[] } {
  const events: string[] = [];
  const paths: string[] = [];
  return {
    events,
    paths,
    hooks: {
      onJournal: (path) => {
        paths.push(path);
        events.push('journal');
      },
      onStepStart: ({ id }) => events.push(`start:${id}`),
    },
  };
}

describe('onJournal', () => {
  it('install announces its journal once, before the first step, even when that step fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-journal-hook-'));
    const { hooks, events, paths } = recorder();

    await runInstall({
      deployRoot: root,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
      runCommand: noSubprocess,
      hooks,
    }).catch(() => undefined);

    expect(paths).toHaveLength(1);
    expect(paths[0]?.startsWith(join(root, 'logs'))).toBe(true);
    expect(existsSync(paths[0] as string)).toBe(true);
    expect(events[0]).toBe('journal');
    expect(events.length).toBeGreaterThan(1);
  });

  it('update announces its journal once, before the first step', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-journal-hook-update-'));
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    writeFileSync(join(root, '.env'), 'APP_BIND_PORT=3535\n');
    writeState({
      version: DEPLOY_STATE_VERSION,
      repoUrl: 'https://example.test/o/r',
      ref: 'main',
      commitSha: 'a'.repeat(40),
      bindPort: 3535,
      deployRoot: root,
      installedAt: '2026-01-01T00:00:00.000Z',
      lastDeployedAt: '2026-01-01T00:00:00.000Z',
      lastCommand: 'install',
      appctlVersion: '1.0.0',
    });
    const { hooks, events, paths } = recorder();

    await runUpdate({ deployRoot: root, runCommand: noSubprocess, hooks }).catch(() => undefined);

    expect(paths).toHaveLength(1);
    expect(paths[0]?.startsWith(join(root, 'logs'))).toBe(true);
    expect(events[0]).toBe('journal');
  });
});
