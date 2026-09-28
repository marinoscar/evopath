import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { CliError, EXIT, type ExitCode } from '../errors.js';

// =============================================================================
// What is deployed here  (issue #173, epic #168)
// =============================================================================
//
// `update` has to answer three questions before it does anything: is anything
// installed, where, and at which commit. `status` needs the same. This file is
// where the answer lives.
//
// IT IS NOT IN ~/.appctl/config.json, AND THAT IS NOT A STYLE CHOICE.
// `writeConfigFile` copies an ALLOW-LIST of fields and drops everything else on
// every write (see config.ts). Deploy state placed there would survive until
// the next `appctl login` and then vanish, turning a working deployment into
// one the CLI believes was never installed. Its own file, next to the
// deployment it describes, also means the state travels with the server rather
// than with whichever operator's home directory happened to run the install.
// =============================================================================

/**
 * Bumped only when a field changes meaning; unknown versions are refused.
 *
 * ⚠ 2 SINCE ISSUE #392, AND EVERY OLDER VERSION IS UPGRADED FORWARD, NEVER
 * REFUSED. A bump alone would make this CLI refuse every state file already on
 * a live server; `upgradeState` is the migration path that makes the bump
 * safe, and every version this CLI ever wrote must keep a branch in it.
 *
 * The one direction that cannot be helped is backwards: once a v2 file is
 * written, an OLDER appctl refuses it with its own "upgrade appctl" message,
 * which is the refusal this rule exists for.
 */
export const DEPLOY_STATE_VERSION = 2;

/** How many successful runs `history` keeps, newest first. */
export const DEPLOY_HISTORY_LIMIT = 20;

export const DEPLOY_STATE_FILENAME = '.appctl-deploy.json';

/**
 * The machine a deployment runs on, as last observed by a successful run.
 *
 * Every field is `null` when it could not be determined -- see
 * `collectHostFacts`, which never throws. Nothing here is a secret.
 */
export interface HostFacts {
  hostname: string | null;
  /** `PRETTY_NAME` from /etc/os-release, else `os.type()`. */
  os: string | null;
  /** `os.release()`. */
  kernel: string | null;
  arch: string | null;
  cpus: number | null;
  memoryBytes: number | null;
  dockerVersion: string | null;
  composeVersion: string | null;
  capturedAt: string | null;
}

/**
 * One SUCCESSFUL install or update.
 *
 * ⚠ SUCCESS-ONLY, by construction rather than by filtering: an entry is
 * appended only on the success path, so a failed run leaves the list exactly
 * as it found it. `lastOutcome`/`lastFailedStep` are where failures live.
 */
export interface DeploymentHistoryEntry {
  /** ISO-8601 finish time. */
  at: string;
  command: 'install' | 'update';
  commitSha: string | null;
  /** What this run replaced; null for a first install. */
  previousCommitSha: string | null;
  ref: string | null;
  durationMs: number | null;
  cliVersion: string | null;
  outcome: 'success';
}

/** How this deployment is published, as last observed by a successful run. */
export interface DeployProxyFacts {
  domain: string | null;
  bindPort: number | null;
  mode: 'container' | 'host' | null;
  container: string | null;
  /** ISO-8601, read from the certificate itself; null with no domain or no readable cert. */
  certificateExpiresAt: string | null;
}

