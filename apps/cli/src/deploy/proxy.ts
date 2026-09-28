import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { UsageError } from '../errors.js';
import type { runCommand } from './executor.js';
import type { DeployHooks } from './hooks.js';

// =============================================================================
// Publishing the app through the shared proxy  (issue #181, epic #168)
// =============================================================================
//
// The application stack terminates no TLS and, behind vps.compose.yml, binds
// 127.0.0.1 only - it is not reachable from outside the server at all. This
// module is what publishes it on https://<domain>.
//
// THE PROXY IS SHARED, AND THAT IS THE WHOLE DIFFICULTY. A malformed vhost
// written here does not break one application; it breaks `nginx -t` for the
// entire server, and the next reload takes every site down with it. So:
//
//   - The certificate is issued BEFORE the vhost is written. A vhost naming an
//     ssl_certificate that does not exist FAILS nginx -t, which would leave
//     the shared proxy unable to reload for anybody.
//   - The vhost is validated before it is used, and REMOVED AND RE-VALIDATED
//     if validation fails, restoring whatever it overwrote.
//   - Reload, never restart. A restart drops connections for every other
//     application on the box.
//   - A vhost this tool did not write is never touched.
//
// =============================================================================
// ⚠ TWO KINDS OF PATH, AND CONFLATING THEM IS A BUG WE HAVE ALREADY SHIPPED
// =============================================================================
//
// Every certificate and webroot path exists TWICE: once as the HOST sees it
// (`<proxyRoot>/letsencrypt/...`, `<proxyRoot>/webroot`) and once as NGINX sees
// it. When the proxy runs on the host those are the same string. When it runs
// in a container -- the documented target architecture: one long-lived nginx
// container fronting every application, with `./letsencrypt` mounted at
// `/etc/letsencrypt` and `./webroot` at `/var/www/certbot` -- they are not, and
// a host path written into the vhost names a file that does not exist inside
// the container. `nginx -t` then fails for every site on the box.
//
//   - `livePath(target, file)` is the HOST accessor. It is what this process
//     stats and what openssl reads: `certificateStatus`, `certificateExpiry`
//     and the TLS doctor checks legitimately use it.
//   - `configLivePath(runtime, domain, file)` and `runtime.webroot` are the
//     CONFIG accessors: what goes INTO an nginx config. `renderVhost` uses
//     these and nothing else.
//
// The same split applies to certbot. A host certbot run with `--config-dir
// <proxyRoot>/letsencrypt` records HOST paths in `renewal/<domain>.conf`, which
// a dockerised `certbot renew` cannot follow -- the certificate then silently
// stops renewing. In container mode certbot therefore runs as
// `certbot/certbot` with the two volumes mounted at the container paths, and
// WITHOUT --config-dir/--work-dir/--logs-dir.
//
// Which runtime applies is a `ProxyRuntime`, resolved once per command by
// `resolveProxyRuntime` (explicit flag, then the deployment record, then
// detection) and passed down -- never re-guessed at a call site.
// =============================================================================

export interface ProxyTarget {
  domain: string;
  bindPort: number;
  /** Default /opt/infra/proxy. */
  proxyRoot: string;
}

export type ProxyMode = 'container' | 'host';

export const PROXY_MODES: readonly ProxyMode[] = ['container', 'host'];

/** The container name the shared-proxy model uses unless told otherwise. */
export const DEFAULT_PROXY_CONTAINER = 'proxy-nginx';

/** Mount points inside the proxy container (and the dockerised certbot). */
export const CONTAINER_CERT_ROOT = '/etc/letsencrypt';
export const CONTAINER_WEBROOT = '/var/www/certbot';

/** The dockerised certbot used in container mode. */
export const CERTBOT_IMAGE = 'certbot/certbot:latest';

/**
 * How the shared proxy runs, and where IT sees the certificate and webroot.
 *
 * `certRoot` and `webroot` are CONFIG paths -- what nginx resolves -- never
 * host paths. See the module header.
 */
export interface ProxyRuntime {
  mode: ProxyMode;
  /** The proxy container's name. Meaningful in container mode only. */
  container: string;
  /** `/etc/letsencrypt` in container mode; `<proxyRoot>/letsencrypt` on the host. */
  certRoot: string;
  /** `/var/www/certbot` in container mode; `<proxyRoot>/webroot` on the host. */
  webroot: string;
}

