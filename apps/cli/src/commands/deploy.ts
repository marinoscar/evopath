import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { Command } from 'commander';

import { CLI_NAME } from '../branding.js';
import {
  ALL_CHECKS,
  checksPassed,
  gitCredentialStateFor,
  runChecks,
  summarise,
  type CheckContext,
  type CheckStatus,
  type CompletedCheck,
} from '../deploy/checks/index.js';
import { parseEnvFile } from '../deploy/env-spec.js';
import {
  collectHealth,
  isHealthy,
  type HealthReport,
  type ProbeResult,
} from '../deploy/health.js';
import { resolveRepoUrl } from '../deploy/repo.js';
import { readState } from '../deploy/state.js';
import { readAbout, renderAbout } from '../deploy/about.js';
import { readAnswersFile } from '../deploy/answers-file.js';
import { isDeployment, resolveEnvPath } from '../deploy/deployment-evidence.js';
import { readEnvFile } from '../deploy/env-file.js';
import { collectInventory, renderInventory } from '../deploy/inventory.js';
import {
  planUninstall,
  runUninstall,
  type UninstallPlan,
} from '../deploy/uninstall.js';
import {
  assertValidContainerName,
  certificateExpiry,
  parseProxyMode,
  renewCertificate,
  resolveRecordedProxyRuntime,
  RENEW_WITHIN_DAYS,
  type ProxyMode,
  type ProxyTarget,
  type ResolvedProxyRuntime,
} from '../deploy/proxy.js';
import {
  DEFAULT_APPS_ROOT,
  locateApp,
  type LocatedApp,
} from '../deploy/layout.js';
import {
  composeProjectFor,
  oauthSmokeTarget,
  runInstall,
  type InstallOptions,
} from '../deploy/install.js';
import { runUpdate, type UpdateOptions } from '../deploy/update.js';
import type { EnvGroup } from '../deploy/env-metadata.js';
import { runCommand } from '../deploy/executor.js';
import { CliError, EXIT, PreconditionError, UsageError, type ExitCode } from '../errors.js';
import { shouldUseColour } from '../output.js';

// =============================================================================
// `appctl deploy`  (issue #178, epic #168)
// =============================================================================
//
// The first user-facing surface of the deployment work, and the place the
// command GROUP is established - so the shape chosen here is the one every
// later subcommand follows.
//
// Two rules inherited from program.ts, neither negotiable here:
//
//   - HUMAN OUTPUT GOES TO STDERR. stdout carries `--json` and nothing else,
//     so `appctl deploy doctor --json | jq` is clean.
//   - FAILURE IS NON-ZERO. A doctor that prints failures and exits 0 makes
//     `doctor || provision-the-box` silently useless.
// =============================================================================

export const DEFAULT_DEPLOY_ROOT = '/opt/infra/apps';
export { DEFAULT_APPS_ROOT };
export const DEFAULT_PROXY_ROOT = '/opt/infra/proxy';
export const DEFAULT_BIND_PORT = 3535;

const PROXY_CONTAINER_HELP =
  'Name of the shared proxy container (default: as recorded, else proxy-nginx)';
const PROXY_MODE_HELP =
  'How the shared proxy runs: container or host (default: as recorded, else detected)';

/** The two proxy-runtime flags, as every subcommand that touches the proxy takes them. */
interface ProxyRuntimeFlags {
  proxyContainer?: string | undefined;
  proxyMode?: string | undefined;
}

/**
 * Validates the proxy-runtime flags BEFORE anything runs.
 *
 * Refused as a usage error rather than passed through: a mistyped mode must not
 * quietly become detection, and a container name reaches a docker argv.
 */
function proxyFlags(options: ProxyRuntimeFlags): { mode?: ProxyMode; container?: string } {
  const mode = options.proxyMode === undefined ? undefined : parseProxyMode(options.proxyMode);
  if (options.proxyContainer !== undefined) assertValidContainerName(options.proxyContainer);
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(options.proxyContainer === undefined ? {} : { container: options.proxyContainer }),
  };
}

const ESC = String.fromCharCode(27);
const RESET = ESC + '[0m';

export interface DoctorCommandOptions {
  /** Rank 1. Absent now means absent: the default was removed. */
  root?: string | undefined;
  /** Rank 2. */
  name?: string | undefined;
  appsRoot?: string | undefined;
  proxyRoot: string;
  port: string;
  domain?: string | undefined;
  proxyContainer?: string | undefined;
  proxyMode?: string | undefined;
  /** Repository to check access to; defaults to the record, then this checkout's origin. */
  repo?: string | undefined;
  json?: boolean | undefined;
  color: boolean;
}

export interface DeployContext {
  /** Injected so tests drive the checks without a server. */
  checks?: readonly import('../deploy/checks/index.js').Check[] | undefined;
  /**
   * Every subprocess a subcommand runs, including doctor's proxy-runtime
   * detection (`docker inspect`, `nginx -v`) -- inject it and nothing spawns.
   */
  runCommand?: typeof runCommand | undefined;
  stdout?: { write(chunk: string): unknown } | undefined;
  stderr?: { write(chunk: string): unknown } | undefined;
  isTty?: boolean | undefined;
  /** Injected so `status` can be tested without a running deployment. */
  fetch?: typeof globalThis.fetch | undefined;
}

