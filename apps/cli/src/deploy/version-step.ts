/**
 * The deploy-time version bump: choose, write, commit, and later push.
 *
 * =============================================================================
 * ⚠ THE INVARIANT THE WHOLE DESIGN RESTS ON
 * =============================================================================
 *
 *   At the end of every run, the clone's HEAD is the commit `origin/<ref>`
 *   resolves to -- either because the bump commit BECAME that commit, or
 *   because it was rolled back out.
 *
 * On a FAILED PUSH the bump commit is rolled back (`checkout --force --detach
 * <baseSha>`). Not for tidiness: without it the clone sits permanently one
 * commit ahead of origin, every later `update` sees itself as behind, and the
 * server rebuilds byte-identical images for ever. The DEPLOYMENT keeps the
 * version -- it is in the image, the `.env` and the deploy-info.
 *
 * ⚠ ON SUCCESS THE RECORDED DEPLOYED COMMIT IS THE BUMP COMMIT. Recording the
 * pre-bump one leaves every server permanently reporting itself a commit
 * behind, rebuilding identical code and bumping again on every update -- an
 * infinite treadmill. It is also simply more accurate: the commit happens
 * before `build`, so the images WERE built with HEAD there.
 *
 * =============================================================================
 * ⚠ PUSH RULES
 * =============================================================================
 *
 * - PUSH LAST, after verify -- not at the health gate. `deploy-info` is gated
 *   at health because it must describe a running deployment even on a failed
 *   run. Pushing to a shared repository is IRREVERSIBLE and externally
 *   visible: a version not pushed is re-derived next run; a version pushed for
 *   a deploy that did not finish is a commit someone has to reason about.
 * - A FAILED PUSH IS A WARNING, never a failure. By then the app is built,
 *   migrated, started and answering.
 * - NEVER `--force`. NEVER RETRY. A retry re-commits the bump on top of
 *   wherever origin moved -- but the deployment was built from the OLD tip, so
 *   the published tree would contain code this server never built. Rebasing a
 *   version bump is a code change wearing a bookkeeping retry's clothes.
 * - Push EXPLICITLY as `git push origin HEAD:refs/heads/<ref>`. It works from a
 *   detached HEAD, and ⚠ a "skip on a detached HEAD" guard would skip ALWAYS,
 *   because the checkout step ends detached on every normal deployment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readEnvFile, writeEnvFile } from './env-file.js';
import { parseEnvExample } from './env-spec.js';
import { runCommand as defaultRunCommand } from './executor.js';
import {
  assertMovesForward,
  currentVersion,
  suggestNext,
  writeVersion,
} from './app-version.js';

export interface VersionStepOptions {
  checkoutPath: string;
  /** An explicit `--app-version`. A malformed one stops the run. */
  requested?: string | undefined;
  /** `--no-version-bump`. */
  disabled?: boolean | undefined;
  runCommand?: typeof defaultRunCommand | undefined;
}

export interface VersionStepResult {
  /** False when bumping was disabled or nothing needed changing. */
  bumped: boolean;
  version: string;
  /** The commit HEAD was on before the bump. Needed to roll back. */
  baseSha?: string | undefined;
  /** The bump commit. This is what the deployment records as deployed. */
  commitSha?: string | undefined;
  detail: string;
}

async function git(
  options: VersionStepOptions,
  args: readonly string[],
): Promise<string> {
  const run = options.runCommand ?? defaultRunCommand;
  const result = await run(['git', ...args], {
    cwd: options.checkoutPath,
    timeoutMs: 60_000,
  });
  return result.stdout.trim();
}

/**
 * Chooses the version, writes it, and commits -- in ONE step.
 *
 * See the header: splitting the write from the commit leaves the tree dirty
 * across the build, and the checkout step refuses a dirty tree.
 */
