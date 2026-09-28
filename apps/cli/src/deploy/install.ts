import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { PreconditionError, UsageError } from '../errors.js';
import { CLI_VERSION } from '../package-info.js';
import {
  ALL_CHECKS,
  checksPassed,
  gitCredentialStateFor,
  requiredChecks,
  runChecks,
  type CheckContext,
} from './checks/index.js';
import { parseEnvExample, parseEnvFile } from './env-spec.js';
import { composeFileArgs, composeFilesFor, effectiveGroups } from './compose-files.js';
import { writeEnvFile } from './env-file.js';
import { isDeployment } from './deployment-evidence.js';
import { runEnvWizard } from './env-wizard.js';
import type { EnvGroup } from './env-metadata.js';
import { runCommand as defaultRunCommand } from './executor.js';
import {
  canObtainConsent,
  consented,
  obtainConsent,
  type ConsentOptions,
  type ConsentOutcome,
} from './consent.js';
import { ensureDatabase, onlyDatabaseMissing, unattendedDatabaseRefusal } from './database.js';
import { waitForHealthy, collectHealth, isHealthy, type FetchLike, type OAuthSmoke } from './health.js';
import { runOAuthCheck } from './oauth-check.js';
import {
  bootstrapProxy,
  ensureExternalNetworks,
  externalNetworksIn,
  inspectProxy,
  type ProxyPresence,
} from './proxy-bootstrap.js';
import { ensureRenewal } from './renewal.js';
import type { DeployHooks } from './hooks.js';
import { openJournal, type Journal, type SecretEntry } from './journal.js';
import {
  bootstrapProxyRoot,
  certificateStatus,
  describeProxyRuntime,
  installVhost,
  issueCertificate,
  resolveRecordedProxyRuntime,
  type ProxyMode,
  type ProxyRuntime,
  type ProxyTarget,
  type ResolvedProxyRuntime,
} from './proxy.js';
import { ensureCheckout, resolveRepoTarget, resolveRepoUrl, type RepoTarget } from './repo.js';
import {
  DEPLOY_STATE_VERSION,
  appendHistory,
  readState,
  writeState,
  type DeployState,
  type HostFacts,
} from './state.js';
import { runPipeline, type DeployStep, type StepContext } from './steps/pipeline.js';
import {
  checkoutPathFor,
  publishVersion,
  runVersionStep,
  stampAppVersion,
  type VersionStepResult,
} from './version-step.js';
import { writeDeployInfo, type DeployInfoInput } from './deploy-info.js';
import { collectHostFacts } from './host-facts.js';
import { observeProxy, proxyInfoOf } from './run-record.js';
import { metadataFor } from './env-metadata.js';
import type { PromptContext } from '../prompt.js';

// =============================================================================
// `appctl deploy install`  (issue #180, epic #168)
// =============================================================================
//
// Takes a prepared VPS from nothing to a running, migrated, seeded, healthy,
// HTTPS deployment.
//
// FOUR THINGS THAT DECIDE WHETHER THIS WORKS AT ALL, all of them learned from
// the code rather than assumed:
//
//   1. MIGRATIONS NEED THE ENVIRONMENT EXPLICITLY. scripts/prisma-env.js only
//      loads dotenv when NODE_ENV !== 'production', and the production stack
//      sets NODE_ENV=production - so POSTGRES_* must be present in the migrate
//      container's environment, not merely in a file it might have read.
//   2. NEVER `npm ci` WITH NODE_ENV=production anywhere in here. It drops
//      @nestjs/cli, the Prisma CLI and ts-node, which build, migrate and seed
//      all need. This has bitten the repository before; ci.yml says so.
//   3. /api/health/ready IS NOT PROOF THAT MIGRATIONS RAN. Its only indicator
//      issues SELECT 1, which passes against an empty database. Step 8's exit
//      status is what proves the schema; the health wait proves the process is
//      up. Do not let a green probe stand in for the migration.
//   4. THE CERTIFICATE IS ISSUED BEFORE THE VHOST IS WRITTEN. A vhost naming a
//      certificate that does not exist fails nginx -t and takes the shared
//      proxy's reload down for every site on the host.
// =============================================================================

export interface InstallOptions {
  deployRoot: string;
  domain?: string | undefined;
  bindPort: number;
  proxyRoot: string;
  /**
   * How the shared proxy runs. Absent means "as recorded, else detected" --
   * see `resolveProxyRuntime`.
   */
  proxyMode?: ProxyMode | undefined;
  /** The proxy container's name. Absent means "as recorded, else proxy-nginx". */
  proxyContainer?: string | undefined;
  repo?: string | undefined;
  ref?: string | undefined;
  nonInteractive?: boolean | undefined;
  all?: boolean | undefined;
  groups?: readonly EnvGroup[] | undefined;
  reinstall?: boolean | undefined;
  resume?: boolean | undefined;
  skipDoctor?: boolean | undefined;
  skipProxy?: boolean | undefined;
  skipSeed?: boolean | undefined;
  noCache?: boolean | undefined;
  force?: boolean | undefined;
  email?: string | undefined;
  staging?: boolean | undefined;
  runCommand?: typeof defaultRunCommand | undefined;
  hooks?: DeployHooks | undefined;
  promptContext?: PromptContext | undefined;
  cwd?: string | undefined;
  /**
   * The release version to deploy, overriding the suggested patch bump.
   *
   * Rejected outright when it does not sort ABOVE the clone's current version
   * -- see app-version.ts. Absent means "suggest the patch bump".
   */
  appVersion?: string | undefined;
  /** Deploy the clone's current version unchanged: no write, no commit, no push. */
  noVersionBump?: boolean | undefined;
  /**
   * Values collected elsewhere, merged in ahead of the wizard.
   *
   * The ink screen (#184) needs this: readline cannot ask a question while
   * ink holds stdin in raw mode, so the TUI collects the fields with its own
   * text input and hands them over, then runs the wizard non-interactively.
   */
  answers?: ReadonlyMap<string, string> | undefined;
  /**
   * `--bootstrap-proxy`: consent, given in advance, to create the shared proxy
   * when this box has none (#391). Interactive runs are asked instead.
   */
  bootstrapProxy?: boolean | undefined;
  /**
   * `--create-database`: consent, given in advance, to CREATE the configured
   * database when it is the only thing missing (#391). Interactive runs are
   * asked instead.
   */
  createDatabase?: boolean | undefined;
  /** `--skip-renewal`: do not schedule certificate renewal. */
  skipRenewal?: boolean | undefined;
  /**
   * `--skip-oauth-check`: no live Google credential probe and no post-deploy
   * OAuth smoke, and a malformed client id only warns. For deployments with
   * placeholder credentials (CI) or no outbound HTTPS.
   */
  skipOAuthCheck?: boolean | undefined;
  /** The HTTP client for the OAuth probe and the health/OAuth smoke. Test seam. */
  fetch?: FetchLike | undefined;
  /** Replaces the terminal yes/no question for the consent gates. Test seam. */
  ask?: ((question: string) => Promise<boolean>) | undefined;
}

