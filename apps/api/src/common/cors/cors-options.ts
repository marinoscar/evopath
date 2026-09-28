// =============================================================================
// CORS policy from CORS_ORIGIN  (issue #517)
// =============================================================================
//
// The application is SAME-ORIGIN by design: nginx serves the web app at `/` and
// the API at `/api`, and the Vite dev server proxies `/api` the same way. The
// `appctl` CLI and worker nodes are not browsers, so CORS never applies to them.
// No first-party caller therefore needs a single CORS header.
//
// The previous `origin: process.env.CORS_ORIGIN || true` with
// `credentials: true` REFLECTED ANY ORIGIN with credentials allowed, because
// CORS_ORIGIN was set nowhere: every website on the internet was a trusted
// cross-origin caller of this API. This module replaces it with a closed
// default and an explicit allowlist.
//
//   unset / empty / only commas  -> `{ origin: false }`: no CORS headers at
//                                   all, so browsers enforce same-origin.
//   `https://a.example,https://b.example`
//                                -> `{ origin: [...], credentials: true }`:
//                                   exactly those origins, nothing reflected.
//
// Misconfiguration THROWS, and is meant to be called during bootstrap so the
// process exits before binding the port (the same posture as the
// TEST_AUTH_ENABLED guard and the SECRETS_ENCRYPTION_KEY check in main.ts):
//
//   - `*` anywhere in the list. A credentialed wildcard is never valid - browsers
//     refuse it - and "allow everyone with cookies" is the bug this replaces.
//   - An entry that is not exactly a serialized origin (`scheme://host[:port]`,
//     http or https, lowercase host, no default port, no path, no trailing
//     slash). The browser's `Origin` header is compared byte for byte, so
//     `https://app.example.com/` or `https://App.example.com` would silently
//     never match; failing loudly at startup beats a CORS error in a browser
//     console nobody connects to this variable.
//
// Pure: no process.env, no logging. main.ts passes the raw value in and logs
// the resulting mode.
// =============================================================================

/** No CORS headers are emitted; the browser's same-origin policy applies. */
export interface SameOriginCorsOptions {
  origin: false;
}

/** Exactly these origins may call the API cross-origin, with credentials. */
export interface AllowlistCorsOptions {
  origin: string[];
  credentials: true;
}

/**
 * Structurally assignable to `FastifyCorsOptions`, which
 * `NestFastifyApplication.enableCors` takes. Declared here rather than imported
 * because `@fastify/cors` is only a transitive dependency of this workspace.
 */
export type CorsOptions = SameOriginCorsOptions | AllowlistCorsOptions;

/** Raised for a CORS_ORIGIN value the API refuses to start with. */
export class InvalidCorsOriginError extends Error {
  constructor(message: string) {
    super(`Invalid CORS_ORIGIN: ${message}`);
    this.name = 'InvalidCorsOriginError';
  }
}

/**
 * Parses the raw CORS_ORIGIN value into the options for `app.enableCors`.
 *
 * Comma-separated; each entry is trimmed and empty entries are dropped, so
 * `" https://a.example , ,https://b.example "` yields two origins. Duplicates
 * are collapsed, keeping first-seen order.
 *
 * @throws InvalidCorsOriginError for a wildcard or a malformed origin.
 */
export function buildCorsOptions(raw: string | undefined): CorsOptions {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (entries.length === 0) {
    return { origin: false };
  }

  for (const entry of entries) {
    assertSerializedOrigin(entry);
  }

  return { origin: [...new Set(entries)], credentials: true };
}

/** True when the options leave the API same-origin only. */
export function isSameOriginOnly(
  options: CorsOptions,
): options is SameOriginCorsOptions {
  return options.origin === false;
}

function assertSerializedOrigin(entry: string): void {
  if (entry.includes('*')) {
    throw new InvalidCorsOriginError(
      `"${entry}" is a wildcard. The API sends credentials (the refresh-token ` +
        'cookie), and a credentialed wildcard is never valid. List each ' +
        'trusted origin explicitly, comma-separated, or leave CORS_ORIGIN ' +
        'unset for same-origin only.',
    );
  }

  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new InvalidCorsOriginError(
      `"${entry}" is not a URL. Expected an origin such as ` +
        'https://app.example.com (scheme and host, optional port, no path).',
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidCorsOriginError(
      `"${entry}" must use http or https. Expected an origin such as ` +
        'https://app.example.com.',
    );
  }

  if (url.origin !== entry) {
    throw new InvalidCorsOriginError(
      `"${entry}" is not an exact origin; browsers would send ` +
        `"${url.origin}", which would never match. Use the scheme and host ` +
        'only (lowercase, optional non-default port, no path, no trailing slash).',
    );
  }
}