export function registerDeployCommand(
  program: Command,
  ctx?: DeployContext,
): Command {
  const deploy = program
    .command('deploy')
    .description('Check, install and update this application on a server');

  deploy
    .command('doctor')
    .description('Check that this server meets the prerequisites')
    .option('--root <path>', 'Deployment directory (rank 1: an explicit path)')
    .option(
      '--apps-root <path>',
      'Directory holding the deployments (rank 3 walks up inside it)',
      DEFAULT_APPS_ROOT,
    )
    .option('--name <app>', 'Which deployment to act on, by name')
    .option('--proxy-root <path>', 'Shared reverse proxy directory', DEFAULT_PROXY_ROOT)
    .option('--port <port>', 'Loopback port the proxy forwards to', String(DEFAULT_BIND_PORT))
    .option('--domain <domain>', 'Public domain; enables the DNS and TLS checks')
    .option('--proxy-container <name>', PROXY_CONTAINER_HELP)
    .option('--proxy-mode <mode>', PROXY_MODE_HELP)
    .option(
      '--repo <url>',
      'Repository whose access to check (default: the recorded one, then this checkout\'s origin)',
    )
    .option('--json', 'Print a machine-readable report on stdout')
    .option('--no-color', 'Disable colour even on a terminal')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy doctor`,
        `  ${CLI_NAME} deploy doctor --domain app.example.com`,
        `  ${CLI_NAME} deploy doctor --json | jq '.checks[] | select(.status=="fail")'`,
        '',
        'Exit codes:',
        '  0  every required check passed (warnings do not fail the run)',
        '  6  a required check failed; nothing was changed',
        '',
        'Nothing is installed, written or started. It is safe to run at any time.',
      ].join('\n'),
    )
    .action(async (options: DoctorCommandOptions) => {
      await runDoctorCommand(options, ctx);
    });

  deploy
    .command('install')
    .description('Install this application on this server')
    .option('--root <path>', 'Deployment directory (rank 1: an explicit path)')
    .option(
      '--apps-root <path>',
      'Directory holding the deployments (rank 3 walks up inside it)',
      DEFAULT_APPS_ROOT,
    )
    .option('--name <app>', 'Which deployment to act on, by name')
    .option('--domain <domain>', 'Public domain to publish under')
    .option('--proxy-root <path>', 'Shared reverse proxy directory', DEFAULT_PROXY_ROOT)
    .option('--proxy-container <name>', PROXY_CONTAINER_HELP)
    .option('--proxy-mode <mode>', PROXY_MODE_HELP)
    .option('--port <port>', 'Loopback port the proxy forwards to', String(DEFAULT_BIND_PORT))
    .option('--repo <url>', 'Repository to deploy (default: this checkout\'s origin)')
    .option('--ref <ref>', 'Branch, tag or commit (default: the remote default branch)')
    .option('--email <email>', 'Certificate registration address')
    .option('--group <name>', 'Optional feature group; repeat for more', collectGroup, [])
    .option('--all', 'Review every environment variable, not only the essential ones')
    .option('--non-interactive', 'Never prompt; fail listing anything unresolved')
    .option(
      '--answer <key=value>',
      'Supply one environment answer; repeat for more',
      collectAnswer,
      new Map<string, string>(),
    )
    .option('--answers-file <path>', 'Read answers from a KEY=value file (like .env)')
    .option('--reinstall', 'Install over an existing deployment')
    .option('--resume', 'Continue from the step that failed')
    .option('--skip-doctor', 'Skip the prerequisite checks')
    .option('--skip-proxy', 'Do not touch the reverse proxy or request a certificate')
    .option('--skip-seed', 'Do not run the database seed')
    .option('--bootstrap-proxy', 'Create the shared proxy if this server has none (no prompt)')
    .option('--create-database', 'Create the database if it does not exist (no prompt)')
    .option('--skip-renewal', 'Do not schedule certificate renewal')
    .option('--skip-oauth-check', 'Do not verify the Google OAuth credentials with Google')
    .option('--no-cache', 'Rebuild images without the layer cache')
    .option('--force', 'Discard uncommitted changes in the checkout')
    .option('--staging', "Use Let's Encrypt staging while working out the setup")
    .option(
      '--app-version <version>',
      'Release version to deploy (default: a patch bump of the current one)',
    )
    .option('--no-version-bump', 'Deploy the current version: no write, no commit, no push')
    .option('--json', 'Print a machine-readable result on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy install --domain app.example.com`,
        `  ${CLI_NAME} deploy install --domain app.example.com --staging`,
        `  ${CLI_NAME} deploy install --non-interactive --domain app.example.com`,
        '',
        'What it does, in order: checks prerequisites, clones the repository,',
        'collects the environment, validates the database and the Google OAuth',
        'credentials, creates the database if it is missing (asked, or',
        '--create-database), builds the images, migrates, seeds, starts the',
        'stack, waits for health, creates the shared proxy if the server has',
        'none (asked, or --bootstrap-proxy), issues the certificate and',
        'publishes the vhost, schedules renewal unless something already owns',
        'it, then verifies the result -- including that sign-in redirects to',
        'Google with the configured client.',
        '',
        'The repository and branch come from THIS checkout\'s git remote unless',
        'you pass --repo/--ref, so a fork deploys itself with no configuration.',
      ].join('\n'),
    )
    .action(async (options: InstallCommandOptions) => {
      await runInstallCommand(options, ctx);
    });

  deploy
    .command('update')
    .description('Bring this server up to the latest revision')
    .option('--root <path>', 'Deployment directory (rank 1: an explicit path)')
    .option(
      '--apps-root <path>',
      'Directory holding the deployments (rank 3 walks up inside it)',
      DEFAULT_APPS_ROOT,
    )
    .option('--name <app>', 'Which deployment to act on, by name')
    .option('--ref <ref>', 'Branch, tag or commit to move to')
    .option('--force', 'Rebuild even when the revision has not changed')
    .option('--no-cache', 'Rebuild images without the layer cache')
    .option('--non-interactive', 'Never prompt; fail listing anything unresolved')
    .option(
      '--answer <key=value>',
      'Supply one environment answer; repeat for more',
      collectAnswer,
      new Map<string, string>(),
    )
    .option('--answers-file <path>', 'Read answers from a KEY=value file (like .env)')
    .option('--skip-seed', 'Do not re-run the database seed')
    .option('--skip-proxy', 'Do not touch the reverse proxy')
    .option('--create-database', 'Create the database if it does not exist (no prompt)')
    .option('--skip-renewal', 'Do not schedule certificate renewal')
    .option('--skip-oauth-check', 'Do not run the post-deploy OAuth sign-in smoke')
    .option('--proxy-container <name>', PROXY_CONTAINER_HELP)
    .option('--proxy-mode <mode>', PROXY_MODE_HELP)
    .option(
      '--app-version <version>',
      'Release version to deploy (default: a patch bump of the current one)',
    )
    .option('--no-version-bump', 'Deploy the current version: no write, no commit, no push')
    .option('--json', 'Print a machine-readable result on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy update`,
        `  ${CLI_NAME} deploy update --ref v1.4.0`,
        '',
        'Exits 0 without doing anything when the revision has not moved, so it',
        'is safe to run from cron.',
        '',
        'The seed RE-RUNS by default. It is idempotent, and it is the only way',
        'permissions added by a new release reach an existing deployment —',
        'without it the feature ships and the permission does not exist, which',
        'surfaces as a confusing 403. Pass --skip-seed to opt out.',
        '',
        'There is no automatic roll-back: a partly-applied migration cannot be',
        'undone by checking out the old code. On failure the previous revision',
        'and the command to redeploy it are printed.',
      ].join('\n'),
    )
    .action(async (options: UpdateCommandOptions) => {
      await runUpdateCommand(options, ctx);
    });

  deploy
    .command('status')
    .description('Report whether the deployment on this server is healthy')
    .option('--root <path>', 'Deployment directory (rank 1: an explicit path)')
    .option(
      '--apps-root <path>',
      'Directory holding the deployments (rank 3 walks up inside it)',
      DEFAULT_APPS_ROOT,
    )
    .option('--name <app>', 'Which deployment to act on, by name')
    .option('--port <port>', 'Loopback port the proxy forwards to', String(DEFAULT_BIND_PORT))
    .option('--domain <domain>', 'Public domain; adds an external HTTPS check')
    .option('--json', 'Print a machine-readable report on stdout')
    .option('--no-color', 'Disable colour even on a terminal')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        `  ${CLI_NAME} deploy status`,
        `  ${CLI_NAME} deploy status --domain app.example.com`,
        `  ${CLI_NAME} deploy status --json || alert 'deployment unhealthy'`,
        '',
        'Exit codes:',
        '  0  serving, and the schema is current',
        '  1  installed but unhealthy',
        '  2  nothing is installed at --root',
        '',
        'Note that /api/health/ready only proves SELECT 1 succeeded, so it',
        'passes against an empty database. Migration state is reported',
        'separately, and a green probe alone is not treated as proof.',
      ].join('\n'),
    )
    .action(async (options: StatusCommandOptions) => {
      await runStatusCommand(options, ctx);
    });

  deploy
    .command('list')
    .description('List every deployment on this server')
    .option('--apps-root <path>', 'Directory holding the deployments', DEFAULT_APPS_ROOT)
    .option('--json', 'Print a machine-readable inventory on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Reads only the filesystem: no git, no Docker, no network. A deployment',
        'with no record reports a null commit rather than having one looked up,',
        'so listing a host with several applications costs no subprocesses and',
        'cannot fail differently per application.',
        '',
        'The SOURCE column says where each row came from:',
        '  record      a deployment record was read',
        '  inferred    reconstructed from the environment file; `update` adopts it',
        '  unreadable  a record is present and this build cannot interpret it',
      ].join('\n'),
    )
    .action((options: ListCommandOptions) => {
      runListCommand(options, ctx);
    });

  deploy
    .command('about')
    .description('Show what this server says it is running')
    .option('--root <path>', 'Deployment directory (rank 1: an explicit path)')
    .option(
      '--apps-root <path>',
      'Directory holding the deployments (rank 3 walks up inside it)',
      DEFAULT_APPS_ROOT,
    )
    .option('--name <app>', 'Which deployment to act on, by name')
    .option('--json', 'Print the record itself on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Reads `deploy-info/info.json` off this disk — it does NOT ask the',
        'application. The moment you most want to know what was deployed here',
        'is the moment it is not answering, and that endpoint needs a login.',
        '',
        'Exits 0 when there is no record. A deployment installed before this',
        'CLI wrote one, or whose run stopped before the API answered, simply',
        'has none — which is not the same as nothing being deployed.',
      ].join('\n'),
    )
    .action((options: AboutCommandOptions) => {
      runAboutCommand(options, ctx);
    });

  deploy
    .command('certs')
    .description('Inspect or renew this deployment\'s TLS certificate')
    .option('--root <path>', 'Deployment directory (rank 1: an explicit path)')
    .option(
      '--apps-root <path>',
      'Directory holding the deployments (rank 3 walks up inside it)',
      DEFAULT_APPS_ROOT,
    )
    .option('--name <app>', 'Which deployment to act on, by name')
    .option('--proxy-root <path>', 'Shared reverse proxy directory', DEFAULT_PROXY_ROOT)
    .option('--domain <domain>', 'Domain to act on (default: the recorded one)')
    .option('--proxy-container <name>', PROXY_CONTAINER_HELP)
    .option('--proxy-mode <mode>', PROXY_MODE_HELP)
    .option('--renew', 'Renew when the certificate is inside the renewal window')
    .option('--force', 'Renew even when it is not due. Spends rate-limit budget.')
    .option('--email <email>', 'Registration address (default: INITIAL_ADMIN_EMAIL)')
    .option('--staging', "Use Let's Encrypt staging, which is not trusted by browsers")
    .option('--json', 'Print a machine-readable report on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Without --renew this reports and changes nothing.',
        '',
        `With --renew it renews only when the certificate expires within ${String(RENEW_WITHIN_DAYS)} days.`,
        "Let's Encrypt allows 5 DUPLICATE certificates per week, and a command that",
        're-issued on every invocation would exhaust that during one debugging',
        'session -- leaving the deployment unable to get a certificate at the moment',
        'it most needs one. --force overrides that and is deliberately not implied.',
        '',
        'An unreadable expiry is reported, never treated as "not due": silently',
        'assuming a certificate is healthy is how one quietly expires.',
        '',
        'A renewal validates and RELOADS the proxy afterwards: a renewed certificate',
        'on disk is not served until nginx reloads. A renewal whose reload failed',
        'exits 1, because the old certificate is still what browsers see.',
        '',
        'Exit codes:',
        '  0  reported, or renewed and reloaded successfully',
        '  1  the certificate is due and --renew was not passed, or the reload failed',
        '  2  nothing is installed at --root',
      ].join('\n'),
    )
    .action(async (options: CertsCommandOptions) => {
      await runCertsCommand(options, ctx);
    });

  deploy
    .command('uninstall')
    .description('Remove a deployment from this server')
    .option('--root <path>', 'Deployment directory (rank 1: an explicit path)')
    .option(
      '--apps-root <path>',
      'Directory holding the deployments (rank 3 walks up inside it)',
      DEFAULT_APPS_ROOT,
    )
    .option('--name <app>', 'Which deployment to act on, by name')
    .option('--proxy-root <path>', 'Shared reverse proxy directory', DEFAULT_PROXY_ROOT)
    .option('--proxy-container <name>', PROXY_CONTAINER_HELP)
    .option('--proxy-mode <mode>', PROXY_MODE_HELP)
    .option('--dry-run', 'Report what would be removed and change nothing')
    .option(
      '--drop-database',
      'Also DROP the PostgreSQL database named by POSTGRES_DB, after the stack stops (needs --confirm-database)',
    )
    .option('--confirm-database <name>', "The database's own name, typed back")
    .option('--purge-storage', 'Also delete every object in storage (needs --confirm-bucket)')
    .option('--confirm-bucket <name>', "The bucket's own name, typed back")
    .option('--json', 'Print a machine-readable plan on stdout')
    .addHelpText(
      'after',
      [
        '',
        'Removes the containers and their volumes, the clone, the vhost, the',
        'logs, the environment file and the deployment record.',
        '',
        'ALWAYS REFUSES to remove four things, because they are shared with every',
        'other application on this host:',
        '  - the shared Docker network',
        '  - the shared proxy container',
        "  - the TLS certificate (Let's Encrypt allows 5 duplicates per week;",
        '    keeping it is what makes a reinstall possible)',
        "  - the renewal cron entry (per-host; it renews the neighbours' certs too)",
        '',
        'The two destructive extras each need their own flag AND that resource\'s',
        'own real name typed back -- not the word DELETE. A word typed for one',
        'must never authorise the other.',
        '',
        '--drop-database runs DROP DATABASE after the stack stops and before the',
        'files go. If it fails, the checkout and the environment file are kept',
        '(they hold the credentials) so the same command can be re-run.',
        '',
        'Run --dry-run first. It reports exactly what would go and what would stay.',
      ].join('\n'),
    )
    .action(async (options: UninstallCommandOptions) => {
      await runUninstallCommand(options, ctx);
    });

  return deploy;
}