interface InstallContext extends StepContext {
  /** Set once the stack's external networks are known to exist; see ensureStackNetworks. */
  networksEnsured?: boolean | undefined;
  options: InstallOptions;
  runCommand: typeof defaultRunCommand;
  journal: Journal;
  target?: RepoTarget | undefined;
  checkoutPath?: string | undefined;
  commitSha?: string | undefined;
  env?: Map<string, string> | undefined;
  /** Undefined means the directory-derived default; see composeProjectFor. */
  composeProject?: string | undefined;
  /** The result of the `version` step, read by `publish-version`. */
  version?: VersionStepResult | undefined;
  /** What a previous run recorded about the proxy, for --resume/--reinstall. */
  recordedProxy?: Pick<DeployState, 'proxyMode' | 'proxyContainer'> | undefined;
  /** Resolved once, on first use; see `proxyRuntimeOf`. */
  proxyRuntime?: ResolvedProxyRuntime | undefined;
  /** The record this run started from, if any; the source of prior history. */
  existingState?: DeployState | undefined;
  /** Collected once, on first use; see `hostFactsOf`. */
  hostFacts?: HostFacts | undefined;
  /**
   * What `validate-environment` learned about the database: `exists`, or
   * `missing` (the ONE failure `ensure-database` may act on). Undefined when it
   * did not run in this process -- a resumed run -- and then `ensure-database`
   * asks for itself.
   */
  database?: 'exists' | 'missing' | undefined;
  /** The proxy-bootstrap consent preflight obtained, so it is asked once. */
  proxyBootstrapConsent?: ConsentOutcome | undefined;
}

/**
 * The environment this run acts on: the wizard's, or -- on a resumed run that
 * skipped the `environment` step -- the file on disk.
 */
function environmentOf(context: InstallContext): Map<string, string> | undefined {
  if (context.env !== undefined) return context.env;
  const path = envFilePath(context.options.deployRoot);
  return existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : undefined;
}

/** The question the proxy-bootstrap gate asks. */
function bootstrapQuestion(proxyRoot: string, container: string): string {
  return (
    `This server has no shared reverse proxy. Create one in ${proxyRoot} ` +
    `(nginx container "${container}" on ports 80/443, serving every application on this host)?`
  );
}

/** The refusal when the proxy is absent and nobody consented to create it. */
function bootstrapRefusal(outcome: ConsentOutcome, proxyRoot: string): PreconditionError {
  return new PreconditionError(
    (outcome === 'declined'
      ? 'Creating the shared proxy was declined.'
      : 'This server has no shared reverse proxy, and nothing could be asked in this mode.') +
      ` Re-run with --bootstrap-proxy to have install create it in ${proxyRoot}, ` +
      `bring up an existing one (cd ${proxyRoot} && docker compose up -d), or pass --skip-proxy.`,
  );
}

/**
 * The proxy runtime this run acts under, resolved ONCE and then reused, so the
 * preflight, the certificate and the vhost can never disagree about it.
 */
async function proxyRuntimeOf(context: InstallContext): Promise<ResolvedProxyRuntime> {
  if (context.proxyRuntime !== undefined) return context.proxyRuntime;

  const runtime = await resolveRecordedProxyRuntime({
    proxyRoot: context.options.proxyRoot,
    flags: { mode: context.options.proxyMode, container: context.options.proxyContainer },
    recorded: context.recordedProxy,
    runCommand: context.runCommand,
  });
  context.proxyRuntime = runtime;
  context.journal.line(describeProxyRuntime(runtime));
  return runtime;
}

/**
 * The host facts for this run, collected ONCE on first use and then reused, so
 * the health-gate info.json and the final state/info.json agree. Lazy rather
 * than up front: by the health gate Docker is demonstrably there to answer.
 */
async function hostFactsOf(context: InstallContext): Promise<HostFacts> {
  context.hostFacts ??= await collectHostFacts({ runCommand: context.runCommand });
  return context.hostFacts;
}

/**
 * The info.json input for this run, as known at `at`.
 *
 * One builder for both writes -- the health gate and the end of a successful
 * run -- so the second can only ADD what the run learned since (the new
 * history entry, the certificate), never describe the deployment differently.
 */
function installDeployInfo(context: InstallContext, at: string): DeployInfoInput {
  const existing = context.existingState;
  const runtime = recordedRuntime(context);
  const domain = context.options.domain;
  return {
    name: basename(context.options.deployRoot),
    ...(context.version?.version === undefined ? {} : { version: context.version.version }),
    ...(context.commitSha === undefined ? {} : { commitSha: context.commitSha }),
    ...(context.target?.ref === undefined ? {} : { ref: context.target.ref }),
    // The first install is `at`; a --reinstall keeps the original.
    installedAt: existing?.installedAt ?? at,
    updatedAt: at,
    cliVersion: CLI_VERSION,
    ...(domain === undefined ? {} : { domain }),
    // What THIS run has finished so far -- not the resume set, which is what a
    // PREVIOUS run finished.
    completed: [...(context.progress ?? [])],
    lastCommand: 'install',
    bindPort: context.options.bindPort,
    // Before `publish` the certificate is whatever a previous run observed for
    // the SAME domain; the end-of-run rewrite replaces it with a fresh read.
    proxy: proxyInfoOf(
      domain === undefined
        ? undefined
        : {
            domain,
            bindPort: context.options.bindPort,
            mode: runtime.proxyMode ?? null,
            container: runtime.proxyContainer ?? null,
            certificateExpiresAt:
              existing?.proxy?.domain === domain ? existing.proxy.certificateExpiresAt : null,
          },
    ),
    ...(context.hostFacts === undefined ? {} : { host: context.hostFacts }),
    // Success-only: THIS run is not in it until it has succeeded.
    history: existing?.history ?? [],
  };
}

/** The state fields that record the runtime, when one was resolved. */
function recordedRuntime(
  context: InstallContext,
): Pick<DeployState, 'proxyMode' | 'proxyContainer'> {
  const runtime = context.proxyRuntime;
  // A run that never touched the proxy keeps whatever was recorded before.
  if (runtime === undefined) return context.recordedProxy ?? {};
  return { proxyMode: runtime.mode, proxyContainer: runtime.container };
}

export function composeCwd(deployRoot: string): string {
  // The relative build contexts in base.compose.yml (`../..`, `../nginx`)
  // resolve against the COMPOSE FILE's directory, so this is not incidental.
  return join(deployRoot, 'repo', 'infra', 'compose');
}

/**
 * The compose project name for a deployment.
 *
 * ⚠ THIS IS AN OUTAGE WAITING TO HAPPEN IF GOT WRONG, so read before changing.
 *
 * Without `-p`, Compose derives the project name from the compose file's
 * DIRECTORY, which is `compose` for every deployment on the host -- so two
 * applications collide on one project and each `up -d` fights the other. That
 * is the bug this fixes.
 *
 * But naming an EXISTING deployment's project renames it, and Compose then
 * sees no existing containers: it builds a parallel stack that collides with
 * the old one still holding the bind port. A bookkeeping change would have
 * caused an outage.
 *
 * So the name is RECORDED, never derived at the call site. A deployment that
 * was installed before this existed stays on `compose` for ever; only a fresh
 * install gets its own name. `state.composeProject` is the record, and the
 * absence of it means `compose` -- which is exactly what every deployment in
 * the field has.
 */
export const LEGACY_COMPOSE_PROJECT = 'compose';

export function composeProjectFor(
  state: { composeProject?: string | undefined } | undefined,
): string {
  return state?.composeProject ?? LEGACY_COMPOSE_PROJECT;
}

/**
 * The full `docker compose` argv for this deployment.
 *
 * `groups` are the deployment's groups -- this run's flag, else what install
 * recorded -- and decide which compose files take part; see compose-files.ts.
 * The always-on telemetry files are included whatever is passed (#567).
 */
export function composeArgv(
  extra: readonly string[],
  project?: string,
  groups?: readonly string[] | undefined,
): string[] {
  return [
    'docker',
    'compose',
    ...(project === undefined ? [] : ['-p', project]),
    ...composeFileArgs(groups),
    ...extra,
  ];
}

