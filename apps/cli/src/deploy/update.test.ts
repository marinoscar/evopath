import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CommandResult, runCommand } from './executor.js';
import { DeployStateError, NotInstalledError, deployStatePath } from './state.js';
import { buildUpdateSteps, runUpdate } from './update.js';

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
      'build',
      'migrate',
      'seed',
      'restart',
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
    for (const id of ['ensure-database', 'build', 'migrate', 'seed', 'restart', 'health', 'publish', 'renewal', 'verify']) {
      expect(skipReason(id, { unchanged: true, options: {}, state: {} })).toBe(
        'already up to date',
      );
    }
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
    const empty = mkdtempSync(join(tmpdir(), 'appctl-noinstall-'));

    const error = await runUpdate({ deployRoot: empty }).catch((caught: unknown) => caught);

    // The precondition install does not have, and the reason this is its own
    // command rather than a flag: the guards are opposite.
    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain('deploy install');
  });

  it('names which half is missing when refusing, rather than asserting a bare negative', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'appctl-noinstall-'));

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
    const root = mkdtempSync(join(tmpdir(), 'appctl-adopt-update-'));
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
    const empty = mkdtempSync(join(tmpdir(), 'appctl-adopt-update-empty-'));

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
    const root = mkdtempSync(join(tmpdir(), 'appctl-update-publish-'));
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
    const root = mkdtempSync(join(tmpdir(), 'appctl-update-publish-'));
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
    const root = mkdtempSync(join(tmpdir(), 'appctl-badstate-'));
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
    const root = mkdtempSync(join(tmpdir(), 'appctl-update-preflight-'));
    const context = contextFor(root, { repoUrl: 'git@github.com:acme/widgets.git' }, makeRunCommand(() => undefined));

    // gh is never even probed: no `gh ...` argv is answered above, so this
    // would throw "unexpected command" if gh-installed/gh-authenticated ran.
    await expect(preflightStep().run(context as never)).resolves.toBeUndefined();
  });

  it('does not require gh when git can already read the HTTPS GitHub URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-update-preflight-'));
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
    const root = mkdtempSync(join(tmpdir(), 'appctl-update-preflight-'));
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
    const root = mkdtempSync(join(tmpdir(), 'appctl-update-preflight-'));
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
