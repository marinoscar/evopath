import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { UsageError } from '../errors.js';
import { probe } from './checks/host.js';
import { gitCredentialStateFor, isHttpsGithubUrl, nonInteractiveGitEnv } from './checks/source.js';
import type { DeployHooks } from './hooks.js';
import type { runCommand } from './executor.js';
import type { DeployState } from './state.js';

// =============================================================================
// What to deploy, worked out rather than hardcoded  (issue #179, epic #168)
// =============================================================================
//
// THIS REPOSITORY IS A TEMPLATE. It exists to be forked, and each fork has its
// own origin, its own default branch and its own tags.
//
// The shell scripts this epic replaces hardcode the repository they deploy,
// and that is the single largest reason they cannot be shared: every new
// application means copying the script and editing the URL, after which the
// copies drift and a fix made in one never reaches the others. If appctl
// hardcoded an owner or a repository name anywhere, it would inherit exactly
// that, and every downstream repository would have to patch the CLI before it
// could deploy itself.
//
// So NOTHING here names a repository. The target is resolved from the checkout
// appctl is running in, and repo.test.ts asserts that this module contains no
// owner, no repository name and no forge URL - a guard that already caught an
// earlier draft of this very comment, which had spelled one out as an example.
// =============================================================================

export interface RepoTarget {
  /** Normalised remote URL, in whichever scheme the operator already uses. */
  url: string;
  /** Branch, tag or SHA. */
  ref: string;
  source: 'flag' | 'state' | 'git-remote';
}

export interface ResolveRepoOptions {
  repoFlag?: string | undefined;
  refFlag?: string | undefined;
  state?: Pick<DeployState, 'repoUrl' | 'ref'> | undefined;
  /** Where to start looking for a .git directory. */
  cwd: string;
  runCommand: typeof runCommand;
}

/**
 * Strips a trailing `.git` and any credentials, without changing the scheme.
 *
 * THE SCHEME IS PRESERVED DELIBERATELY. Rewriting ssh to https breaks a server
 * whose access is a deploy key; rewriting https to ssh breaks one that has no
 * key at all. Whichever the operator already uses is the one that works.
 */
export function normaliseRepoUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '');
  // A token in the URL must never reach a log line or an error message.
  return trimmed.replace(/^(https?:\/\/)[^@/]+@/, '$1');
}

/** True when the URL carries embedded credentials that must not be printed. */
export function hasEmbeddedCredentials(url: string): boolean {
  return /^https?:\/\/[^@/]+@/.test(url);
}

/** Redacts credentials for display. */
export function displayRepoUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/, '$1***@');
}