/**
 * Creates every directory compose bind-mounts from, before compose runs.
 *
 * =============================================================================
 * ⚠ CALLED BEFORE **EVERY** COMPOSE INVOCATION, NOT JUST BEFORE `up`
 * =============================================================================
 *
 * Docker creates a missing bind SOURCE itself, as `root:root`, the moment it
 * instantiates the service that mounts it -- and `compose run --rm --no-deps
 * api` instantiates the api service just as thoroughly as `up` does. So
 * `migrate`, two steps before `start`, was already creating
 * `<deployRoot>/deploy-info` owned by root; the `mkdirSync` at `start` then
 * no-opped on a directory that already existed, and the `deploy-info` step
 * later got EACCES writing into it.
 *
 * Every step reported green. The deployment was up, healthy and serving; only
 * the About page was permanently empty, and the one line saying why was a
 * warning in a journal nobody reads on a successful run.
 *
 * Guarding the ORDER was the original fix and it was the wrong shape: it left
 * the invariant depending on which step happens to come first, so adding a
 * compose call earlier in the pipeline silently reintroduces the bug. Guarding
 * the CALL makes that unrepresentable. `mkdirSync` with `recursive` is a no-op
 * when the directory is already there, so the cost is one syscall.
 */
function ensureBindSources(deployRoot: string): void {
  mkdirSync(join(deployRoot, 'deploy-info'), { recursive: true });
}

function envFilePath(deployRoot: string): string {
  return join(composeCwd(deployRoot), '.env');
}

/**
 * What the wizard will start from: the `.env` on disk, with the caller's
 * non-blank answers over it. Shared by the `environment` step and preflight's
 * database gate (#396), so the gate probes the settings the run will write.
 */
function plannedEnvironment(options: InstallOptions): Map<string, string> | undefined {
  const path = envFilePath(options.deployRoot);
  const onDisk = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : undefined;

  // Answers supplied by a caller win over what is on disk: they are the
  // more recent statement of intent.
  //
  // A BLANK ANSWER IS NOT AN ANSWER, though, and this is the guard that
  // says so. The TUI collects every essential key into a form and hands
  // the whole map over, so a field the operator left alone arrives as
  // `''`. Letting that beat the on-disk value means a re-install over a
  // live deployment overwrites the secrets it did not ask about - and for
  // `SECRETS_ENCRYPTION_KEY` that makes every credential encrypted under
  // the old key permanently undecryptable, with no visible symptom.
  //
  // Dropping blanks here means "leave it as it is" survives the round
  // trip, which is what an untouched field means in every UI anyone has
  // ever used.
  if (options.answers === undefined) return onDisk;
  const supplied = [...options.answers].filter(([, value]) => value !== '');
  return new Map([...(onDisk ?? new Map<string, string>()), ...supplied]);
}

/**
 * The POSTGRES_* keys that must all be known, non-blank, before checkout for
 * preflight to probe the database (#396). POSTGRES_SSL is left out: absent
 * means `false` both here and in the template.
 */
const PRE_CHECKOUT_DATABASE_KEYS = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
] as const;

/**
 * The environment preflight may probe the database with, or undefined when
 * the settings are not knowable until the wizard has run -- a first install
 * whose answers leave a POSTGRES_* key to the template, which is not on disk
 * until `checkout`. A template default is never guessed at here: probing a
 * database the run will not use could refuse an install that would work.
 */
function preCheckoutDatabaseEnvironment(options: InstallOptions): Map<string, string> | undefined {
  const env = plannedEnvironment(options);
  if (env === undefined) return undefined;
  return PRE_CHECKOUT_DATABASE_KEYS.every((key) => (env.get(key) ?? '') !== '') ? env : undefined;
}

/** Secrets for the journal's redactor, from the metadata rather than a guess. */
export function secretsFrom(env: ReadonlyMap<string, string>): SecretEntry[] {
  return [...env.entries()]
    .filter(([key]) => metadataFor(key).secret === true)
    .map(([key, value]) => ({ key, value }));
}

async function compose(
  context: InstallContext,
  extra: readonly string[],
  options?: { timeoutMs?: number },
): Promise<void> {
  ensureBindSources(context.options.deployRoot);
  await ensureStackNetworks(context, extra, context.options.groups);

  const argv = composeArgv(extra, context.composeProject, context.options.groups);
  const result = await context.runCommand(argv, {
    cwd: composeCwd(context.options.deployRoot),
    timeoutMs: options?.timeoutMs ?? 30 * 60_000,
    redact: context.journal.redact,
    ...(context.hooks?.onLog === undefined
      ? {}
      : { onLine: (line: string) => context.hooks?.onLog?.(line) }),
  });
  context.journal.command(result);
}

/** Compose subcommands that instantiate services, and so need their networks. */
const INSTANTIATING = new Set(['up', 'run', 'create', 'start', 'restart']);

/**
 * Ensures the stack's external networks exist before the FIRST compose call
 * that instantiates a service -- `migrate`'s `compose run`, before `start`'s
 * `up`. Once per run (`networksEnsured`), and guarded on the CALL for the same
 * reason `ensureBindSources` is: an earlier compose step added later cannot
 * reintroduce the fresh-box failure. Shared with update.
 */
export async function ensureStackNetworks(
  context: Pick<StepContext, 'journal'> & {
    runCommand: typeof defaultRunCommand;
    options: { deployRoot: string };
    networksEnsured?: boolean | undefined;
  },
  extra: readonly string[],
  groups?: readonly string[] | undefined,
): Promise<void> {
  if (context.networksEnsured === true || !INSTANTIATING.has(extra[0] ?? '')) return;
  const composeDir = composeCwd(context.options.deployRoot);
  await ensureExternalNetworks({
    // The same files the compose call itself will use; see compose-files.ts.
    composeFiles: composeFilesFor(groups).map((file) => join(composeDir, file)),
    runCommand: context.runCommand,
    onLine: (line) => context.journal.line(line),
  });
  context.networksEnsured = true;
}

/**
 * Preflight's database gate (#396): the refusal `ensure-database` is certain
 * to give, or undefined. Asks nothing and creates nothing; see the call site.
 */
async function preflightDatabaseRefusal(context: InstallContext): Promise<Error | undefined> {
  if (canObtainConsent(consentOptions(context, context.options.createDatabase))) return undefined;

  const env = preCheckoutDatabaseEnvironment(context.options);
  if (env === undefined) {
    context.journal.line(
      'Database settings are not known until the environment is configured; ensure-database will check.',
    );
    return undefined;
  }

  // The existence checks carry the password in PGPASSWORD; a fresh journal
  // has not seen it yet, and a psql error must not put it in the log.
  context.journal.addSecrets?.(secretsFrom(env));
  return await unattendedDatabaseRefusal({
    env,
    runCommand: context.runCommand,
    envPath: envFilePath(context.options.deployRoot),
    onLine: (line) => context.journal.line(line),
  });
}