export interface UninstallCommandOptions {
  /** Rank 1. Absent now means absent: the default was removed. */
  root?: string | undefined;
  /** Rank 2. */
  name?: string | undefined;
  appsRoot?: string | undefined;
  proxyRoot: string;
  proxyContainer?: string | undefined;
  proxyMode?: string | undefined;
  dryRun?: boolean;
  dropDatabase?: boolean;
  confirmDatabase?: string;
  purgeStorage?: boolean;
  confirmBucket?: string;
  json?: boolean;
}

export async function runUninstallCommand(
  options: UninstallCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  // ⚠ Resolved through the five ranks, not read off `--root`. See
  // `resolveApp`: with a defaulted `--root` every rank below the first
  // was dead code, including the cwd walk the resolver exists for.
  const app = resolveApp(options);
  const proxy = proxyFlags(options);

  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;

  const plan = planUninstall({
    deployRoot: app.deployRoot,
    proxyRoot: options.proxyRoot,
    ...(options.dropDatabase === undefined ? {} : { dropDatabase: options.dropDatabase }),
    ...(options.purgeStorage === undefined ? {} : { purgeStorage: options.purgeStorage }),
  });

  // ⚠ THE INVENTORY COMES FIRST, ALWAYS. Nobody can consent to a number they
  // were not shown, so the plan is rendered before any confirmation is judged.
  if (options.json === true) {
    stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    stderr.write(`${renderUninstallPlan(plan)}\n`);
  }

  if (options.dryRun === true) return;

  const result = await runUninstall({
    deployRoot: app.deployRoot,
    proxyRoot: options.proxyRoot,
    ...(proxy.mode === undefined ? {} : { proxyMode: proxy.mode }),
    ...(proxy.container === undefined ? {} : { proxyContainer: proxy.container }),
    ...(options.dropDatabase === undefined ? {} : { dropDatabase: options.dropDatabase }),
    ...(options.confirmDatabase === undefined ? {} : { confirmDatabase: options.confirmDatabase }),
    ...(options.purgeStorage === undefined ? {} : { purgeStorage: options.purgeStorage }),
    ...(options.confirmBucket === undefined ? {} : { confirmBucket: options.confirmBucket }),
    ...(ctx?.runCommand === undefined ? {} : { runCommand: ctx.runCommand }),
  });

  for (const warning of result.warnings) stderr.write(`warning: ${warning}\n`);
  if (result.database !== undefined) {
    // The count is always printed, even when zero: an operator not told a
    // session was killed cannot know to go and ask whose it was.
    stderr.write(
      `Dropped database ${result.database.name} ` +
        `(terminated ${String(result.database.terminated)} session(s)).\n`,
    );
  }
  stderr.write(`Removed ${app.deployRoot}. Log: ${result.journalPath}\n`);
}

