import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { totalmem } from 'node:os';
import { connect as tlsConnect } from 'node:tls';

import type { runCommand } from '../executor.js';
import type { ProxyRuntime } from '../proxy.js';

// =============================================================================
// The doctor check contract  (issue #176, epic #168)
// =============================================================================
//
// A VPS deployment has prerequisites. When one is missing, the failure surfaces
// halfway through an install - after the repository is cloned and possibly
// after .env is written - as an error from a tool the operator was not
// expecting to run. The whole point of `doctor` is to ask "is this server
// ready?" BEFORE anything is changed, and get back a list of what to fix.
//
// FOUR RULES THAT MAKE THIS WORTH HAVING:
//
//   1. A CHECK NEVER THROWS. A crashed probe becomes a `fail` carrying the
//      error's message. One broken check must not abort the run: the operator
//      wants the whole list, not the first problem.
//   2. `remedy` IS MANDATORY ON `fail`, and must name a command or a path.
//      "Install Docker" is not a remedy. There is a test asserting every check
//      in the registry produces one, so a new check cannot be added without it.
//   3. `required` vs `recommended` decides the EXIT CODE, not the display.
//      Both are shown; only a failed required check makes doctor exit non-zero.
//      Failing on advice is how people learn to pass --force, and then the
//      required checks stop being enforced too.
//   4. CHECKS ARE READ-ONLY. Doctor never installs, never writes, never starts
//      anything. That is what makes it safe to run against a production server
//      at any time, and it must stay true.
// =============================================================================

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  status: CheckStatus;
  /** One line: what was found. "Docker 27.3.1", or "not installed". */
  detail: string;
  /** Shown on warn/fail. A command or a path, never a category. */
  remedy?: string | undefined;
}

/** Filesystem probes, injectable so checks are testable without a real server. */
export interface CheckFs {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  isWritable(path: string): boolean;
  /** UTF-8 contents, or undefined when absent or unreadable. Never throws. */
  readFile(path: string): string | undefined;
  /** Entry names, or [] when absent or unreadable. Never throws. */
  readdir(path: string): string[];
}

export const realFs: CheckFs = {
  exists(path) {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  isWritable(path) {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  readdir(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

/** What the certificate ON THE WIRE says, as opposed to the one on disk. */
export interface ServedCertificate {
  /** The peer certificate's `valid_to`. */
  notAfter: Date;
}

/**
 * Reads the certificate a TLS server presents for `domain`.
 *
 * `rejectUnauthorized: false` because the question is WHICH certificate is
 * served, not whether it is trusted -- an expired or staging certificate is
 * exactly the one this has to be able to read. Nothing is sent after the
 * handshake. Rejects on any failure; the caller decides what that means.
 */
export async function fetchServedCertificate(
  domain: string,
  options: { port?: number; timeoutMs?: number } = {},
): Promise<ServedCertificate> {
  return await new Promise<ServedCertificate>((resolve, reject) => {
    const socket = tlsConnect({
      host: domain,
      port: options.port ?? 443,
      servername: domain,
      rejectUnauthorized: false,
    });

    socket.setTimeout(options.timeoutMs ?? 10_000, () => {
      socket.destroy(new Error(`timed out reading the certificate served for ${domain}`));
    });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      socket.end();
      const notAfter = new Date(certificate.valid_to ?? '');
      if (Number.isNaN(notAfter.getTime())) {
        reject(new Error(`unrecognised served expiry: ${String(certificate.valid_to)}`));
        return;
      }
      resolve({ notAfter });
    });
  });
}

/**
 * True when nothing is listening on the loopback address for `port`.
 *
 * Binding is used rather than parsing `ss` output: it needs no external tool,
 * it cannot be confused by a different output format, and it answers the
 * question that actually matters - can this deployment take the port.
 */
export async function isLoopbackPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** True when something answers on `port` of any interface. */
export async function isPortListening(port: number): Promise<boolean> {
  return !(await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  }));
}

export interface CheckContext {
  runCommand: typeof runCommand;
  /** Where the deployment lives, or will. */
  deployRoot: string;
  /** Loopback port the shared proxy forwards to. */
  bindPort: number;
  /** The shared reverse proxy's directory. */
  proxyRoot: string;
  /** Public hostname, when one is known. DNS and TLS checks need it. */
  domain?: string | undefined;
  /** The resolved environment, when one exists. Database checks need it. */
  env?: ReadonlyMap<string, string> | undefined;
  fs?: CheckFs | undefined;
  totalMemoryBytes?: (() => number) | undefined;
  portFree?: ((port: number) => Promise<boolean>) | undefined;
  portListening?: ((port: number) => Promise<boolean>) | undefined;
  /** Resolves DNS; injected so the DNS checks (#177) are testable. */
  resolveHost?: ((hostname: string) => Promise<string[]>) | undefined;
  /** This host's own public addresses, when they can be determined. */
  ownAddresses?: (() => Promise<string[]>) | undefined;
  /**
   * How the shared proxy runs, resolved once by the command building this
   * context (see `resolveProxyRuntime`). Absent means unknown, and the checks
   * that care fall back to their historical host-mode behaviour.
   */
  proxyRuntime?: ProxyRuntime | undefined;
  /** Reads the certificate served on the wire; injected so no test opens a socket. */
  servedCertificate?: ((domain: string) => Promise<ServedCertificate>) | undefined;
  /**
   * The repository this deployment clones or fetches, when it is known (a
   * flag, the deployment record, or the checkout's `origin`). Display-safe:
   * normalised, so it carries no embedded credential.
   */
  repoUrl?: string | undefined;
  /**
   * Whether git can ALREADY read `repoUrl` without a prompt -- a public
   * repository, a credential helper, a stored token. Computed ONCE by the
   * command building this context (see `gitCredentialStateFor`), because
   * `severityFor` must stay synchronous and cheap. Absent means "not probed":
   * nothing is promoted on an unknown.
   */
  gitCredentialed?: boolean | undefined;
  /**
   * True when this run will NOT publish through the shared proxy (install or
   * update with --skip-proxy). The proxy prerequisites are then advice, not
   * blockers. Doctor leaves it unset: it asks about a deployment in general.
   */
  skipProxy?: boolean | undefined;
  /**
   * True when this run is authorised to BOOTSTRAP the shared proxy if it is
   * absent (#391: `--bootstrap-proxy`, or a yes at install's prompt). A proxy
   * container that does not exist, in a proxy root with no compose file, is
   * then not a blocker -- install is about to create it. An existing but
   * stopped proxy, or a root with a compose file, still fails: those belong to
   * somebody else and are never touched.
   */
  proxyBootstrap?: boolean | undefined;
}

