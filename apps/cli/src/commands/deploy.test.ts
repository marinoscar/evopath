import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import type { Check, CompletedCheck } from '../deploy/checks/index.js';
import { DEPLOY_STATE_VERSION, deployStatePath, type DeployState } from '../deploy/state.js';
import type { CommandResult, RunCommandOptions } from '../deploy/executor.js';
import type { HealthReport } from '../deploy/health.js';
import * as installModule from '../deploy/install.js';
import type { InstallOptions } from '../deploy/install.js';
import * as updateModule from '../deploy/update.js';
import type { UpdateOptions } from '../deploy/update.js';
import { EXIT, exitCodeFor } from '../errors.js';
import {
  buildReport,
  registerDeployCommand,
  renderHealth,
  renderResult,
  renderSummary,
  type DeployContext,
  type DoctorReport,
} from './deploy.js';
import type { InventoryEntry } from '../deploy/inventory.js';

vi.mock('../deploy/install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deploy/install.js')>();
  return { ...actual, runInstall: vi.fn() };
});
vi.mock('../deploy/update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deploy/update.js')>();
  return { ...actual, runUpdate: vi.fn() };
});

const ESC = String.fromCharCode(27);

function check(
  id: string,
  severity: 'required' | 'recommended',
  status: 'pass' | 'warn' | 'fail' | 'skip',
  detail = 'detail',
  remedy?: string,
): Check {
  return {
    id,
    title: id,
    severity,
    run: async () => ({ status, detail, ...(remedy === undefined ? {} : { remedy }) }),
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
  error: unknown;
}

/**
 * A runCommand that answers every probe as a missing binary.
 *
 * `doctor` resolves the proxy runtime (`docker inspect`, `nginx -v`) before it
 * runs any check, so without this the tests below would spawn real processes.
 * Every probe failing lands on the documented default -- container mode -- and
 * the injected checks never call it at all.
 */
const noProcesses: typeof import('../deploy/executor.js').runCommand = (async (
  argv: readonly string[],
) => {
  throw new Error(`${argv[0] ?? ''}: command not found`);
}) as typeof import('../deploy/executor.js').runCommand;

async function runDoctor(
  argv: readonly string[],
  checks: readonly Check[],
  extra: Partial<DeployContext> = {},
): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program, {
    checks,
    runCommand: noProcesses,
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    isTty: false,
    ...extra,
  });

  let error: unknown;
  try {
    await program.parseAsync(['deploy', 'doctor', ...argv], { from: 'user' });
  } catch (caught) {
    error = caught;
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), error };
}

const HEALTHY: Check[] = [
  check('a', 'required', 'pass', 'fine'),
  check('b', 'recommended', 'pass', 'fine'),
];

describe('appctl deploy doctor', () => {
  it('exits 0 when every required check passes', async () => {
    const result = await runDoctor([], HEALTHY);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('2 passed');
  });

  it('exits 6 when a required check fails', async () => {
    const result = await runDoctor([], [
      check('broken', 'required', 'fail', 'nope', 'do the thing'),
    ]);

    // A distinct code is the point: `doctor || provision-the-box` has to tell
    // "not ready" apart from "appctl itself broke".
    expect(exitCodeFor(result.error)).toBe(EXIT.PRECONDITION);
    expect((result.error as Error).message).toContain('broken');
  });

  it('exits 0 when only a recommended check fails', async () => {
    // Failing on advice is how people learn to pass --force.
    const result = await runDoctor([], [
      check('a', 'required', 'pass'),
      check('advice', 'recommended', 'fail', 'meh', 'consider this'),
    ]);

    expect(result.error).toBeUndefined();
  });

  it('writes nothing to stdout without --json', async () => {
    const result = await runDoctor([], HEALTHY);

    // stdout is reserved so `--json | jq` stays clean.
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
  });

  it('shows a remedy for every failing check', async () => {
    const result = await runDoctor([], [
      check('broken', 'required', 'fail', 'nope', 'run the fix command'),
    ]);

    expect(result.stderr).toContain('run the fix command');
  });

  it('emits no ANSI when the stream is not a terminal', async () => {
    const result = await runDoctor([], HEALTHY);

    expect(result.stderr).not.toContain(ESC);
  });

  it('emits no ANSI under --no-color even on a terminal', async () => {
    const result = await runDoctor(['--no-color'], HEALTHY, { isTty: true });

    expect(result.stderr).not.toContain(ESC);
  });

  it('reports a check that throws as a failure rather than crashing', async () => {
    const exploding: Check = {
      id: 'boom',
      title: 'boom',
      severity: 'recommended',
      run: async () => {
        throw new Error('probe blew up');
      },
    };

    const result = await runDoctor([], [check('a', 'required', 'pass'), exploding]);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('probe blew up');
  });
});