export function renderUninstallPlan(plan: UninstallPlan): string {
  const lines = [`Uninstalling ${plan.deployRoot}`, '', 'This will REMOVE:'];
  for (const entry of plan.removes) lines.push(`  - ${entry}`);
  lines.push('', 'This will KEEP:');
  for (const keep of plan.keeps) lines.push(`  - ${keep.what}  (${keep.because})`);
  return lines.join('\n');
}


export interface CertsCommandOptions {
  /** Rank 1. Absent now means absent: the default was removed. */
  root?: string | undefined;
  /** Rank 2. */
  name?: string | undefined;
  appsRoot?: string | undefined;
  proxyRoot: string;
  proxyContainer?: string | undefined;
  proxyMode?: string | undefined;
  domain?: string;
  renew?: boolean;
  force?: boolean;
  email?: string;
  staging?: boolean;
  json?: boolean;
}

export async function runCertsCommand(
  options: CertsCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  // ⚠ Resolved through the five ranks, not read off `--root`. See
  // `resolveApp`: with a defaulted `--root` every rank below the first
  // was dead code, including the cwd walk the resolver exists for.
  const app = resolveApp(options);
  const proxy = proxyFlags(options);

  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const run = ctx?.runCommand ?? runCommand;

  const state = readState(app.deployRoot);
  const domain = options.domain ?? state?.domain;

  if (domain === undefined) {
    throw new UsageError(
      `No domain is recorded for the deployment at ${app.deployRoot}, and none was given. Pass --domain.`,
    );
  }

  const target: ProxyTarget = {
    domain,
    bindPort: state?.bindPort ?? DEFAULT_BIND_PORT,
    proxyRoot: state?.proxyRoot ?? options.proxyRoot,
  };

  // Resolved only for --renew: reporting reads the host files and needs no
  // runtime, and stays free of docker probes.
  const runtime: ResolvedProxyRuntime | undefined =
    options.renew === true
      ? await resolveRecordedProxyRuntime({
          proxyRoot: target.proxyRoot,
          flags: proxy,
          recorded: state,
          runCommand: run,
        })
      : undefined;

  const report = options.renew === true
    ? await renewCertificate(target, {
        runCommand: run,
        // Which certbot runs, and where the post-renewal reload happens.
        ...(runtime === undefined ? {} : { runtime }),
        email: options.email ?? emailFor(app.deployRoot),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.staging === undefined ? {} : { staging: options.staging }),
      }).then((result) => ({
        ...result.expiry,
        renewed: result.renewed,
        reloaded: result.reloaded,
        reason: result.reason,
      }))
    : await certificateExpiry(target, { runCommand: run }).then((expiry) => ({
        ...expiry,
        renewed: false,
        reloaded: false,
        reason: 'reported only; pass --renew to act',
      }));

  if (options.json === true) {
    stdout.write(`${JSON.stringify({ domain, ...report, notAfter: report.notAfter?.toISOString() ?? null }, null, 2)}\n`);
  } else {
    stderr.write(`${renderCerts(domain, report)}\n`);
  }

  // A certificate that is due and was not renewed is a non-zero exit, so a cron
  // wrapper notices. Reporting it at exit 0 is how it goes unnoticed until the
  // browser says so.
  if (report.exists && report.dueForRenewal && report.renewed !== true) {
    throw new DeploymentUnhealthyError(
      `The certificate for ${domain} is due for renewal. Re-run with --renew.`,
    );
  }

  // Renewed but not reloaded: the new certificate is on disk and the OLD one is
  // still what browsers get. Exit non-zero so a cron wrapper notices, exactly
  // as for a certificate that was never renewed.
  if (report.renewed && !report.reloaded) {
    throw new DeploymentUnhealthyError(
      `The certificate for ${domain} was renewed, but the proxy was not reloaded, so the old certificate is still being served. ${report.reason}`,
    );
  }
}

/** The registration address a renewal should use, from the deployment's own env. */
function emailFor(deployRoot: string): string {
  const path = join(deployRoot, 'repo', 'infra', 'compose', '.env');
  try {
    const email = parseEnvFile(readFileSync(path, 'utf8')).get('INITIAL_ADMIN_EMAIL');
    if (email !== undefined && email !== '') return email;
  } catch {
    // No readable .env. The explicit --email below is the answer.
  }
  throw new UsageError(
    'No registration address: pass --email, or set INITIAL_ADMIN_EMAIL in the deployment environment.',
  );
}

export function renderCerts(
  domain: string,
  report: { exists: boolean; path: string; notAfter: Date | null; daysRemaining: number | null; dueForRenewal: boolean; problem?: string; renewed: boolean; reason: string },
): string {
  const lines = [`Certificate for ${domain}`, `  path       ${report.path}`];

  if (!report.exists) {
    lines.push('  status     not installed');
  } else if (report.problem !== undefined) {
    // Surfaced, not swallowed: see certificateExpiry's own warning.
    lines.push(`  status     expiry unreadable — ${report.problem}`);
  } else {
    lines.push(`  expires    ${report.notAfter?.toISOString() ?? 'unknown'}`);
    lines.push(`  remaining  ${String(report.daysRemaining)} day(s)`);
    lines.push(`  status     ${report.dueForRenewal ? 'DUE for renewal' : 'current'}`);
  }

  lines.push(`  action     ${report.renewed ? 'renewed' : report.reason}`);
  return lines.join('\n');
}


