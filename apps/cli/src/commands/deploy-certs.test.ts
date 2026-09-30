import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import type { CommandResult, RunCommandOptions } from '../deploy/executor.js';
import { DEFAULT_PROXY_CONTAINER, describeReloadCommand } from '../deploy/proxy.js';
import { DEPLOY_STATE_VERSION, deployStatePath, type DeployState } from '../deploy/state.js';
import { UsageError, EXIT, exitCodeFor } from '../errors.js';
import {
  DeploymentUnhealthyError,
  registerDeployCommand,
  renderCerts,
  type DeployContext,
} from './deploy.js';

// =============================================================================
// `evopathcli deploy certs`  (runCertsCommand / renderCerts / CertsCommandOptions)
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
  const root = mkdtempSync(join(tmpdir(), 'evopathcli-certs-'));
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

// =============================================================================
// certificateServedMatchesDisk, wired into `deploy certs` unconditionally
// (issue #205). Real fixture certificates -- see proxy.test.ts's own copy of
// these constants for how they were generated (`openssl req -x509 ... -subj
// "/CN=test-a"` / "/CN=test-b"): X509Certificate needs real, parseable
// DER/PEM, which cannot be fabricated by hand.
// =============================================================================

const CERT_A = `-----BEGIN CERTIFICATE-----
MIIDAzCCAeugAwIBAgIUQl3s/TajaCF+hNqOhCYG8bFOTy0wDQYJKoZIhvcNAQEL
BQAwETEPMA0GA1UEAwwGdGVzdC1hMB4XDTI2MDkzMDIzMDk0MloXDTM2MDkyNzIz
MDk0MlowETEPMA0GA1UEAwwGdGVzdC1hMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A
MIIBCgKCAQEAuVkysGXIf48aRt+AiXPLlyJaZoFa/EMTbxMg3H2N/RypqKm7WLa3
zrYxBxI30Pa00dF3kTT6FV5R32GgJFWaENxlY8r/tprpx2QDSRm44yPemzJAr5bA
79le+zQIOaL1+a5GNgmhpf5LllZ9P8s300BHyKj3HvUNJl5esBywEc+uvPlKaLCU
5vuU/WwTZyDUU9jAzM4j5BBKj94NVo+Wb7c+SbGI1eQ/XnP4I5AVuTUa3PAjuUYh
mqWRQa9c3r/klz+lXz7Ew5iutUNEnC5Rrpe6+Vfeybw+kCIKERfuJFoocjJFIX7T
+vIj+v2fQACnbb36v9C2wmtyzF0ip01IzQIDAQABo1MwUTAdBgNVHQ4EFgQUp2os
5LUbM9tRE+YpYkkddQERxyQwHwYDVR0jBBgwFoAUp2os5LUbM9tRE+YpYkkddQER
xyQwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEADdFwZ5Kmr1Ur
IVaZzmFc8OuL6kdpBsj7SN+6+DN+xaPXSrK6mi2MhpQ//hKrn6Dkn4wllwd9elpJ
roPCL1KEZTxY0+5qBP16GBKsPbc/P7A3iDyAjhhu9qajxIJXbqNR7sCuLX5DUWUh
w9l9+mJqGXkePORExJ8XuJSGztEsms88hsdDNEfiFnxmVdzDzw0C22wY0h0nD6vb
5z3Z63DrHXQIKzicghzI5m8Um2X64Rmrx8wMw318EI5f8xk1DHAkO3bsvLQG7vIA
hCDXV1pLYncAA9C79QfQUZfus+2zxz+cFhl96WsKrbbuLJQfjeihsVUfOdHf7XOV
CSBzweNCtw==
-----END CERTIFICATE-----
`;

