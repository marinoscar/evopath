// =============================================================================
// `deploy-info/info.json` — the document the deploy CLI leaves behind (issue
// #401, epic #397)
// =============================================================================
//
// `appctl deploy install|update` writes this file into the deploy root and the
// compose file bind-mounts it READ-ONLY into the api container. Nothing in this
// application writes it, and nothing in this application may fetch, refresh or
// verify it: it is a note left by the process that put this container here, and
// the whole value of that note is that it describes what was actually deployed
// rather than what this process believes about itself.
//
// -----------------------------------------------------------------------------
// ⚠ EVERY DEPLOYMENT IN EXISTENCE TODAY IS MISSING THIS FILE
// -----------------------------------------------------------------------------
//
// The CLI half lands in a later issue, so on the day this ships the file is
// absent EVERYWHERE — every developer machine, every CI job, every currently
// running container. `absent` is therefore the ORDINARY case and not an error
// case, and it is the one the reader below is designed around: a missing file
// answers `absent` with no log line, no exception and no partial document.
//
// -----------------------------------------------------------------------------
// ⚠ `schema` IS THE ONLY FIELD VALIDATED STRICTLY, AND THE NUMBER NEVER MOVES
// -----------------------------------------------------------------------------
//
// See `DEPLOY_INFO_SCHEMA_VERSION` below, which carries the full argument. Every
// OTHER field is read leniently: a missing, mistyped or unrecognised value
// becomes `null` (or is dropped from a list) and the document as a whole stays
// `ok`. That asymmetry is deliberate. The reader and the writer are two
// separately-versioned programs on the same disk, and the writer is the one
// that gets upgraded first — a reader that rejected a document for carrying a
// field it had not heard of would report `invalid` for a file that is, in fact,
// perfectly correct and freshly written.
// =============================================================================

import { readFile } from 'fs/promises';

import { DEPLOY_INFO_STATUSES } from './deploy-info.constants';

/**
 * The ONE value `schema` may hold, and the one field checked strictly.
 *
 * ⚠ DO NOT BUMP THIS TO ADD AN OPTIONAL FIELD. EVER.
 *
 * The ordering of a deploy makes that a guaranteed outage of this endpoint
 * rather than a risk of one. `appctl deploy update` writes `info.json` and THEN
 * brings containers up; more to the point, an operator running a newer CLI
 * against a deployment whose image has not been rebuilt has a NEW file being
 * read by an OLD api. If a new optional field came with `schema: 2`, every
 * already-deployed API in the world would begin answering `invalid` the instant
 * the new CLI wrote its file — immediately, before the container it describes
 * has necessarily restarted, and for a document that is not malformed in any
 * way. The operator would be told their deployment information is corrupt at
 * exactly the moment they most need it to be readable.
 *
 * Additive change needs no version bump, because this reader is lenient about
 * everything else: an unknown field is ignored, a missing one reads `null`. The
 * number exists to catch a document that is a DIFFERENT DOCUMENT — a file whose
 * fields mean something else than they do here — and that is the only change
 * that may ever move it. Such a change also requires every reader to be
 * upgraded before any writer, which is the cost the number is there to make
 * visible.
 */
export const DEPLOY_INFO_SCHEMA_VERSION = 1;

/**
 * Where the container's bind mount lands, and the default when
 * `DEPLOY_INFO_PATH` is unset.
 */
export const DEFAULT_DEPLOY_INFO_PATH = '/app/deploy-info/info.json';

/** Resolves the path to read, per call — see `readDeployInfo`'s note on caching. */
export function resolveDeployInfoPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.DEPLOY_INFO_PATH?.trim();

  return configured && configured.length > 0 ? configured : DEFAULT_DEPLOY_INFO_PATH;
}

/**
 * Whether the document could be read.
 *
 * Note what is NOT on this axis: a document that read cleanly but describes a
 * FAILED deploy run is `ok`. The run's own outcome is a separate fact carried
 * by `run`, because a run that got far enough to write this file did deploy
 * something, and reporting the file as broken would hide every fact in it from
 * the one operator who needs them.
 */
export type DeployInfoStatus = (typeof DEPLOY_INFO_STATUSES)[number];

/** `run.outcome`, or `null` when the file carried something unrecognised. */
export type DeployRunOutcome = 'success' | 'failure';

export interface DeployInfoApp {
  name: string | null;
  version: string | null;
  commitSha: string | null;
  ref: string | null;
}

export interface DeployInfoDeployedBy {
  cli: string | null;
  version: string | null;
}

export interface DeployInfoRemote {
  commitsBehind: number | null;
  checkedAt: string | null;
}

export interface DeployInfoRun {
  completed: string[];
  failedStep: string | null;
  outcome: DeployRunOutcome | null;
}

// --- Issue #392: additive fields. `schema` stays 1 — see DEPLOY_INFO_SCHEMA_VERSION. ---

/** Which `appctl deploy` subcommand last wrote the document. */
export type DeployCommand = 'install' | 'update';

/** How TLS is terminated in front of this deployment. */
export type DeployProxyMode = 'container' | 'host';

