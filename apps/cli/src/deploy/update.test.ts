import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { CommandResult, runCommand } from './executor.js';
import type { HealthReport } from './health.js';
import * as healthModule from './health.js';
import { DeployStateError, NotInstalledError, deployStatePath } from './state.js';
import { buildUpdateSteps, runUpdate } from './update.js';

// The `verify` step's own logic (isHealthy/the #205 cert hint) is what the
// tests below exercise -- `collectHealth` itself (a real docker/curl probe)
// is replaced so a canned HealthReport can be fed straight in.
vi.mock('./health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./health.js')>();
  return { ...actual, collectHealth: vi.fn() };
});

describe('the update pipeline', () => {
  const steps = buildUpdateSteps();
  const ids = steps.map((step) => step.id);

  it('looks for a new revision before it changes anything', () => {
    expect(ids).toEqual([
      'preflight',
      'fetch',
      'environment-drift',
      'ensure-database',
      'version',
      'maintenance-on',
      'build',
      'migrate',
      'seed',
      'restart',
      'maintenance-off',
      'edge-config',
      'health',
      'deploy-info',
      'publish',
      'renewal',
      'verify',
      'publish-version',
    ]);
  });

  it('records what was deployed as soon as the API answers', () => {
    expect(ids.indexOf('deploy-info')).toBe(ids.indexOf('health') + 1);
    expect(ids.indexOf('deploy-info')).toBeLessThan(ids.indexOf('publish'));
  });

  it('does not bump a version when the revision has not moved', () => {
    // ⚠ THE TREADMILL THIS PREVENTS. An update that finds the remote
    // unchanged rebuilds nothing -- so bumping here would commit and push a
    // release for code nobody wrote, which makes the remote "move", which
    // makes the NEXT update rebuild and bump again, for ever.
    expect(skipReason('version', { unchanged: true, options: {}, state: {} })).toBe(
      'already up to date',
    );
    expect(
      skipReason('publish-version', { unchanged: true, options: {}, state: {} }),
    ).toBe('no version was bumped');
  });

  function skipReason(id: string, context: Record<string, unknown>): string | undefined {
    return steps.find((step) => step.id === id)?.skip?.(context as never);
  }

  it('stands every later step down when the revision has not moved', () => {
    // Several minutes of build and a restart for a no-op is exactly the
    // friction that stops people updating often.
    for (const id of ['ensure-database', 'maintenance-on', 'build', 'migrate', 'seed', 'restart', 'maintenance-off', 'health', 'publish', 'renewal', 'verify']) {
      expect(skipReason(id, { unchanged: true, options: {}, state: {} })).toBe(
        'already up to date',
      );
    }
  });

  it('checks the nginx config even when the revision has not moved (#206)', () => {
    // A checkout updated by hand never reaches the steps above, so this is
    // the only step that can notice nginx still serving an old config.
    expect(skipReason('edge-config', { unchanged: true, options: {}, state: {} })).toBeUndefined();
    // ⚠ NOT a hardcoded `+ 1`: `maintenance-off` (#226) now sits between
    // `restart` and `edge-config` when it runs, so the real intent here is
    // just "after restart, before health" - not a specific offset.
    expect(ids.indexOf('edge-config')).toBeGreaterThan(ids.indexOf('restart'));
    expect(ids.indexOf('edge-config')).toBeLessThan(ids.indexOf('health'));
  });

  it('still runs the fetch step when unchanged, since that is what decides', () => {
    expect(skipReason('fetch', { unchanged: true, options: {}, state: {} })).toBeUndefined();
  });

  it('re-seeds by default', () => {
    // The only way permissions added by a new release reach an existing
    // deployment; without it the feature ships and the permission does not.
    expect(skipReason('seed', { options: {}, state: {} })).toBeUndefined();
  });

  it('honours --skip-seed', () => {
    expect(skipReason('seed', { options: { skipSeed: true }, state: {} })).toContain(
      '--skip-seed',
    );
  });

  it('skips publishing for a deployment that was never published', () => {
    expect(skipReason('publish', { options: {}, state: {} })).toContain('not published');
  });

  it('honours --skip-proxy', () => {
    expect(
      skipReason('publish', { options: { skipProxy: true }, state: { domain: 'x' } }),
    ).toContain('--skip-proxy');
  });
});