/** Walks up from `cwd` looking for a .git directory or file. */
export function findGitRoot(cwd: string): string | undefined {
  let current = resolve(cwd);

  for (;;) {
    // `.git` is a directory in a normal clone and a FILE in a worktree, so
    // existsSync rather than a directory test.
    if (existsSync(join(current, '.git'))) return current;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function git(
  options: ResolveRepoOptions | { cwd: string; runCommand: typeof runCommand },
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await options.runCommand(['git', ...args], {
      cwd: options.cwd,
      timeoutMs: 30_000,
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Works out what to deploy.
 *
 * Order: an explicit flag, then the recorded state, then the local checkout.
 *
 * State beats the checkout so that an `update` redeploys WHAT WAS INSTALLED.
 * An install pinned to a tag must not be quietly moved to whatever branch the
 * operator's shell happens to be on.
 */
export async function resolveRepoTarget(
  options: ResolveRepoOptions,
): Promise<RepoTarget> {
  if (options.repoFlag !== undefined) {
    return {
      url: normaliseRepoUrl(options.repoFlag),
      ref: options.refFlag ?? (await defaultRefFor(options, options.repoFlag)) ?? 'main',
      source: 'flag',
    };
  }

  if (options.state !== undefined) {
    return {
      url: options.state.repoUrl,
      ref: options.refFlag ?? options.state.ref,
      source: 'state',
    };
  }

  const root = findGitRoot(options.cwd);
  if (root === undefined) {
    throw new UsageError(
      `Not inside a git checkout, so there is no repository to deploy. Pass --repo <url> (and --ref if you need a branch or tag other than the default).`,
    );
  }

  const scoped = { cwd: root, runCommand: options.runCommand };
  const origin = await git(scoped, ['remote', 'get-url', 'origin']);

  if (origin === undefined || origin === '') {
    throw new UsageError(
      `This checkout has no \`origin\` remote, so ${CLI_NAME} cannot tell what to deploy. Pass --repo <url>.`,
    );
  }

  const ref =
    options.refFlag ??
    (await git(scoped, ['rev-parse', '--abbrev-ref', 'HEAD'])) ??
    (await remoteDefaultBranch(scoped));

  if (ref === undefined || ref === '' || ref === 'HEAD') {
    // A detached HEAD, or a repository whose default branch cannot be read.
    // Guessing "main" here is how you deploy the wrong code on a fork that
    // uses master or develop.
    throw new UsageError(
      `Could not work out which branch to deploy from this checkout. Pass --ref <branch|tag|sha>.`,
    );
  }

  return { url: normaliseRepoUrl(origin), ref, source: 'git-remote' };
}

/**
 * Only the repository URL, by the same precedence as `resolveRepoTarget`
 * (flag, then recorded state, then the checkout's `origin`), for callers that
 * need to know WHERE the code comes from but not which ref -- the doctor
 * checks that ask whether git can authenticate to it.
 *
 * Never throws and resolves no ref, so it runs no more git than it has to:
 * `undefined` when nothing names a repository. Normalised, so it carries no
 * embedded credential.
 */
export async function resolveRepoUrl(
  options: Omit<ResolveRepoOptions, 'refFlag' | 'state'> & {
    state?: Pick<DeployState, 'repoUrl'> | undefined;
  },
): Promise<string | undefined> {
  if (options.repoFlag !== undefined) return normaliseRepoUrl(options.repoFlag);
  if (options.state?.repoUrl !== undefined) return normaliseRepoUrl(options.state.repoUrl);

  const root = findGitRoot(options.cwd);
  if (root === undefined) return undefined;

  const origin = await git({ cwd: root, runCommand: options.runCommand }, ['remote', 'get-url', 'origin']);
  return origin === undefined || origin === '' ? undefined : normaliseRepoUrl(origin);
}

async function defaultRefFor(
  options: ResolveRepoOptions,
  _url: string,
): Promise<string | undefined> {
  const root = findGitRoot(options.cwd);
  if (root === undefined) return undefined;
  return await remoteDefaultBranch({ cwd: root, runCommand: options.runCommand });
}

/**
 * The remote's own default branch.
 *
 * NEVER ASSUMED TO BE `main`. A fork may use master, develop, or anything
 * else, and deploying the wrong branch is the kind of mistake that looks like
 * a successful deployment.
 */
async function remoteDefaultBranch(scoped: {
  cwd: string;
  runCommand: typeof runCommand;
}): Promise<string | undefined> {
  const symbolic = await git(scoped, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return symbolic?.replace(/^origin\//, '');
}

export interface CheckoutOptions {
  deployRoot: string;
  runCommand: typeof runCommand;
  hooks?: DeployHooks | undefined;
  /** Discard uncommitted local modifications instead of refusing. */
  force?: boolean | undefined;
}

export interface CheckoutResult {
  /** The commit before this call moved anything; undefined on a first clone. */
  previousSha: string | undefined;
  sha: string;
  changed: boolean;
  path: string;
}

/**
 * Clones or updates the checkout, idempotently.
 *
 * The same call performs a first install and every later update, which is what
 * lets #180 and #182 share it rather than each doing half of it differently.
 */
export async function ensureCheckout(
  target: RepoTarget,
  options: CheckoutOptions,
): Promise<CheckoutResult> {
  const path = join(options.deployRoot, 'repo');
  const scoped = { cwd: path, runCommand: options.runCommand };
  const exists = existsSync(join(path, '.git'));

  if (!exists) {
    // Before the FIRST clone only: a fetch reuses whatever the clone used.
    const gh = await configureGhCredentials(target.url, options.runCommand);
    if (gh === 'configured') {
      options.hooks?.onProgress?.('Configured git to use the GitHub CLI\'s credentials (gh auth setup-git)');
    }
    options.hooks?.onProgress?.(`Cloning ${displayRepoUrl(target.url)}`);
    await runGit(options, options.deployRoot, [
      'clone',
      '--no-checkout',
      target.url,
      path,
    ]);
  } else {
    options.hooks?.onProgress?.('Fetching');
    await runGit(options, path, ['fetch', '--tags', '--prune', 'origin']);
  }

  const previousSha = exists ? await git(scoped, ['rev-parse', 'HEAD']) : undefined;

  if (exists && options.force !== true) {
    const dirty = await git(scoped, ['status', '--porcelain']);
    if (dirty !== undefined && dirty !== '') {
      // Someone hand-patched a file on the server. Resetting over it silently
      // is how a fix disappears and nobody knows why the bug came back.
      throw new UsageError(
        `The checkout at ${path} has uncommitted changes:\n` +
          dirty
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n') +
          `\nCommit or remove them, or re-run with --force to discard them.`,
      );
    }
  }

  const resolved = await resolveRef(scoped, target.ref);
  if (resolved === undefined) {
    throw new UsageError(
      `\`${target.ref}\` is not a branch, tag or commit in ${displayRepoUrl(target.url)}.`,
    );
  }

  // A hard reset rather than a merge: a deployed checkout is not a development
  // tree, and a merge conflict on a server is worse than a discarded local
  // change that --force already had to allow.
  await runGit(options, path, ['checkout', '--force', '--detach', resolved]);

  const sha = (await git(scoped, ['rev-parse', 'HEAD'])) ?? resolved;

  return {
    previousSha,
    sha,
    changed: previousSha !== sha,
    path,
  };
}

export type GhCredentialOutcome =
  /** Not an HTTPS GitHub URL: gh is not how it authenticates. */
  | 'not-applicable'
  /** git can already read it (public, a helper, a stored token). */
  | 'already-readable'
  /** gh is missing or not logged in; the clone proceeds and reports its own error. */
  | 'gh-unavailable'
  /** `gh auth setup-git` ran. */
  | 'configured';

/**
 * Lets the GitHub CLI supply clone credentials, when that is what is needed
 * (#391).
 *
 * Only for an HTTPS GitHub URL that git cannot already read, and only when
 * `gh auth status` says gh is logged in: then `gh auth setup-git` registers gh
 * as git's credential helper for that host. The clone itself is still a plain
 * `git clone` -- `gh repo clone` was rejected because it makes gh a hard
 * prerequisite even for a public repository, and breaks a server whose access
 * is an SSH deploy key.
 *
 * Never throws: every outcome ends with the clone being attempted exactly as
 * before, and a clone that still cannot authenticate says so itself.
 */
export async function configureGhCredentials(
  url: string,
  run: typeof runCommand,
): Promise<GhCredentialOutcome> {
  if (!isHttpsGithubUrl(url)) return 'not-applicable';
  if ((await gitCredentialStateFor(url, run)) !== false) return 'already-readable';

  const env = nonInteractiveGitEnv();
  const status = await probe({ runCommand: run }, ['gh', 'auth', 'status'], { env });
  if (!status.ok) return 'gh-unavailable';

  const setup = await probe({ runCommand: run }, ['gh', 'auth', 'setup-git'], { env, timeoutMs: 30_000 });
  return setup.ok ? 'configured' : 'gh-unavailable';
}

/** Resolves a branch, tag or SHA to a commit, preferring the remote branch. */
async function resolveRef(
  scoped: { cwd: string; runCommand: typeof runCommand },
  ref: string,
): Promise<string | undefined> {
  for (const candidate of [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`, ref]) {
    const sha = await git(scoped, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (sha !== undefined && sha !== '') return sha;
  }
  return undefined;
}

/** Runs git, turning an auth failure into something an operator can act on. */
async function runGit(
  options: CheckoutOptions,
  cwd: string,
  args: readonly string[],
): Promise<void> {
  try {
    const result = await options.runCommand(['git', ...args], {
      cwd,
      timeoutMs: 15 * 60_000,
      ...(options.hooks?.onLog === undefined
        ? {}
        : { onLine: (line: string) => options.hooks?.onLog?.(line) }),
    });
    void result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // The most common first-install failure by a wide margin, and the raw git
    // output does not say what to do about it.
    if (/authentication|permission denied|could not read Username|publickey/i.test(message)) {
      throw new UsageError(
        `git could not authenticate. This server needs read access to the repository — add a deploy key, or use an https URL with a credential helper.\n${message}`,
      );
    }
    throw error;
  }
}
