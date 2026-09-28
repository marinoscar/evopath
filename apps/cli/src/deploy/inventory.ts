/**
 * `deploy list` - every deployment under the apps root.
 *
 * ⚠ FILESYSTEM ONLY. No git, no Docker, no network. The temptation is to run
 * `git rev-parse` per directory to fill in a commit the state file does not
 * carry, and that is exactly the wrong trade: it turns an inventory of a
 * seven-app host into fourteen subprocesses, and it fails differently for each
 * app depending on whether its checkout happens to be healthy. An unrecorded
 * deployment reports a NULL commit, which is the true answer to "what does the
 * record say?".
 *
 * Every field here therefore comes from one of two files already on disk: the
 * deployment record, or the `.env`.
 */
import { UsageError } from '../errors.js';
import { resolveEnvPath } from './deployment-evidence.js';
import { readEnvFile } from './env-file.js';
import { enumerateDeployments, DEFAULT_APPS_ROOT } from './layout.js';
import { readState } from './state.js';

export interface InventoryEntry {
  name: string;
  deployRoot: string;
  /** Null when no record exists; never filled in by running git. */
  commitSha: string | null;
  ref: string | null;
  domain: string | null;
  bindPort: number | null;
  lastDeployedAt: string | null;
  /**
   * Where these facts came from. `record` when a deployment record was read,
   * `inferred` when everything above was reconstructed from the `.env`.
   *
   * Surfaced rather than smoothed over: an operator deciding whether to trust
   * a row needs to know which of the two they are looking at, and an inferred
   * row is exactly the one an `update` will adopt.
   */
  source: 'record' | 'inferred' | 'unreadable';
  /** Set when the record exists but this build cannot interpret it. */
  problem?: string;
}

export interface InventoryOptions {
  appsRoot?: string | undefined;
}

export function collectInventory(options: InventoryOptions = {}): InventoryEntry[] {
  const appsRoot = options.appsRoot ?? DEFAULT_APPS_ROOT;

  return enumerateDeployments(appsRoot).map((entry) => {
    let state;
    try {
      state = readState(entry.deployRoot);
    } catch (error) {
      // ⚠ An unreadable record is NOT an unrecorded deployment. The file is
      // there and this build cannot interpret it, which is a different
      // problem, and a row that quietly showed it as "inferred" would hide it.
      return {
        name: entry.name,
        deployRoot: entry.deployRoot,
        commitSha: null,
        ref: null,
        domain: null,
        bindPort: null,
        lastDeployedAt: null,
        source: 'unreadable' as const,
        problem: (error as Error).message,
      };
    }

    if (state !== undefined) {
      return {
        name: entry.name,
        deployRoot: entry.deployRoot,
        commitSha: state.commitSha === '' ? null : state.commitSha,
        ref: state.ref === '' ? null : state.ref,
        domain: state.domain ?? null,
        bindPort: state.bindPort,
        lastDeployedAt: state.lastDeployedAt === '' ? null : state.lastDeployedAt,
        source: 'record' as const,
      };
    }

    const envPath = resolveEnvPath(entry.deployRoot);
    let env = new Map<string, string>();
    try {
      if (envPath !== undefined) env = readEnvFile(envPath);
    } catch {
      // A deployment whose `.env` became unreadable between the predicate and
      // here. Report the row rather than failing the whole inventory.
    }

    const port = Number(env.get('APP_BIND_PORT'));

    return {
      name: entry.name,
      deployRoot: entry.deployRoot,
      // Null, not a `git rev-parse`. See the header.
      commitSha: null,
      ref: null,
      domain: hostnameFrom(env.get('APP_URL')),
      bindPort: Number.isInteger(port) && port > 0 ? port : null,
      lastDeployedAt: null,
      source: 'inferred' as const,
    };
  });
}

function hostnameFrom(url: string | undefined): string | null {
  if (url === undefined || url === '') return null;
  try {
    const { hostname } = new URL(url);
    return hostname === '' ? null : hostname;
  } catch {
    return null;
  }
}

/** Human-readable table. `--json` callers get `collectInventory` directly. */
export function renderInventory(entries: readonly InventoryEntry[], appsRoot: string): string {
  if (entries.length === 0) {
    // Not phrased as a failure: a host with nothing installed is a normal host.
    return `No deployments found under ${appsRoot}.`;
  }

  const rows = entries.map((entry) => [
    entry.name,
    entry.commitSha === null ? '-' : entry.commitSha.slice(0, 12),
    entry.domain ?? '-',
    entry.bindPort === null ? '-' : String(entry.bindPort),
    entry.lastDeployedAt ?? '-',
    entry.source,
  ]);

  const headers = ['NAME', 'COMMIT', 'DOMAIN', 'PORT', 'LAST DEPLOY', 'SOURCE'];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] as string).length)),
  );

  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] as number)).join('  ').trimEnd();

  const out = [line(headers), ...rows.map(line)];

  const unreadable = entries.filter((entry) => entry.source === 'unreadable');
  for (const entry of unreadable) {
    out.push('', `${entry.name}: ${entry.problem ?? 'deployment record could not be read'}`);
  }

  return out.join('\n');
}

/** Guards a caller that requires at least one deployment. */
export function requireInventory(options: InventoryOptions = {}): InventoryEntry[] {
  const entries = collectInventory(options);
  if (entries.length === 0) {
    throw new UsageError(
      `No deployments found under ${options.appsRoot ?? DEFAULT_APPS_ROOT}.`,
    );
  }
  return entries;
}