describe('runUpdate preconditions', () => {
  it('refuses to run when nothing is installed, naming install', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'evopathcli-noinstall-'));

    const error = await runUpdate({ deployRoot: empty }).catch((caught: unknown) => caught);

    // The precondition install does not have, and the reason this is its own
    // command rather than a flag: the guards are opposite.
    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain('deploy install');
  });

  it('names which half is missing when refusing, rather than asserting a bare negative', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'evopathcli-noinstall-'));

    const error = await runUpdate({ deployRoot: empty }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain('a checkout at repo/');
    expect((error as Error).message).toContain('a readable environment file');
  });
});

describe('runUpdate: adopting an unrecorded deployment (#not the NotInstalledError refusal)', () => {
  /** A minimal CommandResult, for a stub that only needs a few argvs to succeed. */
  function ok(argv: readonly string[], cwd: string, stdout: string): CommandResult {
    return { argv, cwd, exitCode: 0, stdout, stderr: '', durationMs: 0, timedOut: false };
  }

  /**
   * Answers just enough git plumbing (used by `resolveRepoTarget` to work out
   * what to redeploy from the checkout's own origin) for `resolveStateForUpdate`
   * to reach adoption, then refuses everything else (docker/df probes used by
   * the `preflight` step) so the pipeline fails fast and predictably rather
   * than hanging on a real subprocess.
   */
  const gitOnlyRunCommand: typeof runCommand = async (argv, options) => {
    const cmd = argv.join(' ');
    if (cmd === 'git remote get-url origin') {
      return ok(argv, options.cwd, 'https://example.test/o/demo.git\n');
    }
    if (cmd === 'git rev-parse --abbrev-ref HEAD') {
      return ok(argv, options.cwd, 'main\n');
    }
    throw new Error(`unexpected command in adoption test: ${cmd}`);
  };

  function unrecordedDeploymentRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-adopt-update-'));
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    writeFileSync(join(root, '.env'), 'APP_BIND_PORT=3535\n');
    return root;
  }

  it('does not throw NotInstalledError for a root with evidence but no state file - it adopts and proceeds', async () => {
    const root = unrecordedDeploymentRoot();

    const error = await runUpdate({
      deployRoot: root,
      runCommand: gitOnlyRunCommand,
    }).catch((caught: unknown) => caught);

    // It is fine for the run to fail further into the pipeline (the preflight
    // checks have nothing real to probe here) - what must never happen again
    // is the "no deployment" refusal for a directory that plainly is one.
    expect(error).not.toBeInstanceOf(NotInstalledError);
  });

  it('still refuses a root with NEITHER a checkout nor an .env, even alongside this adoption path', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'evopathcli-adopt-update-empty-'));

    const error = await runUpdate({
      deployRoot: empty,
      runCommand: gitOnlyRunCommand,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotInstalledError);
  });
});

// =============================================================================
// The `publish` step resolves the proxy runtime ONCE (flag > record > detect),
// and that is exactly what `runUpdate` later writes back into the state file
// as `proxyMode`/`proxyContainer`. Asserting `context.proxyRuntime` here is
// asserting the value that write reads from.
// =============================================================================
describe('the publish step resolves and records the proxy runtime', () => {
  function publishStep() {
    const step = buildUpdateSteps().find((candidate) => candidate.id === 'publish');
    if (step === undefined) throw new Error('the "publish" step was removed or renamed');
    return step;
  }

  function baseState(root: string, overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      repoUrl: 'https://example.test/o/r',
      ref: 'main',
      commitSha: 'a'.repeat(40),
      domain: 'app.example.test',
      bindPort: 3535,
      deployRoot: root,
      installedAt: '2026-01-01T00:00:00.000Z',
      lastDeployedAt: '2026-01-01T00:00:00.000Z',
      lastCommand: 'update',
      appctlVersion: '1.0.0',
      proxyRoot: join(root, 'proxy'),
      ...overrides,
    };
  }

  function contextFor(root: string, state: Record<string, unknown>, options: Record<string, unknown> = {}) {
    return {
      options: { deployRoot: root, ...options },
      state,
      runCommand: (async (argv: readonly string[]) => {
        if (argv[0] === 'docker') {
          return { argv, cwd: root, exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false };
        }
        throw new Error(`this test must not spawn: ${argv.join(' ')}`);
      }) as never,
      journal: { line: () => undefined, redact: (text: string) => text },
      hooks: undefined,
      completed: new Set<string>(),
      env: new Map<string, string>(),
      progress: [] as string[],
      proxyRuntime: undefined as { mode: string; container: string; source: string } | undefined,
    };
  }

  it('an explicit --proxy-mode/--proxy-container flag is what gets resolved and recorded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-publish-'));
    const context = contextFor(root, baseState(root), {
      proxyMode: 'container',
      proxyContainer: 'flagged-proxy',
    });

    await publishStep().run(context as never);

    expect(context.proxyRuntime).toMatchObject({
      mode: 'container',
      container: 'flagged-proxy',
      source: 'explicit',
    });
  });

  it('with no flag, install\'s recorded runtime is what gets resolved and recorded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-publish-'));
    const context = contextFor(
      root,
      baseState(root, { proxyMode: 'container', proxyContainer: 'recorded-proxy' }),
    );

    await publishStep().run(context as never);

    expect(context.proxyRuntime).toMatchObject({
      mode: 'container',
      container: 'recorded-proxy',
      source: 'explicit',
    });
  });
});

