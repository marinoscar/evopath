import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PreconditionError, UsageError } from '../errors.js';
import { CommandFailedError, type CommandResult, runCommand } from './executor.js';
import {
  buildInstallSteps,
  composeArgv,
  composeCwd,
  defaultRootFor,
  runInstall,
  scheduleRenewal,
  secretsFrom,
} from './install.js';
import { openJournal } from './journal.js';
import { proxyRuntimeFor, type ResolvedProxyRuntime } from './proxy.js';
import * as renewalModule from './renewal.js';
import { DEPLOY_STATE_VERSION, writeState, type DeployState } from './state.js';

vi.mock('./renewal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./renewal.js')>();
  return { ...actual, ensureRenewal: vi.fn() };
});

function installedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));
  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    bindPort: 3535,
    deployRoot: root,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-01T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
  writeState(state);
  return root;
}

describe('the install pipeline', () => {
  const steps = buildInstallSteps();
  const ids = steps.map((step) => step.id);

  it('runs the steps in an order the deployment actually requires', () => {
    expect(ids).toEqual([
      'preflight',
      'checkout',
      'environment',
      'validate-environment',
      'ensure-database',
      'version',
      'build',
      'migrate',
      'seed',
      'start',
      'health',
      'deploy-info',
      'proxy-bootstrap',
      'publish',
      'renewal',
      'verify',
      'publish-version',
    ]);
  });

  it('records what was deployed as soon as the API answers', () => {
    // ⚠ IMMEDIATELY AFTER `health`, AND BEFORE `publish`. If the API is
    // answering, the application demonstrably IS deployed. Written at the end,
    // a failure in `publish` would leave the About page reporting nothing at
    // all about a deployment that is up and serving -- which is exactly when
    // somebody is looking at it.
    expect(ids.indexOf('deploy-info')).toBe(ids.indexOf('health') + 1);
    expect(ids.indexOf('deploy-info')).toBeLessThan(ids.indexOf('publish'));
  });

  it('chooses the version immediately before the build, and publishes it last', () => {
    // ⚠ Both halves are the design, not an ordering preference.
    //
    // `version` writes the manifests AND commits them, so it sits one step
    // before `build`: the dirty window is milliseconds, and the images are
    // built from the commit that carries the number they report.
    //
    // `publish-version` pushes, which is irreversible and externally visible,
    // so it goes after `verify` -- last of all. A version not pushed is
    // re-derived next run; a version pushed for a deploy that never finished
    // is a commit someone has to reason about.
    expect(ids.indexOf('version')).toBe(ids.indexOf('build') - 1);
    expect(ids.indexOf('publish-version')).toBe(ids.length - 1);
    expect(ids.indexOf('verify')).toBeLessThan(ids.indexOf('publish-version'));
  });

  it('checks prerequisites before it fetches anything', () => {
    // The whole point of a preflight: abort before the repository is cloned
    // and before .env is written.
    expect(ids.indexOf('preflight')).toBeLessThan(ids.indexOf('checkout'));
  });

  it('migrates before it starts the stack, and seeds after migrating', () => {
    expect(ids.indexOf('migrate')).toBeLessThan(ids.indexOf('start'));
    expect(ids.indexOf('migrate')).toBeLessThan(ids.indexOf('seed'));
  });

  it('publishes only after the API is known to be healthy', () => {
    // Issuing a certificate for a stack that never came up wastes rate limit.
    expect(ids.indexOf('health')).toBeLessThan(ids.indexOf('publish'));
  });

  function skipReasonFor(id: string, options: Record<string, unknown>): string | undefined {
    const step = steps.find((candidate) => candidate.id === id);
    return step?.skip?.({ options } as never);
  }

  it('honours --skip-doctor, --skip-proxy and --skip-seed', () => {
    expect(skipReasonFor('preflight', { skipDoctor: true })).toContain('--skip-doctor');
    expect(skipReasonFor('seed', { skipSeed: true })).toContain('--skip-seed');
    expect(skipReasonFor('publish', { skipProxy: true, domain: 'x' })).toContain('--skip-proxy');
  });

  it('skips publishing when there is no domain to publish under', () => {
    expect(skipReasonFor('publish', {})).toContain('no --domain');
  });

  it('does not skip anything by default', () => {
    for (const id of ids) {
      // `publish-version` is the one step gated on a RESULT rather than an
      // option -- it stands down unless the `version` step actually bumped --
      // so it is asserted separately below.
      if (id === 'publish-version') continue;
      expect(skipReasonFor(id, { domain: 'app.example.test' })).toBeUndefined();
    }
  });

  it('publishes a version only when one was actually bumped', () => {
    const step = steps.find((candidate) => candidate.id === 'publish-version');

    // ⚠ Keyed on the step's own result, so every reason there is nothing to
    // push -- --no-version-bump, a manifest already carrying the number -- is
    // one condition here rather than a second copy of the same three tests.
    expect(step?.skip?.({ options: {}, version: { bumped: false } } as never)).toBe(
      'no version was bumped',
    );
    expect(step?.skip?.({ options: {} } as never)).toBe('no version was bumped');
    expect(
      step?.skip?.({ options: {}, version: { bumped: true } } as never),
    ).toBeUndefined();
  });

  it('still stamps a version when --no-version-bump is passed', () => {
    // ⚠ The flag means "do not bump", NOT "do not stamp". Skipping the step
    // outright would leave the container reporting whatever APP_VERSION the
    // previous deploy happened to write.
    expect(skipReasonFor('version', { noVersionBump: true })).toBeUndefined();
  });
});