/** Where a resolved runtime came from, for the journal and for doctor. */
export type ProxyRuntimeSource = 'explicit' | 'detected' | 'default';

export interface ResolvedProxyRuntime extends ProxyRuntime {
  source: ProxyRuntimeSource;
}

/** Docker's own container-name grammar; also keeps a leading `-` out of argv. */
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function assertValidContainerName(name: string): void {
  if (!CONTAINER_NAME.test(name)) {
    throw new UsageError(
      `"${name}" is not a valid container name, so it will not be passed to docker.`,
    );
  }
}

/** Parses a `--proxy-mode` value, refusing anything else. */
export function parseProxyMode(value: string): ProxyMode {
  if ((PROXY_MODES as readonly string[]).includes(value)) return value as ProxyMode;
  throw new UsageError(
    `--proxy-mode must be one of ${PROXY_MODES.join(', ')}, not "${value}".`,
  );
}

/** The runtime for a known mode. Pure; the test seam. */
export function proxyRuntimeFor(
  mode: ProxyMode,
  proxyRoot: string,
  container: string = DEFAULT_PROXY_CONTAINER,
): ProxyRuntime {
  return mode === 'container'
    ? { mode, container, certRoot: CONTAINER_CERT_ROOT, webroot: CONTAINER_WEBROOT }
    : {
        mode,
        container,
        certRoot: join(proxyRoot, 'letsencrypt'),
        webroot: join(proxyRoot, 'webroot'),
      };
}

export interface ResolveProxyRuntimeOptions {
  proxyRoot: string;
  /** Explicit mode (a flag, or the deployment record). Skips detection. */
  mode?: ProxyMode | undefined;
  /** Explicit container name. Also what detection looks for. */
  container?: string | undefined;
  runCommand: typeof runCommand;
}