export function buildInstallSteps(): DeployStep<InstallContext>[] {
  return [
    {
      id: 'preflight',
      title: 'Check prerequisites',
      skip: (context) =>
        context.options.skipDoctor === true
          ? 'skipped with --skip-doctor'
          : undefined,
      async run(context) {
        // Create the shared proxy's directory layout BEFORE the checks that
        // look for it. Both the spec and the runbook promise install does this;
        // until now the checks simply failed instead, so an operator following
        // the documentation on a fresh VPS hit a refusal it told them would not
        // happen. Directories only -- the proxy itself is shared infrastructure
        // this deployment is a tenant of, not an owner of.
        if (context.options.skipProxy !== true) {
          const { created } = bootstrapProxyRoot(context.options.proxyRoot, context.hooks);
          for (const path of created) context.journal.line(`Created ${path}`);
        }

        // The repository `checkout` will clone, by the same precedence, and
        // whether git can already read it. Probed ONCE here because it decides
        // whether gh-installed/gh-authenticated are required (#390): an HTTPS
        // GitHub URL git cannot read would otherwise stop the clone at an
        // authentication prompt, after this preflight said it was fine.
        const repoUrl = await resolveRepoUrl({
          cwd: context.options.cwd ?? process.cwd(),
          runCommand: context.runCommand,
          ...(context.options.repo === undefined ? {} : { repoFlag: context.options.repo }),
        });
        const gitCredentialed = await gitCredentialStateFor(repoUrl, context.runCommand);

        // #391: a box with no proxy at all is bootstrappable -- ask NOW, with
        // the other questions, rather than after a four-minute build. Consent
        // lets the proxy-container check stand down; the `proxy-bootstrap`
        // step does the work later, just before `publish`.
        const runtime = await proxyRuntimeOf(context);
        if (
          context.options.skipProxy !== true &&
          context.options.domain !== undefined &&
          runtime.mode === 'container'
        ) {
          const presence = await inspectProxy({
            proxyRoot: context.options.proxyRoot,
            runtime,
            runCommand: context.runCommand,
          });
          if (presence.state === 'absent') {
            context.proxyBootstrapConsent = await obtainConsent(
              bootstrapQuestion(context.options.proxyRoot, runtime.container),
              consentOptions(context, context.options.bootstrapProxy),
            );
            context.journal.line(`Shared proxy absent; bootstrap consent: ${context.proxyBootstrapConsent}`);
          }
        }

        const checkContext: CheckContext = {
          runCommand: context.runCommand,
          deployRoot: context.options.deployRoot,
          bindPort: context.options.bindPort,
          proxyRoot: context.options.proxyRoot,
          // Resolved before the checks, because it decides which of them are
          // required: certbot-installed only on the host, renewal-path hygiene
          // only in a container.
          proxyRuntime: runtime,
          ...(context.options.domain === undefined
            ? {}
            : { domain: context.options.domain }),
          ...(repoUrl === undefined ? {} : { repoUrl }),
          ...(gitCredentialed === undefined ? {} : { gitCredentialed }),
          ...(context.options.skipProxy === true ? { skipProxy: true } : {}),
          ...(context.proxyBootstrapConsent !== undefined && consented(context.proxyBootstrapConsent)
            ? { proxyBootstrap: true }
            : {}),
        };

        const results = await runChecks(requiredChecks(ALL_CHECKS, checkContext), checkContext);

        for (const result of results) {
          context.journal.line(`${result.status} ${result.id}: ${result.detail}`);
        }

        // #396: a missing database is a QUESTION, and `ensure-database` asks
        // it -- after `validate-environment`, with the settings the wizard
        // actually wrote. The one case decided HERE is the one whose answer is
        // already certain: nobody can be asked (--non-interactive, no
        // terminal) and --create-database was not given, so the install is
        // bound to stop at `ensure-database` -- and stopping now spares the
        // clone. Only when the settings are knowable before checkout (a
        // re-install's `.env`, or answers naming every POSTGRES_* key); on a
        // first install that leaves one to the template, the refusal still
        // comes from `ensure-database`, before anything is built or migrated.
        // Never prompts: an interactive run is asked later, once.
        const databaseRefusal = await preflightDatabaseRefusal(context);

        if (!checksPassed(results) || databaseRefusal !== undefined) {
          const failed = results.filter((result) => result.status === 'fail');
          // Aborts BEFORE anything is cloned or written.
          throw new PreconditionError(
            `Prerequisites not met:\n` +
              [
                ...failed.map((result) => `  - ${result.id}: ${result.detail}\n    ${result.remedy ?? ''}`),
                ...(databaseRefusal === undefined
                  ? []
                  : [`  - database-exists: ${databaseRefusal.message.split('\n').join('\n    ')}`]),
              ].join('\n') +
              `\nRun \`${CLI_NAME} deploy doctor\` for the full report.`,
          );
        }
      },
    },
    {
      id: 'checkout',
      title: 'Fetch the application',
      async run(context) {
        const target = await resolveRepoTarget({
          cwd: context.options.cwd ?? process.cwd(),
          runCommand: context.runCommand,
          ...(context.options.repo === undefined ? {} : { repoFlag: context.options.repo }),
          ...(context.options.ref === undefined ? {} : { refFlag: context.options.ref }),
        });

        context.journal.line(`Deploying ${target.url} @ ${target.ref} (${target.source})`);

        const checkout = await ensureCheckout(target, {
          deployRoot: context.options.deployRoot,
          runCommand: context.runCommand,
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
          ...(context.options.force === undefined ? {} : { force: context.options.force }),
        });

        context.target = target;
        context.checkoutPath = checkout.path;
        context.commitSha = checkout.sha;
        context.journal.line(`Checked out ${checkout.sha}`);
      },
    },
    {
      id: 'environment',
      title: 'Configure the environment',
      async run(context) {
        const templatePath = join(
          context.options.deployRoot,
          'repo',
          'infra',
          'compose',
          '.env.example',
        );
        const specs = parseEnvExample(readFileSync(templatePath, 'utf8'));

        const path = envFilePath(context.options.deployRoot);
        // On disk, with the caller's non-blank answers over it -- see
        // plannedEnvironment for why a blank answer is not an answer.
        const existing = plannedEnvironment(context.options);

        const domain = context.options.domain;
        if (domain === undefined && context.options.skipProxy !== true) {
          throw new UsageError(
            'A domain is required so APP_URL and the OAuth callback can be derived. Pass --domain.',
          );
        }

        const { values } = await runEnvWizard({
          specs,
          // With --skip-proxy and no --domain there is no public hostname to
          // derive from, and localhost is the honest stand-in: APP_URL and the
          // OAuth callback then point where the stack actually answers.
          domain: domain ?? 'localhost',
          ...(existing === undefined ? {} : { existing }),
          ...(context.options.all === undefined ? {} : { all: context.options.all }),
          ...(context.options.nonInteractive === undefined
            ? {}
            : { nonInteractive: context.options.nonInteractive }),
          ...(context.options.groups === undefined ? {} : { groups: context.options.groups }),
          ...(context.options.promptContext === undefined
            ? {}
            : { ctx: context.options.promptContext }),
        });

        values.set('APP_BIND_PORT', String(context.options.bindPort));

        // ⚠ THE CLI'S OWN KEY, AND THE BIND MOUNT DOES NOT WORK WITHOUT IT.
        //
        // `DEPLOY_ROOT` was READ in three places and written in none:
        //
        //   - `vps.compose.yml` interpolates it for the deploy-info bind mount
        //     source. Unset, it falls back to `./.deploy/deploy-info` --
        //     relative to the compose directory -- so the api container mounts
        //     an empty directory Docker created, and the About page reports
        //     `absent` for ever. Every step still reports green, because the
        //     stack is up and the fallback path is perfectly valid.
        //   - `layout.ts` uses it as the marker identifying an `.env` THIS CLI
        //     wrote, so `deploy list` and the ambiguity refusal labelled every
        //     deployment we had written as unmarked.
        //   - `version-step.ts`'s comment describes it as already being there.
        //
        // It is deliberately absent from `.env.example` -- that is what makes
        // it a usable marker, since a stranger's file cannot have it -- so it
        // lands under the serializer's own `# Not in .env.example` banner.
        //
        // ⚠ `COMPOSE_PROJECT_NAME` is deliberately NOT written here. The
        // project name reaches compose through `-p` on every invocation this
        // CLI makes, and writing it into an EXISTING deployment's `.env`
        // renames the project: compose then sees no existing containers,
        // builds a parallel stack, and collides with the old one on the bind
        // port. That is an outage caused by a bookkeeping change, and `-p`
        // already solves the problem it would solve.
        values.set('DEPLOY_ROOT', context.options.deployRoot);

        mkdirSync(composeCwd(context.options.deployRoot), { recursive: true });
        writeEnvFile(path, values, specs);

        context.env = values;
        // ⚠ BEFORE ANYTHING USES THEM. A fresh install's journal was opened
        // with no secrets (there was no .env to seed it from); the OAuth probe
        // in the next step sends GOOGLE_CLIENT_SECRET over the network, and an
        // error quoting the request must not put it in the log.
        context.journal.addSecrets(secretsFrom(values));
        context.journal.line(`Wrote ${path} (${values.size} variables)`);
      },
    },
    {
      id: 'validate-environment',
      title: 'Validate the environment',
      async run(context) {
        if (context.env === undefined) return;

        const results = await runChecks(
          ALL_CHECKS.filter((check) => check.id.startsWith('database-')),
          {
            runCommand: context.runCommand,
            deployRoot: context.options.deployRoot,
            bindPort: context.options.bindPort,
            proxyRoot: context.options.proxyRoot,
            env: context.env,
          },
        );

        for (const result of results) {
          context.journal.line(`${result.status} ${result.id}: ${result.detail}`);
        }

        if (checksPassed(results)) {
          context.database = 'exists';
        } else if (onlyDatabaseMissing(results)) {
          // #391: the ONE failure `ensure-database` may act on -- reachable,
          // authenticated, and only the database itself absent. Deferred, not
          // thrown; every other failure still stops the install right here.
          context.database = 'missing';
          context.journal.line('The database does not exist yet; ensure-database decides what to do about it.');
        } else {
          throw new PreconditionError(
            `The database is not usable with these settings:\n` +
              results
                .filter((result) => result.status === 'fail')
                .map((result) => `  - ${result.detail}\n    ${result.remedy ?? ''}`)
                .join('\n'),
          );
        }

        // #391: the OAuth credentials, BEFORE the build -- a wrong secret was
        // otherwise found by the first user to sign in, after everything.
        const oauth = await runOAuthCheck({
          env: context.env,
          ...(context.options.domain === undefined ? {} : { domain: context.options.domain }),
          skipLiveProbe: context.options.skipOAuthCheck === true,
          ...(context.options.fetch === undefined ? {} : { fetch: context.options.fetch }),
        });
        for (const finding of oauth.findings) {
          context.journal.line(`${finding.status} ${finding.id}: ${finding.detail}`);
          if (finding.status === 'warn') {
            context.hooks?.onProgress?.(`warning: ${finding.detail}`);
          }
        }
        if (!oauth.ok) {
          throw new PreconditionError(
            'The Google OAuth settings would fail every sign-in:\n' +
              oauth.findings
                .filter((finding) => finding.status === 'fail')
                .map((finding) => `  - ${finding.detail}\n    ${finding.remedy ?? ''}`)
                .join('\n') +
              '\nFix them in the environment file (or pass --skip-oauth-check for placeholder credentials), then re-run with --resume.',
          );
        }
      },
    },
    {
      id: 'ensure-database',
      title: 'Make sure the database exists',
      async run(context) {
        // Already known to exist: no second round of psql containers.
        if (context.database === 'exists') return;

        const env = environmentOf(context);
        if (env === undefined) {
          context.journal.line('No environment file; nothing to check.');
          return;
        }

        // #396: the one "offer, create, re-verify" implementation -- see
        // ensureDatabase's own comment.
        const result = await ensureDatabase({
          env,
          runCommand: context.runCommand,
          createDatabase: context.options.createDatabase,
          ...consentOptions(context),
          envPath: envFilePath(context.options.deployRoot),
          onLine: (line) => context.journal.line(line),
        });
        context.database = 'exists';
        context.journal.line(result.detail);
        if (result.outcome === 'created') context.hooks?.onProgress?.(result.detail);
      },
    },
    {
      id: 'version',
      title: 'Choose the release version',
      // ⚠ NO `skip` FOR --no-version-bump. The flag means "do not bump", not
      // "do not stamp": the step still writes the clone's CURRENT version into
      // the `.env`, because skipping it entirely would leave the container
      // reporting whatever APP_VERSION the last deploy happened to set.
      async run(context) {
        // ⚠ IMMEDIATELY BEFORE `build`, AND IT COMMITS. The checkout step
        // refuses a dirty tree, so leaving manifests dirty across a
        // four-minute build would wedge the NEXT update behind a refusal about
        // files the operator never touched. See version-step.ts's header.
        const result = await runVersionStep({
          checkoutPath: checkoutPathFor(context.options.deployRoot),
          ...(context.options.appVersion === undefined
            ? {}
            : { requested: context.options.appVersion }),
          ...(context.options.noVersionBump === undefined
            ? {}
            : { disabled: context.options.noVersionBump }),
          runCommand: context.runCommand,
        });

        context.version = result;
        context.journal.line(`Version: ${result.detail}`);

        // ⚠ The DEPLOYED COMMIT IS THE BUMP COMMIT. Recording the pre-bump one
        // leaves every server reporting itself a commit behind for ever,
        // rebuilding identical code and bumping again on every update. It is
        // also more accurate: the commit happens before `build`, so the images
        // really were built with HEAD here.
        if (result.commitSha !== undefined) context.commitSha = result.commitSha;

        // ⚠ STAMPED ON DISK, NOT JUST IN MEMORY. `context.env` is the wizard's
        // map and nothing writes it again after the `environment` step, so an
        // in-memory set alone would leave the running container on whatever
        // APP_VERSION the last deploy wrote. The disk write is what the build
        // and the api container actually read.
        const stamped = stampAppVersion(
          envFilePath(context.options.deployRoot),
          join(composeCwd(context.options.deployRoot), '.env.example'),
          result.version,
        );
        context.env?.set('APP_VERSION', result.version);
        if (!stamped) {
          context.journal.line('APP_VERSION was not stamped: no .env on disk yet.');
        }
      },
    },
    {
      id: 'build',
      title: 'Build images',
      async run(context) {
        await compose(context, [
          'build',
          ...(context.options.noCache === true ? ['--no-cache'] : []),
        ]);
      },
    },
    {
      id: 'migrate',
      title: 'Apply migrations',
      async run(context) {
        // `run --rm` rather than `exec`: the stack is not up yet, and this must
        // not depend on the api container already running.
        await compose(context, [
          'run', '--rm', '--no-deps', 'api',
          'npm', 'run', 'prisma:migrate',
        ], { timeoutMs: 10 * 60_000 });
      },
    },
    {
      id: 'seed',
      title: 'Seed roles and permissions',
      skip: (context) =>
        context.options.skipSeed === true ? 'skipped with --skip-seed' : undefined,
      async run(context) {
        await compose(context, [
          'run', '--rm', '--no-deps', 'api',
          'npm', 'run', 'prisma:seed',
        ], { timeoutMs: 10 * 60_000 });
      },
    },
    {
      id: 'start',
      title: 'Start the stack',
      async run(context) {
        // The bind sources are created by `ensureBindSources`, which runs
        // before EVERY compose invocation -- see its header for why doing it
        // here, one step before `up`, was not enough.
        await compose(context, ['up', '-d']);
      },
    },
    {
      id: 'health',
      title: 'Wait for the API',
      async run(context) {
        const probe = await waitForHealthy({
          runCommand: context.runCommand,
          deployRoot: context.options.deployRoot,
          bindPort: context.options.bindPort,
          ...(context.composeProject === undefined
            ? {}
            : { composeProject: context.composeProject }),
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
        });

        if (!probe.ok) {
          throw new Error(
            `The API did not become ready: ${probe.error ?? `HTTP ${probe.status ?? '?'}`}`,
          );
        }
      },
    },
    {
      id: 'deploy-info',
      title: 'Record what was deployed',
      async run(context) {
        // ⚠ IMMEDIATELY AFTER `health`, NOT AT THE END. If the API is
        // answering, the application demonstrably IS deployed and the About
        // page should say so. Written at the end, a failure in `publish` --
        // which runs between here and there -- would leave that page reporting
        // nothing at all about a deployment that is up and serving, which is
        // exactly when somebody is looking at it.
        //
        // ⚠ AND REWRITTEN AT THE END of a successful run (see `runInstall`),
        // which is the only point at which this run's history entry and a
        // freshly read certificate expiry exist. This write describes what is
        // answering NOW; that one supersedes it with the finished run.
        await hostFactsOf(context);
        const result = writeDeployInfo(
          context.options.deployRoot,
          installDeployInfo(context, new Date().toISOString()),
        );

        // ⚠ BOOKKEEPING, NOT THE DEPLOYMENT. By this point the stack is up and
        // answering; a file this CLI could not write is a warning, never a
        // failure that undoes a successful deploy.
        context.journal.line(
          result.written
            ? `Wrote ${result.path}`
            : `warning: could not write ${result.path}: ${result.error ?? 'unknown'}`,
        );
        if (!result.written) {
          context.hooks?.onProgress?.(`warning: deployment record not written (${result.error ?? 'unknown'})`);
        }
      },
    },
    {
      id: 'proxy-bootstrap',
      title: 'Make sure the shared proxy is running',
      skip: (context) => {
        if (context.options.skipProxy === true) return 'skipped with --skip-proxy';
        if (context.options.domain === undefined) return 'no --domain given';
        return undefined;
      },
      async run(context) {
        const runtime = await proxyRuntimeOf(context);
        if (runtime.mode !== 'container') {
          context.journal.line('The proxy runs on the host; it is the host\'s to run, and nothing is bootstrapped.');
          return;
        }

        const proxyRoot = context.options.proxyRoot;
        const presence: ProxyPresence = await inspectProxy({
          proxyRoot,
          runtime,
          runCommand: context.runCommand,
        });
        context.journal.line(presence.detail);

        switch (presence.state) {
          case 'running':
            // The ordinary case on every deployment after a box's first.
            return;
          case 'stopped':
            // ⚠ NOT STARTED FOR THEM. It is shared, and somebody stopped it --
            // possibly on purpose. Say so and let them decide.
            throw new PreconditionError(
              `The shared proxy container ${runtime.container} exists but is stopped. It is shared infrastructure, so ` +
                `this install will not start it. Start it: docker start ${runtime.container} (or: cd ${proxyRoot} && docker compose up -d), then re-run with --resume.`,
            );
          case 'configured':
            throw new PreconditionError(
              `${presence.detail}. That proxy belongs to whatever created it, so this install will not touch it. ` +
                `Start it: cd ${proxyRoot} && docker compose up -d -- or, if its container has another name, pass --proxy-container <name>. Then re-run with --resume.`,
            );
          case 'unknown':
            throw new PreconditionError(`${presence.detail}. Check it by hand: docker inspect ${runtime.container}`);
          case 'absent':
            break;
        }

        // Asked once: preflight's answer, when it asked; otherwise now (a
        // resumed run, or --skip-doctor). A "no" is not asked twice.
        const consent =
          context.proxyBootstrapConsent ??
          (await obtainConsent(
            bootstrapQuestion(proxyRoot, runtime.container),
            consentOptions(context, context.options.bootstrapProxy),
          ));
        if (!consented(consent)) throw bootstrapRefusal(consent, proxyRoot);

        const composeDir = composeCwd(context.options.deployRoot);
        const result = await bootstrapProxy({
          proxyRoot,
          runtime,
          runCommand: context.runCommand,
          hooks: context.hooks,
          // The networks the APPLICATION's compose files declare external,
          // read from the checkout -- never a name this CLI makes up.
          networks: externalNetworksIn(
            composeFilesFor(context.options.groups).map((file) => join(composeDir, file)),
          ),
          onLine: (line) => context.journal.line(line),
        });
        context.hooks?.onProgress?.(
          `Created the shared proxy in ${proxyRoot} (${result.created.length} file(s)/directories)`,
        );
      },
    },
    {
      id: 'publish',
      title: 'Publish over HTTPS',
      skip: (context) => {
        if (context.options.skipProxy === true) return 'skipped with --skip-proxy';
        if (context.options.domain === undefined) return 'no --domain given';
        return undefined;
      },
      async run(context) {
        const target: ProxyTarget = {
          domain: context.options.domain as string,
          bindPort: context.options.bindPort,
          proxyRoot: context.options.proxyRoot,
        };

        const email =
          context.options.email ?? context.env?.get('INITIAL_ADMIN_EMAIL') ?? '';
        if (email === '') {
          throw new UsageError(
            'A registration email is required for the certificate. Pass --email, or set INITIAL_ADMIN_EMAIL.',
          );
        }

        const runtime = await proxyRuntimeOf(context);

        // Certificate FIRST. See rule 4 in the header.
        await issueCertificate(target, {
          runCommand: context.runCommand,
          runtime,
          email,
          ...(context.options.staging === undefined ? {} : { staging: context.options.staging }),
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
        });

        await installVhost(target, {
          runCommand: context.runCommand,
          // Paths in the vhost, and where `nginx -t` / the reload run, both
          // come from here. Omitting it is the host-binary assumption.
          runtime,
          ...(context.hooks === undefined ? {} : { hooks: context.hooks }),
          ...(context.env?.get('MAX_FILE_SIZE') === undefined
            ? {}
            : { maxBodyBytes: Number(context.env.get('MAX_FILE_SIZE')) }),
        });
      },
    },
    {
      id: 'renewal',
      title: 'Schedule certificate renewal',
      skip: (context) => {
        if (context.options.skipRenewal === true) return 'skipped with --skip-renewal';
        if (context.options.skipProxy === true) return 'skipped with --skip-proxy';
        if (context.options.domain === undefined) return 'no --domain given';
        return undefined;
      },
      async run(context) {
        const proxyRoot = context.options.proxyRoot;
        const status = certificateStatus({
          domain: context.options.domain as string,
          bindPort: context.options.bindPort,
          proxyRoot,
        });
        if (!status.exists) {
          context.journal.line(`No certificate at ${status.path}; nothing to renew yet.`);
          return;
        }

        await scheduleRenewal(context, proxyRoot, await proxyRuntimeOf(context));
      },
    },
    {
      id: 'verify',
      title: 'Verify the deployment',
      async run(context) {
        const report = await collectHealth({
          runCommand: context.runCommand,
          deployRoot: context.options.deployRoot,
          bindPort: context.options.bindPort,
          ...(context.composeProject === undefined
            ? {}
            : { composeProject: context.composeProject }),
          ...(context.options.domain === undefined || context.options.skipProxy === true
            ? {}
            : { domain: context.options.domain }),
          ...(context.options.fetch === undefined ? {} : { fetch: context.options.fetch }),
          ...oauthSmokeTarget(context.options.skipOAuthCheck, environmentOf(context)),
          ...(context.options.groups === undefined ? {} : { groups: context.options.groups }),
        });

        context.journal.line(
          `containers=${report.containers.length} ready=${report.local.ready.ok} frontend=${report.local.frontend.ok} migrations=${report.migrations.known ? report.migrations.pending.length : 'unknown'}`,
        );

        if (!isHealthy(report)) {
          throw new Error(
            'The stack is up but not healthy. Run `' +
              CLI_NAME +
              ' deploy status` for the detail.',
          );
        }

        reportOAuthSmoke(context, report.oauth);
      },
    },
    {
      id: 'publish-version',
      title: 'Publish the release version',
      skip: (context) =>
        context.version?.bumped === true ? undefined : 'no version was bumped',
      async run(context) {
        // ⚠ PUSH LAST, AFTER VERIFY -- not at the health gate. Pushing to a
        // shared repository is irreversible and externally visible: a version
        // not pushed is re-derived next run, while a version pushed for a
        // deploy that did not finish is a commit someone has to reason about.
        const result = await publishVersion({
          checkoutPath: checkoutPathFor(context.options.deployRoot),
          ref: context.target?.ref ?? 'main',
          result: context.version as VersionStepResult,
          runCommand: context.runCommand,
        });

        // ⚠ A FAILED PUSH IS A WARNING, NEVER A FAILURE. By this point the app
        // is built, migrated, started, answering and verified. The rollback
        // keeps the clone level with origin; the deployment keeps the version.
        context.journal.line(`Publish: ${result.detail}`);
        if (!result.pushed) context.hooks?.onProgress?.(`warning: ${result.detail}`);
      },
    },
  ];
}

