/**
 * Where deployments live, and which one a command is acting on.
 *
 * The layout is `<apps-root>/<app-name>/`, with the apps root defaulting to
 * `/opt/infra/apps`. A single host runs several applications behind one shared
 * proxy, so "which app?" is a real question with a wrong answer available.
 *
 * ⚠ The resolution ranks below are ordered, and rank 3 is the one that matters.
 * Without it, an operator standing inside their own deployment on a host with
 * seven apps was told `Several apps are installed ... Pass --name` -- by a
 * command run from the directory the CLI's own error message had just left
 * them in. A helper that did the cwd walk already existed, with one caller.
 *
 * ⚠ The cwd walk and the enumeration MUST use the same deployment predicate.
 * If the walk required a state file while enumeration accepted evidence, the
 * walk would fail to find exactly the unrecorded deployment it exists to find.
 * Both import `isDeployment` from `deployment-evidence.ts`, and
 * `layout.test.ts` asserts it.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { UsageError } from '../errors.js';
import { isDeployment, resolveEnvPath } from './deployment-evidence.js';
import { readEnvFile } from './env-file.js';

export const DEFAULT_APPS_ROOT = '/opt/infra/apps';

/**
 * The marker identifying an `.env` THIS CLI wrote.
 *
 * ⚠ `COMPOSE_PROJECT_NAME` was rejected for this job: Docker Compose itself
 * defines that variable, so a neighbouring application's `.env` may carry it
 * legitimately and would be enumerated as ours. `DEPLOY_ROOT` is absent from
 * `.env.example` precisely so that a stranger's file cannot have it.
 *
 * ⚠ An honest limit: a neighbouring app that is a FORK OF THIS TEMPLATE is
 * deployed by this same CLI family and writes the same marker. Two forks on one
 * host are genuinely ambiguous and no marker can separate them. Rank 3 is what
 * actually resolves the operator's problem; this narrowing only excludes
 * genuinely foreign applications.
 */
export const DEPLOY_ROOT_MARKER = 'DEPLOY_ROOT';

export interface DeploymentEntry {
  name: string;
  deployRoot: string;
  /** True when the `.env` carries this CLI's own marker. */
  claimed: boolean;
}

export function deployRootFor(appsRoot: string, name: string): string {
  return join(appsRoot, name);
}

/**
 * Every deployment under an apps root.
 *
 * ⚠ The apps root may ITSELF be a deployment. Every deployment installed by an
 * earlier version of this CLI is exactly that: `--root` defaulted to the apps
 * root and the clone went straight into it. Enumerating its children in that
 * case offers `repo` and `logs` as candidate applications, which is nonsense.
 * So: if the root is a deployment, it is the sole entry and the children are
 * not walked.
 */