describe('runUpdate: an unreadable state file is not an unrecorded deployment', () => {
  it('surfaces DeployStateError, not the adoption path and not NotInstalledError', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-badstate-'));
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    writeFileSync(join(root, '.env'), 'APP_BIND_PORT=3535\n');
    // The file is present but this build cannot interpret it - a different
    // problem from "nothing recorded", deserving a different message.
    writeFileSync(deployStatePath(root), '{ not json');

    const error = await runUpdate({ deployRoot: root }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeployStateError);
    expect(error).not.toBeInstanceOf(NotInstalledError);
  });
});

// =============================================================================
// The `preflight` step's source-check wiring (#390): `fetch` talks to the
// recorded repository, so gh is folded in as the REQUIRED subset of
// SOURCE_CHECK_IDS only -- gh is advice everywhere except an HTTPS GitHub URL
// git cannot read.
// =============================================================================
describe('the preflight step: gh is required only for an unreadable HTTPS GitHub URL', () => {
  function preflightStep() {
    const step = buildUpdateSteps().find((candidate) => candidate.id === 'preflight');
    if (step === undefined) throw new Error('the "preflight" step was removed or renamed');
    return step;
  }

  /** Answers every host-check probe successfully; git/gh answered per test. */
  function makeRunCommand(
    respond: (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } | undefined,
  ): typeof runCommand {
    return (async (argv: readonly string[], options: { cwd: string }): Promise<CommandResult> => {
      const line = argv.join(' ');
      const canned =
        respond(argv) ??
        (line.startsWith('docker --version')
          ? { exitCode: 0, stdout: 'Docker version 27.3.1, build abc' }
          : line.startsWith('docker info')
            ? { exitCode: 0, stdout: '27.3.1' }
            : line.startsWith('docker compose version')
              ? { exitCode: 0, stdout: 'Docker Compose version v2.29.0' }
              : line.startsWith('git --version')
                ? { exitCode: 0, stdout: 'git version 2.43.0' }
                : line.startsWith('df -Pk')
                  ? {
                      exitCode: 0,
                      stdout:
                        'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 10000000 80000000 12% /',
                    }
                  : undefined);

      if (canned === undefined) {
        throw new Error(`unexpected command in preflight test: ${line}`);
      }

      const result: CommandResult = {
        argv: [...argv],
        cwd: options.cwd,
        exitCode: canned.exitCode,
        stdout: canned.stdout ?? '',
        stderr: canned.stderr ?? '',
        durationMs: 1,
        timedOut: false,
      };
      if (result.exitCode !== 0) {
        const error = new Error(canned.stderr ?? 'failed') as Error & { result: CommandResult };
        error.result = result;
        throw error;
      }
      return result;
    }) as typeof runCommand;
  }

  function contextFor(root: string, state: Record<string, unknown>, runCommandFn: typeof runCommand) {
    return {
      options: { deployRoot: root },
      state: { bindPort: 3535, proxyRoot: join(root, 'proxy'), domain: undefined, ...state },
      runCommand: runCommandFn,
      journal: { line: () => undefined, redact: (text: string) => text },
      hooks: undefined,
      completed: new Set<string>(),
      env: new Map<string, string>(),
    };
  }

  it('does not require gh at all for a non-github (or ssh) repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-preflight-'));
    const context = contextFor(root, { repoUrl: 'git@github.com:acme/widgets.git' }, makeRunCommand(() => undefined));

    // gh is never even probed: no `gh ...` argv is answered above, so this
    // would throw "unexpected command" if gh-installed/gh-authenticated ran.
    await expect(preflightStep().run(context as never)).resolves.toBeUndefined();
  });

  it('does not require gh when git can already read the HTTPS GitHub URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-preflight-'));
    const context = contextFor(
      root,
      { repoUrl: 'https://github.com/acme/widgets' },
      makeRunCommand((argv) =>
        argv.join(' ').startsWith('git ls-remote') ? { exitCode: 0, stdout: 'abc\tHEAD' } : undefined,
      ),
    );

    await expect(preflightStep().run(context as never)).resolves.toBeUndefined();
  });

  it('REQUIRES gh (and FAILS the preflight) for an HTTPS GitHub URL git cannot read, with gh missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-preflight-'));
    const context = contextFor(
      root,
      { repoUrl: 'https://github.com/acme/widgets' },
      makeRunCommand((argv) => {
        const line = argv.join(' ');
        if (line.startsWith('git ls-remote')) return { exitCode: 128, stderr: 'fatal: could not read Username' };
        if (line.startsWith('gh')) return undefined; // not installed
        return undefined;
      }),
    );

    const error = await preflightStep().run(context as never).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('gh-installed');
  });

  it('passes when gh is required AND actually installed and authenticated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-preflight-'));
    const context = contextFor(
      root,
      { repoUrl: 'https://github.com/acme/widgets' },
      makeRunCommand((argv) => {
        const line = argv.join(' ');
        if (line.startsWith('git ls-remote')) return { exitCode: 128, stderr: 'fatal: could not read Username' };
        if (line.startsWith('gh --version')) return { exitCode: 0, stdout: 'gh version 2.63.0\n' };
        if (line.startsWith('gh auth status')) return { exitCode: 0, stdout: '✓ Logged in to github.com\n' };
        return undefined;
      }),
    );

    await expect(preflightStep().run(context as never)).resolves.toBeUndefined();
  });
});

