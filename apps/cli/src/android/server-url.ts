import { CLI_NAME } from '../branding.js';
import { resolveConfig, type ConfigContext } from '../config.js';
import type { ApkMetadata } from './metadata.js';
import { sameServer } from './release-status.js';

// =============================================================================
// Which server an APK is built for  (issue #318)
// =============================================================================
//
// The app claims https links (and so Chrome's Web Push delegation) only for
// the host of the server URL it was built with (`-Pevopath.serverUrl` →
// manifest placeholder `twaHost`). Built without one, it claims
// `invalid.example` and every notification shows as Chrome's, not the app's.
//
// So `android build` / `android release` (and the TUI) default to the server
// of the stored login — the same one `publish` uploads to — when no
// `--server-url` is given, and say loudly when there is none at all.
// =============================================================================

export type BuildServerUrlSource = 'flag' | 'login' | 'none';

export interface BuildServerUrl {
  serverUrl: string | undefined;
  source: BuildServerUrlSource;
}

export const NO_SERVER_URL_WARNING =
  '⚠ No server URL: this APK will not receive notifications as the app (Chrome will show them). ' +
  `Pass --server-url https://<server> or log in first (\`${CLI_NAME} login\`).`;

/** An explicit `--server-url` wins; otherwise the stored login's server; otherwise none. */
export function resolveBuildServerUrl(explicit: string | undefined, ctx?: ConfigContext): BuildServerUrl {
  if (explicit !== undefined && explicit.trim() !== '') return { serverUrl: explicit.trim(), source: 'flag' };
  const stored = resolveConfig(ctx).serverUrl;
  if (stored !== undefined && stored.trim() !== '') return { serverUrl: stored.trim(), source: 'login' };
  return { serverUrl: undefined, source: 'none' };
}

/** The line the build output carries, naming the server the APK is tied to. */
export function builtForLine(resolved: BuildServerUrl): string {
  if (resolved.serverUrl === undefined) return 'Built for no server: notifications will show as Chrome\'s, not the app\'s.';
  return `Built for ${resolved.serverUrl}${resolved.source === 'login' ? ' (the logged-in server)' : ''}`;
}

/**
 * A warning when the APK being published was built for another server (or
 * none). `undefined` when they match, or when the metadata predates #318 and
 * does not record a server.
 */
export function publishServerWarning(metadata: Pick<ApkMetadata, 'serverUrl'>, publishTo: string): string | undefined {
  if (metadata.serverUrl === undefined) return undefined;
  if (metadata.serverUrl === null) {
    return `⚠ This APK was built without a server URL: on ${publishTo} its notifications will show as Chrome's, not the app's. Rebuild with --server-url ${publishTo}.`;
  }
  if (sameServer(metadata.serverUrl, publishTo)) return undefined;
  return `⚠ This APK was built for ${metadata.serverUrl}, not ${publishTo}: on ${publishTo} its notifications will show as Chrome's, not the app's. Rebuild with --server-url ${publishTo}.`;
}