describe('appctl deploy doctor --json', () => {
  it('writes valid JSON on stdout and nothing on stderr', async () => {
    const result = await runDoctor(['--json'], HEALTHY);

    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.ok).toBe(true);
    expect(report.checks.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(report.summary).toEqual({ passed: 2, warned: 0, failed: 0, skipped: 0 });
  });

  it('still exits 6 when a required check failed', async () => {
    const result = await runDoctor(['--json'], [
      check('broken', 'required', 'fail', 'nope', 'fix it'),
    ]);

    expect(exitCodeFor(result.error)).toBe(EXIT.PRECONDITION);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.remedy).toBe('fix it');
  });

  it('never emits ANSI, whatever the terminal looks like', async () => {
    const result = await runDoctor(['--json'], HEALTHY, { isTty: true });

    expect(result.stdout).not.toContain(ESC);
  });
});

describe('buildReport', () => {
  const results: CompletedCheck[] = [
    { id: 'a', title: 'A', severity: 'required', status: 'pass', detail: 'ok', durationMs: 1 },
    {
      id: 'b',
      title: 'B',
      severity: 'recommended',
      status: 'warn',
      detail: 'hmm',
      remedy: 'maybe',
      durationMs: 2,
    },
  ];

  it('omits remedy entirely when there is none', () => {
    const report = buildReport(results);

    expect(report.checks[0]).not.toHaveProperty('remedy');
    expect(report.checks[1]?.remedy).toBe('maybe');
  });

  it('is ok when only a recommended check warned', () => {
    expect(buildReport(results).ok).toBe(true);
  });
});

describe('rendering', () => {
  const failing: CompletedCheck = {
    id: 'x',
    title: 'Something',
    severity: 'required',
    status: 'fail',
    detail: 'not there',
    remedy:
      'A remedy long enough that it has to wrap across more than one line so it stays readable in an eighty column session over ssh',
    durationMs: 1,
  };

  it('marks status with a glyph, not only colour', () => {
    // Read over SSH, piped into files, and by people who cannot tell red from
    // green - colour alone would make the status invisible to all three.
    expect(renderResult(failing, false)).toContain('XX');
  });

  it('wraps a long remedy', () => {
    const lines = renderResult(failing, false).trim().split('\n');

    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
  });

  it('does not print a remedy for a passing check', () => {
    const passing: CompletedCheck = { ...failing, status: 'pass' };

    expect(renderResult(passing, false)).not.toContain('->');
  });

  it('colours only when asked', () => {
    expect(renderResult(failing, true)).toContain(ESC);
    expect(renderResult(failing, false)).not.toContain(ESC);
  });

  it('leads the summary with failures', () => {
    const line = renderSummary({ passed: 9, warned: 1, failed: 2, skipped: 0 }, false);

    expect(line.trim().startsWith('2 failed')).toBe(true);
    expect(line).toContain('1 warning(s)');
  });
});

describe('the deploy group', () => {
  it('fails rather than doing nothing when no subcommand is given', async () => {
    const program = new Command();
    program.exitOverride();
    registerDeployCommand(program, { checks: HEALTHY });

    // A CLI that exits 0 having done nothing turns a broken pipeline step
    // into a green one.
    await expect(program.parseAsync(['deploy'], { from: 'user' })).rejects.toBeDefined();
  });
});


// ---------------------------------------------------------------------------
// `appctl deploy status`  (issue #183)
// ---------------------------------------------------------------------------

function installedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-status-'));
  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    bindPort: 3535,
    deployRoot: root,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
  writeFileSync(deployStatePath(root), JSON.stringify(state));
  return root;
}

function composeRunCommand(psJson: string, migrateOutput: string) {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const line = argv.join(' ');
    const stdout = line.includes(' ps ') ? psJson : migrateOutput;
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 1,
      timedOut: false,
    };
    return result;
  }) as typeof import('../deploy/executor.js').runCommand;
}

