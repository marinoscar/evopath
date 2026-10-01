import { describe, expect, it } from 'vitest';

import type { ExecFn } from './exec.js';
import { commitVersionFile, releaseCommitMessage, ReleaseStepError, runRelease, type ReleaseSteps } from './release.js';

function steps(fail?: 'build' | 'publish') {
  const order: string[] = [];
  const impl: ReleaseSteps<string, string> = {
    bump: (part) => {
      order.push(`bump:${part}`);
      return { versionName: '1.0.1', versionCode: 2 };
    },
    build: async () => {
      order.push('build');
      if (fail === 'build') throw new Error('gradle exploded');
      return 'apk';
    },
    publish: async (build) => {
      order.push(`publish:${build}`);
      if (fail === 'publish') throw new Error('409 conflict');
      return 'release';
    },
    commit: async () => {
      order.push('commit');
      return 'committed abc';
    },
  };
  return { order, impl };
}

describe('runRelease', () => {
  it('bumps, builds, publishes, then commits — in that order', async () => {
    const { order, impl } = steps();
    const outcome = await runRelease({ bump: 'patch', commit: true }, impl, () => {});
    expect(order).toEqual(['bump:patch', 'build', 'publish:apk', 'commit']);
    expect(outcome).toMatchObject({ release: 'release', commit: 'committed abc' });
  });

  it('skips the commit with --no-commit', async () => {
    const { order, impl } = steps();
    const outcome = await runRelease({ bump: 'minor', commit: false }, impl, () => {});
    expect(order).not.toContain('commit');
    expect(outcome.commit).toMatch(/skipped/);
  });

  it.each(['build', 'publish'] as const)('does not commit when %s fails, and says the bump is local', async (fail) => {
    const { order, impl } = steps(fail);
    const error = await runRelease({ bump: 'patch', commit: true }, impl, () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReleaseStepError);
    expect((error as Error).message).toMatch(/bumped locally to 1\.0\.1 \(2\) and NOT committed/);
    expect(order).not.toContain('commit');
    if (fail === 'build') expect(order).not.toContain('publish:apk');
  });
});

describe('commitVersionFile', () => {
  it('commits only version.properties with the release message', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'abc1234\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await commitVersionFile(exec, '/repo', { versionName: '1.0.1', versionCode: 2 });
    expect(calls[1]).toEqual(['add', '--', 'apps/android/version.properties']);
    expect(calls[2]).toEqual(['commit', '-m', 'chore(android): release 1.0.1 (2)', '--', 'apps/android/version.properties']);
    expect(result).toBe('committed abc1234 "chore(android): release 1.0.1 (2)"');
    expect(releaseCommitMessage({ versionName: '2.0.0', versionCode: 9 })).toBe('chore(android): release 2.0.0 (9)');
  });

  it('skips outside a git repository', async () => {
    const exec: ExecFn = async () => ({ code: 128, stdout: '', stderr: 'fatal' });
    expect(await commitVersionFile(exec, '/repo', { versionName: '1.0.1', versionCode: 2 })).toMatch(/not a git repository/);
    const missing: ExecFn = async () => {
      throw new Error('git missing');
    };
    expect(await commitVersionFile(missing, '/repo', { versionName: '1.0.1', versionCode: 2 })).toMatch(/not a git repository/);
  });
});
