import { ENV_METADATA } from './env-metadata.js';

// =============================================================================
// Are the Google OAuth credentials right?  (issue #391, epic #388)
// =============================================================================
//
// The wizard rejects a PLACEHOLDER client id. It cannot tell a well-formed
// wrong value from a right one, and a wrong client secret is not discovered
// until the first user tries to sign in -- after the build, the migration, the
// seed, the certificate and the vhost. Three layers, cheapest first:
//
//   1. SHAPE. A Google client id is `<digits>-<token>.apps.googleusercontent.com`.
//      A value that is not is a paste error, found in microseconds.
//   2. CALLBACK. GOOGLE_CALLBACK_URL must be exactly
//      `https://<domain>/api/auth/google/callback` -- the top row of the
//      runbook's troubleshooting table, and a mismatch that looks right.
//   3. A LIVE PROBE of the credentials themselves: a token request carrying a
//      deliberately invalid authorization code. Google checks the CLIENT
//      before the code, so
//        - `invalid_client` / `unauthorized_client` => the credentials are wrong;
//        - `invalid_grant`                          => the credentials were
//          ACCEPTED and only the code was rejected -- a PASS.
//      No browser, no user, no token issued. A network failure is a WARNING,
//      never a failure: an egress firewall is not a wrong secret.
//
// ⚠ THE SECRET NEVER LEAVES THIS MODULE IN A STRING. It travels only in the
// request body; no detail, remedy or thrown message built here contains it.
// The install pipeline also registers it with the journal's redactor BEFORE
// this runs (`Journal.addSecrets`), so even a runtime error quoting the request
// cannot put it in the log.
// =============================================================================

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** `<project number>-<token>.apps.googleusercontent.com`. */
export const GOOGLE_CLIENT_ID_SHAPE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/**
 * The code sent to the token endpoint. Not a real code, and recognisably not
 * one, so a request that somehow surfaced in Google's logs explains itself.
 */
export const INVALID_PROBE_CODE = 'deploy-credential-probe-not-a-real-code';

const PROBE_TIMEOUT_MS = 10_000;

export type OAuthFindingId = 'oauth-client-id' | 'oauth-callback-url' | 'oauth-credentials';

export interface OAuthFinding {
  id: OAuthFindingId;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail: string;
  remedy?: string | undefined;
}

export type FetchLike = typeof globalThis.fetch;

const CONSOLE = 'Google Cloud Console > APIs & Services > Credentials';

/** The callback the application must be configured with for `domain`. */
export function expectedCallbackUrl(domain: string): string {
  // From the metadata the wizard itself derives it with, so the two cannot
  // disagree about the path.
  return (
    ENV_METADATA.GOOGLE_CALLBACK_URL?.derive?.({ domain, answers: new Map() }) ??
    `https://${domain}/api/auth/google/callback`
  );
}

/**
 * Layer 1. `lenient` (--skip-oauth-check) turns a malformed id into a warning:
 * a test deployment with dummy credentials must still be installable.
 */
export function checkClientIdShape(clientId: string | undefined, options: { lenient?: boolean } = {}): OAuthFinding {
  const value = (clientId ?? '').trim();
  if (value === '') {
    return {
      id: 'oauth-client-id',
      status: options.lenient === true ? 'warn' : 'fail',
      detail: 'GOOGLE_CLIENT_ID is empty',
      remedy: `Set it to the OAuth client id from the ${CONSOLE}.`,
    };
  }
  if (GOOGLE_CLIENT_ID_SHAPE.test(value)) {
    return { id: 'oauth-client-id', status: 'pass', detail: 'GOOGLE_CLIENT_ID is well formed' };
  }
  return {
    id: 'oauth-client-id',
    status: options.lenient === true ? 'warn' : 'fail',
    detail: 'GOOGLE_CLIENT_ID does not look like a Google OAuth client id (<number>-<id>.apps.googleusercontent.com)',
    remedy: `Copy the client id again from the ${CONSOLE}; a partial or mis-pasted value fails every sign-in.`,
  };
}

/** Layer 2. Exact comparison: a trailing slash or `http://` is a real mismatch. */
export function checkCallbackUrl(configured: string | undefined, domain: string): OAuthFinding {
  const expected = expectedCallbackUrl(domain);
  if ((configured ?? '') === expected) {
    return { id: 'oauth-callback-url', status: 'pass', detail: expected };
  }
  return {
    id: 'oauth-callback-url',
    status: 'fail',
    detail: `GOOGLE_CALLBACK_URL is ${configured === undefined || configured === '' ? 'not set' : `"${configured}"`}, not ${expected}`,
    remedy:
      `Set GOOGLE_CALLBACK_URL=${expected} in the environment file, and make sure the same URL is an ` +
      `Authorized redirect URI of the client in the ${CONSOLE}.`,
  };
}