/** A root passing `isDeployment` (checkout + .env), but with no state file. */
function evidenceOnlyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-install-evidence-'));
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  writeFileSync(join(root, '.env'), 'APP_BIND_PORT=3535\n');
  return root;
}

/** Refuses to run any subprocess; every check that touches it fails cleanly. */
const noSubprocessRunCommand: typeof runCommand = async () => {
  throw new Error('this test must not spawn a real subprocess');
};

describe('runInstall preconditions', () => {
  it('refuses to install over an existing deployment, pointing at update', async () => {
    const root = installedRoot();

    const error = await runInstall({
      deployRoot: root,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('deploy update');
    expect((error as Error).message).toContain('--reinstall');
  });

  // ===========================================================================
  // The guard is EVIDENCE OR RECORD (install.ts, ~line 434). Before this it was
  // RECORD ONLY, so a deployment whose state file was lost - containers
  // running, certificate issued, site serving - was invisible to `install`,
  // which would proceed and clobber it: a fresh checkout over the live one, a
  // re-run wizard over the live `.env`. This is the mirror of the defect
  // `update` had, from the other side.
  // ===========================================================================
  it('refuses to install over a directory with a checkout and an .env but no deployment record', async () => {
    const root = evidenceOnlyRoot();

    const error = await runInstall({
      deployRoot: root,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('no deployment record');
    expect((error as Error).message).toContain('deploy update');
    expect((error as Error).message).toContain('--reinstall');
  });

  it('--reinstall bypasses the evidence-only guard and lets the pipeline start', async () => {
    const root = evidenceOnlyRoot();

    const error = await runInstall({
      deployRoot: root,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
      reinstall: true,
      runCommand: noSubprocessRunCommand,
    }).catch((caught: unknown) => caught);

    // The guard itself must not have fired: whatever failed next is the
    // *pipeline's* own PreconditionError (wrapped into a plain Error by
    // runInstall, same as every other pipeline failure), not the guard's
    // UsageError.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UsageError);
    const message = (error as Error).message;
    expect(message).not.toContain('no deployment record');
    expect(message).toContain('Check prerequisites failed');
  });

  it('--resume bypasses the evidence-only guard and lets the pipeline start', async () => {
    const root = evidenceOnlyRoot();

    const error = await runInstall({
      deployRoot: root,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
      resume: true,
      runCommand: noSubprocessRunCommand,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UsageError);
    const message = (error as Error).message;
    expect(message).not.toContain('no deployment record');
    expect(message).toContain('Check prerequisites failed');
  });

  it('--reinstall also bypasses the guard when a full deployment record is present', async () => {
    const root = installedRoot();

    const error = await runInstall({
      deployRoot: root,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
      reinstall: true,
      runCommand: noSubprocessRunCommand,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UsageError);
    const message = (error as Error).message;
    expect(message).not.toContain('deploy update');
    expect(message).toContain('Check prerequisites failed');
  });
});

describe('compose invocation', () => {
  it('layers base, prod and vps in that order', () => {
    // The VPS files must come last: their `!override` on ports only replaces
    // what the earlier files declared if they are applied after them. The
    // telemetry files are always present (#567).
    expect(composeArgv(['up', '-d']).join(' ')).toBe(
      'docker compose -f base.compose.yml -f prod.compose.yml -f telemetry.compose.yml' +
        ' -f vps.compose.yml -f vps.telemetry.compose.yml up -d',
    );
  });

  it('runs from the compose file directory', () => {
    // The relative build contexts (`../..`, `../nginx`) resolve against the
    // compose file's directory, so the working directory is not incidental.
    expect(composeCwd('/opt/infra/apps/demo')).toBe('/opt/infra/apps/demo/repo/infra/compose');
  });
});

describe('secretsFrom', () => {
  it('picks out exactly the values the journal must redact', () => {
    const env = new Map([
      ['POSTGRES_PASSWORD', 'p4ssword'],
      ['JWT_SECRET', 'jwt-secret-value'],
      ['POSTGRES_HOST', 'db.internal'],
      ['APP_URL', 'https://app.example.test'],
    ]);

    const secrets = secretsFrom(env).map((entry) => entry.key).sort();

    // Driven by the metadata registry rather than by a second guess at which
    // keys are sensitive.
    expect(secrets).toEqual(['JWT_SECRET', 'POSTGRES_PASSWORD']);
  });
});

describe('defaultRootFor', () => {
  it('derives the directory from the repository name, never a fixed one', () => {
    expect(defaultRootFor('https://example.test/o/MyApp.git', '/opt/infra/apps')).toBe(
      '/opt/infra/apps/myapp',
    );
  });
});

// =============================================================================
// The `environment` step: a blank answer must not beat an on-disk value (the
// secret-rotation guard). A re-install that overwrote JWT_SECRET, COOKIE_SECRET
// or SECRETS_ENCRYPTION_KEY with '' every time an operator left a field
// untouched would make every credential encrypted under the old key
// permanently undecryptable, with no visible symptom.
// =============================================================================
describe('the environment step: blank answers vs. an on-disk value', () => {
  const KNOWN_SECRET = 'on-disk-secret-that-is-plenty-long-enough-32ch';
  const NEW_SECRET = 'freshly-supplied-secret-also-plenty-long-enough';

  const runCommandStub: typeof runCommand = async () => {
    throw new Error('the environment step must not run any commands');
  };

  function environmentStep() {
    const step = buildInstallSteps().find((candidate) => candidate.id === 'environment');
    if (step === undefined) throw new Error('the "environment" step was removed or renamed');
    return step;
  }

  /** Seeds deployRoot/repo/infra/compose/.env.example and .env, the two files
   *  the environment step reads before it writes anything. */
  function seed(root: string, onDiskSecret: string): void {
    const dir = composeCwd(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + '/.env.example', 'JWT_SECRET=your-super-secret-key-min-32-characters-long\n');
    writeFileSync(dir + '/.env', `JWT_SECRET=${onDiskSecret}\n`);
  }

  function contextFor(root: string, answers: ReadonlyMap<string, string>) {
    return {
      options: {
        deployRoot: root,
        domain: 'app.example.test',
        bindPort: 3535,
        proxyRoot: '/tmp/proxy',
        nonInteractive: true,
        answers,
      },
      runCommand: runCommandStub,
      journal: openJournal({ deployRoot: root, command: 'install' }),
      hooks: undefined,
      completed: new Set<string>(),
      env: undefined as Map<string, string> | undefined,
    };
  }

  it('keeps the on-disk secret when the supplied answer is blank', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-env-step-'));
    seed(root, KNOWN_SECRET);

    const context = contextFor(root, new Map([['JWT_SECRET', '']]));
    await environmentStep().run(context as never);

    expect(context.env?.get('JWT_SECRET')).toBe(KNOWN_SECRET);
    const written = readFileSync(join(composeCwd(root), '.env'), 'utf8');
    expect(written).toContain(`JWT_SECRET=${KNOWN_SECRET}`);
    expect(written).not.toContain('JWT_SECRET=\n');
  });

  it('lets a genuinely supplied, non-blank answer win over the on-disk value', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-env-step-'));
    seed(root, KNOWN_SECRET);

    const context = contextFor(root, new Map([['JWT_SECRET', NEW_SECRET]]));
    await environmentStep().run(context as never);

    expect(context.env?.get('JWT_SECRET')).toBe(NEW_SECRET);
    const written = readFileSync(join(composeCwd(root), '.env'), 'utf8');
    expect(written).toContain(`JWT_SECRET=${NEW_SECRET}`);
    expect(written).not.toContain(KNOWN_SECRET);
  });
});

// =============================================================================
// The `publish` step resolves the proxy runtime ONCE, and that resolution is
// exactly what `runInstall` later records into the state file as
// `proxyMode`/`proxyContainer` (see `recordedRuntime`, install.ts). Asserting
// `context.proxyRuntime` here is asserting the value that write reads from.
// =============================================================================
describe('the publish step resolves and records the proxy runtime', () => {
  function publishStep() {
    const step = buildInstallSteps().find((candidate) => candidate.id === 'publish');
    if (step === undefined) throw new Error('the "publish" step was removed or renamed');
    return step;
  }

  const noSubprocess: typeof runCommand = async (argv) => {
    throw new Error(`this test must not spawn: ${argv.join(' ')}`);
  };

  function contextFor(root: string, options: Record<string, unknown>) {
    return {
      options: {
        deployRoot: root,
        domain: 'app.example.test',
        bindPort: 3535,
        proxyRoot: join(root, 'proxy'),
        email: 'admin@example.test',
        ...options,
      },
      runCommand: (async (argv: readonly string[]) => {
        // Every command the publish step issues under a container runtime:
        // the dockerised certbot, and `docker exec ... nginx`.
        if (argv[0] === 'docker') return { argv, cwd: root, exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false };
        return noSubprocess(argv, { cwd: root });
      }) as typeof runCommand,
      journal: openJournal({ deployRoot: root, command: 'install' }),
      hooks: undefined,
      completed: new Set<string>(),
      env: new Map<string, string>(),
      progress: [] as string[],
      proxyRuntime: undefined as ResolvedProxyRuntime | undefined,
    };
  }

  it('an explicit --proxy-mode/--proxy-container flag is what gets resolved and recorded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-publish-step-'));
    const context = contextFor(root, { proxyMode: 'container', proxyContainer: 'my-proxy' });

    await publishStep().run(context as never);

    expect(context.proxyRuntime).toMatchObject({
      mode: 'container',
      container: 'my-proxy',
      source: 'explicit',
    });
  });

  it('with no flag, a previous run\'s recorded runtime is what gets resolved and recorded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-publish-step-'));
    const context = {
      ...contextFor(root, {}),
      recordedProxy: { proxyMode: 'container' as const, proxyContainer: 'recorded-proxy' },
    };

    await publishStep().run(context as never);

    expect(context.proxyRuntime).toMatchObject({
      mode: 'container',
      container: 'recorded-proxy',
      source: 'explicit',
    });
  });

  it('resolves the runtime only ONCE: preflight and publish must never disagree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-publish-step-'));
    const context = contextFor(root, { proxyMode: 'host' });
    // A HOST runtime would call `certbot certonly` and `nginx -t`/`-s reload`
    // directly, none of which this test's runCommand answers -- so a second,
    // independent resolution inside the step would throw here, while reusing
    // the ALREADY-RESOLVED value (set below, as `proxyRuntimeOf` does on a
    // second call) does not.
    context.proxyRuntime = {
      ...proxyRuntimeFor('container', root, 'already-resolved'),
      source: 'explicit',
    };

    await publishStep().run(context as never);

    expect(context.proxyRuntime).toMatchObject({ container: 'already-resolved' });
  });
});