// =============================================================================
// nginx's single-file config mounts (#206): `restart` recreates nginx rather
// than restarting it, and `edge-config` compares what the container reads with
// what the checkout holds on EVERY run, recreating nginx when they differ.
// =============================================================================
describe('the nginx config reaches the running container (#206)', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

  function step(id: string) {
    const found = buildUpdateSteps().find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`the "${id}" step was removed or renamed`);
    return found;
  }

  /** A deploy root whose checkout holds the given nginx files. */
  function deployRootWith(nginx: string, csp: string): string {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-edge-'));
    mkdirSync(join(root, 'repo', 'infra', 'nginx'), { recursive: true });
    mkdirSync(join(root, 'repo', 'infra', 'compose'), { recursive: true });
    writeFileSync(join(root, 'repo', 'infra', 'nginx', 'nginx.conf'), nginx);
    writeFileSync(join(root, 'repo', 'infra', 'nginx', 'csp.conf'), csp);
    return root;
  }

  /**
   * Records every compose argv (after the file list) and answers the
   * `exec ... sha256sum` reads from `served`, one entry per read.
   */
  function contextFor(root: string, served: Array<{ nginx: string; csp: string } | 'down'>) {
    const calls: string[][] = [];
    let reads = 0;
    const run = (async (argv: readonly string[], options: { cwd: string }) => {
      const done = (stdout: string, exitCode = 0): CommandResult => ({
        argv,
        cwd: options.cwd,
        exitCode,
        stdout,
        stderr: '',
        durationMs: 0,
        timedOut: false,
      });
      const execAt = argv.indexOf('exec');
      const upAt = argv.indexOf('up');
      const restartAt = argv.indexOf('restart');
      const at = [execAt, upAt, restartAt].filter((index) => index !== -1)[0];
      if (argv[0] !== 'docker' || at === undefined) {
        throw new Error(`unexpected command: ${argv.join(' ')}`);
      }
      calls.push(argv.slice(at));
      if (execAt === -1) return done('');
      const answer = served[Math.min(reads++, served.length - 1)];
      if (answer === 'down' || answer === undefined) {
        throw new Error('service "nginx" is not running');
      }
      return done(
        `${sha(answer.nginx)}  /etc/nginx/nginx.conf\n${sha(answer.csp)}  /etc/nginx/csp.conf\n`,
      );
    }) as typeof runCommand;

    return {
      calls,
      context: {
        options: { deployRoot: root },
        state: { bindPort: 3535, composeProject: 'demo' },
        runCommand: run,
        // Skips the external-network probe; not what these tests are about.
        networksEnsured: true,
        journal: { line: () => undefined, command: () => undefined, redact: (text: string) => text },
        hooks: undefined,
        completed: new Set<string>(),
        // The case the issue is about: the checkout did not move this run.
        unchanged: true,
      },
    };
  }

  it('restart recreates nginx instead of restarting it', async () => {
    const root = deployRootWith('n', 'c');
    const { context, calls } = contextFor(root, []);

    await step('restart').run(context as never);

    expect(calls).toContainEqual(['up', '-d', '--no-deps', '--force-recreate', 'nginx']);
    expect(calls.some((argv) => argv[0] === 'restart')).toBe(false);
  });

  it('leaves a matching nginx alone', async () => {
    const root = deployRootWith('new', 'csp');
    const { context, calls } = contextFor(root, [{ nginx: 'new', csp: 'csp' }]);

    await step('edge-config').run(context as never);

    expect(calls).toEqual([
      ['exec', '-T', 'nginx', 'sha256sum', '/etc/nginx/nginx.conf', '/etc/nginx/csp.conf'],
    ]);
  });

  it('recreates a stale nginx once on an unchanged run, then passes', async () => {
    const root = deployRootWith('geolocation=(self)', 'csp');
    const { context, calls } = contextFor(root, [
      { nginx: 'geolocation=()', csp: 'csp' },
      { nginx: 'geolocation=(self)', csp: 'csp' },
    ]);

    await step('edge-config').run(context as never);

    expect(calls.map((argv) => argv[0])).toEqual(['exec', 'up', 'exec']);
    expect(calls[1]).toEqual(['up', '-d', '--no-deps', '--force-recreate', 'nginx']);
  });

  it('recreates nginx when it is not running at all', async () => {
    const root = deployRootWith('new', 'csp');
    const { context, calls } = contextFor(root, ['down', { nginx: 'new', csp: 'csp' }]);

    await step('edge-config').run(context as never);

    expect(calls.map((argv) => argv[0])).toEqual(['exec', 'up', 'exec']);
  });

  it('fails with the manual recreate command, under the deployment\'s project, when still stale', async () => {
    const root = deployRootWith('new', 'csp');
    const { context, calls } = contextFor(root, [{ nginx: 'old', csp: 'csp' }]);

    const error = await step('edge-config').run(context as never).catch((caught: unknown) => caught);

    expect(calls.filter((argv) => argv[0] === 'up')).toHaveLength(1);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('/etc/nginx/nginx.conf');
    expect(message).toContain('docker compose -p demo');
    expect(message).toContain('up -d --no-deps --force-recreate nginx');
  });
});

