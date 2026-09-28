import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// =============================================================================
// GreptimeDB host resolution — telling "no such host" from "timed out"
// (issue #564, epic #528)
// =============================================================================
//
// When the GreptimeDB host does not exist on the network at all (the usual
// case: the automatic host `greptimedb` names a container that is not running
// on this deployment yet), Docker's embedded DNS takes ~5 s to give up and answer
// `getaddrinfo EAI_AGAIN greptimedb`. That is just past
// `GREPTIME_CONNECT_TIMEOUT_MS`, so the connect attempt loses the race and the
// administrator is told "timeout expired" / "Connection terminated due to
// connection timeout" — the real, actionable cause is swallowed.
//
// This module resolves the host ON ITS OWN, under a much longer ceiling, so a
// DNS failure is reported as what it is:
//
//   - the connection test resolves the candidate host once, before probing;
//   - `GreptimeClient` resolves the host only AFTER a connect attempt failed
//     with a timeout (never on the success path: every query would pay for a
//     lookup).
//
// It never throws. `null` means "nothing to report" — the host resolved, is an
// IP literal, the lookup failed for a non-DNS reason, or the lookup itself ran
// out of time (inconclusive: let the connect attempt speak).
// =============================================================================

/**
 * How long a host lookup may take before it is treated as inconclusive.
 *
 * Deliberately far beyond Docker's ~5 s EAI_AGAIN retry window, and separate
 * from `GREPTIME_CONNECT_TIMEOUT_MS`: the whole point is to outlast the
 * resolver long enough to hear its verdict, which the connect timeout cannot.
 * It only runs when the host is about to be (or was just) unreachable, so the
 * wait costs nothing on a healthy connection.
 */
export const GREPTIME_DNS_TIMEOUT_MS = 15_000;

/** `getaddrinfo` / `dns` error codes that mean "no host by that name". */
export const DNS_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EAI_FAIL',
  'EAI_NODATA',
]);

/** Resolves a host name; rejects with a `code`-carrying error when it cannot. */
export type HostLookup = (host: string) => Promise<unknown>;

const defaultLookup: HostLookup = (host) => dnsLookup(host);

/** Whether an error is a name-resolution failure (checks its `code`). */
export function isDnsError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' && DNS_ERROR_CODES.has(code);
}

/** Whether the host being checked is the automatic (deployment) host or one the administrator typed. */
export interface HostCheckOptions {
  /**
   * `true` when the host is the deployment host an automatic (blank) host
   * resolves to; `false` (the default) for a literal the administrator set.
   */
  automatic?: boolean;
}

/**
 * The administrator-facing explanation of a DNS failure for `host`.
 *
 * ⚠ Shown in `/admin/settings/telemetry`. It must never tell an administrator
 * to start compose files, edit files or run the CLI: GreptimeDB ships with
 * every deployment, so an automatic host that does not resolve is fixed from
 * this same page ("Deploy GreptimeDB" in its Telemetry services section, #567),
 * and a custom one by correcting (or clearing) it.
 */
export function hostNotFoundMessage(host: string, error: unknown, options: HostCheckOptions = {}): string {
  const detail = error instanceof Error ? error.message : String(error);

  if (options.automatic) {
    return (
      `GreptimeDB is not running alongside this application: the built-in host "${host}" does not exist on its network (${detail}). ` +
      'GreptimeDB is deployed with the application but its container is not running. ' +
      'Use "Deploy GreptimeDB" in the Telemetry services section of this page to start it.'
    );
  }

  return (
    `GreptimeDB host "${host}" could not be resolved (${detail}): no host by that name exists on this network. ` +
    'Check the host name, or clear it to use the GreptimeDB deployed with this application.'
  );
}

/**
 * Resolves `host` and returns a human message when it does not exist, else
 * `null` (see the header for every `null` case). Never throws.
 */
export async function checkHostResolves(
  host: string,
  lookup: HostLookup = defaultLookup,
  timeoutMs = GREPTIME_DNS_TIMEOUT_MS,
  options: HostCheckOptions = {},
): Promise<string | null> {
  if (!host || isIP(host) !== 0) return null;

  let timer: NodeJS.Timeout | undefined;

  const TIMED_OUT = Symbol('timed-out');
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });

  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(lookup(host));
  } catch (error) {
    // A lookup that throws synchronously is still a verdict.
    return isDnsError(error) ? hostNotFoundMessage(host, error, options) : null;
  }

  // Settle to a value either way, so a late rejection (after the timeout won)
  // is never an unhandled one.
  const outcome = pending.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  try {
    const result = await Promise.race([outcome, timeout]);

    if (result === TIMED_OUT || result.ok) return null;

    return isDnsError(result.error) ? hostNotFoundMessage(host, result.error, options) : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
