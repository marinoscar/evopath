import { readFileSync } from 'node:fs';
import * as nodeOs from 'node:os';

import type { runCommand as defaultRunCommand } from './executor.js';
import type { HostFacts } from './state.js';

// =============================================================================
// What machine is this deployment on  (issue #392)
// =============================================================================
//
// Collected ONCE per install/update and recorded in the deployment state and
// `deploy-info/info.json`, so the About page can say which host, OS, kernel
// and Docker it is running on without the API container -- which sees its OWN
// kernel namespace and none of the host's tooling -- having to guess.
//
// ⚠ NEVER THROWS. This is a description of the deployment, not part of it: a
// host with no /etc/os-release, a Docker CLI that answers oddly, or a probe
// that times out yields `null` for that one fact and nothing else changes.
// `null` means "not known", exactly as it does in info.json.
// =============================================================================

/** The `node:os` surface this reads, injectable so tests need no real host. */
export interface OsProbe {
  hostname(): string;
  type(): string;
  release(): string;
  arch(): string;
  cpus(): readonly unknown[];
  totalmem(): number;
}

export interface CollectHostFactsOptions {
  runCommand: typeof defaultRunCommand;
  /** Reads /etc/os-release. Defaults to the real file. */
  readFile?: ((path: string) => string) | undefined;
  now?: (() => Date) | undefined;
  os?: OsProbe | undefined;
}

export const OS_RELEASE_PATH = '/etc/os-release';

/** Long enough for any real version string; short enough to stop a runaway one. */
const MAX_FACT_LENGTH = 200;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, MAX_FACT_LENGTH);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Each probe is isolated: one that throws costs its own fact and no other. */
function attempt<T>(probe: () => T): T | null {
  try {
    return probe();
  } catch {
    return null;
  }
}

/** `PRETTY_NAME` from an os-release document, quotes removed; null when absent. */
export function prettyNameFrom(osRelease: string): string | null {
  for (const line of osRelease.split('\n')) {
    const match = /^\s*PRETTY_NAME\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const raw = (match[1] ?? '').trim();
    const unquoted = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw;
    return text(unquoted);
  }
  return null;
}

async function commandOutput(
  runCommand: typeof defaultRunCommand,
  argv: readonly string[],
): Promise<string | null> {
  try {
    const result = await runCommand(argv, { cwd: '/', timeoutMs: 15_000 });
    return result.exitCode === 0 ? text(result.stdout.split('\n')[0]) : null;
  } catch {
    return null;
  }
}

export async function collectHostFacts(options: CollectHostFactsOptions): Promise<HostFacts> {
  const os = options.os ?? nodeOs;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  const capturedAt = attempt(() => (options.now?.() ?? new Date()).toISOString());

  const [dockerVersion, composeVersion] = await Promise.all([
    commandOutput(options.runCommand, ['docker', 'version', '--format', '{{.Server.Version}}']),
    commandOutput(options.runCommand, ['docker', 'compose', 'version', '--short']),
  ]);

  return {
    hostname: attempt(() => text(os.hostname())),
    os:
      attempt(() => prettyNameFrom(readFile(OS_RELEASE_PATH))) ?? attempt(() => text(os.type())),
    kernel: attempt(() => text(os.release())),
    arch: attempt(() => text(os.arch())),
    cpus: attempt(() => positiveInteger(os.cpus().length)),
    memoryBytes: attempt(() => positiveInteger(os.totalmem())),
    dockerVersion,
    composeVersion,
    capturedAt,
  };
}