// =============================================================================
// The `verify` step's certificate hint (#205): see install.ts's equivalent
// block's header comment -- same reasoning, same three cases, this file's
// own `verify` step.
// =============================================================================
describe('the verify step: the certs hint on a failed external probe', () => {
  function verifyStep() {
    const step = buildUpdateSteps().find((candidate) => candidate.id === 'verify');
    if (step === undefined) throw new Error('the "verify" step was removed or renamed');
    return step;
  }

  const healthyProbe = { ok: true as const, durationMs: 1 };

  function contextFor(root: string, report: HealthReport) {
    vi.mocked(healthModule.collectHealth).mockResolvedValueOnce(report);
    return {
      options: { deployRoot: root, skipProxy: false },
      state: { domain: 'app.example.test', bindPort: 3535 },
      env: undefined,
      runCommand: (async () => {
        throw new Error('verify must not spawn directly; collectHealth is mocked');
      }) as unknown as typeof runCommand,
      journal: { line: () => undefined, redact: (text: string) => text },
      hooks: undefined,
      completed: new Set<string>(),
    };
  }

  it('appends the certs hint when a domain was probed and the probe failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-verify-'));
    const context = contextFor(root, {
      containers: [],
      local: { live: healthyProbe, ready: healthyProbe, frontend: healthyProbe },
      migrations: { pending: [], known: false },
      external: {
        url: 'https://app.example.test',
        probe: { ok: false, durationMs: 1, error: 'certificate verify failed' },
      },
    });

    const error = await verifyStep()
      .run(context as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'evopathcli deploy certs --domain app.example.test',
    );
    expect((error as Error).message).toContain('certificate/SSL error');
  });

  it('does NOT append the hint when the probe succeeded, even though something else is unhealthy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-verify-'));
    const context = contextFor(root, {
      containers: [],
      local: { live: healthyProbe, ready: { ok: false, durationMs: 1, error: 'timeout' }, frontend: healthyProbe },
      migrations: { pending: [], known: false },
      external: { url: 'https://app.example.test', probe: healthyProbe },
    });

    const error = await verifyStep()
      .run(context as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('deploy certs');
  });

  it('does NOT append the hint when no domain was probed at all', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-verify-'));
    const context = contextFor(root, {
      containers: [],
      local: { live: healthyProbe, ready: { ok: false, durationMs: 1, error: 'timeout' }, frontend: healthyProbe },
      migrations: { pending: [], known: false },
      external: undefined,
    });

    const error = await verifyStep()
      .run(context as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('deploy certs');
  });
});