export interface ListCommandOptions {
  appsRoot?: string;
  json?: boolean;
}

export function runListCommand(options: ListCommandOptions, ctx?: DeployContext): void {
  const appsRoot = options.appsRoot ?? DEFAULT_APPS_ROOT;
  const entries = collectInventory({ appsRoot });

  if (options.json === true) {
    (ctx?.stdout ?? process.stdout).write(`${JSON.stringify({ appsRoot, deployments: entries }, null, 2)}\n`);
    return;
  }

  (ctx?.stderr ?? process.stderr).write(`${renderInventory(entries, appsRoot)}\n`);
}


/** Display-safe by construction: no field can hold a secret. */
export interface DoctorReport {
  ok: boolean;
  checks: Array<{
    id: string;
    title: string;
    severity: 'required' | 'recommended';
    status: CheckStatus;
    detail: string;
    remedy?: string;
    durationMs: number;
  }>;
  summary: ReturnType<typeof summarise>;
  /** How the shared proxy was judged to run. Set by `doctor`, not by `buildReport`. */
  proxy?: { mode: ProxyMode; container: string; source: string } | undefined;
}

export async function runDoctorCommand(
  options: DoctorCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  // ⚠ Resolved through the five ranks, not read off `--root`. See
  // `resolveApp`: with a defaulted `--root` every rank below the first
  // was dead code, including the cwd walk the resolver exists for.
  const app = resolveApp(options, { mayBeAbsent: true });

  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const checks = ctx?.checks ?? ALL_CHECKS;
  const json = options.json === true;
  const run = ctx?.runCommand ?? runCommand;

  // Flags, then what an installed deployment recorded, then detection. Read-
  // only: `docker inspect` and `nginx -v` change nothing, so doctor stays safe
  // to run against production at any time.
  const recorded = readRecordSafely(app.deployRoot);
  const proxyRuntime = await resolveRecordedProxyRuntime({
    proxyRoot: options.proxyRoot,
    flags: proxyFlags(options),
    recorded,
    runCommand: run,
  });

  // Where the code comes from, and whether git can already read it: decides
  // whether the gh checks are required (#390). `git ls-remote` is read-only.
  const repoUrl = await resolveRepoUrl({
    cwd: process.cwd(),
    runCommand: run,
    ...(options.repo === undefined ? {} : { repoFlag: options.repo }),
    ...(recorded === undefined ? {} : { state: recorded }),
  });
  const gitCredentialed = await gitCredentialStateFor(repoUrl, run);

  const context: CheckContext = {
    runCommand: run,
    deployRoot: app.deployRoot,
    proxyRoot: options.proxyRoot,
    proxyRuntime,
    ...(repoUrl === undefined ? {} : { repoUrl }),
    ...(gitCredentialed === undefined ? {} : { gitCredentialed }),
    bindPort: Number(options.port),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(readEnvironment(app.deployRoot) ?? {}),
  };

  // Under --json nothing is written until the end: a partial checklist on
  // stderr is useless to a machine, and colour is never consulted at all so
  // no FORCE_COLOR can inject escapes into the pipe.
  const colour =
    !json &&
    shouldUseColour({
      // `--no-color` arrives as `color: false`, matching commander's handling
      // of a `--no-` flag; `requested` is undefined when the user said nothing.
      requested: options.color === false ? false : undefined,
      env: process.env,
      isTTY: ctx?.isTty ?? process.stderr.isTTY === true,
    });

  if (!json) {
    stderr.write('\n  Prerequisites\n\n');
    stderr.write(
      `  Proxy: ${proxyRuntime.mode === 'container' ? `container ${proxyRuntime.container}` : 'host nginx'} (${proxyRuntime.source})\n\n`,
    );
  }

  const results = await runChecks(checks, context, (result) => {
    // Streamed as each completes: a dozen subprocess probes take long enough
    // that a silent terminal looks like a hang.
    if (!json) stderr.write(renderResult(result, colour));
  });

  const report = {
    ...buildReport(results),
    proxy: { mode: proxyRuntime.mode, container: proxyRuntime.container, source: proxyRuntime.source },
  };

  if (json) {
    stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    stderr.write(renderSummary(report.summary, colour));
  }

  if (!report.ok) {
    const failed = results.filter(
      (result) => result.severity === 'required' && result.status === 'fail',
    );
    throw new PreconditionError(
      `${failed.length} required check(s) failed: ${failed.map((result) => result.id).join(', ')}`,
    );
  }
}

/**
 * The deployment record, or undefined -- including when it cannot be read.
 *
 * Doctor must work on a server where nothing is installed, and on one whose
 * record is from a newer appctl; neither is a reason not to run the checks.
 */
function readRecordSafely(deployRoot: string): ReturnType<typeof readState> {
  try {
    return readState(deployRoot);
  } catch {
    return undefined;
  }
}

/** Reads the deployment's .env, when there is one, for the database checks. */
function readEnvironment(deployRoot: string): { env: Map<string, string> } | undefined {
  try {
    const contents = readFileSync(
      join(deployRoot, 'repo', 'infra', 'compose', '.env'),
      'utf8',
    );
    return { env: parseEnvFile(contents) };
  } catch {
    // Absent before a first install; the database checks then report `skip`.
    return undefined;
  }
}

export function buildReport(results: readonly CompletedCheck[]): DoctorReport {
  return {
    ok: checksPassed(results),
    checks: results.map((result) => ({
      id: result.id,
      title: result.title,
      severity: result.severity,
      status: result.status,
      detail: result.detail,
      ...(result.remedy === undefined ? {} : { remedy: result.remedy }),
      durationMs: result.durationMs,
    })),
    summary: summarise(results),
  };
}

/** The status glyphs, shared with the deploy screens so both say the same thing. */
export const MARKS: Readonly<Record<CheckStatus, string>> = {
  pass: 'OK',
  warn: '!!',
  fail: 'XX',
  skip: '--',
};

const COLOURS: Record<CheckStatus, string> = {
  pass: '32',
  warn: '33',
  fail: '31',
  skip: '90',
};

const TITLE_WIDTH = 30;

/** Installed, reachable, and not working. Distinct from "not installed". */
export class DeploymentUnhealthyError extends CliError {
  readonly exitCode: ExitCode = EXIT.FAILURE;
}

