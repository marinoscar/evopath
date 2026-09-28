import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  RENEW_WITHIN_DAYS,
  bootstrapProxyRoot,
  certificateExpiry,
  renewCertificate,
  type ProxyTarget,
} from './proxy.js';
import type { CommandResult } from './executor.js';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-proxy-'));
}

function targetIn(proxyRoot: string, domain = 'app.example.com'): ProxyTarget {
  return { domain, bindPort: 3535, proxyRoot };
}

/** Puts a fullchain.pem where `certificateStatus` looks for it. */
function installCert(target: ProxyTarget): void {
  const dir = join(target.proxyRoot, 'letsencrypt', 'live', target.domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fullchain.pem'), '-----BEGIN CERTIFICATE-----\n');
}

function ok(stdout: string): CommandResult {
  return {
    argv: [],
    cwd: '/tmp',
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1,
    timedOut: false,
  };
}

describe('bootstrapProxyRoot', () => {
  it('creates the three directories this deployment writes into', () => {
    const proxyRoot = root();

    const { created } = bootstrapProxyRoot(proxyRoot);

    expect(existsSync(join(proxyRoot, 'nginx', 'conf.d'))).toBe(true);
    expect(existsSync(join(proxyRoot, 'letsencrypt'))).toBe(true);
    expect(existsSync(join(proxyRoot, 'webroot'))).toBe(true);
    expect(created).toHaveLength(3);
  });

  it('is idempotent: a second call creates nothing', () => {
    const proxyRoot = root();
    bootstrapProxyRoot(proxyRoot);

    expect(bootstrapProxyRoot(proxyRoot).created).toEqual([]);
  });

  it('creates directories only -- no nginx config, no certificate, no container', () => {
    const proxyRoot = root();
    bootstrapProxyRoot(proxyRoot);

    // The proxy is shared infrastructure this deployment is a TENANT of. Writing
    // a config or starting anything would be claiming ownership of it.
    expect(readdirSync(join(proxyRoot, 'nginx', 'conf.d'))).toEqual([]);
    expect(readdirSync(join(proxyRoot, 'webroot'))).toEqual([]);
    expect(readdirSync(proxyRoot).sort()).toEqual(['letsencrypt', 'nginx', 'webroot']);
  });

  it('leaves an existing directory\'s contents alone', () => {
    const proxyRoot = root();
    const confd = join(proxyRoot, 'nginx', 'conf.d');
    mkdirSync(confd, { recursive: true });
    writeFileSync(join(confd, 'neighbour.conf'), '# another app');

    bootstrapProxyRoot(proxyRoot);

    expect(readdirSync(confd)).toEqual(['neighbour.conf']);
  });
});

describe('certificateExpiry', () => {
  it('reports a parseable expiry and the days remaining', async () => {
    const proxyRoot = root();
    const target = targetIn(proxyRoot);
    installCert(target);
    const run = vi.fn().mockResolvedValue(ok('notAfter=Mar 1 12:00:00 2027 GMT\n'));

    const expiry = await certificateExpiry(target, {
      runCommand: run as never,
      now: new Date('2027-01-01T12:00:00Z'),
    });

    expect(expiry.exists).toBe(true);
    expect(expiry.notAfter?.toISOString()).toBe('2027-03-01T12:00:00.000Z');
    expect(expiry.daysRemaining).toBe(59);
    expect(expiry.dueForRenewal).toBe(false);
    expect(expiry.problem).toBeUndefined();
  });

  it(`is due at exactly ${String(RENEW_WITHIN_DAYS)} days, and not at one more`, async () => {
    const proxyRoot = root();
    const target = targetIn(proxyRoot);
    installCert(target);
    const run = vi.fn().mockResolvedValue(ok('notAfter=Mar 1 12:00:00 2027 GMT\n'));

    const at = async (now: string) =>
      (await certificateExpiry(target, { runCommand: run as never, now: new Date(now) }))
        .dueForRenewal;

    // 30 days out -> due. 31 days out -> not due.
    expect(await at('2027-01-30T12:00:00Z')).toBe(true);
    expect(await at('2027-01-29T12:00:00Z')).toBe(false);
  });

  it('an UNREADABLE expiry is not "not due": it carries a problem and stays false', async () => {
    // ⚠ The rule this pins. Silently treating an unparseable certificate as
    // healthy is how one quietly expires -- the caller must surface `problem`
    // rather than reading `dueForRenewal: false` as "all is well".
    const proxyRoot = root();
    const target = targetIn(proxyRoot);
    installCert(target);
    const run = vi.fn().mockResolvedValue(ok('some other openssl output\n'));

    const expiry = await certificateExpiry(target, { runCommand: run as never });

    expect(expiry.exists).toBe(true);
    expect(expiry.dueForRenewal).toBe(false);
    expect(expiry.problem).toMatch(/unrecognised expiry/i);
    expect(expiry.notAfter).toBeNull();
  });

  it('reports a problem when openssl itself fails', async () => {
    const proxyRoot = root();
    const target = targetIn(proxyRoot);
    installCert(target);
    const run = vi.fn().mockRejectedValue(new Error('openssl: not found'));

    const expiry = await certificateExpiry(target, { runCommand: run as never });

    expect(expiry.problem).toMatch(/openssl: not found/);
    expect(expiry.dueForRenewal).toBe(false);
  });

  it('a missing certificate is absent, not a problem', async () => {
    const target = targetIn(root());
    const run = vi.fn();

    const expiry = await certificateExpiry(target, { runCommand: run as never });

    expect(expiry.exists).toBe(false);
    expect(expiry.problem).toBeUndefined();
    // Nothing to read, so nothing was spawned.
    expect(run).not.toHaveBeenCalled();
  });
});

describe('renewCertificate', () => {
  /** True when certbot was spawned at all. */
  const spawnedCertbot = (run: ReturnType<typeof vi.fn>): boolean =>
    run.mock.calls.some((call) => (call[0] as string[])[0] === 'certbot');

  it('does NOT spend an issuance when the certificate is not due', async () => {
    // Let's Encrypt allows 5 DUPLICATE certificates per week. A command that
    // re-issued on every invocation would exhaust that during one debugging
    // session, leaving the deployment unable to get a certificate at the moment
    // it most needs one.
    const proxyRoot = root();
    const target = targetIn(proxyRoot);
    installCert(target);
    const run = vi.fn().mockResolvedValue(ok('notAfter=Mar 1 12:00:00 2027 GMT\n'));

    const result = await renewCertificate(target, {
      runCommand: run as never,
      email: 'ops@example.com',
      now: new Date('2027-01-01T12:00:00Z'),
    });

    expect(result.renewed).toBe(false);
    expect(result.reason).toMatch(/not due/);
    expect(spawnedCertbot(run)).toBe(false);
  });

  it('does NOT spend an issuance when the expiry is unreadable', async () => {
    const proxyRoot = root();
    const target = targetIn(proxyRoot);
    installCert(target);
    const run = vi.fn().mockResolvedValue(ok('gibberish\n'));

    const result = await renewCertificate(target, {
      runCommand: run as never,
      email: 'ops@example.com',
    });

    expect(result.renewed).toBe(false);
    expect(spawnedCertbot(run)).toBe(false);
    // ⚠ Asserting the REASON, not just the refusal. Without the dedicated
    // unreadable-expiry guard the run still declines -- but via the
    // `dueForRenewal` check, reporting "not due", which is a claim the CLI
    // cannot actually support: it does not know when this certificate expires.
    // An operator told "not due" stops looking. This assertion is the only
    // thing that distinguishes the two paths.
    expect(result.reason).toMatch(/unrecognised expiry/i);
    expect(result.reason).not.toMatch(/not due/i);
  });

  it('does NOT spend an issuance when no certificate is installed', async () => {
    const run = vi.fn();

    const result = await renewCertificate(targetIn(root()), {
      runCommand: run as never,
      email: 'ops@example.com',
    });

    expect(result.renewed).toBe(false);
    expect(result.reason).toMatch(/no certificate/i);
    expect(spawnedCertbot(run)).toBe(false);
  });

  it('renews with --force-renewal when the certificate IS due', async () => {
    const proxyRoot = root();
    const target = targetIn(proxyRoot);
    installCert(target);
    const run = vi.fn().mockResolvedValue(ok('notAfter=Mar 1 12:00:00 2027 GMT\n'));

    const result = await renewCertificate(target, {
      runCommand: run as never,
      email: 'ops@example.com',
      now: new Date('2027-02-20T12:00:00Z'),
    });

    expect(result.renewed).toBe(true);
    const certbot = run.mock.calls.find((call) => (call[0] as string[])[0] === 'certbot');
    expect(certbot?.[0]).toContain('--force-renewal');
    expect(certbot?.[0]).toContain('app.example.com');
  });

  it('--force renews a certificate that is not due, deliberately', async () => {
    const proxyRoot = root();
    const target = targetIn(proxyRoot);
    installCert(target);
    const run = vi.fn().mockResolvedValue(ok('notAfter=Mar 1 12:00:00 2027 GMT\n'));

    const result = await renewCertificate(target, {
      runCommand: run as never,
      email: 'ops@example.com',
      force: true,
      now: new Date('2027-01-01T12:00:00Z'),
    });

    expect(result.renewed).toBe(true);
    expect(spawnedCertbot(run)).toBe(true);
  });

  it('passes --staging through when asked', async () => {
    const proxyRoot = root();
    const target = targetIn(proxyRoot);
    installCert(target);
    const run = vi.fn().mockResolvedValue(ok('notAfter=Mar 1 12:00:00 2027 GMT\n'));

    await renewCertificate(target, {
      runCommand: run as never,
      email: 'ops@example.com',
      force: true,
      staging: true,
    });

    const certbot = run.mock.calls.find((call) => (call[0] as string[])[0] === 'certbot');
    expect(certbot?.[0]).toContain('--staging');
  });

  // ===========================================================================
  // The reload is load-bearing: a renewed certificate on disk is NOT a served
  // one until the proxy reloads it. See renewCertificate's own header comment.
  // ===========================================================================
  describe('validating and reloading after a renewal', () => {
    /** Every call after certbot answers `ok()`, unless overridden. */
    function runWith(
      after: (argv: readonly string[]) => ReturnType<typeof ok> | { exitCode: number; stderr?: string } | undefined,
    ): ReturnType<typeof vi.fn> {
      return vi.fn().mockImplementation(async (argv: readonly string[]) => {
        if (argv[0] === 'certbot') return ok('notAfter=Mar 1 12:00:00 2027 GMT\n');
        if (argv[0] === 'openssl') return ok('notAfter=Jun 1 12:00:00 2027 GMT\n');
        const overridden = after(argv);
        if (overridden === undefined) return ok('');
        if ('exitCode' in overridden && overridden.exitCode !== 0) {
          const error = new Error(overridden.stderr ?? 'failed');
          (error as { result?: unknown }).result = { stdout: '', stderr: overridden.stderr ?? '' };
          throw error;
        }
        return overridden;
      });
    }

    it('validates then reloads on success: renewed and reloaded both true', async () => {
      const proxyRoot = root();
      const target = targetIn(proxyRoot);
      installCert(target);
      const run = runWith(() => undefined);

      const result = await renewCertificate(target, {
        runCommand: run as never,
        email: 'ops@example.com',
        force: true,
      });

      expect(result.renewed).toBe(true);
      expect(result.reloaded).toBe(true);
      expect(result.reason).toMatch(/renewed and the proxy reloaded/);

      const calls = run.mock.calls.map((call) => (call[0] as string[]).join(' '));
      expect(calls).toContain('nginx -t');
      expect(calls).toContain('nginx -s reload');
      // Validated BEFORE reloading, so a neighbour's broken vhost cannot be
      // turned into a failed reload for every site on the box.
      expect(calls.indexOf('nginx -t')).toBeLessThan(calls.indexOf('nginx -s reload'));
    });

    it('renewed but NOT reloaded when nginx -t fails after the renewal', async () => {
      const proxyRoot = root();
      const target = targetIn(proxyRoot);
      installCert(target);
      const run = runWith((argv) =>
        argv.join(' ') === 'nginx -t' ? { exitCode: 1, stderr: 'nginx: [emerg] bad vhost' } : undefined,
      );

      const result = await renewCertificate(target, {
        runCommand: run as never,
        email: 'ops@example.com',
        force: true,
      });

      expect(result.renewed).toBe(true);
      expect(result.reloaded).toBe(false);
      expect(result.reason).toMatch(/NOT reloaded/);
      expect(result.reason).toContain('bad vhost');

      // Never reloads what did not validate.
      expect(run.mock.calls.map((call) => (call[0] as string[]).join(' '))).not.toContain(
        'nginx -s reload',
      );
    });

    it('renewed but NOT reloaded when the reload itself fails', async () => {
      const proxyRoot = root();
      const target = targetIn(proxyRoot);
      installCert(target);
      const run = runWith((argv) =>
        argv.join(' ') === 'nginx -s reload' ? { exitCode: 1, stderr: 'reload refused' } : undefined,
      );

      const result = await renewCertificate(target, {
        runCommand: run as never,
        email: 'ops@example.com',
        force: true,
      });

      expect(result.renewed).toBe(true);
      expect(result.reloaded).toBe(false);
      expect(result.reason).toMatch(/reload failed/);
    });

    it('uses the given runtime for validate/reload -- docker exec under a container runtime', async () => {
      const proxyRoot = root();
      const target = targetIn(proxyRoot);
      installCert(target);
      const run = runWith(() => undefined);

      await renewCertificate(target, {
        runCommand: run as never,
        email: 'ops@example.com',
        force: true,
        runtime: { mode: 'container', container: 'infra-proxy-1', certRoot: '/etc/letsencrypt', webroot: '/var/www/certbot' },
      });

      const calls = run.mock.calls.map((call) => (call[0] as string[]).join(' '));
      expect(calls).toContain('docker exec infra-proxy-1 nginx -t');
      expect(calls).toContain('docker exec infra-proxy-1 nginx -s reload');
    });
  });
});
