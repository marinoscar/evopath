import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { PreconditionError } from '../errors.js';
import type { runCommand } from './executor.js';
import type { DeployHooks } from './hooks.js';
import {
  CONTAINER_CERT_ROOT,
  CONTAINER_WEBROOT,
  assertValidContainerName,
  validateProxy,
  type ProxyRuntime,
} from './proxy.js';

// =============================================================================
// Bringing up the shared proxy on a box that has none  (issue #391, epic #388)
// =============================================================================
//
// The runbook promised that on the first application ever deployed to a box,
// "`install` bootstraps this for you". Nothing did: the proxy prerequisites
// simply failed. This keeps that promise -- and the one rule that makes the
// multi-app model work:
//
//   ⚠ AN EXISTING PROXY IS NEVER TOUCHED. It belongs to whichever application
//   got there first. So:
//     - a RUNNING proxy container          => nothing to do;
//     - a compose file in the proxy root   => not ours: no file is written, no
//       container is started, and the step fails with the command to start it;
//     - a STOPPED proxy container          => likewise: somebody stopped it,
//       possibly on purpose, and starting shared infrastructure on their
//       behalf is not this deployment's decision;
//   and only when there is NO container and NO compose file does it create one.
//
// Container mode only. A host-mode proxy is the host's nginx, installed and
// configured by the host; there is nothing here to bring up.
//
// =============================================================================
// ⚠ WHY `network_mode: host`, AND NOT A BRIDGE NETWORK WITH PORTS 80/443
// =============================================================================
//
// Every vhost this CLI writes proxies to `http://127.0.0.1:<bind port>`,
// because vps.compose.yml publishes each application on the HOST's loopback
// ONLY (that is the whole point of that file). In a bridged container,
// 127.0.0.1 is the container itself, and every site would answer 502. Host
// networking is the one topology in which the existing vhosts, the existing
// loopback-only bindings and a containerised proxy all agree -- so the
// container binds 80/443 directly on the host, and there is no `ports:` list
// (Compose rejects one alongside host networking).
//
// The application stack's own EXTERNAL network (declared `external: true` in
// the checkout's compose files) is still created when missing, because the
// stack cannot start without it -- but the proxy is not attached to it: it
// reaches applications over the host loopback, never over a docker network.
// =============================================================================

/** Filenames `docker compose` itself looks for, in its own order. */
export const PROXY_COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const;

/** The image the bootstrapped proxy runs. */
export const PROXY_IMAGE = 'nginx:alpine';

/** The default server, named to load first. */
export const DEFAULT_SERVER_CONF = '00-default.conf';

export type ProxyPresence =
  /** The proxy container is running: nothing to do. */
  | { state: 'running'; detail: string }
  /** A container by that name exists and is stopped. */
  | { state: 'stopped'; detail: string }
  /** No container, but a compose file says the root is somebody's. */
  | { state: 'configured'; composeFile: string; detail: string }
  /** No container and no compose file: bootstrappable. */
  | { state: 'absent'; detail: string }
  /** Docker could not answer. */
  | { state: 'unknown'; detail: string };

/** The compose file in `proxyRoot`, if any. */
export function proxyComposeFile(
  proxyRoot: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return PROXY_COMPOSE_FILES.map((name) => join(proxyRoot, name)).find((path) => exists(path));
}

/** Read-only: `docker inspect` and a stat. Never throws. */
export async function inspectProxy(options: {
  proxyRoot: string;
  runtime: ProxyRuntime;
  runCommand: typeof runCommand;
  exists?: ((path: string) => boolean) | undefined;
}): Promise<ProxyPresence> {
  const container = options.runtime.container;
  assertValidContainerName(container);

  try {
    const result = await options.runCommand(
      ['docker', 'inspect', '--type', 'container', '--format', '{{.State.Running}}', container],
      { cwd: process.cwd(), timeoutMs: 20_000 },
    );
    const running = result.stdout.trim().split('\n')[0]?.trim() === 'true';
    return running
      ? { state: 'running', detail: `${container} is running` }
      : { state: 'stopped', detail: `${container} exists but is not running` };
  } catch (error) {
    const failure = error as { result?: { stderr?: string } };
    const stderr = failure.result?.stderr ?? (error instanceof Error ? error.message : String(error));
    if (!/no such (container|object)/i.test(stderr)) {
      return { state: 'unknown', detail: `could not inspect ${container}: ${stderr.split('\n')[0] ?? ''}` };
    }
  }

  const composeFile = proxyComposeFile(options.proxyRoot, options.exists);
  if (composeFile !== undefined) {
    return {
      state: 'configured',
      composeFile,
      detail: `no container named ${container}, but ${composeFile} exists`,
    };
  }
  return { state: 'absent', detail: `no container named ${container} and no compose file in ${options.proxyRoot}` };
}