export interface DeployInfoProxy {
  mode: DeployProxyMode | null;
  /** The proxy container's name, when `mode` is `'container'`. */
  container: string | null;
  /** ISO-8601; as observed by the CLI when it wrote the file, never re-probed. */
  certificateExpiresAt: string | null;
}

/** Facts about the machine, captured by the CLI at `capturedAt` — never live. */
export interface DeployInfoHost {
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  arch: string | null;
  cpus: number | null;
  memoryBytes: number | null;
  dockerVersion: string | null;
  composeVersion: string | null;
  capturedAt: string | null;
}

/** One successful deploy run. The history is success-only by contract. */
export interface DeployInfoHistoryEntry {
  /** ISO-8601 finish time. Required: an entry without one is dropped. */
  at: string;
  command: DeployCommand;
  commitSha: string | null;
  previousCommitSha: string | null;
  ref: string | null;
  durationMs: number | null;
  cliVersion: string | null;
  outcome: 'success';
}

/** The most history entries ever surfaced, whatever the file carries. */
export const DEPLOY_INFO_HISTORY_LIMIT = 20;

export interface DeployInfoDocument {
  app: DeployInfoApp;
  installedAt: string | null;
  updatedAt: string | null;
  deployedBy: DeployInfoDeployedBy | null;
  domain: string | null;
  remote: DeployInfoRemote | null;
  run: DeployInfoRun | null;
  lastCommand: DeployCommand | null;
  bindPort: number | null;
  proxy: DeployInfoProxy | null;
  host: DeployInfoHost | null;
  /** Newest first, at most `DEPLOY_INFO_HISTORY_LIMIT`; `[]` when the file has none. */
  history: DeployInfoHistoryEntry[];
}

export interface DeployInfoReadResult {
  status: DeployInfoStatus;
  /** The absolute path that was read, reported whatever the outcome. */
  path: string;
  /** Why the document is `invalid`; `null` for `ok` and for `absent`. */
  error: string | null;
  /** Present exactly when `status` is `ok`. */
  document: DeployInfoDocument | null;
}

/**
 * Reads and parses the deploy document.
 *
 * ⚠ READS FROM DISK ON EVERY CALL, AND CACHES NOTHING. `appctl deploy update`
 * rewrites this file in place without restarting the container — that is the
 * point of the bind mount — so a cached parse would serve a stale commit SHA
 * for as long as the process lives, which is precisely the question this
 * endpoint exists to answer. The file is a few hundred bytes on a local mount.
 *
 * ⚠ NEVER THROWS, AND NEVER PERFORMS NETWORK I/O. Every failure mode is one of
 * the three statuses. In particular `remote` is copied out of the file as-is:
 * this reader does not contact the deploy remote, run git, or refresh anything.
 */
export async function readDeployInfo(path: string): Promise<DeployInfoReadResult> {
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;

    // ENOENT: nothing at that path. ENOTDIR: a path component is a file, so
    // nothing can be at that path either. Both are "no document here", which is
    // the shipped state of every environment until the CLI half lands.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'absent', path, error: null, document: null };
    }

    // Anything else — EACCES on a mis-permissioned mount, EISDIR when the bind
    // mount landed a directory where a file was expected — means SOMETHING is
    // there and it could not be read. That is not the same as absent, and
    // flattening the two would tell an operator to create a file that exists.
    return {
      status: 'invalid',
      path,
      error: `Could not read the deploy information file (${code ?? 'unknown error'}).`,
      document: null,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: 'invalid',
      path,
      error: 'The deploy information file is not valid JSON.',
      document: null,
    };
  }

  if (!isRecord(parsed)) {
    return {
      status: 'invalid',
      path,
      error: 'The deploy information file does not contain a JSON object.',
      document: null,
    };
  }

  // THE ONE STRICT CHECK. See `DEPLOY_INFO_SCHEMA_VERSION`.
  if (parsed.schema !== DEPLOY_INFO_SCHEMA_VERSION) {
    return {
      status: 'invalid',
      path,
      error:
        `The deploy information file declares schema ${describeSchema(parsed.schema)}; ` +
        `this API reads schema ${DEPLOY_INFO_SCHEMA_VERSION}.`,
      document: null,
    };
  }

  return {
    status: 'ok',
    path,
    error: null,
    document: {
      app: readApp(parsed.app),
      installedAt: readString(parsed.installedAt),
      updatedAt: readString(parsed.updatedAt),
      deployedBy: readDeployedBy(parsed.deployedBy),
      domain: readString(parsed.domain),
      remote: readRemote(parsed.remote),
      run: readRun(parsed.run),
      lastCommand: readCommand(parsed.lastCommand),
      bindPort: readPort(parsed.bindPort),
      proxy: readProxy(parsed.proxy),
      host: readHost(parsed.host),
      history: readHistory(parsed.history),
    },
  };
}