/** One check, rendered. Exported for its test. */
export function renderResult(result: CompletedCheck, colour: boolean): string {
  // A GLYPH as well as a colour. These are read over SSH, piped into files,
  // and by people who cannot distinguish red from green; colour alone would
  // make the status invisible to all three.
  const mark = MARKS[result.status];
  const painted = colour ? `${ESC}[${COLOURS[result.status]}m${mark}${RESET}` : mark;

  const lines = [`  ${painted} ${result.title.padEnd(TITLE_WIDTH)}${result.detail}\n`];

  if (result.remedy !== undefined && (result.status === 'fail' || result.status === 'warn')) {
    // The arrow marks the remedy once; continuation lines are indented to
    // line up under it, so a wrapped sentence reads as one sentence rather
    // than as several separate instructions.
    wrap(result.remedy, 66).forEach((line, index) => {
      lines.push(`       ${index === 0 ? '->' : '  '} ${line}\n`);
    });
  }

  return lines.join('');
}

export function renderSummary(
  summary: ReturnType<typeof summarise>,
  colour: boolean,
): string {
  const parts = [`${summary.passed} passed`];
  if (summary.warned > 0) parts.unshift(`${summary.warned} warning(s)`);
  if (summary.failed > 0) parts.unshift(`${summary.failed} failed`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);

  const line = parts.join(', ');
  const painted =
    colour && summary.failed > 0 ? `${ESC}[31m${line}${RESET}` : line;

  return `\n  ${painted}\n\n`;
}

/** Wraps a remedy so it stays readable in an 80-column SSH session. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);

  return lines;
}


// ---------------------------------------------------------------------------
// `appctl deploy status`  (issue #183)
// ---------------------------------------------------------------------------

export interface AboutCommandOptions {
  root?: string | undefined;
  name?: string | undefined;
  appsRoot?: string | undefined;
  json?: boolean | undefined;
}

/**
 * ⚠ EXITS 0 WHEN THERE IS NO RECORD. An absent document is one of three normal
 * states, not a failure: this command answers "what does this server say it is
 * running", and "nothing has written that down here" is a real answer to it.
 */