const ALL_RUNNING = JSON.stringify([
  { Name: 'demo-api-1', Service: 'api', State: 'running', Image: 'i' },
  { Name: 'demo-web-1', Service: 'web', State: 'running', Image: 'i' },
]);

const WEB_DOWN = JSON.stringify([
  { Name: 'demo-api-1', Service: 'api', State: 'running', Image: 'i' },
  { Name: 'demo-web-1', Service: 'web', State: 'exited', Image: 'i' },
]);

async function runStatus(
  argv: readonly string[],
  extra: Partial<DeployContext>,
): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program, {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    isTty: false,
    ...extra,
  });

  let error: unknown;
  try {
    await program.parseAsync(['deploy', 'status', ...argv], { from: 'user' });
  } catch (caught) {
    error = caught;
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), error };
}

describe('appctl deploy status', () => {
  it('exits 0 and reports every section when healthy', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('Revision');
    expect(result.stderr).toContain('Containers');
    expect(result.stderr).toContain('up to date');
    expect(result.stderr).toContain('healthy');
  });

  it('is unhealthy when the web container is down, even with the API green', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root], {
      runCommand: composeRunCommand(WEB_DOWN, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(exitCodeFor(result.error)).toBe(EXIT.FAILURE);
    expect(result.stderr).toContain('NOT healthy');
  });

  it('is unhealthy with pending migrations despite a green readiness probe', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root], {
      runCommand: composeRunCommand(
        ALL_RUNNING,
        'Following migrations have not yet been applied:\n20260101000000_add_thing\n',
      ),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    // /api/health/ready only proves SELECT 1 succeeded.
    expect(exitCodeFor(result.error)).toBe(EXIT.FAILURE);
    expect(result.stderr).toContain('1 pending');
    expect(result.stderr).toContain('20260101000000_add_thing');
  });

  it('distinguishes "nothing installed" from "installed and unhealthy"', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'appctl-empty-'));

    const result = await runStatus(['--root', empty], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    // A monitoring script has to be able to tell these apart.
    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
    expect((result.error as Error).message).toContain('deploy install');
  });

  it('writes the report as JSON on stdout and nothing on stderr', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root, '--json'], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as { healthy: boolean };
    expect(report.healthy).toBe(true);
  });

  it('reports a failing external check', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root, '--domain', 'app.example.test'], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async (url: string | URL) =>
        String(url).startsWith('https://')
          ? Promise.reject(
              Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }),
            )
          : new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(result.stderr).toContain('certificate has expired');
    expect(exitCodeFor(result.error)).toBe(EXIT.FAILURE);
  });
});

// ---------------------------------------------------------------------------
// `appctl deploy list`  (runListCommand / ListCommandOptions)
// ---------------------------------------------------------------------------

/** A fixture deployment: `<root>/repo/.git/` (a directory is enough) plus an `.env`. */
function addDeployment(appsRoot: string, name: string, envContents = 'APP_BIND_PORT=3535\n'): string {
  const deployRoot = join(appsRoot, name);
  mkdirSync(join(deployRoot, 'repo', '.git'), { recursive: true });
  writeFileSync(join(deployRoot, '.env'), envContents);
  return deployRoot;
}

async function runList(
  argv: readonly string[],
  extra: Partial<DeployContext> = {},
): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program, {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    isTty: false,
    ...extra,
  });

  let error: unknown;
  try {
    await program.parseAsync(['deploy', 'list', ...argv], { from: 'user' });
  } catch (caught) {
    error = caught;
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), error };
}

describe('appctl deploy list', () => {
  it('writes the table to stderr and nothing to stdout without --json', async () => {
    const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-list-'));
    addDeployment(appsRoot, 'alpha');

    const result = await runList(['--apps-root', appsRoot]);

    expect(result.error).toBeUndefined();
    // stdout is reserved for --json, same rule as `doctor`.
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('alpha');
    expect(result.stderr).toContain('NAME');
  });

  it('writes JSON to stdout and nothing to stderr under --json', async () => {
    const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-list-'));
    addDeployment(appsRoot, 'alpha');

    const result = await runList(['--apps-root', appsRoot, '--json']);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as { appsRoot: string; deployments: InventoryEntry[] };
    expect(report.appsRoot).toBe(appsRoot);
    expect(report.deployments).toHaveLength(1);
    expect(report.deployments[0]?.name).toBe('alpha');
  });
});