const CERT_B = `-----BEGIN CERTIFICATE-----
MIIDAzCCAeugAwIBAgIUVzbxdztP65NfeCHLN/HkF6VOWqYwDQYJKoZIhvcNAQEL
BQAwETEPMA0GA1UEAwwGdGVzdC1iMB4XDTI2MDkzMDIzMDk0MloXDTM2MDkyNzIz
MDk0MlowETEPMA0GA1UEAwwGdGVzdC1iMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A
MIIBCgKCAQEAjAYREni3yTVCWT+m02zvW3gHDs/Ctob8n4mb7SJFBE0C5H5Ccz2c
55IxdXLzGnybfgU2MIHH52UtjpSou/ly2hdnunD02BjT12eVAL0IDBg7t3vqPc4V
hdPBSfvCHIbLQyfc5NUgHCuS3RjsySGoBYfn5sWn2SN/YFrFFFKrYaKioztsT6tZ
XnA24mKJiWJZg9JpswpzTz8q/6SszhaMA//nQKjdb+OXHn1/NoC8Bqx3hoEwEga0
zOKnYiKBCQrYIcC0Y+l/RMS1XJxTEMMoo13maeZpjskeacOoNH0C9K26Gv426YIr
ru37bWiuyNcNOU7NQo9HMEqkxJxmfGxZvQIDAQABo1MwUTAdBgNVHQ4EFgQU84Yn
gERGYL4q8394FqoPNLBqitcwHwYDVR0jBBgwFoAU84YngERGYL4q8394FqoPNLBq
itcwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAfXZVSMzZzXYl
wA5sfJ6UyTocXNY8FTvi1Nxfk7bbDDPQg4RZUPjy/Lbe3S1T3uFKEUe+5X6zhLLh
3l+akFLYO2jiP6oxKtKFtt+Gk34+tJ+pk8rIsvGncItZ7lPebN8F33SuUGNzwNIF
vtKVulDTnI/aN58dI6jhIOIbo0VhIm+R1/zMoFAvemzEBZkrpVy1EzZox13aN0hs
8MX1+PnLtEbM8gLkfnfZPpz8+eYiPoPL0Sq+UAmCy+PCXenJauBMIYnzKjXl8w50
+FChWtMv4PyxUcPR3/lPvKZRHa+WrnmWv4E1ZXN1kqdkB96CZ1bca/5ZbVsQaFBZ
ud8V2TuBRQ==
-----END CERTIFICATE-----
`;

/** Puts a REAL, parseable certificate where `certificateStatus` looks for it. */
function installRealCert(proxyRoot: string, domain: string, pem: string): void {
  const dir = join(proxyRoot, 'letsencrypt', 'live', domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fullchain.pem'), pem);
}

/**
 * Answers `openssl x509 -enddate` (certificateExpiry) with a current expiry
 * and `openssl s_client` (certificateServedMatchesDisk) with the given
 * transcript. Also answers `docker inspect`/`nginx -v` (proxy-runtime
 * detection) with a bare success, so resolution falls through to its
 * documented default: container mode, DEFAULT_PROXY_CONTAINER.
 */
function fakeDeploymentRunCommand(sClientStdout: string): typeof import('../deploy/executor.js').runCommand {
  const notAfter = new Date(Date.now() + 200 * 86_400_000).toUTCString();
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const isSClient = argv[0] === 'openssl' && argv[1] === 's_client';
    return {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: 0,
      stdout: isSClient ? sClientStdout : `notAfter=${notAfter}\n`,
      stderr: '',
      durationMs: 1,
      timedOut: false,
    };
  }) as typeof import('../deploy/executor.js').runCommand;
}

/** A realistic `openssl s_client` transcript wrapping the given PEM block. */
function sClientOutput(pem: string): string {
  return `CONNECTED(00000003)\n---\nCertificate chain\n 0 s:CN = test\n${pem}---\nNo client certificate CA names sent\n---\n`;
}

