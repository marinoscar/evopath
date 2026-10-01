import { ApiClient, resolveApiBaseUrl } from '../api-client.js';
import { isExpired, resolveConfig, type ConfigContext, type ConfigSource } from '../config.js';
import type { CurrentUser } from '../device-login.js';
import { ApiError, formatError } from '../errors.js';
import { readSigningConfig } from './keystore.js';
import { versionPropertiesPath } from './paths.js';
import type { AndroidRelease } from './publish.js';
import { readVersion, type AppVersion } from './version.js';

// =============================================================================
// Release status: where the local APK version stands against a server  (#291)
// =============================================================================
//
// One answer to "can I release, and would it be newer?", shared by the TUI's
// Android screen (#291) and `deploy … --with-android` (#292):
//
//   local     apps/android/version.properties
//   keystore  ~/.<cli>/android/signing.json (its cached certificate SHA-256)
//   login     the stored login (or the env override), checked against the
//             target server and `GET /api/auth/me` for `system_settings:write`
//   server    `GET /api/android-app/releases/latest` (any authenticated user)
//
// THE TOKEN NEVER LEAVES THIS MODULE'S LOCALS. `ReleaseStatus` has no field
// that could hold one, so a screen that keeps it in React state cannot render
// it. Actions that need the token read it again at the moment they act, with
// `credentialsForServer`.
// =============================================================================

/** The permission the release upload and make-current endpoints enforce. */
export const PUBLISH_PERMISSION = 'system_settings:write';

/** Any authenticated user may read the current release. */
export const LATEST_RELEASE_PATH = '/android-app/releases/latest';

export type LoginState = 'logged_in' | 'logged_out' | 'expired' | 'other_server';

export interface ReleaseLoginStatus {
  state: LoginState;
  /** The server the stored login (or env override) points at. */
  serverUrl?: string | undefined;
  /** Where the token came from, when there is one. */
  source?: ConfigSource | undefined;
  /** True only when `/auth/me` confirmed `system_settings:write`. */
  canPublish: boolean;
  email?: string | undefined;
  /** Why `/auth/me` could not answer (network, 5xx), when it could not. */
  error?: string | undefined;
}

export interface ReleaseServerStatus {
  /** `null` when nothing is published, or when it could not be read. */
  current: AndroidRelease | null;
  /** True when the server answered the latest-release request (404 NO_RELEASE included). */
  reachable: boolean;
  error?: string | undefined;
}

export interface ReleaseStatus {
  repoRoot: string | undefined;
  /** The server this status was computed for: the given one, else the login's. */
  targetServerUrl: string | undefined;
  local: AppVersion | null;
  keystore: { configured: boolean; sha256?: string | undefined; error?: string | undefined };
  login: ReleaseLoginStatus;
  server: ReleaseServerStatus;
  /** Local versionCode is above the server's current one (or the server has none). */
  newerLocally: boolean;
}

export interface ReleaseStatusInput {
  repoRoot: string | undefined;
  /** Compare against this server; the login must be for it. Default: the login's own server. */
  serverUrl?: string | undefined;
}

export interface ReleaseStatusDeps {
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  now?: Date | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  signal?: AbortSignal | undefined;
  /** Test seam. */
  createClient?: ((apiBaseUrl: string, token: string) => ApiClient) | undefined;
}

/** Same server, whatever way it was typed (`app.example.com` vs `https://app.example.com/api/`). */
export function sameServer(a: string, b: string): boolean {
  try {
    return resolveApiBaseUrl(a).toLowerCase() === resolveApiBaseUrl(b).toLowerCase();
  } catch {
    return false;
  }
}

/** `local` is publishable over `current`: strictly higher code, or nothing published. */
export function isNewerLocally(local: AppVersion | null, server: ReleaseServerStatus): boolean {
  if (local === null || !server.reachable) return false;
  return server.current === null || local.versionCode > server.current.versionCode;
}

/**
 * The stored credentials, only when they belong to `serverUrl` (or to any
 * server when it is omitted). Read at the moment of acting; never kept.
 */
export function credentialsForServer(
  serverUrl: string | undefined,
  ctx?: ConfigContext,
): { serverUrl: string; token: string } | undefined {
  const resolved = resolveConfig(ctx);
  if (resolved.serverUrl === undefined || resolved.token === undefined) return undefined;
  if (serverUrl !== undefined && !sameServer(serverUrl, resolved.serverUrl)) return undefined;
  return { serverUrl: resolved.serverUrl, token: resolved.token };
}

