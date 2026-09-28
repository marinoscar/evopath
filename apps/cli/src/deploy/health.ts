import { join } from 'node:path';

import { composeFileArgs } from './compose-files.js';
import type { runCommand } from './executor.js';
import type { DeployHooks } from './hooks.js';
import type { DeployState } from './state.js';

// =============================================================================
// Is this deployment actually working?  (issue #183, epic #168)
// =============================================================================
//
// `doctor` answers "can this server run the application?" - a question about
// prerequisites, asked before anything is installed. This answers "is the
// deployment I have right now healthy?", which is the question asked at 2am.
//
// THE TRAP THIS MODULE EXISTS TO CLOSE: /api/health/ready RETURNING 200 IS
// MUCH WEAKER EVIDENCE THAN IT LOOKS. Its only indicator issues `SELECT 1`,
// which passes against a completely empty database. A deployment whose
// migrations silently failed reports itself ready. So this asks about
// migration state separately, and a green probe alone is never treated as
// proof that the schema is there.
// =============================================================================

export interface ProbeResult {
  ok: boolean;
  status?: number | undefined;
  durationMs: number;
  /** Why it failed, when it did. */
  error?: string | undefined;
}

export interface ContainerState {
  name: string;
  service: string;
  state: string;
  health?: string | undefined;
  image: string;
}

export interface MigrationState {
  applied?: number | undefined;
  pending: string[];
  /** Undefined when the state could not be determined at all. */
  known: boolean;
}

export interface HealthReport {
  containers: ContainerState[];
  local: { live: ProbeResult; ready: ProbeResult; frontend: ProbeResult };
  external?: { url: string; probe: ProbeResult } | undefined;
  migrations: MigrationState;
  /**
   * The OAuth wiring, end to end (#391). Present only when the caller asked
   * for it with `oauth`; deliberately NOT part of `isHealthy`, so `status`'s
   * exit code keeps meaning "is it serving" -- the verify step decides what a
   * failed smoke means for a deploy.
   */
  oauth?: OAuthSmoke | undefined;
  deployed?: Pick<DeployState, 'commitSha' | 'ref' | 'lastDeployedAt' | 'lastCommand'> | undefined;
}

export type FetchLike = typeof globalThis.fetch;

export interface HealthOptions {
  runCommand: typeof runCommand;
  deployRoot: string;
  bindPort: number;
  domain?: string | undefined;
  state?: DeployState | undefined;
  fetch?: FetchLike | undefined;
  hooks?: DeployHooks | undefined;
  timeoutMs?: number | undefined;
  /**
   * The Docker Compose project these containers live under.
   *
   * ⚠ WITHOUT THIS THE HEALTH GATE INSPECTS THE WRONG PROJECT. `install` and
   * `update` pass `-p <name>` on every compose invocation, so a deployment
   * installed since that landed runs under its own project -- while this
   * module built its own argv and passed no `-p` at all, so `compose ps` and
   * `prisma migrate status` were answered by the DIRECTORY-DERIVED default
   * (`compose`). The gate then reported no containers and an unknown schema
   * for a stack that was up and migrated, on exactly the deployments the
   * project naming exists to keep apart.
   *
   * Absent means the directory-derived default, which is correct for every
   * deployment installed before the naming existed -- the same rule
   * `composeProjectFor` states for the state file.
   */
  composeProject?: string | undefined;
  /**
   * The Google OAuth client this deployment is configured with. When given,
   * `collectHealth` also runs the OAuth smoke (`oauthSmoke`).
   */
  oauth?: { clientId: string; callbackUrl: string } | undefined;
  /**
   * The deployment's groups: they decide which compose files the stack
   * was started with (compose-files.ts), and this module must name the SAME
   * files, so `compose ps` and the migration probe's `compose run` describe
   * the stack that is actually running rather than a base-only model of it.
   * The always-on telemetry files are included whatever is passed (#567).
   */
  groups?: readonly string[] | undefined;
}

function composeArgs(
  options: Pick<HealthOptions, 'deployRoot' | 'composeProject' | 'groups'>,
): string[] {
  return [
    ...(options.composeProject === undefined ? [] : ['-p', options.composeProject]),
    ...composeFileArgs(options.groups),
    '--project-directory',
    join(options.deployRoot, 'repo', 'infra', 'compose'),
  ];
}