/**
 * The proxy's compose file. Pure and deterministic.
 *
 * Mounts match what everything else in this CLI assumes of a containerised
 * proxy: `./letsencrypt` at /etc/letsencrypt and `./webroot` at
 * /var/www/certbot (`certbotArgv`, `renderVhost`), and the vhost directory at
 * /etc/nginx/conf.d. All read-only: nginx only reads them.
 */
export function renderProxyCompose(runtime: ProxyRuntime): string {
  assertValidContainerName(runtime.container);
  return `# Managed by ${CLI_NAME} deploy: the shared reverse proxy for every application
# on this host, created by the first install. Other applications add their own
# vhosts to ./nginx/conf.d; none of them owns this file.
#
# network_mode: host -- vhosts proxy to 127.0.0.1:<port>, where each
# application binds on the host's loopback only. A bridged container would see
# its own loopback there instead, and every site would answer 502.
services:
  nginx:
    image: ${PROXY_IMAGE}
    container_name: ${runtime.container}
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - ./nginx/snippets:/etc/nginx/snippets:ro
      - ./letsencrypt:${CONTAINER_CERT_ROOT}:ro
      - ./webroot:${CONTAINER_WEBROOT}:ro
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
`;
}

/**
 * The default HTTP server: answers the ACME challenge for any name -- which is
 * what lets the FIRST certificate for a new domain be issued before its vhost
 * exists -- and drops everything else without a response.
 */
export function renderDefaultServer(): string {
  return `# Managed by ${CLI_NAME} deploy. The catch-all server for plain HTTP.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Every certificate on this host is issued with the webroot method, before
    # the domain has a vhost of its own -- so the challenge is served here.
    location /.well-known/acme-challenge/ {
        root ${CONTAINER_WEBROOT};
    }

    # Anything else for a name no vhost claims: close the connection.
    location / {
        return 444;
    }
}
`;
}

/**
 * Networks the application's compose files declare `external: true`, by the
 * name Docker knows them under (`name:` when given, else the key).
 *
 * A deliberately small line reader rather than a YAML dependency: it reads the
 * top-level `networks:` block only, which is all this needs.
 */
export function externalNetworks(composeText: string): string[] {
  const lines = composeText.split('\n');
  const found: string[] = [];
  let inNetworks = false;
  let entryIndent: number | undefined;
  let current: { key: string; name?: string; external: boolean } | undefined;

  const flush = (): void => {
    if (current?.external === true) found.push(current.name ?? current.key);
    current = undefined;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      flush();
      inNetworks = /^networks:\s*$/.test(line);
      entryIndent = undefined;
      continue;
    }
    if (!inNetworks) continue;

    const entry = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (entry === null) continue;
    const key = entry[1] as string;
    const value = (entry[2] ?? '').trim();

    entryIndent ??= indent;
    if (indent <= entryIndent) {
      flush();
      current = { key, external: false };
      continue;
    }
    if (current === undefined) continue;
    if (key === 'external' && /^(true|yes)$/i.test(value)) current.external = true;
    if (key === 'name' && value !== '') current.name = value.replace(/^["']|["']$/g, '');
  }
  flush();

  return [...new Set(found)].filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name));
}

/** External networks across the given compose files that exist on disk. */
export function externalNetworksIn(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const name of externalNetworks(text)) names.add(name);
  }
  return [...names];
}

/**
 * Makes sure every network the given compose files declare `external: true`
 * exists, creating the missing ones (#391 follow-up).
 *
 * ⚠ THE APPLICATION STACK NEEDS THESE BEFORE ITS FIRST `compose run`/`up`.
 * Compose refuses to instantiate a service attached to an external network
 * that does not exist ("network devnet declared as external, but could not be
 * found"), and on a fresh box nothing has created it yet -- the proxy
 * bootstrap, which also creates it, runs much later, just before `publish`.
 * Names come from the checkout's own compose files, never from this CLI.
 */