export function runAboutCommand(options: AboutCommandOptions, ctx?: DeployContext): void {
  const app = resolveApp(options);
  const report = readAbout(app.deployRoot);

  if (options.json === true) {
    (ctx?.stdout ?? process.stdout).write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  (ctx?.stderr ?? process.stderr).write(`${renderAbout(report)}\n`);
}

export interface StatusCommandOptions {
  /** Rank 1. Absent now means absent: the default was removed. */
  root?: string | undefined;
  /** Rank 2. */
  name?: string | undefined;
  appsRoot?: string | undefined;
  port: string;
  domain?: string | undefined;
  json?: boolean | undefined;
  color: boolean;
}

export async function runStatusCommand(
  options: StatusCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  // ⚠ Resolved through the five ranks, not read off `--root`. See
  // `resolveApp`: with a defaulted `--root` every rank below the first
  // was dead code, including the cwd walk the resolver exists for.
  const app = resolveApp(options);

  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;

  // ⚠ EVIDENCE, NOT THE RECORD -- the same wrong question `update` used to
  // ask, from the other side. Guarding on the state file meant a deployment
  // whose record was lost -- containers up, certificate issued, site serving --
  // was reported as "No deployment found" by the ONE command an operator runs
  // when something is wrong. `status` needs no record to do its job: it probes
  // the containers and the endpoints, and the record only supplies the compose
  // project and the deployed revision.
  //
  // "Nothing installed" is still a USAGE problem, distinct from "installed and
  // unhealthy" -- a monitoring script must be able to tell them apart. That
  // distinction is preserved; it is just asked of the deployment rather than of
  // the bookkeeping about it.
  const state = readState(app.deployRoot);
  if (state === undefined && !isDeployment(app.deployRoot)) {
    throw new UsageError(
      `No deployment found at ${app.deployRoot}. Run \`${CLI_NAME} deploy install\` first, or pass --root.`,
    );
  }

  const report = await collectHealth({
    runCommand: ctx?.runCommand ?? runCommand,
    deployRoot: app.deployRoot,
    bindPort: Number(options.port),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    // ⚠ From the RECORD, never derived. `status` reads the containers, so
    // looking in the wrong compose project reports a healthy stack as absent.
    // Absent when the record was lost: `composeProjectFor(undefined)` is the
    // directory-derived default, which is what such a deployment is running
    // under anyway -- it predates the naming or lost the file that recorded it.
    ...(state === undefined || composeProjectFor(state) === undefined
      ? {}
      : { composeProject: composeProjectFor(state) }),
    ...(state === undefined ? {} : { state }),
    // The compose files this stack was started with depend on the groups
    // install recorded (compose-files.ts), plus the always-on ones (#567).
    ...(state?.groups === undefined ? {} : { groups: state.groups }),
    ...(ctx?.fetch === undefined ? {} : { fetch: ctx.fetch }),
    // #391: the sign-in wiring, from the deployment's own .env. Reported, and
    // deliberately NOT part of `healthy` -- that stays "is it serving", which
    // is what a monitoring script branches on.
    ...oauthSmokeTarget(false, statusEnvironment(app.deployRoot)),
  });

  const healthy = isHealthy(report);

  if (json) {
    stdout.write(`${JSON.stringify({ healthy, ...report })}\n`);
  } else {
    const colour = shouldUseColour({
      requested: options.color === false ? false : undefined,
      env: process.env,
      isTTY: ctx?.isTty ?? process.stderr.isTTY === true,
    });
    stderr.write(renderHealth(report, healthy, colour));
  }

  if (!healthy) {
    throw new DeploymentUnhealthyError(
      `The deployment at ${app.deployRoot} is not healthy.`,
    );
  }
}

/** The deployment's .env for the OAuth smoke, or undefined when unreadable. */
function statusEnvironment(deployRoot: string): Map<string, string> | undefined {
  const path = resolveEnvPath(deployRoot);
  if (path === undefined) return undefined;
  try {
    return readEnvFile(path);
  } catch {
    return undefined;
  }
}

function probeLine(label: string, result: ProbeResult): string {
  const outcome = result.ok
    ? `${result.status ?? 'ok'} (${result.durationMs}ms)`
    : (result.error ?? `HTTP ${result.status ?? '?'}`);
  return `  ${label.padEnd(TITLE_WIDTH)}${outcome}\n`;
}

/** The human report. Exported for its test. */
export function renderHealth(
  report: HealthReport,
  healthy: boolean,
  colour: boolean,
): string {
  const lines: string[] = ['\n  Deployment\n\n'];

  if (report.deployed !== undefined) {
    lines.push(`  ${'Revision'.padEnd(TITLE_WIDTH)}${report.deployed.commitSha.slice(0, 12)} (${report.deployed.ref})\n`);
    lines.push(`  ${'Last deployed'.padEnd(TITLE_WIDTH)}${report.deployed.lastDeployedAt} by ${report.deployed.lastCommand}\n`);
  }

  lines.push('\n  Containers\n\n');
  if (report.containers.length === 0) {
    lines.push('  none reported\n');
  } else {
    for (const container of report.containers) {
      const health = container.health === undefined ? '' : ` (${container.health})`;
      lines.push(`  ${container.service.padEnd(TITLE_WIDTH)}${container.state}${health}\n`);
    }
  }

  lines.push('\n  Probes\n\n');
  lines.push(probeLine('Liveness', report.local.live));
  lines.push(probeLine('Readiness', report.local.ready));
  lines.push(probeLine('Frontend', report.local.frontend));
  if (report.external !== undefined) {
    lines.push(probeLine('External HTTPS', report.external.probe));
  }
  if (report.oauth !== undefined) {
    const outcome =
      report.oauth.status === 'pass'
        ? 'ok'
        : `${report.oauth.status === 'fail' ? 'FAILED' : 'unverified'}: ${report.oauth.detail}`;
    const painted =
      colour && report.oauth.status === 'fail' ? `${ESC}[31m${outcome}${RESET}` : outcome;
    lines.push(`  ${'Google sign-in'.padEnd(TITLE_WIDTH)}${painted}\n`);
    if (report.oauth.status !== 'pass' && report.oauth.remedy !== undefined) {
      lines.push(`       -> ${report.oauth.remedy}\n`);
    }
  }

  lines.push('\n  Schema\n\n');
  if (!report.migrations.known) {
    lines.push(`  ${'Migrations'.padEnd(TITLE_WIDTH)}could not be determined\n`);
  } else if (report.migrations.pending.length > 0) {
    // Readiness can be green while this is red; that is the whole point of
    // reporting it separately.
    lines.push(`  ${'Migrations'.padEnd(TITLE_WIDTH)}${report.migrations.pending.length} pending\n`);
    for (const pending of report.migrations.pending) {
      lines.push(`       -> ${pending}\n`);
    }
  } else {
    lines.push(`  ${'Migrations'.padEnd(TITLE_WIDTH)}up to date\n`);
  }

  const verdict = healthy ? 'healthy' : 'NOT healthy';
  const painted = colour && !healthy ? `${ESC}[31m${verdict}${RESET}` : verdict;
  lines.push(`\n  ${painted}\n\n`);

  return lines.join('');
}


// ---------------------------------------------------------------------------
// `appctl deploy install`  (issue #180)
// ---------------------------------------------------------------------------

function collectGroup(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export interface InstallCommandOptions {
  answer?: ReadonlyMap<string, string> | undefined;
  answersFile?: string | undefined;
  /** Rank 1. Absent now means absent: the default was removed. */
  root?: string | undefined;
  /** Rank 2. */
  name?: string | undefined;
  appsRoot?: string | undefined;
  domain?: string | undefined;
  proxyRoot: string;
  proxyContainer?: string | undefined;
  proxyMode?: string | undefined;
  port: string;
  repo?: string | undefined;
  ref?: string | undefined;
  email?: string | undefined;
  group: string[];
  all?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  reinstall?: boolean | undefined;
  resume?: boolean | undefined;
  skipDoctor?: boolean | undefined;
  skipProxy?: boolean | undefined;
  skipSeed?: boolean | undefined;
  bootstrapProxy?: boolean | undefined;
  createDatabase?: boolean | undefined;
  skipRenewal?: boolean | undefined;
  skipOauthCheck?: boolean | undefined;
  cache: boolean;
  force?: boolean | undefined;
  staging?: boolean | undefined;
  appVersion?: string | undefined;
  /**
   * Commander's negated-boolean form: `--no-version-bump` sets this FALSE, and
   * it is TRUE when the flag was not passed. ⚠ Not `noVersionBump` — reading
   * the absent case as "bump disabled" would turn every ordinary deploy into
   * one that never versions anything.
   */
  versionBump: boolean;
  json?: boolean | undefined;
}

/**
 * Which deployment a subcommand is acting on.
 *
 * =============================================================================
 * ⚠ THE RESOLVER HAD NO CALLERS
 * =============================================================================
 *
 * `locateApp` and its five ranks shipped with `deploy list` and nothing else,
 * so every other subcommand still read a bare `--root` that defaulted to the
 * apps root. That made ranks 2 through 5 unreachable from the command line:
 * `--name` did not exist, the SOLE-APP case was never tried, the ambiguity
 * refusal could never fire -- and, worst, neither could RANK 3, the cwd walk,
 * which is the one defect the resolver was written to fix. An operator
 * standing inside their own deployment was told to pass a flag that did not
 * exist, by a command run from the directory the error had just left them in.
 *
 * ⚠ AND `--root` CARRIED A DEFAULT, which is what made this invisible. With a
 * default, `options.root` is always defined and rank 1 always wins, so adding
 * the lower ranks would have changed nothing at all. The default is gone; an
 * unpassed `--root` is now genuinely absent.
 * =============================================================================
 */
/**
 * Collects a repeated `--answer key=value` into a map.
 *
 * ⚠ SPLIT ON THE FIRST `=` ONLY. A signing secret is base64 and base64 ends in
 * `=` padding, so splitting on every one truncates exactly the values that
 * must not be truncated.
 */
function collectAnswer(entry: string, previous: Map<string, string>): Map<string, string> {
  const at = entry.indexOf('=');
  if (at <= 0) {
    throw new UsageError(`--answer expects KEY=value, not \`${entry}\`.`);
  }
  return new Map(previous).set(entry.slice(0, at), entry.slice(at + 1));
}

/**
 * The answers a run starts with, from `--answers-file` and `--answer`.
 *
 * ⚠ `--answer` WINS OVER THE FILE. The flag is the narrower, later, more
 * deliberate statement -- an operator overriding one value of a shared answers
 * file on one run. The other order makes the flag silently do nothing.
 */
function collectedAnswers(
  options: { answer?: ReadonlyMap<string, string> | undefined; answersFile?: string | undefined },
  warn: (message: string) => void,
): Map<string, string> | undefined {
  const fromFile =
    options.answersFile === undefined ? undefined : readAnswersFile(options.answersFile);

  for (const warning of fromFile?.warnings ?? []) warn(warning);

  const merged = new Map<string, string>([
    ...(fromFile?.values ?? new Map<string, string>()),
    ...(options.answer ?? new Map<string, string>()),
  ]);

  return merged.size === 0 ? undefined : merged;
}

interface LayoutOptions {
  root?: string | undefined;
  name?: string | undefined;
  appsRoot?: string | undefined;
}

function resolveApp(
  options: LayoutOptions,
  { mayBeAbsent = false }: { mayBeAbsent?: boolean } = {},
): LocatedApp {
  const request = {
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.appsRoot === undefined ? {} : { appsRoot: options.appsRoot }),
  };

  try {
    return locateApp(request);
  } catch (error) {
    // ⚠ `doctor` AND `install` MUST WORK WHEN NOTHING IS INSTALLED. That is
    // the entire point of a preflight, and install's job is to create the
    // thing the other commands require. Ranks 4 and 5 both ask "which of the
    // deployments here?", which is not a question either of them has -- so a
    // refusal from those ranks becomes the apps root itself, exactly the value
    // `--root` used to default to.
    //
    // ⚠ NOT EXTENDED TO `update`/`status`/`certs`/`uninstall`. Those act on a
    // deployment that must already exist, and falling back would point them at
    // a directory nothing was installed into -- turning "which one did you
    // mean?" into a confusing failure somewhere further in.
    if (!mayBeAbsent || !(error instanceof UsageError)) throw error;

    const appsRoot = resolve(options.appsRoot ?? DEFAULT_APPS_ROOT);
    return { name: basename(appsRoot), deployRoot: appsRoot, appsRoot, via: 'root' };
  }
}

export async function runInstallCommand(
  options: InstallCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  // ⚠ Resolved through the five ranks, not read off `--root`. See
  // `resolveApp`: with a defaulted `--root` every rank below the first
  // was dead code, including the cwd walk the resolver exists for.
  const app = resolveApp(options, { mayBeAbsent: true });
  const proxy = proxyFlags(options);

  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;

  const answers = collectedAnswers(options, (message) =>
    stderr.write(`warning: ${message}\n`),
  );

  const installOptions: InstallOptions = {
    deployRoot: app.deployRoot,
    bindPort: Number(options.port),
    proxyRoot: options.proxyRoot,
    ...(proxy.mode === undefined ? {} : { proxyMode: proxy.mode }),
    ...(proxy.container === undefined ? {} : { proxyContainer: proxy.container }),
    groups: options.group as EnvGroup[],
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.email === undefined ? {} : { email: options.email }),
    ...(options.all === undefined ? {} : { all: options.all }),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.reinstall === undefined ? {} : { reinstall: options.reinstall }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.skipDoctor === undefined ? {} : { skipDoctor: options.skipDoctor }),
    ...(options.skipProxy === undefined ? {} : { skipProxy: options.skipProxy }),
    ...(options.skipSeed === undefined ? {} : { skipSeed: options.skipSeed }),
    ...(options.bootstrapProxy === undefined ? {} : { bootstrapProxy: options.bootstrapProxy }),
    ...(options.createDatabase === undefined ? {} : { createDatabase: options.createDatabase }),
    ...(options.skipRenewal === undefined ? {} : { skipRenewal: options.skipRenewal }),
    ...(options.skipOauthCheck === undefined ? {} : { skipOAuthCheck: options.skipOauthCheck }),
    ...(options.cache === false ? { noCache: true } : {}),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.staging === undefined ? {} : { staging: options.staging }),
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.versionBump === false ? { noVersionBump: true } : {}),
    ...(answers === undefined ? {} : { answers }),
    ...(ctx?.runCommand === undefined ? {} : { runCommand: ctx.runCommand }),
    // Rendered as lines on stderr here; #184's screen renders the identical
    // callbacks as React state. One implementation, two renderers.
    ...(json
      ? {}
      : {
          hooks: {
            onStepStart: ({ title, index, total }) =>
              void stderr.write(`\n  [${index + 1}/${total}] ${title}\n`),
            onStepResult: (result) =>
              void stderr.write(
                result.outcome === 'ok'
                  ? `  done (${result.durationMs}ms)\n`
                  : `  ${result.outcome}: ${result.detail ?? ''}\n`,
              ),
            onProgress: (message) => void stderr.write(`  ${message}\n`),
            onLog: (line) => void stderr.write(`    ${line}\n`),
          },
        }),
  };

  const result = await runInstall(installOptions);

  if (json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  stderr.write(
    [
      '',
      '  Installed.',
      '',
      `  Revision   ${result.commitSha.slice(0, 12)}`,
      `  Log        ${result.journalPath}`,
      '',
      `  ${result.nextStep}`,
      '',
    ].join('\n'),
  );
}