function readLocal(repoRoot: string | undefined): AppVersion | null {
  if (repoRoot === undefined) return null;
  try {
    const version = readVersion(versionPropertiesPath(repoRoot));
    return { versionName: version.versionName, versionCode: version.versionCode };
  } catch {
    return null;
  }
}

function readKeystore(ctx: ConfigContext): ReleaseStatus['keystore'] {
  try {
    const signing = readSigningConfig({ ...(ctx.env === undefined ? {} : { env: ctx.env }), ...(ctx.home === undefined ? {} : { home: ctx.home }) });
    if (signing === undefined) return { configured: false };
    return { configured: true, ...(signing.certSha256 === undefined ? {} : { sha256: signing.certSha256 }) };
  } catch (error) {
    return { configured: false, error: formatError(error) };
  }
}

function isNoRelease(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 404) return false;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  return reason === 'NO_RELEASE' || error.code === 'NO_RELEASE';
}

export async function getReleaseStatus(input: ReleaseStatusInput, deps: ReleaseStatusDeps = {}): Promise<ReleaseStatus> {
  const ctx: ConfigContext = {
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.home === undefined ? {} : { home: deps.home }),
  };
  const local = readLocal(input.repoRoot);
  const keystore = readKeystore(ctx);
  const notReached = (error: string): ReleaseServerStatus => ({ current: null, reachable: false, error });

  let resolved;
  try {
    resolved = resolveConfig(ctx);
  } catch (error) {
    const login: ReleaseLoginStatus = { state: 'logged_out', canPublish: false, error: formatError(error) };
    return finish(input, local, keystore, login, notReached('Not logged in.'));
  }

  const target = input.serverUrl ?? resolved.serverUrl;
  const base = {
    ...(resolved.serverUrl === undefined ? {} : { serverUrl: resolved.serverUrl }),
    ...(resolved.tokenSource === undefined ? {} : { source: resolved.tokenSource }),
  };

  if (resolved.serverUrl === undefined || resolved.token === undefined) {
    return finish(input, local, keystore, { state: 'logged_out', canPublish: false, ...base }, notReached('Not logged in.'));
  }
  if (target !== undefined && !sameServer(target, resolved.serverUrl)) {
    return finish(
      input,
      local,
      keystore,
      { state: 'other_server', canPublish: false, ...base },
      notReached(`Logged in to ${resolved.serverUrl}, not ${target}.`),
    );
  }
  if (isExpired(resolved.expiresAt, deps.now ?? new Date()) === true) {
    return finish(input, local, keystore, { state: 'expired', canPublish: false, ...base }, notReached('The stored login has expired.'));
  }

  const apiBaseUrl = resolveApiBaseUrl(resolved.serverUrl);
  const token = resolved.token;
  const client =
    deps.createClient?.(apiBaseUrl, token) ??
    new ApiClient({ baseUrl: apiBaseUrl, token, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  const requestOptions = deps.signal === undefined ? undefined : { signal: deps.signal };

  let user: CurrentUser;
  try {
    user = await client.get<CurrentUser>('/auth/me', requestOptions);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return finish(
        input,
        local,
        keystore,
        { state: 'expired', canPublish: false, ...base, error: 'The server rejected the stored token (expired or revoked).' },
        notReached('The server rejected the stored token.'),
      );
    }
    const message = formatError(error);
    return finish(input, local, keystore, { state: 'logged_in', canPublish: false, ...base, error: message }, notReached(message));
  }

  const login: ReleaseLoginStatus = {
    state: 'logged_in',
    canPublish: Array.isArray(user.permissions) && user.permissions.includes(PUBLISH_PERMISSION),
    email: user.email,
    ...base,
  };

  let server: ReleaseServerStatus;
  try {
    const current = await client.get<AndroidRelease>(LATEST_RELEASE_PATH, requestOptions);
    server = { current, reachable: true };
  } catch (error) {
    server = isNoRelease(error) ? { current: null, reachable: true } : notReached(formatError(error));
  }
  return finish(input, local, keystore, login, server);
}

function finish(
  input: ReleaseStatusInput,
  local: AppVersion | null,
  keystore: ReleaseStatus['keystore'],
  login: ReleaseLoginStatus,
  server: ReleaseServerStatus,
): ReleaseStatus {
  return {
    repoRoot: input.repoRoot,
    targetServerUrl: input.serverUrl ?? login.serverUrl,
    local,
    keystore,
    login,
    server,
    newerLocally: isNewerLocally(local, server),
  };
}
