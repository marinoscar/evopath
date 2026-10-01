import { relative } from 'node:path';

import { CliError, formatError } from '../errors.js';
import type { ExecFn } from './exec.js';
import { versionPropertiesPath } from './paths.js';
import type { AppVersion, BumpPart } from './version.js';

// =============================================================================
// `android release`: bump → build → publish → commit  (issue #286)
// =============================================================================
//
// The order is the guarantee. The commit comes LAST so a failed build or a
// rejected upload never leaves a "release x.y.z" commit for a release that
// does not exist. The bump stays in the working tree in that case, and the
// user is told so — re-running after a fix should not bump twice by accident.
// =============================================================================

export interface ReleaseSteps<TBuild, TRelease> {
  bump(part: BumpPart): Promise<AppVersion> | AppVersion;
  build(): Promise<TBuild>;
  publish(build: TBuild): Promise<TRelease>;
  /** Returns a sentence for the log, e.g. the commit SHA or why it was skipped. */
  commit(version: AppVersion): Promise<string>;
}

export interface ReleaseOptions {
  bump: BumpPart;
  commit: boolean;
}

export interface ReleaseOutcome<TBuild, TRelease> {
  version: AppVersion;
  build: TBuild;
  release: TRelease;
  commit: string;
}

/** A step failed after the version was bumped; the message says so. */
export class ReleaseStepError extends CliError {
  readonly exitCode;
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.exitCode = cause instanceof CliError ? cause.exitCode : 1;
  }
}

export async function runRelease<TBuild, TRelease>(
  options: ReleaseOptions,
  steps: ReleaseSteps<TBuild, TRelease>,
  log: (line: string) => void,
): Promise<ReleaseOutcome<TBuild, TRelease>> {
  const version = await steps.bump(options.bump);
  log(`Version bumped to ${version.versionName} (${version.versionCode}).`);

  const failAfterBump = (step: string, error: unknown): never => {
    throw new ReleaseStepError(
      `${step} failed: ${formatError(error)}\n` +
        `version.properties was bumped locally to ${version.versionName} (${version.versionCode}) and NOT committed. ` +
        'Fix the problem and run `android build` / `android publish`, or revert the file.',
      error,
    );
  };

  let build: TBuild;
  try {
    build = await steps.build();
  } catch (error) {
    return failAfterBump('Build', error);
  }

  let release: TRelease;
  try {
    release = await steps.publish(build);
  } catch (error) {
    return failAfterBump('Publish', error);
  }

  const commit = options.commit ? await steps.commit(version) : 'skipped (--no-commit)';
  return { version, build, release, commit };
}

export function releaseCommitMessage(version: AppVersion): string {
  return `chore(android): release ${version.versionName} (${version.versionCode})`;
}

/**
 * Commit ONLY version.properties (`git commit -- <path>`), so whatever else
 * the user has staged is not swept into the release commit.
 */
export async function commitVersionFile(exec: ExecFn, repoRoot: string, version: AppVersion): Promise<string> {
  const inRepo = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot }).catch(() => undefined);
  if (inRepo === undefined || inRepo.code !== 0 || inRepo.stdout.trim() !== 'true') {
    return 'skipped (not a git repository)';
  }
  const file = relative(repoRoot, versionPropertiesPath(repoRoot)).split('\\').join('/');
  const add = await exec('git', ['add', '--', file], { cwd: repoRoot });
  if (add.code !== 0) return `not committed: git add failed (${add.stderr.trim()})`;
  const commit = await exec('git', ['commit', '-m', releaseCommitMessage(version), '--', file], { cwd: repoRoot });
  if (commit.code !== 0) return `not committed: ${(commit.stderr.trim() || commit.stdout.trim()).split('\n')[0]}`;
  const sha = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot });
  return `committed ${sha.stdout.trim()} "${releaseCommitMessage(version)}"`;
}