// ---------------------------------------------------------------------------
// `appctl deploy update`  (issue #182)
// ---------------------------------------------------------------------------

export interface UpdateCommandOptions {
  answer?: ReadonlyMap<string, string> | undefined;
  answersFile?: string | undefined;
  /** Rank 1. Absent now means absent: the default was removed. */
  root?: string | undefined;
  /** Rank 2. */
  name?: string | undefined;
  appsRoot?: string | undefined;
  ref?: string | undefined;
  force?: boolean | undefined;
  cache: boolean;
  nonInteractive?: boolean | undefined;
  skipSeed?: boolean | undefined;
  skipProxy?: boolean | undefined;
  createDatabase?: boolean | undefined;
  skipRenewal?: boolean | undefined;
  skipOauthCheck?: boolean | undefined;
  proxyContainer?: string | undefined;
  proxyMode?: string | undefined;
  appVersion?: string | undefined;
  /**
   * Commander's negated-boolean form: `--no-version-bump` sets this FALSE, and
   * it is TRUE when the flag was not passed. ⚠ Not `noVersionBump` — reading
   * the absent case as "bump disabled" would turn every ordinary deploy into
   * one that never versions anything.
   */
  versionBump: boolean;
  json?: boolean | undefined;
}

export async function runUpdateCommand(
  options: UpdateCommandOptions,
  ctx?: DeployContext,
): Promise<void> {
  // ⚠ Resolved through the five ranks, not read off `--root`. See
  // `resolveApp`: with a defaulted `--root` every rank below the first
  // was dead code, including the cwd walk the resolver exists for.
  const app = resolveApp(options);
  const proxy = proxyFlags(options);

  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const json = options.json === true;

  const answers = collectedAnswers(options, (message) =>
    stderr.write(`warning: ${message}\n`),
  );

  const updateOptions: UpdateOptions = {
    deployRoot: app.deployRoot,
    ...(proxy.mode === undefined ? {} : { proxyMode: proxy.mode }),
    ...(proxy.container === undefined ? {} : { proxyContainer: proxy.container }),
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.cache === false ? { noCache: true } : {}),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.skipSeed === undefined ? {} : { skipSeed: options.skipSeed }),
    ...(options.skipProxy === undefined ? {} : { skipProxy: options.skipProxy }),
    ...(options.createDatabase === undefined ? {} : { createDatabase: options.createDatabase }),
    ...(options.skipRenewal === undefined ? {} : { skipRenewal: options.skipRenewal }),
    ...(options.skipOauthCheck === undefined ? {} : { skipOAuthCheck: options.skipOauthCheck }),
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.versionBump === false ? { noVersionBump: true } : {}),
    ...(answers === undefined ? {} : { answers }),
    ...(ctx?.runCommand === undefined ? {} : { runCommand: ctx.runCommand }),
    ...(json
      ? {}
      : {
          hooks: {
            onStepStart: ({ title, index, total }) =>
              void stderr.write(`\n  [${index + 1}/${total}] ${title}\n`),
            onStepResult: (result) =>
              void stderr.write(
                result.outcome === 'ok'
                  ? `  done (${result.durationMs}ms)\n`
                  : `  ${result.outcome}: ${result.detail ?? ''}\n`,
              ),
            onProgress: (message) => void stderr.write(`  ${message}\n`),
            onLog: (line) => void stderr.write(`    ${line}\n`),
          },
        }),
  };

  const result = await runUpdate(updateOptions);

  if (json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (!result.changed) {
    stderr.write(`\n  Already at ${result.commitSha.slice(0, 12)}. Nothing to do.\n\n`);
    return;
  }

  stderr.write(
    [
      '',
      '  Updated.',
      '',
      `  ${(result.previousSha ?? 'unknown').slice(0, 12)} -> ${result.commitSha.slice(0, 12)}`,
      `  Took       ${Math.round(result.durationMs / 1000)}s`,
      `  Log        ${result.journalPath}`,
      '',
    ].join('\n'),
  );
}
