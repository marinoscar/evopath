/**
 * Rebuilding a deployment record from the deployment itself.
 *
 * When `deployment-evidence.ts` says a directory IS a deployment but no record
 * is present, the answer is to adopt it -- not to refuse, and not to send the
 * operator to `install`, whose precondition is the opposite of the situation
 * they are in.
 *
 * The rule that governs everything here: INVENT NOTHING.
 *
 * `installedAt` is genuinely unknowable from the filesystem. It is NOT
 * approximated from a directory mtime, which records the last write to the
 * directory and not the install. An adopted record says `adoptedAt` -- a third
 * axis, distinct from both `installedAt` and `lastDeployedAt` -- so a later
 * reader can tell "this was adopted, and the earlier history is unknown" from
 * "this was installed then, and last deployed then".
 *
 * `lastDeployedAt` is likewise absent rather than guessed. Its idiom is
 * "absent means no deploy has ever completed here", and an adopted deployment
 * has certainly deployed -- but nothing on disk says when, and a fabricated
 * instant is worse than an honest gap.
 */
import { CLI_VERSION } from '../package-info.js';
import { isDeployment, resolveEnvPath } from './deployment-evidence.js';
import { readEnvFile } from './env-file.js';
import { DEPLOY_STATE_VERSION, type DeployState } from './state.js';

export interface AdoptOptions {
  deployRoot: string;
  /** Resolved from the checkout's own origin. Never hardcoded. */
  repoUrl: string;
  ref: string;
  commitSha: string;
  /** Default bind port, used only when the `.env` does not name one. */
  fallbackBindPort: number;
}

export class NotAdoptableError extends Error {}

/**
 * Builds a record for a deployment the CLI has no record of.
 *
 * Facts come from three places, in order of trust: the clone (revision), the
 * `.env` (port, domain), and the caller (the defaults it was invoked with).
 * Anything none of them knows is left absent.
 */
export function adoptDeployment(options: AdoptOptions): DeployState {
  const { deployRoot } = options;

  if (!isDeployment(deployRoot)) {
    throw new NotAdoptableError(
      `${deployRoot} does not look like a deployment: it needs both a checkout and a readable environment file.`,
    );
  }

  const envPath = resolveEnvPath(deployRoot);
  const env = envPath === undefined ? new Map<string, string>() : readEnvFile(envPath);

  const declaredPort = Number(env.get('APP_BIND_PORT'));
  const bindPort =
    Number.isInteger(declaredPort) && declaredPort > 0
      ? declaredPort
      : options.fallbackBindPort;

  // APP_URL is the only place a deployment records its own hostname when the
  // CLI did not write the record. Parsed, never pattern-matched: a malformed
  // value leaves the domain absent rather than producing a plausible wrong one.
  const domain = hostnameFrom(env.get('APP_URL'));

  return {
    version: DEPLOY_STATE_VERSION,
    repoUrl: options.repoUrl,
    ref: options.ref,
    commitSha: options.commitSha,
    ...(domain === undefined ? {} : { domain }),
    bindPort,
    deployRoot,
    // Unknowable, and deliberately not approximated from a directory mtime.
    installedAt: '',
    lastDeployedAt: '',
    lastCommand: 'update',
    appctlVersion: CLI_VERSION,
    adoptedAt: new Date().toISOString(),
  } as DeployState;
}

function hostnameFrom(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  try {
    const { hostname } = new URL(url);
    return hostname === '' ? undefined : hostname;
  } catch {
    return undefined;
  }
}
