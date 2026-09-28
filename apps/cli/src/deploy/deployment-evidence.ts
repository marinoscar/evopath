/**
 * What makes a directory a deployment.
 *
 * > A deployment is a clone, an `.env`, and running containers. It is NOT a
 * > record in a file.
 *
 * This module exists because that sentence was not true of the code. `update`
 * asked whether the CLI's own bookkeeping was present, not whether a
 * DEPLOYMENT was: a directory with a clone at the right revision, an `.env`,
 * running containers, an issued certificate and a serving site could not be
 * updated because a JSON file was missing. The operator was told there was no
 * deployment while standing in one, and pointed at `install`, whose
 * precondition is the opposite.
 *
 * ⚠ RUNNING CONTAINERS ARE DELIBERATELY EXCLUDED from the predicate, despite
 * the sentence above. A deployment whose containers are stopped or wedged is
 * PRECISELY the one being updated or repaired, and consulting Docker would put
 * a subprocess on a path that must keep working when the daemon is down.
 *
 * ⚠ THE STATE FILE IS DELIBERATELY EXCLUDED. That is the whole lesson.
 *
 * ⚠ Both adoption and enumeration MUST import from here. When they each had
 * their own idea of what a deployment was, fixing one left a bare `update`
 * never reaching the other - so the adoption path was unreachable in exactly
 * the case it existed for. `deployment-evidence.test.ts` asserts the two
 * callers use the same function.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Where a deployment's configuration lives under the current layout. */
export function envPathFor(deployRoot: string): string {
  return join(deployRoot, '.env');
}

/**
 * Where a deployment installed by an earlier CLI keeps its configuration.
 *
 * Deployments in the field have `.env` inside the checkout, at
 * `repo/infra/compose/.env`, because that is where compose reads it from and
 * nothing had yet moved it out. They are real deployments and must be
 * recognised as such; refusing them would re-create the failure this module
 * exists to remove, on every server already running.
 */
export function legacyEnvPathFor(deployRoot: string): string {
  return join(deployRoot, 'repo', 'infra', 'compose', '.env');
}

/** A git checkout, by the one marker that does not require running git. */
export function hasGitCheckout(repoPath: string): boolean {
  return existsSync(join(repoPath, '.git'));
}

/** Readable, and a file rather than a directory. */
export function hasReadableEnvFile(deployRoot: string): boolean {
  return resolveEnvPath(deployRoot) !== undefined;
}

/**
 * The `.env` this deployment actually uses, current layout preferred.
 *
 * Returns `undefined` when there is none. A caller that needs to know WHICH of
 * the two it found - the migration in `install` does - gets it from the path.
 */
export function resolveEnvPath(deployRoot: string): string | undefined {
  for (const candidate of [envPathFor(deployRoot), legacyEnvPathFor(deployRoot)]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Absent, or unreadable by this user. Either way it is not the file.
    }
  }
  return undefined;
}

/**
 * THE predicate. Both, and only these two.
 *
 * Each is something the CLI creates and the pipeline needs, and neither is
 * inferable from the other.
 */
export function isDeployment(deployRoot: string): boolean {
  return hasGitCheckout(join(deployRoot, 'repo')) && hasReadableEnvFile(deployRoot);
}

/** Why a directory is not a deployment, for an operator-facing message. */
export function describeEvidence(deployRoot: string): {
  isDeployment: boolean;
  hasCheckout: boolean;
  hasEnv: boolean;
  envPath: string | undefined;
} {
  const hasCheckout = hasGitCheckout(join(deployRoot, 'repo'));
  const envPath = resolveEnvPath(deployRoot);

  return {
    isDeployment: hasCheckout && envPath !== undefined,
    hasCheckout,
    hasEnv: envPath !== undefined,
    envPath,
  };
}