function composeCwd(deployRoot: string): string {
  // The relative build contexts in base.compose.yml (`../..`, `../nginx`)
  // resolve against the COMPOSE FILE's directory, so the working directory is
  // not incidental here.
  return join(deployRoot, 'repo', 'infra', 'compose');
}

/** One HTTP probe, with its own timeout and a readable failure. */
export async function probe(
  url: string,
  options: { fetch?: FetchLike | undefined; timeoutMs?: number | undefined },
): Promise<ProbeResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const startedAt = Date.now();

  try {
    const response = await doFetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      redirect: 'manual',
    });
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      // Distinguished rather than collapsed: a TLS failure, a refused
      // connection and a timeout have different causes and different fixes.
      error: describeFetchFailure(error),
    };
  }
}

export function describeFetchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code;

  if (error instanceof Error && error.name === 'TimeoutError') return 'timed out';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND') return 'host does not resolve';
  if (code === 'CERT_HAS_EXPIRED') return 'the TLS certificate has expired';
  if (code?.startsWith('DEPTH_ZERO') === true || code?.includes('CERT') === true) {
    return `TLS failure: ${cause?.message ?? code}`;
  }
  return cause?.message ?? message;
}

/** Reads `docker compose ps` as JSON. */
export async function containerStates(
  options: HealthOptions,
): Promise<ContainerState[]> {
  try {
    const result = await options.runCommand(
      ['docker', 'compose', ...composeArgs(options), 'ps', '--format', 'json'],
      { cwd: composeCwd(options.deployRoot), timeoutMs: 60_000 },
    );

    // Compose emits either one JSON array or one object per line depending on
    // version, so both are accepted rather than pinning a version.
    const text = result.stdout.trim();
    if (text === '') return [];

    const rows: unknown[] = text.startsWith('[')
      ? (JSON.parse(text) as unknown[])
      : text.split('\n').map((line) => JSON.parse(line) as unknown);

    return rows.map((row) => {
      const entry = row as Record<string, unknown>;
      return {
        name: String(entry['Name'] ?? ''),
        service: String(entry['Service'] ?? ''),
        state: String(entry['State'] ?? ''),
        image: String(entry['Image'] ?? ''),
        ...(entry['Health'] === undefined || entry['Health'] === ''
          ? {}
          : { health: String(entry['Health']) }),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Asks Prisma what the schema state is.
 *
 * This is the check that distinguishes a genuinely ready deployment from one
 * that merely answers SELECT 1.
 */
export async function migrationState(options: HealthOptions): Promise<MigrationState> {
  try {
    const result = await options.runCommand(
      [
        'docker', 'compose', ...composeArgs(options),
        'run', '--rm', '--no-deps', 'api',
        'npx', 'prisma', 'migrate', 'status',
      ],
      { cwd: composeCwd(options.deployRoot), timeoutMs: 120_000, allowExitCodes: [1] },
    );

    const output = `${result.stdout}\n${result.stderr}`;

    // `prisma migrate status` exits 1 BOTH when migrations are pending and
    // when it could not run at all, so the exit code alone cannot tell those
    // apart - which is why exit 1 is allowed above and the OUTPUT is what
    // decides. If it does not look like Prisma's own report, we do not know
    // the schema state, and saying so is better than reporting "fine".
    const looksLikePrisma =
      /migrations?\s+found/i.test(output) ||
      /database schema is up to date/i.test(output) ||
      /following migrations? have not yet been applied/i.test(output);

    if (!looksLikePrisma) {
      return { known: false, pending: [] };
    }

    const applied = /(\d+)\s+migrations?\s+found/i.exec(output)?.[1];
    const pending = [...output.matchAll(/^\s*[-*]?\s*(\d{14}_[\w-]+)\s*$/gm)].map(
      (match) => match[1] as string,
    );

    const upToDate = /database schema is up to date/i.test(output);

    return {
      known: true,
      ...(applied === undefined ? {} : { applied: Number(applied) }),
      pending: upToDate ? [] : pending,
    };
  } catch {
    // Prisma unavailable, container missing, or the image lacks the CLI. Not
    // knowing is reported as not knowing rather than as "fine".
    return { known: false, pending: [] };
  }
}

export async function collectHealth(options: HealthOptions): Promise<HealthReport> {
  const base = `http://127.0.0.1:${options.bindPort}`;
  const fetchOptions = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  const [containers, live, ready, frontend, migrations] = await Promise.all([
    containerStates(options),
    probe(`${base}/api/health/live`, fetchOptions),
    probe(`${base}/api/health/ready`, fetchOptions),
    // The frontend gets its own probe because it fails INDEPENDENTLY of the
    // API - the nginx upstream bug in #169 is exactly the case where every
    // API check passes and the site serves nothing.
    probe(`${base}/`, fetchOptions),
    migrationState(options),
  ]);

  const external =
    options.domain === undefined
      ? undefined
      : {
          url: `https://${options.domain}/api/health/ready`,
          probe: await probe(`https://${options.domain}/api/health/ready`, fetchOptions),
        };

  const oauth =
    options.oauth === undefined
      ? undefined
      : await oauthSmoke({ base, ...options.oauth, ...fetchOptions });

  return {
    containers,
    local: { live, ready, frontend },
    ...(external === undefined ? {} : { external }),
    migrations,
    ...(oauth === undefined ? {} : { oauth }),
    ...(options.state === undefined
      ? {}
      : {
          deployed: {
            commitSha: options.state.commitSha,
            ref: options.state.ref,
            lastDeployedAt: options.state.lastDeployedAt,
            lastCommand: options.state.lastCommand,
          },
        }),
  };
}

/** True when the deployment is serving and its schema is current. */
export function isHealthy(report: HealthReport): boolean {
  const containersOk =
    report.containers.length === 0 ||
    report.containers.every((container) => /running/i.test(container.state));

  const migrationsOk = !report.migrations.known || report.migrations.pending.length === 0;

  return (
    containersOk &&
    report.local.live.ok &&
    report.local.ready.ok &&
    report.local.frontend.ok &&
    migrationsOk &&
    (report.external?.probe.ok ?? true)
  );
}

export interface WaitOptions extends HealthOptions {
  /** Total time to wait. Matches the shell scripts this replaces. */
  waitMs?: number | undefined;
  intervalMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Polls readiness until it answers or the deadline passes.
 *
 * Shared by install and update rather than reimplemented in each. On timeout
 * it reports the LAST failure, not a bare "timed out" - the useful information
 * is why it never became ready.
 */
export async function waitForHealthy(options: WaitOptions): Promise<ProbeResult> {
  const deadline = Date.now() + (options.waitMs ?? 120_000);
  const interval = options.intervalMs ?? 2_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const url = `http://127.0.0.1:${options.bindPort}/api/health/ready`;
  let attempt = 0;
  let last: ProbeResult = { ok: false, durationMs: 0, error: 'not attempted' };

  for (;;) {
    attempt += 1;
    last = await probe(url, {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      timeoutMs: Math.min(interval * 2, 10_000),
    });

    if (last.ok) {
      options.hooks?.onProgress?.(`Ready after ${attempt} attempt(s)`);
      return last;
    }

    if (Date.now() >= deadline) {
      // The last error, not a generic message: "connection refused" and "503"
      // send you to completely different places.
      options.hooks?.onProgress?.(`Still not ready: ${last.error ?? last.status ?? 'unknown'}`);
      return last;
    }

    options.hooks?.onProgress?.(
      `Waiting for the API (attempt ${attempt}: ${last.error ?? `HTTP ${last.status ?? '?'}`})`,
    );
    await sleep(interval);
  }
}

// =============================================================================
// The OAuth smoke  (issue #391)
// =============================================================================
//
// Proves the sign-in wiring end to end with NO credentials in flight:
//
//   1. GET /api/auth/providers lists `google` -- the API loaded a client id AND
//      secret (it lists the provider only when both are set);
//   2. GET /api/auth/google redirects to Google carrying the configured client
//      id and redirect URI -- the running container has the values the `.env`
//      says it has, not a stale or default copy.
//
// Three outcomes: `pass`; `fail` when the API answered and the answer is wrong
// (a real misconfiguration); `warn` when the API could not be asked at all
// (unreachable, timed out) -- that is the health probes' question, not this
// one's, and they report it already.
// =============================================================================

export interface OAuthSmoke {
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  remedy?: string | undefined;
}

/** Hosts a Google sign-in redirect may legitimately point at. */
const GOOGLE_AUTH_HOST = /(^|\.)accounts\.google\.com$/i;

function providerNames(body: unknown): string[] {
  const root = body as { data?: unknown; providers?: unknown } | undefined;
  const candidates = [
    (root?.data as { providers?: unknown } | undefined)?.providers,
    root?.providers,
    root?.data,
  ];
  const list = candidates.find((candidate) => Array.isArray(candidate)) as unknown[] | undefined;
  return (list ?? [])
    .map((entry) =>
      typeof entry === 'string' ? entry : String((entry as { name?: unknown } | null)?.name ?? ''),
    )
    .filter((name) => name !== '');
}

export async function oauthSmoke(options: {
  base: string;
  clientId: string;
  callbackUrl: string;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
}): Promise<OAuthSmoke> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const signal = (): AbortSignal => AbortSignal.timeout(options.timeoutMs ?? 10_000);

  let providers: string[];
  try {
    const response = await doFetch(`${options.base}/api/auth/providers`, {
      signal: signal(),
      headers: { accept: 'application/json' },
    });
    if (response.status < 200 || response.status >= 300) {
      return {
        status: 'fail',
        detail: `GET /api/auth/providers answered HTTP ${response.status}`,
        remedy: 'The API is up but not serving its auth routes; check the api container logs.',
      };
    }
    providers = providerNames(await response.json().catch(() => undefined));
  } catch (error) {
    return { status: 'warn', detail: `could not ask /api/auth/providers: ${describeFetchFailure(error)}` };
  }

  if (!providers.includes('google')) {
    return {
      status: 'fail',
      detail: `/api/auth/providers does not list google (${providers.length === 0 ? 'none listed' : providers.join(', ')})`,
      remedy:
        'The API lists Google only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set in its environment. ' +
        'Check the .env, then recreate the api container so it reads it.',
    };
  }

  let location: string | null;
  let status: number;
  try {
    const response = await doFetch(`${options.base}/api/auth/google`, { signal: signal(), redirect: 'manual' });
    status = response.status;
    location = response.headers.get('location');
  } catch (error) {
    return { status: 'warn', detail: `could not ask /api/auth/google: ${describeFetchFailure(error)}` };
  }

  if (status < 300 || status >= 400 || location === null) {
    return {
      status: 'fail',
      detail: `GET /api/auth/google answered HTTP ${status}${location === null ? ' with no redirect' : ''}, not a redirect to Google`,
      remedy: 'Sign-in cannot start. Check the api container logs for the Google strategy.',
    };
  }

  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return { status: 'fail', detail: `GET /api/auth/google redirected to an unparseable location` };
  }

  if (!GOOGLE_AUTH_HOST.test(target.hostname)) {
    return {
      status: 'fail',
      detail: `GET /api/auth/google redirects to ${target.hostname}, not accounts.google.com`,
      remedy: 'Something in front of the API is rewriting the redirect, or the strategy is misconfigured.',
    };
  }

  const clientId = target.searchParams.get('client_id');
  const redirectUri = target.searchParams.get('redirect_uri');
  const mismatches = [
    clientId === options.clientId ? undefined : `client_id is ${clientId ?? 'absent'}, expected ${options.clientId}`,
    redirectUri === options.callbackUrl
      ? undefined
      : `redirect_uri is ${redirectUri ?? 'absent'}, expected ${options.callbackUrl}`,
  ].filter((entry): entry is string => entry !== undefined);

  if (mismatches.length > 0) {
    return {
      status: 'fail',
      detail: `the running API redirects with ${mismatches.join('; ')}`,
      remedy:
        'The api container is not running with the values in the .env. Recreate it so it reads them: ' +
        'the update/install `start` step, or docker compose up -d --force-recreate api.',
    };
  }

  return { status: 'pass', detail: 'google is listed, and sign-in redirects with the configured client id and callback' };
}