export async function runVersionStep(
  options: VersionStepOptions,
): Promise<VersionStepResult> {
  const current = currentVersion(options.checkoutPath);

  if (options.disabled === true) {
    return { bumped: false, version: current, detail: 'skipped with --no-version-bump' };
  }

  // ⚠ A BAD `--app-version` STOPS THE RUN rather than falling back to the
  // suggestion. Deploying a different number from the one the operator typed
  // is the worst available outcome -- worse than refusing.
  const version = options.requested ?? suggestNext(current);
  assertMovesForward(version, current);

  const baseSha = await git(options, ['rev-parse', 'HEAD']);
  const { changed } = writeVersion(options.checkoutPath, version);

  if (changed.length === 0) {
    return { bumped: false, version, baseSha, detail: 'every manifest already carries this version' };
  }

  await git(options, ['add', ...changed]);
  await git(options, [
    '-c',
    'user.name=appctl deploy',
    '-c',
    'user.email=appctl@localhost',
    'commit',
    '--no-verify',
    '-m',
    `chore(release): ${version}`,
  ]);

  const commitSha = await git(options, ['rev-parse', 'HEAD']);

  return {
    bumped: true,
    version,
    baseSha,
    commitSha,
    detail: `wrote ${version} to ${String(changed.length)} file(s) and committed`,
  };
}

export interface PublishVersionResult {
  pushed: boolean;
  /** Set when the bump was rolled back out because the push failed. */
  rolledBack: boolean;
  /** Carried to the summary as a WARNING, never an error. */
  detail: string;
}

/**
 * Pushes the bump commit, or rolls it back out.
 *
 * Runs after `verify`, and its failure is a warning -- see the header.
 */
export async function publishVersion(
  options: VersionStepOptions & { ref: string; result: VersionStepResult },
): Promise<PublishVersionResult> {
  const { result, ref } = options;

  if (!result.bumped || result.commitSha === undefined) {
    return { pushed: false, rolledBack: false, detail: 'nothing to publish' };
  }

  try {
    // Explicit refspec: works from the detached HEAD every normal deployment
    // ends on. No --force, and no retry -- see the header for why a retry is a
    // code change wearing a bookkeeping retry's clothes.
    await git(options, ['push', 'origin', `HEAD:refs/heads/${ref}`]);
    return { pushed: true, rolledBack: false, detail: `pushed ${result.version} to ${ref}` };
  } catch (error) {
    // ⚠ ROLL THE BUMP BACK OUT. Left in place, the clone sits permanently one
    // commit ahead of origin and every later update reports itself behind,
    // rebuilding byte-identical images for ever. The deployment KEEPS the
    // version: it is already in the image, the .env and the deploy-info.
    let rolledBack = false;
    if (result.baseSha !== undefined) {
      try {
        await git(options, ['checkout', '--force', '--detach', result.baseSha]);
        rolledBack = true;
      } catch {
        // Reported below rather than thrown: by this point the application is
        // built, migrated, started and answering.
      }
    }

    return {
      pushed: false,
      rolledBack,
      detail:
        `could not publish ${result.version}: ${(error as Error).message}` +
        (rolledBack
          ? ' — the version commit was rolled back out, so the clone matches origin. The deployment keeps the version.'
          : ' — the version commit could NOT be rolled back; the clone is one commit ahead of origin.'),
    };
  }
}

/** Where the checkout lives, for callers that only hold a deploy root. */
export function checkoutPathFor(deployRoot: string): string {
  return join(deployRoot, 'repo');
}

/**
 * Stamps `APP_VERSION` into the deployment's `.env`.
 *
 * ⚠ THIS IS WHAT MAKES THE VERSION REACH THE APPLICATION. `base.compose.yml`
 * hands the api container the `.env` wholesale (`env_file`), and
 * `resolveApiVersion()` reads `APP_VERSION` first -- so without this the number
 * lives only in a commit nobody's runtime reads.
 *
 * ⚠ REWRITTEN THROUGH THE FULL TEMPLATE SPEC LIST, not appended. `.env` is
 * regenerated from `specs` on every write, so appending a line here would be
 * reordered away by the next `environment` step; and passing a SUBSET of the
 * specs would drop every section banner and every key not in that subset.
 * `APP_VERSION` is deliberately NOT in `.env.example` -- it is chosen by the
 * deploy, not answered by an operator -- so it lands under the serializer's
 * own `# Not in .env.example` banner beside `DEPLOY_ROOT`.
 *
 * Returns false when there is no `.env` to stamp, which is not an error: the
 * caller journals it and carries on.
 */
export function stampAppVersion(
  envPath: string,
  templatePath: string,
  version: string,
): boolean {
  if (!existsSync(envPath) || !existsSync(templatePath)) return false;

  const specs = parseEnvExample(readFileSync(templatePath, 'utf8'));
  const values = readEnvFile(envPath);

  if (values.get('APP_VERSION') === version) return true;

  values.set('APP_VERSION', version);
  writeEnvFile(envPath, values, specs);
  return true;
}