export interface DeployState {
  version: typeof DEPLOY_STATE_VERSION;
  /** Resolved from the checkout's own origin; never hardcoded. See #179. */
  repoUrl: string;
  /** Branch, tag or SHA that was requested. */
  ref: string;
  /** The commit actually deployed. */
  commitSha: string;
  /** Public hostname the shared proxy serves this under, if published. */
  domain?: string | undefined;
  /** Loopback port the proxy forwards to. */
  bindPort: number;
  deployRoot: string;
  installedAt: string;
  lastDeployedAt: string;
  lastCommand: 'install' | 'update';
  /** Which appctl wrote this, for diagnosing a state file from the future. */
  appctlVersion: string;
  /** The revision this replaced, for a manual roll-back. */
  previousSha?: string | undefined;
  /**
   * The shared reverse-proxy root this deployment's vhost was written into.
   *
   * Recorded because it cannot be re-derived: a deployment installed with a
   * non-default `--proxy-root` was silently rewritten to
   * `<deployRoot>/../../proxy` on every update, putting the vhost somewhere the
   * proxy does not read.
   */
  proxyRoot?: string | undefined;
  /**
   * How the shared proxy ran when this deployment last published through it:
   * `container` (nginx in a container, certbot dockerised) or `host`.
   *
   * Recorded so `update`, `certs` and `uninstall` act under the SAME runtime
   * install detected or was told, rather than re-detecting on a server whose
   * proxy happens to be stopped at that moment. A flag still overrides it.
   * Absent means "not recorded" -- the reader detects, as install did.
   *
   * Optional, and ⚠ the state version is deliberately NOT bumped for it (a
   * later issue does that deliberately): a bump makes this CLI refuse every
   * state file already on a live server.
   */
  proxyMode?: 'container' | 'host' | undefined;
  /** The proxy container's name, alongside `proxyMode`. Same rules. */
  proxyContainer?: string | undefined;
  /**
   * The Docker Compose project this deployment's containers live under.
   *
   * ⚠ Recorded, never derived. Naming an existing deployment's project renames
   * it, and Compose then sees no existing containers and builds a parallel
   * stack that collides with the old one on the bind port. Absent means
   * `compose` -- the directory-derived default every deployment in the field is
   * already running under -- so an adopted deployment keeps working untouched
   * and only a fresh install gets a name of its own.
   */
  composeProject?: string | undefined;
  /**
   * When this record was rebuilt from the deployment itself, because none was
   * found. A THIRD axis, deliberately separate from `installedAt` and
   * `lastDeployedAt`: an adopted deployment has certainly deployed, but
   * nothing on disk says when, and a fabricated instant is worse than an
   * honest gap. Its presence is what lets a reader tell "adopted, earlier
   * history unknown" from "installed then, last deployed then".
   */
  adoptedAt?: string | undefined;
  /**
   * Feature groups this deployment runs with.
   *
   * `observability` is always on (#567) and is written into every record
   * install and update produce; a record from before that lacks it and gets
   * it on the next update (`effectiveGroups` in compose-files.ts). The other
   * groups are opt-in.
   *
   * Recorded because it CANNOT be inferred later. Nothing in a `.env`
   * distinguishes `OTEL_ENABLED=true` from `OTEL_ENABLED=false` - both are
   * merely PRESENT - so an update that guessed would write a group's
   * placeholder defaults into a live deployment. Absent means no opt-in
   * group, which is the correct reading for every state file written before
   * this field existed.
   *
   * Optional, and the state version is deliberately NOT bumped for it: a bump
   * makes this CLI refuse every state file already sitting on a live server.
   */
  groups?: string[] | undefined;
  /**
   * Step ids that completed, so `--resume` can skip them.
   *
   * A rerun after a fixed database password should not rebuild images.
   */
  completedSteps?: string[] | undefined;
  /**
   * How the last run ended.
   *
   * ⚠ READ AS `=== 'failure'`, NEVER `!== 'success'`. Every state file written
   * before this field existed has it ABSENT, and those runs all succeeded --
   * that is the only way they came to be written at all. A negated test would
   * classify every deployment in the field as a failed one, and `--resume`
   * would then skip steps against a deployment that is serving.
   *
   * Optional, and ⚠ the state version is deliberately NOT bumped for it: a
   * bump makes this CLI refuse every state file already on a live server.
   */
  lastOutcome?: 'success' | 'failure' | undefined;
  /** The step that failed, named so the operator is told where to look. */
  lastFailedStep?: string | undefined;
  /**
   * When a run was last ATTEMPTED, as distinct from when one last succeeded.
   *
   * `lastDeployedAt` answers "what is running"; this answers "what was tried".
   * Collapsing them would report a failed attempt as a deployment.
   */
  lastAttemptAt?: string | undefined;
  /** The host as last observed by a successful run (v2, issue #392). */
  host?: HostFacts | undefined;
  /**
   * Successful runs, NEWEST FIRST, capped at `DEPLOY_HISTORY_LIMIT`.
   * Appended only on success -- see `appendHistory`. (v2, issue #392.)
   */
  history?: DeploymentHistoryEntry[] | undefined;
  /** The published proxy as last observed by a successful run (v2, issue #392). */
  proxy?: DeployProxyFacts | undefined;
}