export async function ensureExternalNetworks(options: {
  composeFiles: readonly string[];
  runCommand: typeof runCommand;
  onLine?: ((line: string) => void) | undefined;
}): Promise<{ checked: string[]; created: string[] }> {
  const checked = externalNetworksIn(options.composeFiles);
  const created: string[] = [];
  for (const network of checked) {
    if (await ensureNetwork(network, options.runCommand)) {
      created.push(network);
      options.onLine?.(`Created docker network ${network}`);
    } else {
      options.onLine?.(`Docker network ${network} exists`);
    }
  }
  return { checked, created };
}

export interface BootstrapProxyOptions {
  proxyRoot: string;
  runtime: ProxyRuntime;
  runCommand: typeof runCommand;
  hooks?: DeployHooks | undefined;
  /** External docker networks the application stack needs; created if missing. */
  networks?: readonly string[] | undefined;
  /** Where to report, one line at a time. */
  onLine?: ((line: string) => void) | undefined;
}

export interface BootstrapProxyResult {
  /** Files and directories this call created. */
  created: string[];
  /** Networks this call created. */
  networksCreated: string[];
}

/** Writes a file only when absent. Never overwrites. Returns whether it wrote. */
function writeIfAbsent(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, { mode: 0o644, flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Creates `name` unless `docker network inspect` finds it. Idempotent.
 * Returns true when it created the network.
 */
export async function ensureNetwork(
  name: string,
  run: typeof runCommand,
): Promise<boolean> {
  try {
    await run(['docker', 'network', 'inspect', name], { cwd: process.cwd(), timeoutMs: 20_000 });
    return false;
  } catch {
    await run(['docker', 'network', 'create', name], { cwd: process.cwd(), timeoutMs: 60_000 });
    return true;
  }
}

/**
 * Creates the shared proxy. The CALLER must already have established that it
 * is `absent` (see `inspectProxy`) and obtained consent; this re-checks the
 * compose file anyway, because writing over one is the thing that must never
 * happen.
 */
export async function bootstrapProxy(options: BootstrapProxyOptions): Promise<BootstrapProxyResult> {
  const root = options.proxyRoot;
  const existing = proxyComposeFile(root);
  if (existing !== undefined) {
    throw new PreconditionError(
      `${existing} already exists, so the shared proxy is not this deployment's to create. ` +
        `Start it where it lives: cd ${root} && docker compose up -d`,
    );
  }

  const created: string[] = [];
  for (const dir of [
    join(root, 'nginx', 'conf.d'),
    join(root, 'nginx', 'snippets'),
    join(root, 'letsencrypt'),
    join(root, 'webroot'),
  ]) {
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    created.push(dir);
  }

  const defaultServer = join(root, 'nginx', 'conf.d', DEFAULT_SERVER_CONF);
  if (writeIfAbsent(defaultServer, renderDefaultServer())) created.push(defaultServer);

  // Last of the files, and `wx`: if anything raced us to it, we stop.
  const composePath = join(root, 'compose.yml');
  if (!writeIfAbsent(composePath, renderProxyCompose(options.runtime))) {
    throw new PreconditionError(`${composePath} appeared while bootstrapping; leaving it alone.`);
  }
  created.push(composePath);
  for (const path of created) options.onLine?.(`Created ${path}`);

  const networksCreated: string[] = [];
  for (const network of options.networks ?? []) {
    if (await ensureNetwork(network, options.runCommand)) {
      networksCreated.push(network);
      options.onLine?.(`Created docker network ${network}`);
    }
  }

  options.hooks?.onProgress?.(`Starting the shared proxy (${options.runtime.container})`);
  await options.runCommand(['docker', 'compose', 'up', '-d'], {
    cwd: root,
    timeoutMs: 10 * 60_000,
    ...(options.hooks?.onLog === undefined
      ? {}
      : { onLine: (line: string) => options.hooks?.onLog?.(line) }),
  });

  const validation = await validateProxy({ runCommand: options.runCommand, runtime: options.runtime });
  if (!validation.ok) {
    throw new PreconditionError(
      `The shared proxy started, but nginx -t fails in ${options.runtime.container}:\n${validation.output}`,
    );
  }

  return { created, networksCreated };
}
