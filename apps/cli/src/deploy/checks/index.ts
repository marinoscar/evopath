import type { Check, CheckContext } from './types.js';
import { severityOf } from './types.js';
import { DATABASE_CHECKS } from './database.js';
import { DNS_CHECKS } from './dns.js';
import { HOST_CHECKS } from './host.js';
import { SOURCE_CHECKS } from './source.js';
import { TLS_CHECKS } from './tls.js';

// =============================================================================
// The check registry  (issue #176, epic #168)
// =============================================================================
//
// ONE ordered list. `doctor` renders it (#178), and install and update run the
// `required` subset as their preflight (#180, #182) - from here, not from a
// second list of their own. Two lists is how a prerequisite ends up enforced
// by one command and not the other.
// =============================================================================

// Host first: everything else depends on docker being usable, and a server
// with no docker should say so before it starts probing databases.
export const ALL_CHECKS: readonly Check[] = [
  ...HOST_CHECKS,
  // After git-installed (in HOST_CHECKS), which gh-installed requires.
  ...SOURCE_CHECKS,
  ...DATABASE_CHECKS,
  ...DNS_CHECKS,
  ...TLS_CHECKS,
];

/**
 * The subset install and update must pass before they touch anything.
 *
 * ⚠ PASS THE CONTEXT. With one, the filter uses each check's EFFECTIVE
 * severity (`severityOf`), so a check its context promotes to required -- a
 * renewal config with host paths in container mode, say -- is in the preflight.
 * Without one, only the static severity is known, which is the historical
 * behaviour and is kept for callers that have no context yet.
 */
export function requiredChecks(
  checks: readonly Check[] = ALL_CHECKS,
  context?: CheckContext,
): Check[] {
  return checks.filter((check) =>
    context === undefined
      ? check.severity === 'required'
      : severityOf(check, context) === 'required',
  );
}

export * from './types.js';
export { HOST_CHECKS, evaluateDf, probe } from './host.js';
export {
  SOURCE_CHECKS,
  SOURCE_CHECK_IDS,
  gitCredentialStateFor,
  gitHasCredentialFor,
  isHttpsGithubUrl,
  needsGithubCli,
  nonInteractiveGitEnv,
} from './source.js';
export {
  DATABASE_CHECKS,
  MAINTENANCE_DATABASE,
  canCreateDatabase,
  databaseSettings,
  probeTcp,
  runPsql,
  type CreateDatabaseCapability,
  type DatabaseSettings,
  type PsqlResult,
} from './database.js';
export { DNS_CHECKS } from './dns.js';
export {
  CLI_RENEWAL_CRON_PATH,
  TLS_CHECKS,
  cronCommandPaths,
  cronLines,
  detectRenewalOwner,
  parseNotAfter,
  renewsWithCertbot,
  type RenewalMechanism,
  type RenewalOwnerKind,
  type RenewalOwnership,
  type RenewalProbe,
} from './tls.js';