// ---------------------------------------------------------------------------
// `appctl deploy certs --renew`  (issue #389)
// ---------------------------------------------------------------------------

function installedCertRoot(proxyRoot: string, domain: string): void {
  const live = join(proxyRoot, 'letsencrypt', 'live', domain);
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, 'fullchain.pem'), '-----BEGIN CERTIFICATE-----\n');
}

async function runCerts(argv: readonly string[], extra: Partial<DeployContext> = {}): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program, {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    isTty: false,
    ...extra,
  });

  let error: unknown;
  try {
    await program.parseAsync(['deploy', 'certs', ...argv], { from: 'user' });
  } catch (caught) {
    error = caught;
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), error };
}

describe('appctl deploy certs --renew', () => {
  /** Every call succeeds except the ones a test's own override answers. */
  function runCommandWith(
    override: (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } | undefined,
  ): typeof import('../deploy/executor.js').runCommand {
    return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
      if (argv[0] === 'openssl') {
        return {
          argv: [...argv], cwd: options.cwd, exitCode: 0,
          stdout: 'notAfter=Feb 1 12:00:00 2026 GMT\n', stderr: '', durationMs: 0, timedOut: false,
        };
      }
      const canned = override(argv) ?? { exitCode: 0 };
      const result: CommandResult = {
        argv: [...argv], cwd: options.cwd, exitCode: canned.exitCode,
        stdout: canned.stdout ?? '', stderr: canned.stderr ?? '', durationMs: 0, timedOut: false,
      };
      if (result.exitCode !== 0) throw new Error(canned.stderr ?? 'failed');
      return result;
    }) as typeof import('../deploy/executor.js').runCommand;
  }

  it('exits non-zero when a renewal reload FAILS, because the old certificate is still being served', async () => {
    const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-certs-'));
    const root = join(appsRoot, 'demo');
    mkdirSync(root, { recursive: true });
    const proxyRoot = join(appsRoot, 'proxy');
    installedCertRoot(proxyRoot, 'app.example.test');

    const result = await runCerts(
      [
        '--root', root,
        '--proxy-root', proxyRoot,
        '--proxy-mode', 'host',
        '--domain', 'app.example.test',
        '--renew', '--force',
        '--email', 'admin@example.test',
      ],
      {
        runCommand: runCommandWith((argv) =>
          argv.join(' ') === 'nginx -s reload' ? { exitCode: 1, stderr: 'reload refused' } : undefined,
        ),
      },
    );

    expect(exitCodeFor(result.error)).toBe(EXIT.FAILURE);
    expect((result.error as Error).message).toContain('not reloaded');
  });

  it('exits 0 when the renewal validates and reloads successfully', async () => {
    const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-certs-'));
    const root = join(appsRoot, 'demo');
    mkdirSync(root, { recursive: true });
    const proxyRoot = join(appsRoot, 'proxy');
    installedCertRoot(proxyRoot, 'app.example.test');

    const result = await runCerts(
      [
        '--root', root,
        '--proxy-root', proxyRoot,
        '--proxy-mode', 'host',
        '--domain', 'app.example.test',
        '--renew', '--force',
        '--email', 'admin@example.test',
      ],
      { runCommand: runCommandWith(() => undefined) },
    );

    expect(result.error).toBeUndefined();
  });

  it('reuses --proxy-container for the post-renewal validate/reload, not the default', async () => {
    const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-certs-'));
    const root = join(appsRoot, 'demo');
    mkdirSync(root, { recursive: true });
    const proxyRoot = join(appsRoot, 'proxy');
    installedCertRoot(proxyRoot, 'app.example.test');

    const seen: string[][] = [];
    await runCerts(
      [
        '--root', root,
        '--proxy-root', proxyRoot,
        '--proxy-mode', 'container',
        '--proxy-container', 'my-proxy',
        '--domain', 'app.example.test',
        '--renew', '--force',
        '--email', 'admin@example.test',
      ],
      {
        runCommand: runCommandWith((argv) => {
          seen.push([...argv]);
          return undefined;
        }),
      },
    );

    expect(seen).toContainEqual(['docker', 'exec', 'my-proxy', 'nginx', '-t']);
    expect(seen).toContainEqual(['docker', 'exec', 'my-proxy', 'nginx', '-s', 'reload']);
  });
});