/**
 * The consent options every gate in this pipeline shares. `flag` is the one
 * gate-specific part.
 */
export function consentOptions(
  context: { options: Omit<ConsentOptions, 'flag'> },
  flag?: boolean | undefined,
): ConsentOptions {
  return {
    flag,
    nonInteractive: context.options.nonInteractive,
    promptContext: context.options.promptContext,
    ask: context.options.ask,
  };
}

/**
 * What the post-deploy OAuth smoke checks against, or nothing when it is
 * skipped or the environment names no Google client. Shared with update.
 */
export function oauthSmokeTarget(
  skip: boolean | undefined,
  env: ReadonlyMap<string, string> | undefined,
): { oauth?: { clientId: string; callbackUrl: string } } {
  if (skip === true || env === undefined) return {};
  const clientId = env.get('GOOGLE_CLIENT_ID') ?? '';
  const callbackUrl = env.get('GOOGLE_CALLBACK_URL') ?? '';
  if (clientId === '' || callbackUrl === '') return {};
  return { oauth: { clientId, callbackUrl } };
}

/**
 * What a smoke result means for a deploy (#391): `fail` fails `verify` -- the
 * API answered, and what it said means nobody can sign in; `warn` (the API
 * could not be asked) is reported and does not, since the health probes above
 * already judged reachability.
 */
