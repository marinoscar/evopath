import { exec as defaultExec, type ExecFn, type ExecResult } from './exec.js';

// =============================================================================
// Is this checkout behind its remote?  (issue #315)
// =============================================================================
//
// An APK is built from whatever the checkout holds. Built from a checkout that
// is behind origin/main, it silently leaves out the commits it is missing --
// and publishing it makes that the current release. `android doctor` reports
// this as a check and `android build` warns before Gradle runs.
//
// ⚠ READ-ONLY, apart from refreshing the remote-tracking ref. The only write
// is `git fetch`, which updates `refs/remotes/...`; this never pulls, merges,
// resets, checks out or touches the work tree.
//
// ⚠ NEVER THROWS, NEVER HANGS. The fetch has a short timeout and no terminal
// prompt; when it fails (offline, no credentials) the comparison falls back to
// the last-known remote ref and says it may be stale. Every other problem is
// an outcome (`not_git`, `detached`, `unknown`), never an exception.
// =============================================================================

/** Compared against when the current branch has no upstream. */
export const FALLBACK_REF = 'origin/main';

/** How long `git fetch` may take before the comparison uses the last-known ref. */
export const FETCH_TIMEOUT_MS = 10_000;

export type FreshnessState = 'up_to_date' | 'behind' | 'not_git' | 'detached' | 'unknown';

export interface GitFreshness {
  state: FreshnessState;
  /** The current branch, when on one. */
  branch?: string | undefined;
  /** The ref compared against: the upstream, or `origin/main`. */
  ref?: string | undefined;
  /** True when `ref` is the branch's configured upstream (so `git pull` alone fixes it). */
  hasUpstream?: boolean | undefined;
  behind: number;
  ahead: number;
  /** Why the fetch failed; when set, the comparison used the last-known ref and may be stale. */
  fetchError?: string | undefined;
  /** For `not_git` and `unknown`: what went wrong. */
  detail?: string | undefined;
}

export interface FreshnessContext {
  exec?: ExecFn | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetchTimeoutMs?: number | undefined;
}

export async function checkGitFreshness(repoRoot: string, ctx: FreshnessContext = {}): Promise<GitFreshness> {
  const exec = ctx.exec ?? defaultExec;
  // No credential prompt may ever wait on a terminal nobody is watching.
  const env: NodeJS.ProcessEnv = { ...(ctx.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
  const git = async (args: string[], timeoutMs?: number): Promise<ExecResult> => {
    try {
      return await exec('git', args, { cwd: repoRoot, env, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    } catch (error) {
      return { code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
    }
  };
  const none = { behind: 0, ahead: 0 };

  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { state: 'not_git', ...none, detail: firstLine(inside.stderr) || `${repoRoot} is not a git checkout` };
  }

  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.stdout.trim();
  if (head.code !== 0 || branch === '') {
    return { state: 'unknown', ...none, detail: firstLine(head.stderr) || 'could not read the current branch' };
  }
  if (branch === 'HEAD') return { state: 'detached', ...none };

  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstreamRef = upstream.code === 0 ? upstream.stdout.trim() : '';
  const hasUpstream = upstreamRef !== '' && upstreamRef.includes('/');
  const ref = hasUpstream ? upstreamRef : FALLBACK_REF;
  const slash = ref.indexOf('/');
  const remote = ref.slice(0, slash);
  const remoteBranch = ref.slice(slash + 1);

  const fetched = await git(['fetch', '--quiet', remote, remoteBranch], ctx.fetchTimeoutMs ?? FETCH_TIMEOUT_MS);
  // A timeout kills the fetch, which `exec` reports as code -1 with no stderr.
  const fetchError =
    fetched.code === 0 ? undefined : firstLine(fetched.stderr) || (fetched.code === -1 ? 'timed out' : `exit ${fetched.code}`);

  const counted = await git(['rev-list', '--left-right', '--count', `HEAD...${ref}`]);
  const match = /^(\d+)\s+(\d+)/.exec(counted.stdout.trim());
  if (counted.code !== 0 || match === null) {
    return {
      state: 'unknown',
      branch,
      ref,
      hasUpstream,
      ...none,
      ...(fetchError === undefined ? {} : { fetchError }),
      detail: firstLine(counted.stderr) || `could not compare with ${ref}`,
    };
  }
  const ahead = Number(match[1]);
  const behind = Number(match[2]);
  return {
    state: behind > 0 ? 'behind' : 'up_to_date',
    branch,
    ref,
    hasUpstream,
    behind,
    ahead,
    ...(fetchError === undefined ? {} : { fetchError }),
  };
}

/** The command that brings the checkout up to date. */
export function freshnessFix(freshness: GitFreshness): string {
  if (freshness.hasUpstream === true) return 'git pull';
  const target = (freshness.ref ?? FALLBACK_REF).split('/').slice(1).join('/');
  return freshness.branch === target ? `git pull origin ${target}` : `git checkout ${target} && git pull`;
}

const commits = (count: number) => `${count} commit${count === 1 ? '' : 's'}`;

/** One human sentence for the outcome (no fix). */
export function describeFreshness(freshness: GitFreshness): string {
  const ref = freshness.ref ?? FALLBACK_REF;
  const stale = freshness.fetchError === undefined ? '' : ` (could not fetch: ${freshness.fetchError}; compared with the last-known ${ref}, which may be stale)`;
  const ahead = freshness.ahead > 0 ? `, ${commits(freshness.ahead)} ahead` : '';
  switch (freshness.state) {
    case 'up_to_date':
      return `Up to date with ${ref}${ahead}${stale}`;
    case 'behind':
      return `${commits(freshness.behind)} behind ${ref}${ahead}${stale}`;
    case 'detached':
      return 'Detached HEAD: not on a branch, so there is nothing to compare';
    case 'not_git':
      return `Not a git checkout, so it cannot be compared with ${ref} (${freshness.detail ?? 'no .git'})`;
    case 'unknown':
      return `Could not compare with ${ref}: ${freshness.detail ?? 'unknown error'}${stale}`;
  }
}

/** The build's warning when behind; undefined otherwise. */
export function behindWarning(freshness: GitFreshness): string | undefined {
  if (freshness.state !== 'behind') return undefined;
  const ref = freshness.ref ?? FALLBACK_REF;
  const stale = freshness.fetchError === undefined ? '' : ` (last-known ${ref}; the fetch failed, so it may be more)`;
  return `⚠ Your checkout is ${commits(freshness.behind)} behind ${ref}${stale} — the APK will not include them. Run: ${freshnessFix(freshness)}`;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