/**
 * Layer 3, the pure half: what a token-endpoint answer means. Exported for
 * its test, which is where `invalid_grant => pass` is pinned.
 */
export function classifyTokenResponse(
  status: number,
  body: unknown,
  redirectUri: string,
): OAuthFinding {
  const error =
    typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : undefined;

  if (error === 'invalid_grant') {
    return {
      id: 'oauth-credentials',
      status: 'pass',
      detail: 'Google accepted the client id and secret (the deliberately invalid code was rejected)',
    };
  }
  if (error === 'invalid_client' || error === 'unauthorized_client') {
    return {
      id: 'oauth-credentials',
      status: 'fail',
      detail: `Google rejected the client credentials (${error})`,
      remedy:
        `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET do not belong together, or the client was deleted. ` +
        `Copy both again from the ${CONSOLE}.`,
    };
  }
  if (error === 'redirect_uri_mismatch') {
    return {
      id: 'oauth-credentials',
      status: 'fail',
      detail: `Google accepted the client but does not allow the redirect URI ${redirectUri}`,
      remedy: `Add ${redirectUri} to the client's Authorized redirect URIs in the ${CONSOLE}.`,
    };
  }
  return {
    id: 'oauth-credentials',
    status: 'warn',
    detail: `could not verify the credentials: Google answered HTTP ${status}${error === undefined ? '' : ` (${error})`}`,
    remedy: 'Sign in once after the install to confirm the credentials work.',
  };
}

export interface ProbeCredentialsOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  endpoint?: string | undefined;
}

/** Layer 3. Never throws: a network failure is a warning. */
export async function probeGoogleCredentials(options: ProbeCredentialsOptions): Promise<OAuthFinding> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: INVALID_PROBE_CODE,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
  });

  let response: Response;
  try {
    response = await doFetch(options.endpoint ?? GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      id: 'oauth-credentials',
      status: 'warn',
      // The error's NAME and code only: a message could in principle quote the
      // request, and the request carries the secret.
      detail: `could not reach Google to verify the credentials (${describeNetworkError(error)})`,
      remedy:
        'This server may not have outbound HTTPS to oauth2.googleapis.com. Sign in once after the install to confirm the credentials work.',
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return classifyTokenResponse(response.status, parsed, options.redirectUri);
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timed out';
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'network error';
}

export interface OAuthCheckOptions {
  env: ReadonlyMap<string, string>;
  /** The public domain, when one is being published. Enables layer 2. */
  domain?: string | undefined;
  /** --skip-oauth-check: no live probe, and a malformed id only warns. */
  skipLiveProbe?: boolean | undefined;
  fetch?: FetchLike | undefined;
}

export interface OAuthCheckResult {
  findings: OAuthFinding[];
  /** False when any finding failed. */
  ok: boolean;
}

/** All three layers, cheapest first. The live probe runs only if 1 and 2 pass. */
export async function runOAuthCheck(options: OAuthCheckOptions): Promise<OAuthCheckResult> {
  const lenient = options.skipLiveProbe === true;
  const clientId = options.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = options.env.get('GOOGLE_CLIENT_SECRET') ?? '';
  const configuredCallback = options.env.get('GOOGLE_CALLBACK_URL');

  const findings: OAuthFinding[] = [checkClientIdShape(clientId, { lenient })];

  if (options.domain !== undefined) {
    findings.push(checkCallbackUrl(configuredCallback, options.domain));
  } else {
    findings.push({ id: 'oauth-callback-url', status: 'skip', detail: 'no domain to compare it with' });
  }

  const blocked = findings.some((finding) => finding.status === 'fail' || finding.status === 'warn');
  if (lenient) {
    findings.push({ id: 'oauth-credentials', status: 'skip', detail: 'skipped with --skip-oauth-check' });
  } else if (blocked) {
    // Probing a malformed id or a wrong callback only produces a second,
    // noisier report of the same problem.
    findings.push({ id: 'oauth-credentials', status: 'skip', detail: 'skipped: fix the findings above first' });
  } else if (clientSecret.trim() === '') {
    findings.push({
      id: 'oauth-credentials',
      status: 'fail',
      detail: 'GOOGLE_CLIENT_SECRET is empty',
      remedy: `Set it from the ${CONSOLE}.`,
    });
  } else {
    findings.push(
      await probeGoogleCredentials({
        clientId: (clientId ?? '').trim(),
        clientSecret,
        redirectUri:
          configuredCallback !== undefined && configuredCallback !== ''
            ? configuredCallback
            : expectedCallbackUrl(options.domain ?? 'localhost'),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    );
  }

  return { findings, ok: !findings.some((finding) => finding.status === 'fail') };
}
