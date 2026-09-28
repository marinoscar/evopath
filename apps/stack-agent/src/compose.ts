// =============================================================================
// Which compose project to act on, and how
// =============================================================================
//
// ZERO CONFIGURATION, BY DESIGN. The agent is told nothing about the
// deployment: no project name, no file list, no directory. It reads them off
// ITS OWN container, whose compose labels record exactly how `appctl deploy`
// started the stack:
//
//   com.docker.compose.project                -> -p
//   com.docker.compose.project.config_files   -> -f ... (comma-separated)
//   com.docker.compose.project.working_dir    -> cwd and --project-directory
//
// So the agent can only ever act on the project it is itself part of, with the
// files that project was started from. A client cannot name another one.
//
// ⚠ Compose resolves relative bind-mount sources to HOST paths and hands them
// to the daemon. The deployment directory is therefore mounted into this
// container at the IDENTICAL absolute path (see vps.compose.yml), so the paths
// in the labels are valid both here and on the host.
// =============================================================================

import { basename, dirname, isAbsolute, join } from 'node:path';

import type { CommandRunner } from './runner.js';

/** The two services this agent may deploy. Fixed; never client-supplied. */
export const TELEMETRY_SERVICES = ['greptimedb', 'otel-collector'] as const;
export type TelemetryService = (typeof TELEMETRY_SERVICES)[number];

export const LABEL_PROJECT = 'com.docker.compose.project';
export const LABEL_CONFIG_FILES = 'com.docker.compose.project.config_files';
export const LABEL_WORKING_DIR = 'com.docker.compose.project.working_dir';

export const TELEMETRY_FILE = 'telemetry.compose.yml';
export const VPS_FILE = 'vps.compose.yml';
export const VPS_TELEMETRY_FILE = 'vps.telemetry.compose.yml';

export interface ComposeTarget {
  project: string;
  workingDir: string;
  /** Absolute paths, in the order compose must apply them. */
  files: string[];
}

export class DiscoveryError extends Error {
  override readonly name = 'DiscoveryError';
}

/** Compose's own rule for project names. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Reads the target out of a container's labels. Throws a DiscoveryError when
 * the container was not started by compose, or the labels are not what compose
 * writes (a relative path, an empty list): refusing is better than guessing.
 */
export function parseLabels(labels: Readonly<Record<string, unknown>> | null): Omit<ComposeTarget, 'files'> & {
  configFiles: string[];
} {
  const project = labels?.[LABEL_PROJECT];
  const workingDir = labels?.[LABEL_WORKING_DIR];
  const configFiles = labels?.[LABEL_CONFIG_FILES];

  if (typeof project !== 'string' || !PROJECT_NAME.test(project)) {
    throw new DiscoveryError(`container has no usable ${LABEL_PROJECT} label`);
  }
  if (typeof workingDir !== 'string' || !isAbsolute(workingDir)) {
    throw new DiscoveryError(`container has no usable ${LABEL_WORKING_DIR} label`);
  }
  if (typeof configFiles !== 'string') {
    throw new DiscoveryError(`container has no usable ${LABEL_CONFIG_FILES} label`);
  }

  const files = configFiles
    .split(',')
    .map((file) => file.trim())
    .filter((file) => file !== '');
  if (files.length === 0) {
    throw new DiscoveryError(`container has no usable ${LABEL_CONFIG_FILES} label`);
  }
  for (const file of files) {
    if (!isAbsolute(file)) {
      throw new DiscoveryError(`${LABEL_CONFIG_FILES} holds a relative path`);
    }
  }
  return { project, workingDir, configFiles: files };
}

/**
 * The file list with the telemetry files added when they are missing from it
 * and present on disk, in the order apps/cli/src/deploy/compose-files.ts
 * documents as load-bearing:
 *
 *   base, prod, [telemetry], vps, [vps.telemetry]
 *
 * - telemetry.compose.yml ADDS the services, so it goes before the VPS files
 *   (and so inherits their hardening): just before vps.compose.yml, or at the
 *   end when that is absent.
 * - vps.telemetry.compose.yml hardens them, and goes last.
 *
 * A stack started before #567 lacks both, and without them compose does not
 * know `greptimedb` at all. The files come from the SAME directory as the
 * files already listed, never from anywhere a client could name.
 */
export function withTelemetryFiles(
  files: readonly string[],
  fileExists: (path: string) => boolean,
): string[] {
  const result = [...files];
  if (result.length === 0) return result;

  const has = (name: string): boolean => result.some((file) => basename(file) === name);
  const vps = result.find((file) => basename(file) === VPS_FILE);
  const directory = dirname(vps ?? (result[0] as string));

  const telemetry = join(directory, TELEMETRY_FILE);
  if (!has(TELEMETRY_FILE) && fileExists(telemetry)) {
    const before = result.findIndex(
      (file) => basename(file) === VPS_FILE || basename(file) === VPS_TELEMETRY_FILE,
    );
    if (before === -1) result.push(telemetry);
    else result.splice(before, 0, telemetry);
  }

  const vpsTelemetry = join(directory, VPS_TELEMETRY_FILE);
  if (!has(VPS_TELEMETRY_FILE) && fileExists(vpsTelemetry)) {
    result.push(vpsTelemetry);
  }
  return result;
}