// -----------------------------------------------------------------------------
// Lenient readers
// -----------------------------------------------------------------------------
//
// ⚠ `null` IS THE ANSWER FOR ANYTHING NOT ON DISK, and nothing below ever
// substitutes a plausible-looking stand-in. No `new Date()` for a missing
// timestamp, no `''` for a missing name, no `0` for a missing commit count.
// Those are not defaults, they are fabrications: an `installedAt` of "now" says
// this deployment was installed the moment somebody opened the page, which is
// both false and unfalsifiable from the client's side. A `null` says the disk
// does not carry this, which is true and which the client can render honestly.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function describeSchema(value: unknown): string {
  if (value === undefined) return 'no version';

  return typeof value === 'number' || typeof value === 'string'
    ? JSON.stringify(value)
    : 'an unreadable version';
}

function readApp(value: unknown): DeployInfoApp {
  const record = isRecord(value) ? value : {};

  return {
    name: readString(record.name),
    version: readString(record.version),
    commitSha: readString(record.commitSha),
    ref: readString(record.ref),
  };
}

function readDeployedBy(value: unknown): DeployInfoDeployedBy | null {
  if (!isRecord(value)) return null;

  return { cli: readString(value.cli), version: readString(value.version) };
}

function readRemote(value: unknown): DeployInfoRemote | null {
  // `remote: null` is a documented value — it means nobody has checked yet, not
  // that the deployment is up to date. Preserved as `null` rather than being
  // turned into `{ commitsBehind: 0 }`, which would assert the opposite.
  if (!isRecord(value)) return null;

  return {
    commitsBehind: readNumber(value.commitsBehind),
    checkedAt: readString(value.checkedAt),
  };
}

function readRun(value: unknown): DeployInfoRun | null {
  if (!isRecord(value)) return null;

  const completed = Array.isArray(value.completed)
    ? value.completed.filter((step): step is string => typeof step === 'string')
    : [];

  const outcome = value.outcome;

  return {
    completed,
    failedStep: readString(value.failedStep),
    // An unrecognised outcome reads `null` rather than making the document
    // `invalid` — see this file's header on why only `schema` is strict.
    outcome: outcome === 'success' || outcome === 'failure' ? outcome : null,
  };
}

// -----------------------------------------------------------------------------
// Issue #392 additions — same leniency rules as everything above
// -----------------------------------------------------------------------------

/**
 * A string that parses as a date, or `null`.
 *
 * Deliberately loose (anything `Date.parse` accepts): the writer emits
 * `toISOString()`, and this only has to stop obvious garbage reaching a client
 * that will try to render it as a date. The ORIGINAL string is returned, never
 * a re-serialisation, so what the disk said is what the client sees.
 */
function readTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;

  return Number.isNaN(Date.parse(value)) ? null : value;
}

function readInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function readNonNegative(value: unknown): number | null {
  const number = readNumber(value);

  return number !== null && number >= 0 ? number : null;
}

function readCommand(value: unknown): DeployCommand | null {
  return value === 'install' || value === 'update' ? value : null;
}

function readPort(value: unknown): number | null {
  return readInteger(value, 1, 65535);
}

function readProxy(value: unknown): DeployInfoProxy | null {
  if (!isRecord(value)) return null;

  const mode = value.mode;

  return {
    mode: mode === 'container' || mode === 'host' ? mode : null,
    container: readString(value.container),
    certificateExpiresAt: readTimestamp(value.certificateExpiresAt),
  };
}

function readHost(value: unknown): DeployInfoHost | null {
  if (!isRecord(value)) return null;

  return {
    hostname: readString(value.hostname),
    os: readString(value.os),
    kernel: readString(value.kernel),
    arch: readString(value.arch),
    cpus: readInteger(value.cpus, 1),
    memoryBytes: readInteger(value.memoryBytes, 0),
    dockerVersion: readString(value.dockerVersion),
    composeVersion: readString(value.composeVersion),
    capturedAt: readTimestamp(value.capturedAt),
  };
}

/**
 * The success-only deploy history, newest first as the writer orders it.
 *
 * An entry is DROPPED — not nulled — when it lacks the three facts that make
 * it an entry at all: a parseable `at`, a recognised `command`, and
 * `outcome: 'success'` (the history is success-only by contract, so anything
 * else is not a history entry this reader understands). Every other sub-field
 * degrades to `null` like the rest of the document. The list is capped AFTER
 * filtering, so an invalid entry never costs a valid one its place.
 */
function readHistory(value: unknown): DeployInfoHistoryEntry[] {
  if (!Array.isArray(value)) return [];

  const entries: DeployInfoHistoryEntry[] = [];

  for (const item of value) {
    if (entries.length >= DEPLOY_INFO_HISTORY_LIMIT) break;
    if (!isRecord(item)) continue;

    const at = readTimestamp(item.at);
    const command = readCommand(item.command);

    if (at === null || command === null || item.outcome !== 'success') continue;

    entries.push({
      at,
      command,
      commitSha: readString(item.commitSha),
      previousCommitSha: readString(item.previousCommitSha),
      ref: readString(item.ref),
      durationMs: readNonNegative(item.durationMs),
      cliVersion: readString(item.cliVersion),
      outcome: 'success',
    });
  }

  return entries;
}
