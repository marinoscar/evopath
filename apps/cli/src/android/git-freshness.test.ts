import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ExecFn } from './exec.js';
import { behindWarning, checkGitFreshness, describeFreshness, freshnessFix } from './git-freshness.js';

// =============================================================================
// `checkGitFreshness`  (issue #315)
// =============================================================================
//
// Against REAL git repositories in a temp directory: a bare "origin", the
// checkout under test, and a second clone that pushes commits the checkout
// does not have. Fetching from a local path needs no network.
// =============================================================================

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: mkdtempSync(join(tmpdir(), 'git-fresh-home-')),
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
}

/** origin (bare, branch main) + `checkout` cloned from it + `other` that can push ahead. */
function repos() {
  const base = mkdtempSync(join(tmpdir(), 'git-fresh-'));
  const origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'init', '-q', '-b', 'main', seed);
  commit(seed, 'a');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  const checkout = join(base, 'checkout');
  git(base, 'clone', '-q', origin, checkout);
  return { base, origin, seed, checkout };
}

const ctx = { env: GIT_ENV };

describe('checkGitFreshness', () => {
  it('up to date with the upstream', async () => {
    const { checkout } = repos();
    const result = await checkGitFreshness(checkout, ctx);
    expect(result).toMatchObject({ state: 'up_to_date', branch: 'main', ref: 'origin/main', hasUpstream: true, behind: 0, ahead: 0 });
    expect(result.fetchError).toBeUndefined();
    expect(behindWarning(result)).toBeUndefined();
    expect(describeFreshness(result)).toBe('Up to date with origin/main');
  });

  it('behind: fetches first, so commits pushed elsewhere are counted (and ahead too)', async () => {
    const { seed, checkout } = repos();
    commit(seed, 'b');
    commit(seed, 'c');
    git(seed, 'push', '-q', 'origin', 'main');
    commit(checkout, 'mine');

    const result = await checkGitFreshness(checkout, ctx);
    expect(result).toMatchObject({ state: 'behind', behind: 2, ahead: 1, ref: 'origin/main' });
    expect(freshnessFix(result)).toBe('git pull');
    expect(describeFreshness(result)).toBe('2 commits behind origin/main, 1 commit ahead');
    expect(behindWarning(result)).toBe(
      '⚠ Your checkout is 2 commits behind origin/main — the APK will not include them. Run: git pull',
    );
    // Read-only: the work tree and HEAD did not move.
    expect(git(checkout, 'log', '-1', '--format=%s')).toBe('mine');
  });

  it('fetch failure (offline): compares with the last-known remote ref and says it may be stale', async () => {
    const { seed, checkout } = repos();
    commit(seed, 'b');
    git(seed, 'push', '-q', 'origin', 'main');
    git(checkout, 'fetch', '-q'); // last-known origin/main is now one ahead
    git(checkout, 'remote', 'set-url', 'origin', join(checkout, 'does-not-exist'));

    const result = await checkGitFreshness(checkout, ctx);
    expect(result.state).toBe('behind');
    expect(result.behind).toBe(1);
    expect(result.fetchError).toBeDefined();
    expect(describeFreshness(result)).toMatch(/may be stale/);
    expect(behindWarning(result)).toMatch(/the fetch failed, so it may be more/);
  });

  it('a fetch that never answers is cut off by the timeout', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (_command, args, options) => {
      calls.push(args.join(' '));
      if (args[0] === 'fetch') {
        expect(options?.timeoutMs).toBe(10_000);
        expect(options?.env?.GIT_TERMINAL_PROMPT).toBe('0');
        return { code: -1, stdout: '', stderr: '' };
      }
      if (args.includes('--is-inside-work-tree')) return { code: 0, stdout: 'true\n', stderr: '' };
      if (args.includes('@{u}')) return { code: 128, stdout: '', stderr: 'fatal: no upstream configured' };
      if (args.at(-1) === 'HEAD') return { code: 0, stdout: 'feature\n', stderr: '' };
      if (args[0] === 'rev-list') return { code: 0, stdout: '0\t3\n', stderr: '' };
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const result = await checkGitFreshness('/repo', { exec });
    expect(calls).toContain('fetch --quiet origin main');
    expect(result).toMatchObject({ state: 'behind', behind: 3, ref: 'origin/main', hasUpstream: false, fetchError: 'timed out' });
    // Not on main, no upstream: switch to main first.
    expect(freshnessFix(result)).toBe('git checkout main && git pull');
  });

  it('never runs anything that changes the work tree', async () => {
    const seen: string[] = [];
    const exec: ExecFn = async (_command, args) => {
      seen.push(args[0] ?? '');
      return { code: 0, stdout: args.includes('--is-inside-work-tree') ? 'true' : args.at(-1) === 'HEAD' ? 'main' : '0\t0', stderr: '' };
    };
    await checkGitFreshness('/repo', { exec });
    expect(seen.filter((verb) => ['pull', 'merge', 'reset', 'checkout', 'rebase', 'stash'].includes(verb))).toEqual([]);
  });

  it('not a git checkout', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'git-fresh-plain-'));
    const result = await checkGitFreshness(plain, ctx);
    expect(result.state).toBe('not_git');
    expect(describeFreshness(result)).toMatch(/^Not a git checkout/);
  });

  it('git itself missing is "not a git checkout", not a crash', async () => {
    const exec: ExecFn = async () => {
      throw new Error('`git` was not found.');
    };
    await expect(checkGitFreshness('/repo', { exec })).resolves.toMatchObject({ state: 'not_git' });
  });

  it('detached HEAD', async () => {
    const { checkout } = repos();
    git(checkout, 'checkout', '-q', '--detach');
    expect((await checkGitFreshness(checkout, ctx)).state).toBe('detached');
  });

  it('no upstream on main: compares with origin/main and suggests pulling it', async () => {
    const { checkout } = repos();
    git(checkout, 'branch', '-q', '--unset-upstream');
    const result = await checkGitFreshness(checkout, ctx);
    expect(result).toMatchObject({ state: 'up_to_date', ref: 'origin/main', hasUpstream: false });
    expect(freshnessFix(result)).toBe('git pull origin main');
  });
});