/** A container id or name as Docker prints them; the only input to inspect. */
const CONTAINER_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export interface DiscoveryOptions {
  runner: CommandRunner;
  /** This container's id: `$HOSTNAME`, which Docker sets to the short id. */
  containerId: string | undefined;
  fileExists: (path: string) => boolean;
}

/**
 * Inspects this container once and remembers a SUCCESSFUL answer (labels do
 * not change for the life of a container). A failure is not cached, so a
 * transient daemon hiccup at startup does not disable the agent for ever. The
 * file list is re-checked against the disk on every call: a `git pull` that
 * adds a telemetry file must not need an agent restart.
 */
export function createDiscovery(options: DiscoveryOptions): () => Promise<ComposeTarget> {
  let cached: ReturnType<typeof parseLabels> | undefined;

  return async () => {
    if (cached === undefined) {
      const id = options.containerId;
      if (id === undefined || !CONTAINER_REF.test(id)) {
        throw new DiscoveryError('HOSTNAME is not a container id');
      }
      const result = await options.runner(
        ['docker', 'inspect', '--format', '{{json .Config.Labels}}', id],
        { timeoutMs: 30_000 },
      );
      if (result.exitCode !== 0) {
        throw new DiscoveryError(`docker inspect exited ${result.exitCode}`);
      }
      let labels: unknown;
      try {
        labels = JSON.parse(result.stdout.trim());
      } catch {
        throw new DiscoveryError('docker inspect did not print JSON');
      }
      cached = parseLabels(
        typeof labels === 'object' ? (labels as Record<string, unknown> | null) : null,
      );
    }
    return {
      project: cached.project,
      workingDir: cached.workingDir,
      files: withTelemetryFiles(cached.configFiles, options.fileExists),
    };
  };
}

/** `docker compose` with the project, directory and files pinned. */
export function composeBase(target: ComposeTarget): string[] {
  return [
    'docker',
    'compose',
    '--ansi',
    'never',
    '-p',
    target.project,
    '--project-directory',
    target.workingDir,
    ...target.files.flatMap((file) => ['-f', file]),
  ];
}

/**
 * `up -d` for the two telemetry services and whatever they depend on.
 *
 * - `--no-build`: both are pulled images; nothing here builds.
 * - Images are pulled when missing (compose's default `--pull missing`).
 * - No `--remove-orphans`: compose's default is not to, and this agent must
 *   never touch a container it was not asked about.
 * - Never `--verbose`: the output is returned to the caller.
 */
export function upArgv(target: ComposeTarget): string[] {
  return [...composeBase(target), 'up', '-d', '--no-build', ...TELEMETRY_SERVICES];
}

export function psArgv(target: ComposeTarget): string[] {
  return [...composeBase(target), 'ps', '--all', '--format', 'json', ...TELEMETRY_SERVICES];
}

export type ServiceHealth = 'healthy' | 'unhealthy' | 'starting' | null;

export interface ServiceStatus {
  name: TelemetryService;
  /**
   * Docker's container state (`running`, `restarting`, `exited`, `created`,
   * `paused`, `dead`, ...) or `missing` when the service has no container.
   */
  state: string;
  health: ServiceHealth;
}

const HEALTH = new Set(['healthy', 'unhealthy', 'starting']);

/**
 * Reads `compose ps --format json`. Compose prints either one JSON array or
 * one object per line depending on its version; both are accepted (the same
 * rule as apps/cli/src/deploy/health.ts).
 */
export function parsePs(stdout: string): ServiceStatus[] {
  const text = stdout.trim();
  let rows: unknown[] = [];
  if (text !== '') {
    rows = text.startsWith('[')
      ? (JSON.parse(text) as unknown[])
      : text
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as unknown);
  }

  return TELEMETRY_SERVICES.map((name) => {
    const row = rows.find(
      (entry) => (entry as Record<string, unknown> | null)?.['Service'] === name,
    ) as Record<string, unknown> | undefined;
    if (row === undefined) return { name, state: 'missing', health: null };

    const state = String(row['State'] ?? '').toLowerCase() || 'missing';
    const health = String(row['Health'] ?? '').toLowerCase();
    return {
      name,
      state,
      health: HEALTH.has(health) ? (health as Exclude<ServiceHealth, null>) : null,
    };
  });
}