// ---------------------------------------------------------------------------
// Proxy-runtime flags are validated as UsageErrors, before anything runs
// (issue #389)
// ---------------------------------------------------------------------------

describe('--proxy-mode / --proxy-container are validated as usage errors', () => {
  it('rejects an unrecognised --proxy-mode', async () => {
    const result = await runDoctor(['--proxy-mode', 'bogus'], HEALTHY);

    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
    expect((result.error as Error).message).toContain('--proxy-mode');
  });

  it('rejects a --proxy-container value that is not a valid docker container name', async () => {
    const result = await runDoctor(['--proxy-container', 'has spaces'], HEALTHY);

    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
    expect((result.error as Error).message).toContain('container name');
  });

  it('accepts valid values for both and runs normally', async () => {
    const result = await runDoctor(
      ['--proxy-mode', 'container', '--proxy-container', 'proxy-nginx-2'],
      HEALTHY,
    );

    expect(result.error).toBeUndefined();
  });
});

// =============================================================================
// `doctor --repo` (#390): the flag wins over everything else `resolveRepoUrl`
// would otherwise fall back to, and never touches git when it is given.
// =============================================================================
describe('appctl deploy doctor --repo', () => {
  function capturingCheck(seen: Array<{ repoUrl: string | undefined; gitCredentialed: boolean | undefined }>): Check {
    return {
      id: 'capture',
      title: 'capture',
      severity: 'recommended',
      async run(context) {
        seen.push({ repoUrl: context.repoUrl, gitCredentialed: context.gitCredentialed });
        return { status: 'pass', detail: 'ok' };
      },
    };
  }

  it('sets CheckContext.repoUrl from --repo, normalised, without running git', async () => {
    const seen: Array<{ repoUrl: string | undefined; gitCredentialed: boolean | undefined }> = [];

    const result = await runDoctor(['--repo', 'https://example.test/o/r.git'], [capturingCheck(seen)]);

    expect(result.error).toBeUndefined();
    expect(seen).toEqual([{ repoUrl: 'https://example.test/o/r', gitCredentialed: undefined }]);
  });

  it('probes git credential state (via the injected runCommand) for an HTTPS GitHub --repo', async () => {
    const seen: Array<{ repoUrl: string | undefined; gitCredentialed: boolean | undefined }> = [];
    const lsRemoteFails: typeof import('../deploy/executor.js').runCommand = (async (
      argv: readonly string[],
    ) => {
      throw new Error(`${argv[0] ?? ''}: command not found`);
    }) as typeof import('../deploy/executor.js').runCommand;

    const result = await runDoctor(['--repo', 'https://github.com/acme/widgets'], [capturingCheck(seen)], {
      runCommand: lsRemoteFails,
    });

    expect(result.error).toBeUndefined();
    // git ls-remote fails (no real network/process in this test), so the
    // clone is judged unable to authenticate -- exactly the state that
    // promotes gh-installed/gh-authenticated to required.
    expect(seen).toEqual([{ repoUrl: 'https://github.com/acme/widgets', gitCredentialed: false }]);
  });

  it('leaves gitCredentialed unset for a non-HTTPS-GitHub --repo (never probed)', async () => {
    const seen: Array<{ repoUrl: string | undefined; gitCredentialed: boolean | undefined }> = [];

    const result = await runDoctor(['--repo', 'git@github.com:acme/widgets.git'], [capturingCheck(seen)]);

    expect(result.error).toBeUndefined();
    expect(seen).toEqual([{ repoUrl: 'git@github.com:acme/widgets', gitCredentialed: undefined }]);
  });
});