/** Runs a probe purely for its exit status. Never throws. */
async function succeeds(
  run: typeof runCommand,
  argv: readonly string[],
): Promise<boolean> {
  try {
    await run(argv, { cwd: process.cwd(), timeoutMs: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides how the shared proxy runs.
 *
 * In order: an explicit mode wins outright; otherwise a container with the
 * expected name (`docker inspect`) means container mode; otherwise a host
 * `nginx` binary means host mode; otherwise container mode, because that is
 * the documented target architecture and the one a fresh server is being
 * prepared for.
 *
 * Read-only -- `docker inspect` and `nginx -v` change nothing -- so doctor can
 * call it. Never throws on a failed probe; it does throw a UsageError on an
 * invalid container name, before anything reaches an argv.
 */
export async function resolveProxyRuntime(
  options: ResolveProxyRuntimeOptions,
): Promise<ResolvedProxyRuntime> {
  const container = options.container ?? DEFAULT_PROXY_CONTAINER;
  assertValidContainerName(container);

  if (options.mode !== undefined) {
    return { ...proxyRuntimeFor(options.mode, options.proxyRoot, container), source: 'explicit' };
  }

  if (await succeeds(options.runCommand, ['docker', 'inspect', '--type', 'container', '--format', '{{.Name}}', container])) {
    return { ...proxyRuntimeFor('container', options.proxyRoot, container), source: 'detected' };
  }

  if (await succeeds(options.runCommand, ['nginx', '-v'])) {
    return { ...proxyRuntimeFor('host', options.proxyRoot, container), source: 'detected' };
  }

  return { ...proxyRuntimeFor('container', options.proxyRoot, container), source: 'default' };
}

/**
 * The runtime a command should act under, from what it was told and what the
 * deployment recorded: an explicit flag wins, then the record, then detection.
 *
 * A recorded container name is reused even when only the mode is overridden,
 * and vice versa -- each half falls back independently.
 */
export async function resolveRecordedProxyRuntime(options: {
  proxyRoot: string;
  flags: { mode?: ProxyMode | undefined; container?: string | undefined };
  recorded?: { proxyMode?: ProxyMode | undefined; proxyContainer?: string | undefined } | undefined;
  runCommand: typeof runCommand;
}): Promise<ResolvedProxyRuntime> {
  const mode = options.flags.mode ?? options.recorded?.proxyMode;
  const container = options.flags.container ?? options.recorded?.proxyContainer;
  return await resolveProxyRuntime({
    proxyRoot: options.proxyRoot,
    runCommand: options.runCommand,
    ...(mode === undefined ? {} : { mode }),
    ...(container === undefined ? {} : { container }),
  });
}

/** A one-line description for the journal and for progress output. */
export function describeProxyRuntime(runtime: ResolvedProxyRuntime): string {
  const where = runtime.mode === 'container' ? `container ${runtime.container}` : 'host nginx';
  return `Proxy runtime: ${where} (${runtime.source})`;
}

export interface ProxyOptions {
  runCommand: typeof runCommand;
  hooks?: DeployHooks | undefined;
  /**
   * How the proxy runs. Every pipeline passes this; it is optional only so the
   * low-level helpers keep their historical default (host mode, or container
   * mode when `proxyContainer` alone is given).
   */
  runtime?: ProxyRuntime | undefined;
  /**
   * Container the proxy runs in, when it is containerised.
   *
   * Superseded by `runtime`, which wins when both are given.
   */
  proxyContainer?: string | undefined;
  /** Upload cap, matched to MAX_FILE_SIZE so uploads do not 413 at the edge. */
  maxBodyBytes?: number | undefined;
}

export interface CertificateOptions extends ProxyOptions {
  /** Registration address; the admin email is the sensible default. */
  email: string;
  /** Use Let's Encrypt's staging environment. */
  staging?: boolean | undefined;
}

/** A hostname, and nothing that could break out of a config or a command. */
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

export function assertValidDomain(domain: string): void {
  // Validated before it reaches a config file OR an argv. Neither is a shell,
  // but a newline in a domain would let a vhost be extended with arbitrary
  // directives, which is the same class of problem.
  if (!HOSTNAME.test(domain)) {
    throw new UsageError(
      `"${domain}" is not a valid hostname, so it will not be written into the proxy configuration.`,
    );
  }
}

export function vhostPath(target: ProxyTarget): string {
  return join(target.proxyRoot, 'nginx', 'conf.d', `${target.domain}.conf`);
}

/**
 * A certificate file's HOST path: what this process stats and openssl reads.
 *
 * ⚠ Never write this into an nginx config -- use `configLivePath`. See the
 * module header.
 */
export function livePath(target: ProxyTarget, file: string): string {
  return join(target.proxyRoot, 'letsencrypt', 'live', target.domain, file);
}

/**
 * A certificate file's path AS NGINX SEES IT: what goes into the vhost.
 *
 * Equal to `livePath` in host mode; `/etc/letsencrypt/live/...` in container
 * mode. Built with posix joins, since it names a path inside nginx's world.
 */
export function configLivePath(runtime: ProxyRuntime, domain: string, file: string): string {
  return posix.join(runtime.certRoot, 'live', domain, file);
}

/**
 * The runtime a low-level helper acts under when its caller gave none.
 *
 * Preserves the helpers' historical behaviour: host paths, and container mode
 * only when a `proxyContainer` alone was passed.
 */
export function effectiveRuntime(target: ProxyTarget, options: ProxyOptions): ProxyRuntime {
  if (options.runtime !== undefined) return options.runtime;
  return options.proxyContainer === undefined
    ? proxyRuntimeFor('host', target.proxyRoot)
    : proxyRuntimeFor('container', target.proxyRoot, options.proxyContainer);
}

/** The container `nginx` runs in, or undefined for a host binary. */
function proxyContainerOf(options: ProxyOptions): string | undefined {
  if (options.runtime !== undefined) {
    return options.runtime.mode === 'container' ? options.runtime.container : undefined;
  }
  return options.proxyContainer;
}

/**
 * Renders the vhost.
 *
 * Deterministic: the same input produces byte-identical output, so re-running
 * an install produces no spurious diff and no needless reload.
 *
 * WHAT IS DELIBERATELY ABSENT: security headers. infra/nginx/nginx.conf
 * already sets HSTS, the CSP, X-Frame-Options and the rest, and nginx's
 * add_header REPLACES the inherited set rather than merging with it - so
 * adding any header here would silently delete the application's CSP.
 */
export function renderVhost(
  target: ProxyTarget,
  runtime: ProxyRuntime,
  options?: { maxBodyBytes?: number | undefined },
): string {
  assertValidDomain(target.domain);

  const maxBody = options?.maxBodyBytes;
  const clientMaxBody = maxBody === undefined ? '100m' : `${Math.ceil(maxBody / (1024 * 1024))}m`;

  return `# Managed by appctl deploy. Edits will be overwritten.
# Application: ${target.domain}

server {
    listen 80;
    listen [::]:80;
    server_name ${target.domain};

    # Left served over HTTP on purpose: renewal uses the same webroot
    # challenge, and redirecting it to HTTPS breaks every future renewal.
    location /.well-known/acme-challenge/ {
        root ${runtime.webroot};
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${target.domain};

    ssl_certificate     ${configLivePath(runtime, target.domain, 'fullchain.pem')};
    ssl_certificate_key ${configLivePath(runtime, target.domain, 'privkey.pem')};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # Matched to MAX_FILE_SIZE. Without this an upload fails at the edge with
    # a bare 413 that never reaches the application's own limits.
    client_max_body_size ${clientMaxBody};

    # No response headers are set here, deliberately. The application's own
    # nginx already sets HSTS, the CSP and the rest, and nginx REPLACES an
    # inherited header set rather than merging with it - so adding even one
    # here would silently delete all of them.

    location / {
        proxy_pass http://127.0.0.1:${target.bindPort};
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # The application forwards $scheme onward, so THIS is the value it
        # ultimately sees. Get it wrong and OAuth callbacks build http:// URLs
        # and the login redirect loops.
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host  $host;

        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }

    # Server-sent events. The application's nginx already disables buffering
    # for this path; without the same treatment at the edge, that care is
    # undone one hop upstream and events arrive in batches or not at all.
    location /api/notifications/stream {
        proxy_pass http://127.0.0.1:${target.bindPort};
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection        '';

        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    # AI response streaming (SSE, issue #433). Same reasoning as above: the
    # application's nginx forwards it unbuffered, and this hop must too, or
    # tokens arrive in batches. One answer rather than a feed, so ten minutes
    # (the application's own bound) instead of an hour; the API heartbeats
    # every 15s.
    location /api/ai/responses/stream {
        proxy_pass http://127.0.0.1:${target.bindPort};
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection        '';

        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # Telemetry AI assistant streaming (SSE, issue #536): the same needs as
    # the AI response stream above — one turn of tool steps and an answer.
    location /api/admin/telemetry/assistant/stream {
        proxy_pass http://127.0.0.1:${target.bindPort};
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection        '';

        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
`;
}

export interface CertInfo {
  exists: boolean;
  path: string;
}

export function certificateStatus(target: ProxyTarget): CertInfo {
  const path = livePath(target, 'fullchain.pem');
  return { exists: existsSync(path), path };
}

/**
 * Issues a certificate, unless a usable one already exists.
 *
 * Skipping when one exists is not an optimisation: re-issuing on every deploy
 * spends the rate limit (50 certificates per registered domain per week) for
 * nothing, and that limit is per DOMAIN, so it is shared with every other
 * subdomain on the same server.
 */
export async function issueCertificate(
  target: ProxyTarget,
  options: CertificateOptions,
): Promise<{ issued: boolean; path: string }> {
  assertValidDomain(target.domain);

  const status = certificateStatus(target);
  if (status.exists) {
    options.hooks?.onProgress?.(`Certificate for ${target.domain} already exists`);
    return { issued: false, path: status.path };
  }

  const argv = certbotArgv(target, effectiveRuntime(target, options), {
    email: options.email,
    staging: options.staging,
  });

  options.hooks?.onProgress?.(`Requesting a certificate for ${target.domain}`);

  try {
    await options.runCommand(argv, {
      cwd: target.proxyRoot,
      timeoutMs: 5 * 60_000,
      ...(options.hooks?.onLog === undefined
        ? {}
        : { onLine: (line: string) => options.hooks?.onLog?.(line) }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Rate limiting needs its own remedy: the fix is to WAIT, and retrying is
    // what put the operator there in the first place.
    if (/too many certificates|rateLimited|rate limit/i.test(message)) {
      throw new UsageError(
        `Let's Encrypt is rate-limiting this domain. Wait before trying again — retrying now makes it worse. Use --staging while working out the rest of the setup.\n${message}`,
      );
    }
    throw error;
  }

  return { issued: true, path: livePath(target, 'fullchain.pem') };
}

/**
 * The argv that runs `certbot certonly --webroot` for this runtime.
 *
 * CONTAINER MODE runs the dockerised certbot with the proxy's two volumes
 * mounted at the SAME paths the proxy container uses, and deliberately passes
 * no --config-dir/--work-dir/--logs-dir: those flags are exactly what write
 * host paths into `renewal/<domain>.conf`, which a dockerised `certbot renew`
 * then cannot follow. With the defaults, every recorded path is under
 * `/etc/letsencrypt`, which is where every later dockerised renewal looks.
 *
 * HOST MODE keeps the historical argv: a host certbot whose state lives under
 * the proxy root.
 *
 * Exported for its test.
 */
export function certbotArgv(
  target: ProxyTarget,
  runtime: ProxyRuntime,
  options: { email: string; staging?: boolean | undefined; forceRenewal?: boolean | undefined },
): string[] {
  const common = [
    '-d', target.domain,
    '--non-interactive', '--agree-tos',
    '--email', options.email,
    ...(options.forceRenewal === true ? ['--force-renewal'] : []),
    ...(options.staging === true ? ['--staging'] : []),
  ];

  if (runtime.mode === 'container') {
    return [
      'docker', 'run', '--rm',
      '-v', `${join(target.proxyRoot, 'letsencrypt')}:${CONTAINER_CERT_ROOT}`,
      '-v', `${join(target.proxyRoot, 'webroot')}:${CONTAINER_WEBROOT}`,
      CERTBOT_IMAGE,
      'certonly',
      '--webroot', '-w', CONTAINER_WEBROOT,
      ...common,
    ];
  }

  return [
    'certbot', 'certonly',
    '--webroot', '--webroot-path', join(target.proxyRoot, 'webroot'),
    ...common,
    '--config-dir', join(target.proxyRoot, 'letsencrypt'),
    '--work-dir', join(target.proxyRoot, 'letsencrypt', 'work'),
    '--logs-dir', join(target.proxyRoot, 'letsencrypt', 'logs'),
  ];
}

export interface InstallVhostResult {
  path: string;
  changed: boolean;
}

/**
 * Writes, validates and activates the vhost, rolling back on failure.
 *
 * The rollback is the reason this function exists rather than a `writeFileSync`
 * at the call site.
 */
export async function installVhost(
  target: ProxyTarget,
  options: ProxyOptions,
): Promise<InstallVhostResult> {
  assertValidDomain(target.domain);

  const path = vhostPath(target);
  const rendered = renderVhost(target, effectiveRuntime(target, options), {
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  });

  const existed = existsSync(path);
  const previous = existed ? readFileSync(path, 'utf8') : undefined;

  if (previous === rendered) {
    // Byte-identical, so there is nothing to validate and nothing to reload.
    options.hooks?.onProgress?.(`Vhost for ${target.domain} is already current`);
    return { path, changed: false };
  }

  mkdirSync(join(target.proxyRoot, 'nginx', 'conf.d'), { recursive: true });
  writeFileSync(path, rendered, { mode: 0o644 });

  const validation = await validateProxy(options);
  if (!validation.ok) {
    // Put the proxy back EXACTLY as it was found, then confirm that actually
    // worked before reporting - a rollback that leaves nginx broken is worse
    // than the original failure.
    if (previous === undefined) {
      rmSync(path, { force: true });
    } else {
      writeFileSync(path, previous, { mode: 0o644 });
    }

    const after = await validateProxy(options);
    const restored = after.ok
      ? 'The proxy has been restored and still validates.'
      : 'WARNING: the proxy does not validate even after rolling back; it was already broken before this run.';

    throw new UsageError(
      `The vhost for ${target.domain} did not pass nginx -t, so it was removed.\n${validation.output}\n${restored}`,
    );
  }

  await reloadProxy(options);
  options.hooks?.onProgress?.(`Published ${target.domain}`);

  return { path, changed: true };
}

export interface ValidationResult {
  ok: boolean;
  output: string;
}

/** Runs `nginx -t`, in the container when the proxy is containerised. */
export async function validateProxy(options: ProxyOptions): Promise<ValidationResult> {
  const container = proxyContainerOf(options);
  const argv =
    container === undefined ? ['nginx', '-t'] : ['docker', 'exec', container, 'nginx', '-t'];

  try {
    const result = await options.runCommand(argv, { cwd: process.cwd(), timeoutMs: 60_000 });
    return { ok: true, output: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    const failure = error as { result?: { stdout?: string; stderr?: string } };
    return {
      ok: false,
      output:
        `${failure.result?.stdout ?? ''}${failure.result?.stderr ?? ''}`.trim() ||
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Reloads, never restarts: a restart drops every other site's connections. */
export async function reloadProxy(options: ProxyOptions): Promise<void> {
  const container = proxyContainerOf(options);
  const argv =
    container === undefined
      ? ['nginx', '-s', 'reload']
      : ['docker', 'exec', container, 'nginx', '-s', 'reload'];

  await options.runCommand(argv, { cwd: process.cwd(), timeoutMs: 60_000 });
}

/** Removes a vhost this tool wrote. Used only to undo a failed install. */
export async function removeVhost(
  target: ProxyTarget,
  options: ProxyOptions,
): Promise<void> {
  const path = vhostPath(target);
  if (!existsSync(path)) return;

  // Only ever a file this tool wrote: the header is the marker, and a vhost
  // without it belongs to somebody else.
  const contents = readFileSync(path, 'utf8');
  if (!contents.startsWith('# Managed by appctl deploy')) {
    throw new UsageError(
      `${path} was not written by appctl, so it will not be removed. Remove it by hand if that is really what you want.`,
    );
  }

  rmSync(path, { force: true });
  const validation = await validateProxy(options);
  if (validation.ok) await reloadProxy(options);
}

/**
 * Creates the shared proxy's directory layout if it is not there.
 *
 * Both the design spec and the operator runbook state that install bootstraps
 * `/opt/infra/proxy` when absent. It did not: `proxy-root`, `proxy-conf-writable`
 * and `acme-webroot` were `required` preflight checks that simply failed, so an
 * operator following the runbook on a fresh VPS hit a refusal the documentation
 * told them would not happen. This is that promise, kept.
 *
 * It creates DIRECTORIES only. It does not write an nginx configuration, start
 * a container, or touch a certificate: those are the shared infrastructure this
 * CLI is a tenant of, not an owner of, and bringing them up is the host's job.
 * What is created is exactly the three paths this deployment will write into.
 *
 * Idempotent, and deliberately silent when everything already exists -- the
 * ordinary case on every host after the first deployment.
 */
export function bootstrapProxyRoot(
  proxyRoot: string,
  hooks?: { onProgress?: ((message: string) => void) | undefined },
): { created: string[] } {
  const needed = [
    join(proxyRoot, 'nginx', 'conf.d'),
    join(proxyRoot, 'letsencrypt'),
    join(proxyRoot, 'webroot'),
  ];

  const created: string[] = [];
  for (const path of needed) {
    if (existsSync(path)) continue;
    mkdirSync(path, { recursive: true });
    created.push(path);
  }

  if (created.length > 0) {
    hooks?.onProgress?.(`Created the shared proxy layout under ${proxyRoot}`);
  }

  return { created };
}

/** Days before expiry at which a certificate is considered due for renewal. */
export const RENEW_WITHIN_DAYS = 30;

export interface CertificateExpiry {
  exists: boolean;
  path: string;
  /** Null when the certificate is absent, or its expiry could not be read. */
  notAfter: Date | null;
  daysRemaining: number | null;
  /** True only when an expiry was READ and it falls inside the window. */
  dueForRenewal: boolean;
  /** Set when the certificate exists but its expiry could not be determined. */
  problem?: string;
}

/**
 * Reads a certificate's expiry with openssl.
 *
 * ⚠ AN UNREADABLE EXPIRY IS NOT "NOT DUE". `dueForRenewal` is false in that
 * case, but `problem` is set and the caller must surface it -- silently
 * treating an unparseable certificate as healthy is how one quietly expires.
 * The same reasoning as `certificate-validity` in the doctor registry, which is
 * why both parse the same `notAfter=` line.
 */
export async function certificateExpiry(
  target: ProxyTarget,
  options: { runCommand: typeof runCommand; now?: Date },
): Promise<CertificateExpiry> {
  const status = certificateStatus(target);
  if (!status.exists) {
    return { exists: false, path: status.path, notAfter: null, daysRemaining: null, dueForRenewal: false };
  }

  let output: string;
  try {
    const result = await options.runCommand(
      ['openssl', 'x509', '-enddate', '-noout', '-in', status.path],
      { cwd: target.proxyRoot, timeoutMs: 15_000 },
    );
    output = result.stdout;
  } catch (error) {
    return {
      exists: true,
      path: status.path,
      notAfter: null,
      daysRemaining: null,
      dueForRenewal: false,
      problem: `could not read the expiry: ${(error as Error).message}`,
    };
  }

  const raw = /notAfter=(.+)/.exec(output)?.[1]?.trim();
  const expiry = raw === undefined ? undefined : new Date(raw);

  if (expiry === undefined || Number.isNaN(expiry.getTime())) {
    return {
      exists: true,
      path: status.path,
      notAfter: null,
      daysRemaining: null,
      dueForRenewal: false,
      problem: `unrecognised expiry: ${raw ?? '(absent)'}`,
    };
  }

  const now = options.now ?? new Date();
  const daysRemaining = Math.floor((expiry.getTime() - now.getTime()) / 86_400_000);

  return {
    exists: true,
    path: status.path,
    notAfter: expiry,
    daysRemaining,
    dueForRenewal: daysRemaining <= RENEW_WITHIN_DAYS,
  };
}

export interface RenewResult {
  renewed: boolean;
  /**
   * True only when the proxy validated and reloaded after a renewal. A renewal
   * with `reloaded: false` has a new certificate on disk that is NOT being
   * served, and the caller must say so.
   */
  reloaded: boolean;
  reason: string;
  expiry: CertificateExpiry;
}

/**
 * Renews a certificate that is inside the renewal window, then validates and
 * reloads the proxy so the renewed certificate is actually served.
 *
 * ⚠ It renews only when the expiry says so. Let's Encrypt allows 5 DUPLICATE
 * certificates per week, and a command that re-issued on every invocation would
 * exhaust that during a single debugging session -- leaving the deployment
 * unable to get a certificate at the moment it most needs one. `force` exists
 * for an operator who has decided otherwise and is deliberately not the default.
 */
export async function renewCertificate(
  target: ProxyTarget,
  options: CertificateOptions & { force?: boolean | undefined; now?: Date | undefined },
): Promise<RenewResult> {
  assertValidDomain(target.domain);

  const expiry = await certificateExpiry(target, {
    runCommand: options.runCommand,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  if (!expiry.exists) {
    return { renewed: false, reloaded: false, reason: 'no certificate is installed for this domain', expiry };
  }

  if (options.force !== true && expiry.problem !== undefined) {
    // Refuses rather than renewing: an unreadable expiry is a question, and
    // spending a rate-limited issuance to answer it is the wrong trade.
    return { renewed: false, reloaded: false, reason: expiry.problem, expiry };
  }

  if (options.force !== true && !expiry.dueForRenewal) {
    return {
      renewed: false,
      reloaded: false,
      reason: `not due: ${String(expiry.daysRemaining)} day(s) remaining, renews within ${RENEW_WITHIN_DAYS}`,
      expiry,
    };
  }

  const argv = certbotArgv(target, effectiveRuntime(target, options), {
    email: options.email,
    staging: options.staging,
    forceRenewal: true,
  });

  await options.runCommand(argv, { cwd: target.proxyRoot, timeoutMs: 5 * 60_000 });

  const after = await certificateExpiry(target, {
    runCommand: options.runCommand,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  // ⚠ THE RELOAD IS LOAD-BEARING. nginx reads the certificate when it loads
  // its configuration, so a renewed certificate on disk is NOT a served one:
  // until the proxy reloads it keeps serving the old certificate until that
  // expires, on a server whose files all look correct. Validated first, so a
  // neighbour's broken vhost cannot be turned into a failed reload for every
  // site on the box.
  const validation = await validateProxy(options);
  if (!validation.ok) {
    return {
      renewed: true,
      reloaded: false,
      reason: `renewed, but the proxy was NOT reloaded because nginx -t failed: ${validation.output}`,
      expiry: after,
    };
  }

  try {
    await reloadProxy(options);
  } catch (error) {
    return {
      renewed: true,
      reloaded: false,
      reason: `renewed, but the proxy reload failed: ${error instanceof Error ? error.message : String(error)}`,
      expiry: after,
    };
  }

  return { renewed: true, reloaded: true, reason: 'renewed and the proxy reloaded', expiry: after };
}