// =============================================================================
// The `proxy-bootstrap` step: never touches an existing proxy, and asks for
// consent at most once (#391).
// =============================================================================
describe('the proxy-bootstrap step', () => {
  function proxyBootstrapStep() {
    const step = buildInstallSteps().find((candidate) => candidate.id === 'proxy-bootstrap');
    if (step === undefined) throw new Error('the "proxy-bootstrap" step was removed or renamed');
    return step;
  }

  /** Routes by argv prefix; an unmatched call throws, like fake-vps. */
  function routedRunCommand(
    routes: readonly [readonly string[], () => { ok: boolean; stdout?: string; stderr?: string }][],
  ): typeof runCommand {
    return (async (argv: readonly string[], options: { cwd: string }): Promise<CommandResult> => {
      const route = routes.find(([prefix]) => prefix.every((word, index) => argv[index] === word));
      if (route === undefined) {
        throw new Error(`unrouted command in proxy-bootstrap test: ${argv.join(' ')}`);
      }
      const reply = route[1]();
      const result: CommandResult = {
        argv,
        cwd: options.cwd,
        exitCode: reply.ok ? 0 : 1,
        stdout: reply.stdout ?? '',
        stderr: reply.stderr ?? '',
        durationMs: 0,
        timedOut: false,
      };
      if (!reply.ok) throw new CommandFailedError(result.stderr, result);
      return result;
    }) as typeof runCommand;
  }

  function contextFor(
    root: string,
    proxyRoot: string,
    runtime: ResolvedProxyRuntime,
    runCommandFn: typeof runCommand,
    extraOptions: Record<string, unknown> = {},
  ) {
    return {
      options: { deployRoot: root, proxyRoot, domain: 'app.example.test', ...extraOptions },
      runCommand: runCommandFn,
      journal: openJournal({ deployRoot: root, command: 'install' }),
      hooks: undefined,
      completed: new Set<string>(),
      env: new Map<string, string>(),
      progress: [] as string[],
      proxyRuntime: runtime,
      proxyBootstrapConsent: undefined as string | undefined,
    };
  }

  const NO_CONTAINER = new CommandFailedError('no such container', {
    argv: [],
    cwd: '.',
    exitCode: 1,
    stdout: '',
    stderr: 'Error: No such container: proxy-nginx',
    durationMs: 0,
    timedOut: false,
  });

  it('does nothing on the host: the proxy is the host\'s own nginx, never bootstrapped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-proxy-step-'));
    const proxyRoot = join(root, 'proxy');
    const runtime = { ...proxyRuntimeFor('host', proxyRoot), source: 'explicit' as const };
    // No command is ever issued in host mode; any call here is a bug.
    const never: typeof runCommand = async (argv) => {
      throw new Error(`must not spawn in host mode: ${argv.join(' ')}`);
    };

    await expect(
      proxyBootstrapStep().run(contextFor(root, proxyRoot, runtime, never) as never),
    ).resolves.toBeUndefined();
    expect(existsSync(proxyRoot)).toBe(false);
  });

  it('does nothing when the proxy container is already running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-proxy-step-'));
    const proxyRoot = join(root, 'proxy');
    const runtime = { ...proxyRuntimeFor('container', proxyRoot, 'proxy-nginx'), source: 'explicit' as const };
    const run = routedRunCommand([
      [['docker', 'inspect'], () => ({ ok: true, stdout: 'true' })],
    ]);

    await expect(
      proxyBootstrapStep().run(contextFor(root, proxyRoot, runtime, run) as never),
    ).resolves.toBeUndefined();
    expect(existsSync(proxyRoot)).toBe(false);
  });

  it('refuses -- and does not start it -- when the container exists but is stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-proxy-step-'));
    const proxyRoot = join(root, 'proxy');
    const runtime = { ...proxyRuntimeFor('container', proxyRoot, 'proxy-nginx'), source: 'explicit' as const };
    const run = routedRunCommand([
      [['docker', 'inspect'], () => ({ ok: true, stdout: 'false' })],
    ]);

    const error = await proxyBootstrapStep()
      .run(contextFor(root, proxyRoot, runtime, run) as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('shared infrastructure');
    expect((error as Error).message).toContain('docker start proxy-nginx');
    expect(existsSync(proxyRoot)).toBe(false);
  });

  it('refuses -- and never overwrites -- when a compose file makes the root somebody else\'s', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-proxy-step-'));
    const proxyRoot = join(root, 'proxy');
    mkdirSync(proxyRoot, { recursive: true });
    const theirs = 'services:\n  proxy:\n    image: caddy\n';
    writeFileSync(join(proxyRoot, 'compose.yml'), theirs);
    const runtime = { ...proxyRuntimeFor('container', proxyRoot, 'proxy-nginx'), source: 'explicit' as const };
    const run = routedRunCommand([
      [['docker', 'inspect'], () => { throw NO_CONTAINER; }],
    ]);

    const error = await proxyBootstrapStep()
      .run(contextFor(root, proxyRoot, runtime, run) as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('belongs to whatever created it');
    expect(readFileSync(join(proxyRoot, 'compose.yml'), 'utf8')).toBe(theirs);
  });

  it('when absent, reuses the preflight\'s consent rather than asking a second time', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-proxy-step-'));
    const proxyRoot = join(root, 'proxy');
    const runtime = { ...proxyRuntimeFor('container', proxyRoot, 'proxy-nginx'), source: 'explicit' as const };
    const run = routedRunCommand([
      [['docker', 'inspect'], () => { throw NO_CONTAINER; }],
    ]);
    const ask = vi.fn(async () => true);

    const context = contextFor(root, proxyRoot, runtime, run, { ask });
    context.proxyBootstrapConsent = 'declined';

    const error = await proxyBootstrapStep()
      .run(context as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('declined');
    // ⚠ THE WHOLE POINT: preflight already asked once (recorded on the
    // context as 'declined'), so this step must not ask again.
    expect(ask).not.toHaveBeenCalled();
    expect(existsSync(proxyRoot)).toBe(false);
  });

  it('when absent and never yet asked, asks once, and on "yes" lays out and starts the proxy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-proxy-step-'));
    const proxyRoot = join(root, 'proxy');
    const runtime = { ...proxyRuntimeFor('container', proxyRoot, 'proxy-nginx'), source: 'explicit' as const };
    const run = routedRunCommand([
      [['docker', 'inspect'], () => { throw NO_CONTAINER; }],
      [['docker', 'compose', 'up', '-d'], () => ({ ok: true })],
      [['docker', 'exec', 'proxy-nginx', 'nginx', '-t'], () => ({ ok: true })],
    ]);
    const ask = vi.fn(async () => true);

    await proxyBootstrapStep().run(contextFor(root, proxyRoot, runtime, run, { ask }) as never);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(existsSync(join(proxyRoot, 'compose.yml'))).toBe(true);
    expect(existsSync(join(proxyRoot, 'nginx', 'conf.d'))).toBe(true);
  });
});