// =============================================================================
// `renderHealth`'s Google sign-in line (#391): reported, but deliberately not
// folded into the healthy/unhealthy verdict -- `status`'s exit code stays "is
// it serving", which is what a monitoring script branches on.
// =============================================================================
describe('renderHealth: the Google sign-in line', () => {
  const BASE: HealthReport = {
    containers: [],
    local: {
      live: { ok: true, status: 200, durationMs: 1 },
      ready: { ok: true, status: 200, durationMs: 1 },
      frontend: { ok: true, status: 200, durationMs: 1 },
    },
    migrations: { known: true, pending: [] },
  };

  it('says nothing about sign-in when the smoke was not run', () => {
    expect(renderHealth(BASE, true, false)).not.toContain('Google sign-in');
  });

  it('reports "ok" for a passing smoke, with no remedy line', () => {
    const report: HealthReport = {
      ...BASE,
      oauth: { status: 'pass', detail: 'google is listed, and sign-in redirects correctly' },
    };

    const rendered = renderHealth(report, true, false);
    expect(rendered).toContain('Google sign-in');
    expect(rendered).toMatch(/Google sign-in\s+ok/);
    expect(rendered).not.toContain('->');
  });

  it('reports FAILED with its remedy for a failing smoke, coloured only when asked', () => {
    const report: HealthReport = {
      ...BASE,
      oauth: {
        status: 'fail',
        detail: 'the running API redirects with client_id is wrong, expected right',
        remedy: 'Recreate the api container so it reads the .env.',
      },
    };

    const plain = renderHealth(report, true, false);
    expect(plain).toContain('FAILED');
    expect(plain).toContain('the running API redirects with');
    expect(plain).toContain('-> Recreate the api container');
    expect(plain).not.toContain(ESC);

    const coloured = renderHealth(report, true, true);
    expect(coloured).toContain(ESC);
  });

  it('reports "unverified" (not FAILED) when the smoke could not be run at all', () => {
    const report: HealthReport = {
      ...BASE,
      oauth: { status: 'warn', detail: 'could not ask /api/auth/providers: connection refused' },
    };

    expect(renderHealth(report, true, false)).toContain('unverified: could not ask');
  });

  it('never affects the healthy/unhealthy verdict passed in -- that is collectHealth/isHealthy\'s call', () => {
    const failingSmoke: HealthReport = {
      ...BASE,
      oauth: { status: 'fail', detail: 'broken' },
    };

    // The verdict is a PARAMETER here, not derived from `report.oauth` -- this
    // just pins that `renderHealth` renders whatever it is told, so a failing
    // smoke cannot silently flip `status`'s exit code on its own.
    expect(renderHealth(failingSmoke, true, false)).toContain('\n  healthy\n');
  });
});

// ---------------------------------------------------------------------------
// `appctl deploy status`: the sign-in smoke end to end, and its exit code
// ---------------------------------------------------------------------------
describe('appctl deploy status: the OAuth smoke (#391)', () => {
  const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
  const CALLBACK = 'https://app.example.test/api/auth/google/callback';

  /** A deployment root with a state file AND an `.env` naming a Google client. */
  function rootWithOAuthEnv(callback = CALLBACK): string {
    const root = installedRoot();
    writeFileSync(
      join(root, '.env'),
      `GOOGLE_CLIENT_ID=${CLIENT_ID}\nGOOGLE_CLIENT_SECRET=irrelevant-here\nGOOGLE_CALLBACK_URL=${callback}\n`,
    );
    return root;
  }

  /** Answers health AND the two sign-in routes the smoke asks. */
  function fetchWithOAuth(options: { redirectClientId?: string; redirectCallback?: string } = {}) {
    return (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/providers')) {
        return new Response(JSON.stringify({ data: { providers: [{ name: 'google', enabled: true }] } }), {
          status: 200,
        });
      }
      if (url.endsWith('/api/auth/google')) {
        const location = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        location.searchParams.set('client_id', options.redirectClientId ?? CLIENT_ID);
        location.searchParams.set('redirect_uri', options.redirectCallback ?? CALLBACK);
        return new Response(null, { status: 302, headers: { location: location.href } });
      }
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
  }

  it('reports the sign-in line as ok when the smoke passes', async () => {
    const root = rootWithOAuthEnv();

    const result = await runStatus(['--root', root], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: fetchWithOAuth(),
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toMatch(/Google sign-in\s+ok/);
  });

  it('includes oauth in --json, and a failing smoke does not change the exit code', async () => {
    const root = rootWithOAuthEnv();

    const result = await runStatus(['--root', root, '--json'], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      // The redirect carries a DIFFERENT client id: the smoke fails.
      fetch: fetchWithOAuth({ redirectClientId: 'someone-else.apps.googleusercontent.com' }),
    });

    // ⚠ THE WHOLE POINT (#391): the smoke is reported, never folded into
    // `healthy` -- `isHealthy` does not read `report.oauth` at all.
    expect(result.error).toBeUndefined();
    const report = JSON.parse(result.stdout) as { healthy: boolean; oauth?: { status: string } };
    expect(report.healthy).toBe(true);
    expect(report.oauth?.status).toBe('fail');
  });

  it('runs no smoke at all, and reports nothing about sign-in, when the .env names no Google client', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root, '--json'], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: fetchWithOAuth(),
    });

    const report = JSON.parse(result.stdout) as { oauth?: unknown };
    expect(report.oauth).toBeUndefined();
  });
});