// =============================================================================
// Opt-in maintenance mode during `deploy update` (#226): `maintenance-on`
// forces `MAINTENANCE_MODE=true` into the `.env` before the risky part of the
// run, `maintenance-off` clears it afterwards, and the off-step self-heals a
// window a PREVIOUS failed run left open -- regardless of `--maintenance`.
// =============================================================================
describe('maintenance mode (#226)', () => {
  function step(id: string) {
    const found = buildUpdateSteps().find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`the "${id}" step was removed or renamed`);
    return found;
  }

  function envPathFor(root: string): string {
    return join(root, 'repo', 'infra', 'compose', '.env');
  }

  /** A deploy root with a `.env`/`.env.example` pair, as `compose()` needs. */
  function deployRootWithEnv(envContents: string): string {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-maintenance-'));
    const composeDir = join(root, 'repo', 'infra', 'compose');
    mkdirSync(composeDir, { recursive: true });
    writeFileSync(join(composeDir, '.env.example'), 'APP_URL=http://localhost:3535\n');
    writeFileSync(envPathFor(root), envContents);
    return root;
  }

  /**
   * A context whose `runCommand` answers every `docker compose` call and
   * records only the part after `up`/`exec` - the same style
   * `contextFor` uses above for the nginx edge-config tests - so assertions
   * read as the flag list rather than the full `docker compose -p ... -f ...`
   * preamble.
   */
  function contextFor(
    root: string,
    options: { maintenance?: boolean } = {},
    behavior: 'ok' | 'fail' = 'ok',
  ) {
    const calls: string[][] = [];
    const journalLines: string[] = [];
    const progressMessages: string[] = [];

    const run = (async (argv: readonly string[], runOptions: { cwd: string }): Promise<CommandResult> => {
      if (argv[0] !== 'docker') throw new Error(`unexpected command: ${argv.join(' ')}`);
      const at = argv.indexOf('up');
      if (at === -1) throw new Error(`unexpected compose call: ${argv.join(' ')}`);
      calls.push(argv.slice(at));

      if (behavior === 'fail') throw new Error('compose recreate failed');

      return {
        argv: [...argv],
        cwd: runOptions.cwd,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
      };
    }) as typeof runCommand;

    return {
      calls,
      journalLines,
      progressMessages,
      context: {
        options: { deployRoot: root, ...options },
        state: { bindPort: 3535 },
        runCommand: run,
        // Skips the external-network probe; not what these tests are about.
        networksEnsured: true,
        journal: {
          line: (text: string) => void journalLines.push(text),
          command: () => undefined,
          redact: (text: string) => text,
        },
        hooks: { onProgress: (message: string) => void progressMessages.push(message) },
        completed: new Set<string>(),
        env: new Map<string, string>(),
        progress: [] as string[],
      },
    };
  }

  const RECREATE_API = ['up', '-d', '--no-deps', '--force-recreate', 'api'];

  describe('enableMaintenanceMode (the "maintenance-on" step)', () => {
    it('writes MAINTENANCE_MODE=true into the .env and recreates api', async () => {
      const root = deployRootWithEnv('APP_URL=http://localhost:3535\n');
      const { context, calls } = contextFor(root);

      await step('maintenance-on').run(context as never);

      expect(readFileSync(envPathFor(root), 'utf8')).toContain('MAINTENANCE_MODE=true');
      expect(calls).toContainEqual(RECREATE_API);
    });

    it('swallows a failed api recreate: warns, and never throws', async () => {
      const root = deployRootWithEnv('APP_URL=http://localhost:3535\n');
      const { context, journalLines, progressMessages } = contextFor(root, {}, 'fail');

      await expect(step('maintenance-on').run(context as never)).resolves.toBeUndefined();

      // The write still happened - only the recreate failed.
      expect(readFileSync(envPathFor(root), 'utf8')).toContain('MAINTENANCE_MODE=true');
      expect(journalLines.some((line) => line.startsWith('warning:'))).toBe(true);
      expect(progressMessages.some((message) => message.startsWith('warning:'))).toBe(true);
    });

    it('no-ops, without writing anything, when there is no .env yet', async () => {
      const root = mkdtempSync(join(tmpdir(), 'evopathcli-update-maintenance-noenv-'));
      const { context, calls } = contextFor(root);

      await step('maintenance-on').run(context as never);

      expect(calls).toEqual([]);
    });
  });

  describe('disableMaintenanceMode (the "maintenance-off" step)', () => {
    it('deletes the key - never writes `false` - and recreates api', async () => {
      const root = deployRootWithEnv('APP_URL=http://localhost:3535\nMAINTENANCE_MODE=true\n');
      const { context, calls } = contextFor(root);

      await step('maintenance-off').run(context as never);

      const written = readFileSync(envPathFor(root), 'utf8');
      expect(written).not.toContain('MAINTENANCE_MODE');
      expect(calls).toContainEqual(RECREATE_API);
    });

    it('no-ops when the key is already absent: no compose call at all', async () => {
      const root = deployRootWithEnv('APP_URL=http://localhost:3535\n');
      const { context, calls } = contextFor(root);

      await step('maintenance-off').run(context as never);

      expect(calls).toEqual([]);
    });

    it('propagates a failed api recreate - unlike enable, this is allowed to throw', async () => {
      const root = deployRootWithEnv('APP_URL=http://localhost:3535\nMAINTENANCE_MODE=true\n');
      const { context } = contextFor(root, {}, 'fail');

      const error = await step('maintenance-off')
        .run(context as never)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('compose recreate failed');
    });

    it('clears a stale MAINTENANCE_MODE=true left by a previous run, even with --maintenance not set', async () => {
      // The self-heal this step exists for: a PREVIOUS run's maintenance-on
      // set the key and never reached its own off-step (a failure in
      // build/migrate/seed before restart). This run never passed
      // --maintenance at all - `context.options.maintenance` is absent - and
      // the leftover key is still cleared.
      const root = deployRootWithEnv('APP_URL=http://localhost:3535\nMAINTENANCE_MODE=true\n');
      const { context } = contextFor(root); // no `maintenance` in options

      expect('maintenance' in context.options).toBe(false);

      await step('maintenance-off').run(context as never);

      expect(readFileSync(envPathFor(root), 'utf8')).not.toContain('MAINTENANCE_MODE');
    });
  });

  describe('skip gating', () => {
    const steps = buildUpdateSteps();
    function skipReason(id: string, context: Record<string, unknown>): string | undefined {
      return steps.find((candidate) => candidate.id === id)?.skip?.(context as never);
    }

    it('maintenance-on skips, naming --maintenance, when the flag was not passed', () => {
      expect(skipReason('maintenance-on', { unchanged: false, options: {}, state: {} })).toContain(
        '--maintenance',
      );
    });

    it('maintenance-on runs when --maintenance was passed', () => {
      expect(
        skipReason('maintenance-on', { unchanged: false, options: { maintenance: true }, state: {} }),
      ).toBeUndefined();
    });

    it('maintenance-on is still gated by "already up to date" ahead of the flag', () => {
      expect(
        skipReason('maintenance-on', { unchanged: true, options: { maintenance: true }, state: {} }),
      ).toBe('already up to date');
    });

    it('maintenance-off is NEVER gated on --maintenance, only on "unchanged"', () => {
      expect(skipReason('maintenance-off', { unchanged: false, options: {}, state: {} })).toBeUndefined();
      expect(
        skipReason('maintenance-off', { unchanged: false, options: { maintenance: true }, state: {} }),
      ).toBeUndefined();
      expect(skipReason('maintenance-off', { unchanged: true, options: {}, state: {} })).toBe(
        'already up to date',
      );
    });
  });
});