// =============================================================================
// The `preflight` step: the proxy-bootstrap consent gate it asks ONCE, before
// the checks run, and the ONE outcome that turns "no shared proxy" from a
// refusal into a pass -- so the `proxy-bootstrap` step (asked separately
// above) never re-asks a question preflight already got an answer to (#391).
// =============================================================================
describe('the preflight step: the bootstrap-proxy consent gate', () => {
  function preflightStep() {
    const step = buildInstallSteps().find((candidate) => candidate.id === 'preflight');
    if (step === undefined) throw new Error('the "preflight" step was removed or renamed');
    return step;
  }

  const NO_CONTAINER_ERROR = new Error('Error: No such container: proxy-nginx');

  /**
   * Answers the three docker probes `docker-installed`/`docker-daemon`/
   * `proxy-container` need to reach a real verdict; every other required
   * check (git, disk space, DNS, gh...) is left unrouted, throws, and is
   * caught by `runChecks` as an ordinary failed result -- which is fine, since
   * none of these tests assert the WHOLE preflight passes, only what the
   * proxy-container check and the consent gate itself did.
   */
  function routedRunCommand(inspectReply: () => { ok: boolean; stdout?: string }): typeof runCommand {
    return (async (argv: readonly string[], options: { cwd: string }): Promise<CommandResult> => {
      const line = argv.join(' ');
      if (line === 'docker --version') {
        return ok(argv, options.cwd, 'Docker version 27.3.1, build abc');
      }
      if (line === 'docker info --format {{.ServerVersion}}') {
        return ok(argv, options.cwd, '27.3.1');
      }
      if (line.startsWith('docker inspect --type container')) {
        const reply = inspectReply();
        if (!reply.ok) throw NO_CONTAINER_ERROR;
        return ok(argv, options.cwd, reply.stdout ?? '');
      }
      throw new Error(`unrouted (and expected to fail its own check only): ${line}`);
    }) as typeof runCommand;

    function ok(argv: readonly string[], cwd: string, stdout: string): CommandResult {
      return { argv, cwd, exitCode: 0, stdout, stderr: '', durationMs: 0, timedOut: false };
    }
  }

  function fakeJournal() {
    const lines: string[] = [];
    return { line: (text: string) => lines.push(text), redact: (text: string) => text, lines };
  }

  function contextFor(
    root: string,
    runCommandFn: typeof runCommand,
    extraOptions: Record<string, unknown>,
  ) {
    const journal = fakeJournal();
    return {
      options: {
        deployRoot: root,
        proxyRoot: join(root, 'proxy'),
        bindPort: 3535,
        domain: 'app.example.test',
        repo: 'https://example.test/o/r',
        skipProxy: false,
        ...extraOptions,
      },
      runCommand: runCommandFn,
      journal: journal as never,
      hooks: undefined,
      completed: new Set<string>(),
      proxyRuntime: { ...proxyRuntimeFor('container', join(root, 'proxy'), 'proxy-nginx'), source: 'explicit' as const },
      proxyBootstrapConsent: undefined as string | undefined,
      _journal: journal,
    };
  }

  function proxyContainerLine(journal: { lines: string[] }): string | undefined {
    return journal.lines.find((line) => / proxy-container:/.test(line));
  }

  it('non-interactive, no --bootstrap-proxy: fails, and the remedy names the flag', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-preflight-consent-'));
    const context = contextFor(root, routedRunCommand(() => ({ ok: false })), { nonInteractive: true });

    const error = await preflightStep()
      .run(context as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('--bootstrap-proxy');
    expect(context.proxyBootstrapConsent).toBe('unavailable');
    expect(proxyContainerLine(context._journal)).toContain('fail');
  });

  it('with --bootstrap-proxy: consent is "flag", and proxy-container itself passes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-preflight-consent-'));
    const context = contextFor(root, routedRunCommand(() => ({ ok: false })), { bootstrapProxy: true });

    // The overall preflight still fails on unrelated required checks (DNS, git,
    // disk space -- all left unrouted above), which is fine: what this test
    // pins is that the PROXY question was answered and that ONE check passed.
    await preflightStep()
      .run(context as never)
      .catch(() => undefined);

    expect(context.proxyBootstrapConsent).toBe('flag');
    expect(proxyContainerLine(context._journal)).toContain('pass');
    expect(proxyContainerLine(context._journal)).toContain('bootstrap');
  });

  it('interactive and declined: asked exactly once, and the answer is recorded, not re-asked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-preflight-consent-'));
    const ask = vi.fn(async () => false);
    const context = contextFor(root, routedRunCommand(() => ({ ok: false })), { ask });

    await preflightStep()
      .run(context as never)
      .catch(() => undefined);

    expect(context.proxyBootstrapConsent).toBe('declined');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(proxyContainerLine(context._journal)).toContain('fail');
  });

  it('a running proxy asks nothing at all: there is no absence to consent to', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-preflight-consent-'));
    const ask = vi.fn(async () => true);
    const context = contextFor(root, routedRunCommand(() => ({ ok: true, stdout: 'true' })), {
      nonInteractive: true,
      ask,
    });

    await preflightStep()
      .run(context as never)
      .catch(() => undefined);

    expect(context.proxyBootstrapConsent).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
    expect(proxyContainerLine(context._journal)).toContain('pass');
  });
});