// =============================================================================
// CLI flags land in the exact InstallOptions/UpdateOptions the pipelines read
// (#391's four new flags: --bootstrap-proxy, --create-database,
// --skip-renewal, --skip-oauth-check). `runInstall`/`runUpdate` are mocked so
// these tests assert on the OPTIONS BUILT, not on a pipeline run.
// =============================================================================
describe('appctl deploy install / update: the #391 flags reach the pipeline options', () => {
  async function runInstallCli(argv: readonly string[]): Promise<InstallOptions> {
    vi.mocked(installModule.runInstall).mockReset();
    vi.mocked(installModule.runInstall).mockResolvedValue({
      deployRoot: '/tmp/x',
      commitSha: 'a'.repeat(40),
      journalPath: '/tmp/x/logs/1.log',
      nextStep: 'Log in.',
    });

    const program = new Command();
    program.exitOverride();
    registerDeployCommand(program, {
      stdout: { write: () => true },
      stderr: { write: () => true },
      isTty: false,
    });

    await program.parseAsync(
      ['deploy', 'install', '--root', '/tmp/appctl-flags-test', '--domain', 'app.example.test', ...argv],
      { from: 'user' },
    );

    return vi.mocked(installModule.runInstall).mock.calls[0]?.[0] as InstallOptions;
  }

  async function runUpdateCli(argv: readonly string[]): Promise<UpdateOptions> {
    vi.mocked(updateModule.runUpdate).mockReset();
    vi.mocked(updateModule.runUpdate).mockResolvedValue({
      changed: false,
      commitSha: 'a'.repeat(40),
      journalPath: '/tmp/x/logs/1.log',
      durationMs: 0,
    });

    const program = new Command();
    program.exitOverride();
    registerDeployCommand(program, {
      stdout: { write: () => true },
      stderr: { write: () => true },
      isTty: false,
    });

    await program.parseAsync(['deploy', 'update', '--root', '/tmp/appctl-flags-test', ...argv], {
      from: 'user',
    });

    return vi.mocked(updateModule.runUpdate).mock.calls[0]?.[0] as UpdateOptions;
  }

  it('--bootstrap-proxy, --create-database, --skip-renewal and --skip-oauth-check all reach install', async () => {
    const options = await runInstallCli([
      '--bootstrap-proxy',
      '--create-database',
      '--skip-renewal',
      '--skip-oauth-check',
    ]);

    expect(options.bootstrapProxy).toBe(true);
    expect(options.createDatabase).toBe(true);
    expect(options.skipRenewal).toBe(true);
    expect(options.skipOAuthCheck).toBe(true);
  });

  it('are absent from install\'s options when not passed, rather than false', async () => {
    const options = await runInstallCli([]);

    expect(options.bootstrapProxy).toBeUndefined();
    expect(options.createDatabase).toBeUndefined();
    expect(options.skipRenewal).toBeUndefined();
    expect(options.skipOAuthCheck).toBeUndefined();
  });

  it('--create-database, --skip-renewal and --skip-oauth-check all reach update', async () => {
    const options = await runUpdateCli(['--create-database', '--skip-renewal', '--skip-oauth-check']);

    expect(options.createDatabase).toBe(true);
    expect(options.skipRenewal).toBe(true);
    expect(options.skipOAuthCheck).toBe(true);
  });

  it('update has no --bootstrap-proxy flag at all: install alone may create shared infrastructure', async () => {
    const program = new Command();
    program.exitOverride();
    registerDeployCommand(program, { stdout: { write: () => true }, stderr: { write: () => true }, isTty: false });

    await expect(
      program.parseAsync(['deploy', 'update', '--root', '/tmp/x', '--bootstrap-proxy'], { from: 'user' }),
    ).rejects.toBeDefined();
  });
});
