import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildInstallSteps, composeCwd } from './install.js';
import { openJournal } from './journal.js';
import { UsageError } from '../errors.js';
import { DEPLOY_STATE_VERSION, readState, writeState, type DeployState } from './state.js';

function fixture(): string {
  const deployRoot = mkdtempSync(join(tmpdir(), 'appctl-harden-'));
  mkdirSync(composeCwd(deployRoot), { recursive: true });
  writeFileSync(
    join(composeCwd(deployRoot), '.env.example'),
    '# ---\n# Core\n# ---\nNODE_ENV=development\nAPP_BIND_PORT=3535\n',
  );
  return deployRoot;
}

function step(id: string) {
  const found = buildInstallSteps().find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

/**
 * Whether a compose argv MATERIALISES a service, and so creates its bind
 * sources.
 *
 * ⚠ THE DISTINCTION IS DOCKER'S, NOT A CONVENIENCE. `docker compose version`
 * and `config` read and print; they start nothing and create nothing, and the
 * preflight runs the first of those before any deploy directory exists. A test
 * that demanded the bind source before THOSE would be demanding a directory
 * for a command that cannot touch it -- and the mkdir added to satisfy it
 * would be cargo, not a fix.
 *
 * `run`, `up`, `create` and `start` each instantiate the service, and each one
 * is enough for Docker to create a missing bind source as root:root.
 */
function instantiates(argv: readonly string[]): boolean {
  return argv.some((word) => word === 'run' || word === 'up' || word === 'create' || word === 'start');
}

describe('install: the deploy-info bind source exists before ANY compose call', () => {
  it('creates it before every compose invocation, not only before `up`', async () => {
    // =========================================================================
    // ⚠ THE ASSERTION THAT WAS TOO NARROW, AND THE BUG IT LET THROUGH
    // =========================================================================
    //
    // Docker creates a MISSING bind source itself, as root:root, the moment it
    // INSTANTIATES the service that mounts it -- and `compose run --rm
    // --no-deps api`, which `migrate` and `seed` both use, instantiates the api
    // service just as thoroughly as `up` does.
    //
    // This test used to drive only the `start` step, so it passed while
    // `migrate` -- two steps earlier -- was already creating
    // `<deployRoot>/deploy-info` owned by root. The `mkdirSync` at `start` then
    // no-opped on a directory that already existed, and the `deploy-info` step
    // later failed with EACCES.
    //
    // Every step reported green. The deployment was up, healthy and serving;
    // only the About page was permanently empty, and the one line saying why
    // was a warning in a journal nobody reads on a successful run. A real
    // Docker run is what caught it.
    //
    // So the assertion is now about EVERY compose spawn in the pipeline, which
    // is the invariant that actually matters -- and it keeps holding when
    // somebody adds a compose call earlier than the ones here.
    // =========================================================================
    const deployRoot = fixture();
    const missingAt: string[] = [];
    let composeCalls = 0;
    let currentStep = '';

    const runCommand = vi.fn().mockImplementation(async (argv: readonly string[]) => {
      if (argv[0] === 'docker' && argv[1] === 'compose' && instantiates(argv)) {
        composeCalls += 1;
        if (!existsSync(join(deployRoot, 'deploy-info'))) missingAt.push(currentStep);
      }
      return { argv, cwd: '/tmp', exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    });

    const journal = openJournal({ deployRoot, command: 'install', secrets: [] });

    // ⚠ SKIPPED BY NAME, WITH A REASON, rather than by listing the steps to
    // INCLUDE. A test that named the compose-spawning steps would not cover a
    // compose call added to a step it had never heard of -- which is exactly
    // the shape of the bug it exists to catch. These three wait on the network
    // rather than on compose: `health` polls the API until it answers,
    // `verify` probes it, and `publish` talks to certbot.
    const WAITS_ON_THE_NETWORK = new Set(['health', 'verify', 'publish', 'publish-version']);

    for (const candidate of buildInstallSteps()) {
      if (WAITS_ON_THE_NETWORK.has(candidate.id)) continue;
      currentStep = candidate.id;
      try {
        await candidate.run({
          options: {
            deployRoot,
            bindPort: 3535,
            proxyRoot: join(deployRoot, 'proxy'),
            skipProxy: true,
            noVersionBump: true,
          },
          runCommand,
          journal,
          hooks: undefined,
          completed: new Set<string>(),
          progress: [],
        } as never);
      } catch {
        // Most steps cannot complete against this bare fixture -- there is no
        // checkout, no database, no running API. That is fine: what is under
        // test is the state of the filesystem AT THE MOMENT compose is
        // spawned, and a step that throws afterwards has already spawned it.
      }
    }

    journal.finish('success');

    expect(composeCalls).toBeGreaterThan(0);
    expect(missingAt, 'compose ran with no deploy-info directory during these steps').toEqual([]);
  });
});

describe('install: --domain is only required when something will be published', () => {
  const base = (deployRoot: string, skipProxy: boolean) => ({
    options: {
      deployRoot,
      bindPort: 3535,
      proxyRoot: join(deployRoot, 'proxy'),
      nonInteractive: true,
      skipProxy,
    },
    runCommand: vi.fn(),
    journal: openJournal({ deployRoot, command: 'install', secrets: [] }),
    hooks: undefined,
    completed: new Set<string>(),
  });

  it('still refuses without --domain when the proxy will be configured', async () => {
    const deployRoot = fixture();

    await expect(step('environment').run(base(deployRoot, false) as never)).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it('does not demand a domain under --skip-proxy: there is nothing to publish', async () => {
    const deployRoot = fixture();

    // It may still fail later for its own reasons; what it must NOT do is throw
    // the "a domain is required" usage error.
    const outcome = await step('environment')
      .run(base(deployRoot, true) as never)
      .then(() => undefined)
      .catch((error: unknown) => error);

    if (outcome instanceof UsageError) {
      expect(outcome.message).not.toMatch(/domain is required/i);
    }
  });
});

describe('deploy state stays readable across this change', () => {
  it('a record with neither composeProject nor proxyRoot still loads', () => {
    const deployRoot = mkdtempSync(join(tmpdir(), 'appctl-state-compat-'));
    // ⚠ A LITERAL v1 RECORD, as every deployment in the field has on disk.
    writeState({
      version: 1 as typeof DEPLOY_STATE_VERSION,
      repoUrl: 'https://example.invalid/app.git',
      ref: 'main',
      commitSha: 'a'.repeat(40),
      bindPort: 3535,
      deployRoot,
      installedAt: '2026-01-01T00:00:00.000Z',
      lastDeployedAt: '2026-01-01T00:00:00.000Z',
      lastCommand: 'install',
      appctlVersion: '1.0.0',
    } as DeployState);

    const state = readState(deployRoot);

    expect(state?.composeProject).toBeUndefined();
    expect(state?.proxyRoot).toBeUndefined();
    // ⚠ Read FORWARD, never refused: the v2 bump (issue #392) is safe only
    // because `upgradeState` carries every v1 record on a live server into it.
    expect(state?.version).toBe(DEPLOY_STATE_VERSION);
    expect(state?.history).toEqual([]);
  });
});