export function reportOAuthSmoke(
  context: Pick<StepContext, 'journal' | 'hooks'>,
  smoke: OAuthSmoke | undefined,
): void {
  if (smoke === undefined) return;
  context.journal.line(`${smoke.status} oauth-smoke: ${smoke.detail}`);
  if (smoke.status === 'warn') {
    context.hooks?.onProgress?.(`warning: OAuth smoke: ${smoke.detail}`);
    return;
  }
  if (smoke.status === 'fail') {
    throw new Error(`Sign-in is broken: ${smoke.detail}${smoke.remedy === undefined ? '' : `\n${smoke.remedy}`}`);
  }
}

/**
 * Acts on the renewal-ownership answer and reports it. Shared with update.
 *
 * ⚠ NEVER FAILS THE DEPLOY. Renewal is not the deployment: a file that could
 * not be written is a loud warning carrying the exact content to install.
 */
export async function scheduleRenewal(
  context: Pick<StepContext, 'journal' | 'hooks'> & { runCommand: typeof defaultRunCommand },
  proxyRoot: string,
  runtime: ProxyRuntime,
): Promise<void> {
  const result = await ensureRenewal({ proxyRoot, runtime, runCommand: context.runCommand });
  context.journal.line(`renewal ${result.action}: ${result.detail}`);

  if (result.action === 'not-writable') {
    context.journal.line(result.remedy ?? '');
    context.hooks?.onProgress?.(`warning: ${result.detail}`);
    context.hooks?.onProgress?.(result.remedy ?? '');
    return;
  }
  if (result.warning !== undefined) {
    context.hooks?.onProgress?.(`warning: ${result.warning}. ${result.remedy ?? ''}`);
  }
  context.hooks?.onProgress?.(result.detail);
}