export function enumerateDeployments(appsRoot: string): DeploymentEntry[] {
  if (isDeployment(appsRoot)) {
    return [
      {
        name: basenameOf(appsRoot),
        deployRoot: appsRoot,
        claimed: carriesMarker(appsRoot),
      },
    ];
  }

  let names: string[];
  try {
    names = readdirSync(appsRoot);
  } catch {
    // No apps root yet is not an error: it is a host with nothing installed.
    return [];
  }

  const found: DeploymentEntry[] = [];
  for (const name of names.sort()) {
    const deployRoot = join(appsRoot, name);
    try {
      if (!statSync(deployRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!isDeployment(deployRoot)) continue;
    found.push({ name, deployRoot, claimed: carriesMarker(deployRoot) });
  }

  return found;
}

/** Whether this deployment's `.env` carries the CLI's own marker. */
function carriesMarker(deployRoot: string): boolean {
  const envPath = resolveEnvPath(deployRoot);
  if (envPath === undefined) return false;
  try {
    return readEnvFile(envPath).has(DEPLOY_ROOT_MARKER);
  } catch {
    return false;
  }
}

function basenameOf(path: string): string {
  const parts = resolve(path).split(/[\\/]/).filter((part) => part !== '');
  return parts.at(-1) ?? path;
}

export interface LocateOptions {
  /** Rank 1: an explicit path. */
  root?: string | undefined;
  /** Rank 2: an explicit name. */
  name?: string | undefined;
  appsRoot?: string | undefined;
  /** Rank 3 starts here. Defaults to the process's working directory. */
  cwd?: string | undefined;
}

export interface LocatedApp {
  name: string;
  deployRoot: string;
  appsRoot: string;
  /** Which rank answered, for the journal and for tests. */
  via: 'root' | 'name' | 'cwd' | 'sole';
}

/**
 * Resolves the deployment a command should act on.
 *
 * Five ranks, in this order:
 *   1. `--root <dir>`  - an explicit path. Not required to exist: `install`
 *                        legitimately names one that does not yet.
 *   2. `--name <app>`  - an explicit name. Still outranks cwd, so `--name
 *                        other` from inside `myapp/` means `other`.
 *   3. the deployment the cwd is standing in, walking up, bounded strictly
 *      inside the apps root.
 *   4. the sole installed deployment.
 *   5. refuse, NAMING the candidates.
 *
 * ⚠ Rank 5 refuses; it never PREFERS. Silently picking the recorded candidate
 * over the unrecorded one invents a tiebreak at the moment the operator most
 * needs to be asked.
 */
export function locateApp(options: LocateOptions = {}): LocatedApp {
  const appsRoot = resolve(options.appsRoot ?? DEFAULT_APPS_ROOT);

  if (options.root !== undefined) {
    const deployRoot = resolve(options.root);
    return {
      name: basenameOf(deployRoot),
      deployRoot,
      appsRoot: isAbsolute(options.root) ? dirname(deployRoot) : appsRoot,
      via: 'root',
    };
  }

  if (options.name !== undefined) {
    return {
      name: options.name,
      deployRoot: deployRootFor(appsRoot, options.name),
      appsRoot,
      via: 'name',
    };
  }

  const standing = deploymentContaining(options.cwd ?? process.cwd(), appsRoot);
  if (standing !== undefined) {
    return { name: basenameOf(standing), deployRoot: standing, appsRoot, via: 'cwd' };
  }

  const found = enumerateDeployments(appsRoot);

  if (found.length === 0) {
    throw new UsageError(
      `No deployment found under ${appsRoot}. Pass --root to point at one somewhere else, or run install first.`,
    );
  }

  if (found.length === 1) {
    const only = found[0] as DeploymentEntry;
    return { name: only.name, deployRoot: only.deployRoot, appsRoot, via: 'sole' };
  }

  // ⚠ AMBIGUITY REFUSES; IT NEVER PREFERS.
  //
  // The obvious move here is to narrow by the marker and, if that leaves one
  // candidate, take it. That is wrong, and quietly so: the marker's job is to
  // exclude GENUINELY FOREIGN applications, and it cannot distinguish "not
  // ours" from "ours, deployed before the marker existed". Every deployment
  // installed by an earlier CLI is unmarked. So narrowing would silently pick
  // the newer app over the operator's older one -- inventing a tiebreak at the
  // moment they most need to be asked, and doing it on the path `uninstall`
  // also uses.
  //
  // The marker is still worth reporting, because it tells the operator which
  // rows this CLI knows it wrote. It just does not get to decide.
  throw new UsageError(
    `Several deployments are installed under ${appsRoot}:\n` +
      found
        .map((entry) => `  - ${entry.name}${entry.claimed ? '' : '  (no deployment marker; deployed before this CLI wrote one)'}`)
        .join('\n') +
      `\nPass --name to choose one, or run this from inside the one you mean.`,
  );
}

/**
 * The deployment a directory is standing in, or `undefined`.
 *
 * ⚠ The walk is bounded STRICTLY inside the apps root. Letting it climb past
 * that found the parent infrastructure repository and tripped an unrelated
 * guard -- and guessing harder is the wrong answer to a bug caused by guessing.
 */
export function deploymentContaining(cwd: string, appsRoot: string): string | undefined {
  const root = resolve(appsRoot);
  let current = resolve(cwd);

  while (current.startsWith(root)) {
    if (isDeployment(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}