describe('evopathcli deploy certs', () => {
  it('writes JSON to stdout and nothing to stderr under --json', async () => {
    const proxyRoot = mkdtempSync(join(tmpdir(), 'evopathcli-certs-proxy-'));
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
    const proxyRoot = mkdtempSync(join(tmpdir(), 'evopathcli-certs-proxy-'));
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
    const proxyRoot = mkdtempSync(join(tmpdir(), 'evopathcli-certs-proxy-'));
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
    const proxyRoot = mkdtempSync(join(tmpdir(), 'evopathcli-certs-proxy-'));
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
    const empty = mkdtempSync(join(tmpdir(), 'evopathcli-certs-nodomain-'));
    const proxyRoot = mkdtempSync(join(tmpdir(), 'evopathcli-certs-proxy-'));

    const result = await runCerts(['--root', empty, '--proxy-root', proxyRoot], {
      runCommand: opensslDaysFromNow(200),
    });

    expect(result.error).toBeInstanceOf(UsageError);
    expect((result.error as Error).message).toContain('--domain');
  });

  // ===========================================================================
  // Served-vs-disk (issue #205): report-only calls (no --renew) are the
  // ordinary "is this actually working" path, and they now always compare the
  // proxy's LIVE certificate against the one on disk, not only the file.
  // ===========================================================================

  it('report-only: a matching served certificate does not throw, and JSON carries served: matches', async () => {
    const proxyRoot = mkdtempSync(join(tmpdir(), 'evopathcli-certs-proxy-'));
    const domain = 'app.example.test';
    const root = installedRootWithDomain(domain, proxyRoot);
    installRealCert(proxyRoot, domain, CERT_A);

    const result = await runCerts(['--root', root, '--proxy-root', proxyRoot, '--json'], {
      runCommand: fakeDeploymentRunCommand(sClientOutput(CERT_A)),
    });

    expect(result.error).toBeUndefined();
    const report = JSON.parse(result.stdout) as {
      served: { checked: boolean; matches: boolean; diskIssuer: string; servedIssuer: string };
    };
    expect(report.served).toMatchObject({ checked: true, matches: true });
    expect(report.served.diskIssuer).toBe(report.served.servedIssuer);
  });

  it('report-only: a matching served certificate prints "matches disk" in the table too', async () => {
    const proxyRoot = mkdtempSync(join(tmpdir(), 'evopathcli-certs-proxy-'));
    const domain = 'app.example.test';
    const root = installedRootWithDomain(domain, proxyRoot);
    installRealCert(proxyRoot, domain, CERT_A);

    const result = await runCerts(['--root', root, '--proxy-root', proxyRoot], {
      runCommand: fakeDeploymentRunCommand(sClientOutput(CERT_A)),
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('served     matches disk');
  });

  it('report-only: a served certificate that does not match disk throws DeploymentUnhealthyError naming both issuers and the remedy', async () => {
    const proxyRoot = mkdtempSync(join(tmpdir(), 'evopathcli-certs-proxy-'));
    const domain = 'app.example.test';
    const root = installedRootWithDomain(domain, proxyRoot);
    installRealCert(proxyRoot, domain, CERT_A);

    const result = await runCerts(['--root', root, '--proxy-root', proxyRoot], {
      runCommand: fakeDeploymentRunCommand(sClientOutput(CERT_B)),
    });

    expect(result.error).toBeInstanceOf(DeploymentUnhealthyError);
    const message = (result.error as Error).message;
    expect(message).toContain('CN=test-b'); // served
    expect(message).toContain('CN=test-a'); // disk
    // No --proxy-mode/--proxy-container flag was given, and `fakeDeploymentRunCommand`
    // answers `docker inspect` with a bare success, so resolution falls
    // through to its documented default: container mode, the default
    // container name -- exactly what `describeReloadCommand` must be given to
    // match.
    expect(message).toContain(
      describeReloadCommand({ mode: 'container', container: DEFAULT_PROXY_CONTAINER }),
    );
    expect(result.stderr).toContain('served     DOES NOT MATCH disk');
  });
});

describe('renderCerts: the served/runtime lines (issue #205)', () => {
  const domain = 'app.example.test';
  const baseReport = {
    exists: true,
    path: '/opt/infra/proxy/letsencrypt/live/app.example.test/fullchain.pem',
    notAfter: new Date('2027-01-01T00:00:00.000Z'),
    daysRemaining: 90,
    dueForRenewal: false,
    renewed: false,
    reason: 'reported only; pass --renew to act',
  };

  it('renders exactly as before when `served` is omitted entirely', () => {
    const rendered = renderCerts(domain, baseReport);

    expect(rendered).not.toContain('served');
    expect(rendered).not.toContain('remedy');
  });

  it('prints a served line, and no remedy, when the certificate matches', () => {
    const rendered = renderCerts(domain, baseReport, {
      checked: true,
      matches: true,
      diskIssuer: 'CN=test-a',
      servedIssuer: 'CN=test-a',
    });

    expect(rendered).toContain('served     matches disk');
    expect(rendered).not.toContain('DOES NOT MATCH');
    expect(rendered).not.toContain('remedy');
  });

  it('prints both issuers and a remedy line when the certificate does not match and a runtime is given', () => {
    const rendered = renderCerts(
      domain,
      baseReport,
      { checked: true, matches: false, diskIssuer: 'CN=test-a', servedIssuer: 'CN=test-b' },
      { mode: 'container', container: 'infra-proxy-1' },
    );

    expect(rendered).toContain('served     DOES NOT MATCH disk');
    expect(rendered).toContain('served: CN=test-b');
    expect(rendered).toContain('disk:   CN=test-a');
    expect(rendered).toContain('remedy     sudo docker exec infra-proxy-1 nginx -s reload');
  });

  it('omits the remedy line on a mismatch when no runtime is given', () => {
    const rendered = renderCerts(domain, baseReport, {
      checked: true,
      matches: false,
      diskIssuer: 'CN=test-a',
      servedIssuer: 'CN=test-b',
    });

    expect(rendered).toContain('DOES NOT MATCH disk');
    expect(rendered).not.toContain('remedy');
  });

  it('stays silent about served when nothing could be compared (checked: false)', () => {
    const rendered = renderCerts(domain, baseReport, { checked: false });

    expect(rendered).not.toContain('served');
    expect(rendered).not.toContain('remedy');
  });
});