/**
 * Nothing is installed at this path.
 *
 * EXIT.USAGE: the command was pointed somewhere it cannot work, and the remedy
 * is to run a different command. #178 introduces EXIT.PRECONDITION for a failed
 * doctor check, which is a different condition - the server is not ready, as
 * opposed to the operator asking for the wrong thing - and this deliberately
 * does not borrow it.
 */
export class NotInstalledError extends CliError {
  readonly exitCode: ExitCode = EXIT.USAGE;
}

/** The file exists but this build cannot safely interpret it. */
export class DeployStateError extends CliError {
  readonly exitCode: ExitCode = EXIT.FAILURE;
}

export function deployStatePath(deployRoot: string): string {
  return join(deployRoot, DEPLOY_STATE_FILENAME);
}

/** Returns undefined when nothing is installed; throws when it is unreadable. */
export function readState(deployRoot: string): DeployState | undefined {
  const path = deployStatePath(deployRoot);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new DeployStateError(
      `Cannot read ${path}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DeployStateError(
      `${path} is not valid JSON. It may have been edited by hand or a previous run may have been interrupted.`,
      { cause: error },
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new DeployStateError(`${path} does not contain a deployment record.`);
  }

  return upgradeState(parsed, path);
}

/**
 * Brings a parsed state record of ANY version this CLI ever wrote up to
 * `DEPLOY_STATE_VERSION`. Pure: it reads nothing and writes nothing, so a
 * read-only command (`status`) never rewrites the file; the next `writeState`
 * persists the upgraded shape.
 *
 * - v1 -> v2: adds an empty `history`. `host` and `proxy` stay ABSENT rather
 *   than being fabricated -- nothing observed them yet, and the next
 *   successful run fills them in.
 * - anything else (a newer appctl, a hand edit) is REFUSED rather than
 *   guessed: misreading a state file means updating the wrong checkout or
 *   reporting the wrong commit as deployed.
 */
export function upgradeState(raw: unknown, source = 'the deployment record'): DeployState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DeployStateError(`${source} does not contain a deployment record.`);
  }

  const version = (raw as { version?: unknown }).version;

  if (version === DEPLOY_STATE_VERSION) {
    return raw as DeployState;
  }

  if (version === 1) {
    return {
      ...(raw as Omit<DeployState, 'version'>),
      version: DEPLOY_STATE_VERSION,
      history: [],
    } as DeployState;
  }

  throw new DeployStateError(
    `${source} has state version ${String(version)}, but this ${CLI_NAME} understands up to ${DEPLOY_STATE_VERSION}. Upgrade ${CLI_NAME}, or remove the file to re-install.`,
  );
}

/**
 * Prepends one successful run to a history, newest first, capped.
 *
 * Pure, and the ONLY way an entry is added, so the cap and the order are
 * enforced in one place. Called only from the success paths of install and
 * update; a failed run never reaches it and so keeps the prior list intact.
 */
export function appendHistory(
  history: readonly DeploymentHistoryEntry[] | undefined,
  entry: DeploymentHistoryEntry,
  limit: number = DEPLOY_HISTORY_LIMIT,
): DeploymentHistoryEntry[] {
  return [entry, ...(history ?? [])].slice(0, limit);
}

/** Reads the state, or explains that there is nothing here to act on. */
export function requireState(deployRoot: string): DeployState {
  const state = readState(deployRoot);
  if (state === undefined) {
    throw new NotInstalledError(
      `No deployment found at ${deployRoot}. Run \`${CLI_NAME} deploy install\` first, or pass --root if it is somewhere else.`,
    );
  }
  return state;
}

/**
 * Writes the state atomically, 0600.
 *
 * The temp-file-then-rename dance is copied from `writeConfigFile`, whose long
 * comment explains why: a plain `writeFileSync(path, data, { mode })` applies
 * the mode ONLY when it creates the file, so rewriting an existing one silently
 * keeps whatever permissions it already had. `flag: 'wx'` makes the temp file's
 * creation - and therefore its mode - unambiguous, and the rename is atomic, so
 * an interrupted write cannot leave a half-written state file behind.
 */
export function writeState(state: DeployState): string {
  const path = deployStatePath(state.deployRoot);
  const temporary = `${path}.${process.pid}.tmp`;

  mkdirSync(state.deployRoot, { recursive: true });

  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new DeployStateError(
      `Cannot write ${path}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  return path;
}