export interface InstallResult {
  deployRoot: string;
  commitSha: string;
  journalPath: string;
  domain?: string | undefined;
  /** The one thing the operator still has to do. */
  nextStep: string;
}

export async function runInstall(requested: InstallOptions): Promise<InstallResult> {
  // Every step reads `options.groups`, so widening it once here is what puts
  // the always-on groups (#567) into the wizard, the compose file list, the
  // health gate and the recorded state alike.
  const options: InstallOptions = { ...requested, groups: effectiveGroups(requested.groups) };
  // The duration a history entry records is the whole run, precondition
  // checks included -- what the operator actually waited.
  const startedAt = Date.now();
  const existingState = readState(options.deployRoot);

  // The mirror of the defect `update` had, and the same wrong question asked
  // from the other side. Guarding on the RECORD means a deployment whose state
  // file was lost -- containers running, certificate issued, site serving -- is
  // not recognised here either, so `install` proceeds and clobbers it: a fresh
  // checkout over the live one, a re-run wizard over the live `.env`.
  //
  // The guard is EVIDENCE OR RECORD. Either is enough to say something is
  // already here; requiring both would reintroduce the same gap.
  const alreadyDeployed = existingState !== undefined || isDeployment(options.deployRoot);

  if (alreadyDeployed && options.reinstall !== true && options.resume !== true) {
    const at =
      existingState === undefined
        ? 'it has a checkout and an environment file, but no deployment record'
        : `${existingState.commitSha.slice(0, 12)}`;
    throw new UsageError(
      `A deployment already exists at ${options.deployRoot} (${at}). Use \`${CLI_NAME} deploy update\` to bring it up to date, or --reinstall to start over.`,
    );
  }

  mkdirSync(options.deployRoot, { recursive: true });

  const journal = openJournal({
    deployRoot: options.deployRoot,
    command: 'install',
    // Seeded from an existing .env so a resumed run redacts from the first
    // line, before the wizard has run again.
    secrets: existsSync(envFilePath(options.deployRoot))
      ? secretsFrom(parseEnvFile(readFileSync(envFilePath(options.deployRoot), 'utf8')))
      : [],
  });
  // Announced at once, so a screen can show where the log is while it runs.
  options.hooks?.onJournal?.(journal.path);

  // A FRESH install gets its own compose project; anything already here keeps
  // the one it is running under. See composeProjectFor for why renaming an
  // existing deployment's project is an outage rather than a tidy-up.
  const composeProject =
    existingState === undefined && !isDeployment(options.deployRoot)
      ? basename(options.deployRoot)
      : composeProjectFor(existingState);

  const context: InstallContext = {
    options,
    runCommand: options.runCommand ?? defaultRunCommand,
    journal,
    hooks: options.hooks,
    composeProject,
    existingState,
    ...(existingState === undefined
      ? {}
      : {
          recordedProxy: {
            ...(existingState.proxyMode === undefined ? {} : { proxyMode: existingState.proxyMode }),
            ...(existingState.proxyContainer === undefined
              ? {}
              : { proxyContainer: existingState.proxyContainer }),
          },
        }),
    completed:
      options.resume === true && existingState !== undefined
        ? new Set(existingState.completedSteps ?? [])
        : new Set<string>(),
    // Appended by `runPipeline` as each step finishes; read by `deploy-info`.
    progress: [],
  };

  const result = await runPipeline(buildInstallSteps(), context);

  if (result.failed !== undefined) {
    journal.finish('failure', `${result.failed.id}: ${result.failed.detail ?? ''}`);

    // ⚠ THE FAILURE PATH RECORDS WHAT COMPLETED, AND WITHOUT THIS `--resume`
    // RESUMES NOTHING. `completedSteps` was written only on the SUCCESS path
    // below, so the one run that needs resuming -- a failed one -- left no
    // record of its progress, and the flag the error message recommends in the
    // very next line skipped zero steps and rebuilt everything. The message
    // was true about intent and false about behaviour.
    //
    // The record is marked `lastOutcome: 'failure'` so nothing downstream
    // mistakes a half-applied attempt for a deployment: `commitSha` is
    // whatever the checkout reached, which may be nothing.
    const attemptedAt = new Date().toISOString();
    try {
      writeState({
        ...(existingState ?? {}),
        version: DEPLOY_STATE_VERSION,
        repoUrl: context.target?.url ?? existingState?.repoUrl ?? '',
        ref: context.target?.ref ?? existingState?.ref ?? '',
        commitSha: context.commitSha ?? existingState?.commitSha ?? '',
        bindPort: options.bindPort,
        deployRoot: options.deployRoot,
        installedAt: existingState?.installedAt ?? '',
        lastDeployedAt: existingState?.lastDeployedAt ?? '',
        lastCommand: 'install',
        appctlVersion: CLI_VERSION,
        composeProject,
        ...(options.domain === undefined ? {} : { domain: options.domain }),
        ...(options.proxyRoot === undefined ? {} : { proxyRoot: options.proxyRoot }),
        ...recordedRuntime(context),
        completedSteps: result.completed,
        lastOutcome: 'failure',
        lastFailedStep: result.failed.id,
        lastAttemptAt: attemptedAt,
      } as DeployState);
    } catch {
      // ⚠ BOOKKEEPING, NEVER THE FAILURE ITSELF. The deploy has already failed
      // and the operator needs THAT reason, not a second one about a file the
      // CLI could not write while reporting the first.
    }

    throw new Error(
      `${result.failed.title} failed: ${result.failed.detail ?? 'unknown error'}\n` +
        `The full log is at ${journal.path}\n` +
        `Fix the cause and re-run with --resume to continue from this step.`,
    );
  }

  const now = new Date().toISOString();

  // ⚠ ONLY THE SUCCESS PATH APPENDS HISTORY. The failure path above spreads
  // the existing record, so a failed run keeps every prior entry and adds none.
  const host = await hostFactsOf(context);
  const runtime = recordedRuntime(context);
  const proxy = await observeProxy({
    domain: options.domain,
    bindPort: options.bindPort,
    proxyRoot: options.proxyRoot,
    mode: runtime.proxyMode,
    container: runtime.proxyContainer,
    runCommand: context.runCommand,
  });
  const history = appendHistory(existingState?.history, {
    at: now,
    command: 'install',
    commitSha: context.commitSha || null,
    previousCommitSha: previousDeployedCommit(existingState),
    ref: context.target?.ref ?? null,
    durationMs: Date.now() - startedAt,
    cliVersion: CLI_VERSION,
    outcome: 'success',
  });
  const installedAt = existingState?.installedAt ?? now;

  writeState({
    version: DEPLOY_STATE_VERSION,
    repoUrl: context.target?.url ?? '',
    ref: context.target?.ref ?? '',
    commitSha: context.commitSha ?? '',
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    bindPort: options.bindPort,
    deployRoot: options.deployRoot,
    installedAt,
    lastDeployedAt: now,
    lastCommand: 'install',
    appctlVersion: CLI_VERSION,
    // Recorded, never re-derived: see composeProjectFor.
    composeProject,
    // Recorded so update writes the vhost where install put it, rather than
    // re-deriving a path that ignores a non-default --proxy-root.
    ...(options.proxyRoot === undefined ? {} : { proxyRoot: options.proxyRoot }),
    // Recorded so update, certs and uninstall act under the runtime this
    // install actually used, rather than re-detecting it.
    ...recordedRuntime(context),
    // Recorded so a later `update` knows which groups this deployment uses.
    // It cannot be re-derived from the `.env`: a group's keys look identical
    // whether the feature is on or off. Always includes the always-on groups
    // (`effectiveGroups`, #567), so the record says what actually runs.
    groups: effectiveGroups(options.groups),
    completedSteps: result.completed,
    // Stated explicitly rather than left absent, so a later reader never has
    // to infer success from the shape of the record.
    lastOutcome: 'success',
    lastAttemptAt: now,
    host,
    history,
    proxy,
  } as DeployState);

  // The end-of-run rewrite of info.json: the same document the health gate
  // wrote, now carrying this run's history entry, every completed step and the
  // certificate `publish` just issued. Never throws; see writeDeployInfo.
  const info = writeDeployInfo(options.deployRoot, {
    ...installDeployInfo(context, now),
    installedAt,
    proxy: proxyInfoOf(proxy),
    host,
    history,
  });
  journal.line(
    info.written
      ? `Wrote ${info.path}`
      : `warning: could not write ${info.path}: ${info.error ?? 'unknown'}`,
  );

  journal.finish('success');

  const admin = context.env?.get('INITIAL_ADMIN_EMAIL') ?? 'the admin address';
  const url =
    options.domain === undefined
      ? `http://127.0.0.1:${options.bindPort}`
      : `https://${options.domain}`;

  return {
    deployRoot: options.deployRoot,
    commitSha: context.commitSha ?? '',
    journalPath: journal.path,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    // The seed writes the ALLOWLIST row, not a user account. Nobody is an
    // admin until this login happens, and an install that does not say so
    // looks broken.
    nextStep: `Log in at ${url} as ${admin} to claim the Admin role.`,
  };
}

/**
 * The commit a fresh install replaces, for its history entry.
 *
 * The last SUCCESSFUL run's commit when there is history. Without it, a record
 * that did not end in failure still names a deployed commit (a v1 record, an
 * adopted one); a failed first install names only the checkout it reached,
 * which was never deployed, so it answers null.
 */
function previousDeployedCommit(existing: DeployState | undefined): string | null {
  if (existing === undefined) return null;
  const last = existing.history?.[0];
  if (last !== undefined) return last.commitSha;
  if (existing.lastOutcome === 'failure') return null;
  return existing.commitSha || null;
}

/** Slug used for the default deploy root, from the repository name. */
export function defaultRootFor(repoUrl: string, base: string): string {
  const name = basename(repoUrl).replace(/\.git$/, '') || 'app';
  return join(base, name.toLowerCase());
}