// =============================================================================
// `scheduleRenewal`: acts on the ownership answer, and NEVER fails the deploy
// over it -- a certificate renewal schedule is bookkeeping, not the deployment
// (#391).
// =============================================================================
describe('scheduleRenewal', () => {
  function fakeContext() {
    const lines: string[] = [];
    const progress: string[] = [];
    return {
      journal: { line: (text: string) => lines.push(text), redact: (text: string) => text } as never,
      hooks: { onProgress: (message: string) => progress.push(message) },
      runCommand: (async () => {
        throw new Error('scheduleRenewal must not spawn directly; ensureRenewal is mocked');
      }) as unknown as typeof runCommand,
      lines,
      progress,
    };
  }

  const RUNTIME = proxyRuntimeFor('container', '/opt/proxy', 'proxy-nginx');

  it('is a no-op, and never warns, when another mechanism owns renewal', async () => {
    vi.mocked(renewalModule.ensureRenewal).mockResolvedValueOnce({
      action: 'owned-elsewhere',
      detail: 'renewal is owned by a central renewal script (found /etc/cron.d/renew-all)',
      path: '/etc/cron.d/appctl-certbot-renew',
      ownership: { owner: 'central-script', detail: 'found /etc/cron.d/renew-all', mechanisms: [] } as never,
    });

    const context = fakeContext();
    await expect(scheduleRenewal(context, '/opt/proxy', RUNTIME)).resolves.toBeUndefined();

    expect(context.lines.some((line) => line.includes('owned-elsewhere'))).toBe(true);
    // The ordinary case: nothing to warn about, since a real mechanism already
    // renews these certificates.
    expect(context.progress).toEqual([context.lines[context.lines.length - 1]?.replace(/^renewal owned-elsewhere: /, '')]);
  });

  it('warns, but never throws, when the cron file cannot be written', async () => {
    const content = '# Managed by appctl deploy.\n17 3,15 * * * root true\n';
    vi.mocked(renewalModule.ensureRenewal).mockResolvedValueOnce({
      action: 'not-writable',
      detail: 'could not write /etc/cron.d/appctl-certbot-renew (EACCES); certificate renewal is NOT scheduled',
      remedy: `As root, write /etc/cron.d/appctl-certbot-renew with exactly this content (mode 0644):\n${content}`,
      content,
      path: '/etc/cron.d/appctl-certbot-renew',
      ownership: { owner: 'none', detail: 'nothing found', mechanisms: [] } as never,
    });

    const context = fakeContext();
    // ⚠ THE WHOLE POINT: a renewal schedule the CLI could not write must never
    // fail the deploy that got this far -- the stack is up, migrated and
    // serving by the time this step runs.
    await expect(scheduleRenewal(context, '/opt/proxy', RUNTIME)).resolves.toBeUndefined();

    expect(context.progress.some((message) => message.includes('warning:') && message.includes('NOT scheduled'))).toBe(
      true,
    );
    expect(context.progress.some((message) => message.includes('As root, write'))).toBe(true);
    expect(context.lines.some((line) => line.includes('As root, write'))).toBe(true);
  });
});
