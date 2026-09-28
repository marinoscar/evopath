import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import type { CommandResult, RunCommandOptions } from '../deploy/executor.js';
import { DEPLOY_STATE_VERSION, deployStatePath, type DeployState } from '../deploy/state.js';
import { UsageError, EXIT, exitCodeFor } from '../errors.js';
import {
  DeploymentUnhealthyError,
  registerDeployCommand,
  type DeployContext,
} from './deploy.js';

// =============================================================================
// `appctl deploy certs`  (runCertsCommand / renderCerts / CertsCommandOptions)
// =============================================================================
//
// Same seam as every other subcommand in this file: DeployContext injects
// stdout/stderr/runCommand so the table-vs-JSON and stdout-vs-stderr rules can
// be asserted without a real terminal, a real openssl or a real certbot.
// =============================================================================

interface RunResult {
  stdout: string;
  stderr: string;
  error: unknown;
}

async function runCerts(
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
    await program.parseAsync(['deploy', 'certs', ...argv], { from: 'user' });
  } catch (caught) {
    error = caught;
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), error };
}

/** A recorded deployment, with a domain and a proxy root, so `certs` has both. */
function installedRootWithDomain(domain: string, proxyRoot: string): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-certs-'));
  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    domain,
    bindPort: 3535,
    deployRoot: root,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
    proxyRoot,
  };
  writeFileSync(deployStatePath(root), JSON.stringify(state));
  return root;
}

/** Puts a fullchain.pem where `certificateStatus` looks for it. */
function installCert(proxyRoot: string, domain: string): void {
  const dir = join(proxyRoot, 'letsencrypt', 'live', domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fullchain.pem'), '-----BEGIN CERTIFICATE-----\n');
}

/** An openssl stub reporting an expiry this many days from right now. */
function opensslDaysFromNow(days: number): typeof import('../deploy/executor.js').runCommand {
  const notAfter = new Date(Date.now() + days * 86_400_000).toUTCString();
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => ({
    argv: [...argv],
    cwd: options.cwd,
    exitCode: 0,
    stdout: `notAfter=${notAfter}\n`,
    stderr: '',
    durationMs: 1,
    timedOut: false,
  })) as typeof import('../deploy/executor.js').runCommand;
}

describe('appctl deploy certs', () => {
  it('writes JSON to stdout and nothing to stderr under --json', async () => {
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-certs-proxy-'));
    const domain = 'app.example.test';
    const root = installedRootWithDomain(domain, proxyRoot);
    installCert(proxyRoot, domain);

    const result = await runCerts(['--root', root, '--proxy-root', proxyRoot, '--json'], {
      runCommand: opensslDaysFromNow(200),
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as { domain: string; exists: boolean };
    expect(report.domain).toBe(domain);
    expect(report.exists).toBe(true);
  });

  it('writes the table to stderr and nothing to stdout without --json', async () => {
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-certs-proxy-'));
    const domain = 'app.example.test';
    const root = installedRootWithDomain(domain, proxyRoot);
    installCert(proxyRoot, domain);

    const result = await runCerts(['--root', root, '--proxy-root', proxyRoot], {
      runCommand: opensslDaysFromNow(200),
    });

    expect(result.error).toBeUndefined();
    // stdout is reserved for --json, same rule as `doctor`, `status` and `list`.
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Certificate for ${domain}`);
  });

  it('a certificate due for renewal, not renewed, throws DeploymentUnhealthyError (exit 1) so a cron wrapper notices', async () => {
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-certs-proxy-'));
    const domain = 'app.example.test';
    const root = installedRootWithDomain(domain, proxyRoot);
    installCert(proxyRoot, domain);

    // Inside the renewal window, and --renew was not passed.
    const result = await runCerts(['--root', root, '--proxy-root', proxyRoot], {
      runCommand: opensslDaysFromNow(10),
    });

    expect(result.error).toBeInstanceOf(DeploymentUnhealthyError);
    expect(exitCodeFor(result.error)).toBe(EXIT.FAILURE);
    expect(result.stderr).toContain('DUE for renewal');
  });

  it('a current certificate does not throw', async () => {
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-certs-proxy-'));
    const domain = 'app.example.test';
    const root = installedRootWithDomain(domain, proxyRoot);
    installCert(proxyRoot, domain);

    const result = await runCerts(['--root', root, '--proxy-root', proxyRoot], {
      runCommand: opensslDaysFromNow(200),
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('current');
  });

  it('refuses when there is no recorded domain and none was given', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'appctl-certs-nodomain-'));
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-certs-proxy-'));

    const result = await runCerts(['--root', empty, '--proxy-root', proxyRoot], {
      runCommand: opensslDaysFromNow(200),
    });

    expect(result.error).toBeInstanceOf(UsageError);
    expect((result.error as Error).message).toContain('--domain');
  });
});