export type Severity = 'required' | 'recommended';

export interface Check {
  /** Stable, kebab-case. Used by --json and by tests. */
  id: string;
  title: string;
  /**
   * The static severity: what the check is when nothing about the context
   * says otherwise. Read it through `severityOf`, never directly, once a
   * context exists.
   */
  severity: Severity;
  /**
   * The severity for THIS context, when it depends on one -- `certbot-installed`
   * is required only when the proxy runs on the host. Must be read-only and
   * cheap; a throw falls back to `severity`.
   */
  severityFor?: ((context: CheckContext) => Severity) | undefined;
  /** Ids that must pass first; otherwise this reports `skip`. */
  requires?: readonly string[] | undefined;
  run(context: CheckContext): Promise<CheckResult>;
}

/**
 * A check's EFFECTIVE severity in a context.
 *
 * ⚠ Everything that decides an exit code -- `requiredChecks`, `checksPassed`
 * via `CompletedCheck.severity`, the doctor and preflight renderers -- goes
 * through this, so a check promoted or demoted by its context is promoted or
 * demoted everywhere at once rather than in whichever caller remembered.
 */
export function severityOf(check: Check, context: CheckContext): Severity {
  if (check.severityFor === undefined) return check.severity;
  try {
    return check.severityFor(context);
  } catch {
    // Rule 1 extends to this: a broken severity function must not abort the
    // run. The static severity is the documented fallback.
    return check.severity;
  }
}

export interface CompletedCheck extends CheckResult {
  id: string;
  title: string;
  /** The EFFECTIVE severity this run evaluated it under -- see `severityOf`. */
  severity: Severity;
  durationMs: number;
}

export function contextFs(context: CheckContext): CheckFs {
  return context.fs ?? realFs;
}

export function contextMemory(context: CheckContext): number {
  return (context.totalMemoryBytes ?? totalmem)();
}

export function contextPortFree(context: CheckContext): (port: number) => Promise<boolean> {
  return context.portFree ?? isLoopbackPortFree;
}

export function contextServedCertificate(
  context: CheckContext,
): (domain: string) => Promise<ServedCertificate> {
  return context.servedCertificate ?? ((domain) => fetchServedCertificate(domain));
}

export function contextPortListening(
  context: CheckContext,
): (port: number) => Promise<boolean> {
  return context.portListening ?? isPortListening;
}

/**
 * Runs the registry in order, honouring `requires`.
 *
 * A check that throws is reported as a failure and the run continues - rule 1.
 * `onResult` fires as each completes so a command can stream a checklist
 * rather than appearing to hang through a dozen subprocess calls.
 */
export async function runChecks(
  checks: readonly Check[],
  context: CheckContext,
  onResult?: (result: CompletedCheck) => void,
): Promise<CompletedCheck[]> {
  const results: CompletedCheck[] = [];
  const byId = new Map<string, CompletedCheck>();

  for (const check of checks) {
    const startedAt = Date.now();

    const unmet = (check.requires ?? []).filter(
      (id) => byId.get(id)?.status !== 'pass',
    );

    const result: CheckResult =
      unmet.length > 0
        ? {
            status: 'skip',
            // Named, so a wall of skips explains itself rather than looking
            // like the checks silently did nothing.
            detail: `skipped: ${unmet.join(', ')} did not pass`,
          }
        : await check.run(context).catch((error: unknown) => ({
            status: 'fail' as const,
            detail: error instanceof Error ? error.message : String(error),
            remedy: 'This check itself failed; the problem may be with appctl.',
          }));

    const completed: CompletedCheck = {
      ...result,
      id: check.id,
      title: check.title,
      severity: severityOf(check, context),
      durationMs: Date.now() - startedAt,
    };

    results.push(completed);
    byId.set(check.id, completed);
    onResult?.(completed);
  }

  return results;
}

/**
 * True when every required check passed. Warnings do not fail a run.
 *
 * Reads `CompletedCheck.severity`, which `runChecks` already set to the
 * EFFECTIVE severity, so a context-promoted check fails the run here too.
 */
export function checksPassed(results: readonly CompletedCheck[]): boolean {
  return !results.some(
    (result) => result.severity === 'required' && result.status === 'fail',
  );
}

export interface CheckSummary {
  passed: number;
  warned: number;
  failed: number;
  skipped: number;
}

export function summarise(results: readonly CompletedCheck[]): CheckSummary {
  return {
    passed: results.filter((result) => result.status === 'pass').length,
    warned: results.filter((result) => result.status === 'warn').length,
    failed: results.filter((result) => result.status === 'fail').length,
    skipped: results.filter((result) => result.status === 'skip').length,
  };
}
