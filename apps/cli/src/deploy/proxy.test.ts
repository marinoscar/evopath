import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions } from './executor.js';
import {
  APK_UPLOAD_MIN_BODY_MB,
  assertValidContainerName,
  assertValidDomain,
  certbotArgv,
  certificateServedMatchesDisk,
  certificateStatus,
  CONTAINER_CERT_ROOT,
  CONTAINER_WEBROOT,
  DEFAULT_PROXY_CONTAINER,
  describeReloadCommand,
  installVhost,
  issueCertificate,
  parseProxyMode,
  proxyRuntimeFor,
  reloadProxy,
  removeVhost,
  renderVhost,
  resolveProxyRuntime,
  resolveRecordedProxyRuntime,
  validateProxy,
  vhostPath,
  type ProxyTarget,
} from './proxy.js';

type Canned = { exitCode: number; stdout?: string; stderr?: string };

function fakeRunCommand(
  respond: (argv: readonly string[]) => Canned | undefined,
  log?: string[][],
): typeof import('./executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    log?.push([...argv]);
    const canned = respond(argv) ?? { exitCode: 0 };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) throw new CommandFailedError(result.stderr || 'failed', result);
    return result;
  }) as typeof import('./executor.js').runCommand;
}

function makeProxyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'evopathcli-proxy-'));
  mkdirSync(join(root, 'nginx', 'conf.d'), { recursive: true });
  mkdirSync(join(root, 'webroot'), { recursive: true });
  return root;
}

function target(proxyRoot: string): ProxyTarget {
  return { domain: 'app.example.test', bindPort: 3535, proxyRoot };
}

describe('assertValidDomain', () => {
  it('accepts a normal hostname', () => {
    expect(() => assertValidDomain('app.example.test')).not.toThrow();
  });

  it.each([
    'has spaces.example',
    'semi;colon.example',
    'new\nline.example',
    '../escape',
    '-leading-hyphen.example',
    '',
  ])('rejects %j before it reaches a config file', (domain) => {
    // Not a shell, but a newline in a domain would let a vhost be extended
    // with arbitrary directives - the same class of problem.
    expect(() => assertValidDomain(domain)).toThrow(UsageError);
  });
});

describe('renderVhost', () => {
  const root = makeProxyRoot();
  const runtime = proxyRuntimeFor('host', root);
  const rendered = renderVhost(target(root), runtime);

  it('redirects HTTP to HTTPS', () => {
    expect(rendered).toContain('return 301 https://$host$request_uri;');
  });

  it('keeps the ACME challenge on HTTP so renewal keeps working', () => {
    const acme = rendered.indexOf('/.well-known/acme-challenge/');
    const redirect = rendered.indexOf('return 301');

    expect(acme).toBeGreaterThan(-1);
    // It must come BEFORE the catch-all redirect, or renewal 301s away.
    expect(acme).toBeLessThan(redirect);
  });

  it('proxies to the loopback port', () => {
    expect(rendered).toContain('proxy_pass http://127.0.0.1:3535;');
  });

  it('sets X-Forwarded-Proto to https, not $scheme', () => {
    // The application forwards $scheme onward, so this is the value it
    // ultimately sees; $scheme here would make it build http:// URLs and the
    // OAuth login redirect would loop.
    expect(rendered).toContain('proxy_set_header X-Forwarded-Proto https;');
  });

  it('adds no headers of its own', () => {
    // nginx's add_header REPLACES the inherited set, so any header here would
    // silently delete the application's CSP and HSTS.
    expect(rendered).not.toContain('add_header');
  });

  it('gives the SSE endpoint its own unbuffered block', () => {
    expect(rendered).toContain('/api/notifications/stream');
    expect(rendered).toContain('proxy_buffering off;');
    expect(rendered).toContain('proxy_read_timeout 1h;');
  });

  it('gives the AI response stream its own unbuffered block', () => {
    const block = rendered.slice(rendered.indexOf('location /api/ai/responses/stream'));
    expect(block).toContain('proxy_pass http://127.0.0.1:3535;');
    expect(block).toContain('proxy_buffering off;');
    expect(block).toContain('proxy_read_timeout 600s;');
    expect(block).toContain("proxy_set_header Connection        '';");
  });

  it('gives the telemetry assistant stream its own unbuffered block', () => {
    const block = rendered.slice(rendered.indexOf('location /api/admin/telemetry/assistant/stream'));
    expect(rendered).toContain('location /api/admin/telemetry/assistant/stream {');
    expect(block).toContain('proxy_pass http://127.0.0.1:3535;');
    expect(block).toContain('proxy_buffering off;');
    expect(block).toContain('proxy_read_timeout 600s;');
    expect(block).toContain("proxy_set_header Connection        '';");
  });

  it('gives the AI Coach chat stream its own unbuffered block (E7.7)', () => {
    const start = rendered.indexOf('location /api/coach/chat/stream {');
    expect(start).toBeGreaterThan(-1);
    // Only this block's body, up to its closing brace.
    const block = rendered.slice(start, rendered.indexOf('}', start));
    expect(block).toContain('proxy_pass http://127.0.0.1:3535;');
    expect(block).toContain('proxy_http_version 1.1;');
    expect(block).toContain('proxy_buffering off;');
    expect(block).toContain('proxy_cache off;');
    expect(block).toContain('chunked_transfer_encoding off;');
    expect(block).toContain('proxy_read_timeout 600s;');
    expect(block).toContain('proxy_send_timeout 600s;');
    expect(block).toContain("proxy_set_header Connection        '';");
  });

  it('gives the training run stream its own unbuffered block', () => {
    const block = rendered.slice(rendered.indexOf('location /api/ai/training/stream {'));
    expect(rendered).toContain('location /api/ai/training/stream {');
    // Regression for #194: this line was `proxy_pass http://127.0.0.1:\${target.bindPort};`
    // in the template - the escaped `$` meant nginx received the literal text
    // `${target.bindPort}` instead of a port number and refused to start.
    expect(block).toContain('proxy_pass http://127.0.0.1:3535;');
    expect(block).toContain('proxy_buffering off;');
    expect(block).toContain('proxy_cache off;');
    expect(block).toContain('chunked_transfer_encoding off;');
    expect(block).toContain('proxy_read_timeout 600s;');
    expect(block).toContain('proxy_send_timeout 600s;');
    expect(block).toContain("proxy_set_header Connection        '';");
  });

  it('never leaks an unresolved template-literal placeholder into the rendered config', () => {
    // A stray backslash before a `${...}` interpolation in the template (like
    // the #194 bug above) survives as literal `${...}` text in the output,
    // which nginx's config parser then chokes on. Catch that failure mode
    // regardless of which block it recurs in.
    expect(rendered).not.toMatch(/\$\{/);
  });

  it('is deterministic, so a re-run produces no spurious diff', () => {
    expect(renderVhost(target(root), runtime)).toBe(rendered);
  });

  it('sizes client_max_body_size from the configured upload limit', () => {
    const sized = renderVhost(target(root), runtime, { maxBodyBytes: 10 * 1024 * 1024 });
    expect(sized).toContain('client_max_body_size 10m;');
  });

  /** One location block's body, from its opening line up to its closing brace. */
  function blockOf(config: string, opener: string): string {
    const start = config.indexOf(opener);
    expect(start).toBeGreaterThan(-1);
    return config.slice(start, config.indexOf('}', start));
  }

  it('streams the APK release upload with its own body limit and timeouts (#285)', () => {
    const block = blockOf(rendered, 'location = /api/admin/android-app/releases {');
    expect(block).toContain('proxy_pass http://127.0.0.1:3535;');
    expect(block).toContain('proxy_set_header X-Forwarded-Proto https;');
    expect(block).toContain('client_max_body_size 160m;');
    expect(block).toContain('proxy_request_buffering off;');
    expect(block).toMatch(/proxy_send_timeout\s+600s;/);
    expect(block).toMatch(/proxy_read_timeout\s+600s;/);
    // The server-wide default stays matched to MAX_FILE_SIZE.
    expect(rendered).toContain('    client_max_body_size 100m;');
  });

  it('proxies the APK download unbuffered with a ten-minute read timeout (#285)', () => {
    const block = blockOf(rendered, 'location /api/android-app/download/ {');
    expect(block).toContain('proxy_pass http://127.0.0.1:3535;');
    expect(block).toContain('proxy_buffering off;');
    expect(block).toMatch(/proxy_read_timeout\s+600s;/);
  });

  it.each([
    [5 * 1024 * 1024, '5m', '160m'],
    [160 * 1024 * 1024, '160m', '160m'],
    [500 * 1024 * 1024, '500m', '500m'],
  ])(
    'never sets the APK upload cap below the server-wide cap (MAX_FILE_SIZE %d)',
    (bytes, serverWide, upload) => {
      const sized = renderVhost(target(root), runtime, { maxBodyBytes: bytes });
      expect(sized).toContain(`    client_max_body_size ${serverWide};`);
      const block = blockOf(sized, 'location = /api/admin/android-app/releases {');
      expect(block).toContain(`client_max_body_size ${upload};`);
      const uploadMb = Number(/client_max_body_size (\d+)m;/.exec(block)?.[1]);
      expect(uploadMb).toBeGreaterThanOrEqual(Number.parseInt(serverWide, 10));
      expect(uploadMb).toBeGreaterThanOrEqual(APK_UPLOAD_MIN_BODY_MB);
    },
  );

  it('refuses a hostile domain', () => {
    expect(() => renderVhost({ ...target(root), domain: 'a b;c' }, runtime)).toThrow(UsageError);
  });
});

describe('installVhost', () => {
  it('writes, validates and reloads, in that order', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    const result = await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
    });

    expect(existsSync(result.path)).toBe(true);
    expect(calls.map((argv) => argv.join(' '))).toEqual(['nginx -t', 'nginx -s reload']);
  });

  it('reloads rather than restarts', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
    });

    // A restart drops connections for every other application on the box.
    expect(calls.flat()).not.toContain('restart');
  });

  it('does nothing when the vhost is already byte-identical', async () => {
    const root = makeProxyRoot();
    const options = { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) };

    await installVhost(target(root), options);
    const calls: string[][] = [];
    const second = await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
    });

    expect(second.changed).toBe(false);
    expect(calls).toEqual([]);
  });

  // ===========================================================================
  // issue #199: nginx caches a certificate's bytes in memory from the load or
  // reload that read it; it never notices the file underneath an
  // `ssl_certificate` directive changing on disk. A same-domain certificate
  // reissuance never changes the vhost TEXT (it only ever pointed at a fixed
  // path), so the "already current" fast path above must still reload when
  // told to -- otherwise a freshly reissued certificate sits on disk, unserved,
  // forever.
  // ===========================================================================
  it('reloads anyway when forceReload is set, even though the vhost is byte-identical', async () => {
    const root = makeProxyRoot();
    await installVhost(target(root), { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) });

    const calls: string[][] = [];
    const second = await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      forceReload: true,
    });

    expect(second.changed).toBe(false);
    expect(calls.map((argv) => argv.join(' '))).toEqual(['nginx -s reload']);
  });

  it('does NOT reload when forceReload is false and the vhost is byte-identical', async () => {
    const root = makeProxyRoot();
    await installVhost(target(root), { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) });

    const calls: string[][] = [];
    const second = await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      forceReload: false,
    });

    expect(second.changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('removes the new vhost and re-validates when nginx -t fails', async () => {
    const root = makeProxyRoot();
    let validations = 0;

    const error = await installVhost(target(root), {
      runCommand: fakeRunCommand((argv) => {
        if (argv.join(' ') === 'nginx -t') {
          validations += 1;
          // Fails while the new vhost is present, passes once it is gone.
          return validations === 1
            ? { exitCode: 1, stderr: 'nginx: [emerg] invalid parameter' }
            : { exitCode: 0 };
        }
        return { exitCode: 0 };
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('invalid parameter');
    expect((error as Error).message).toContain('restored');
    // The proxy must be left exactly as it was found.
    expect(existsSync(vhostPath(target(root)))).toBe(false);
  });

  it('restores the previous contents when it overwrote one', async () => {
    const root = makeProxyRoot();
    const path = vhostPath(target(root));
    const previous = '# Managed by appctl deploy\n# an older version\n';
    writeFileSync(path, previous);

    await installVhost(target(root), {
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ') === 'nginx -t' ? { exitCode: 1, stderr: 'nope' } : { exitCode: 0 },
      ),
    }).catch(() => undefined);

    expect(readFileSync(path, 'utf8')).toBe(previous);
  });

  it('never reloads when validation failed', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await installVhost(target(root), {
      runCommand: fakeRunCommand(
        (argv) => (argv.join(' ') === 'nginx -t' ? { exitCode: 1, stderr: 'no' } : { exitCode: 0 }),
        calls,
      ),
    }).catch(() => undefined);

    expect(calls.flat()).not.toContain('reload');
  });

  it('warns when the proxy was already broken before this run', async () => {
    const root = makeProxyRoot();

    const error = await installVhost(target(root), {
      // Fails even after the rollback: the problem predates this deployment.
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ') === 'nginx -t' ? { exitCode: 1, stderr: 'broken already' } : { exitCode: 0 },
      ),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('already broken');
  });

  it('uses docker exec when the proxy is containerised', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      proxyContainer: 'infra-proxy-1',
    });

    expect(calls[0]).toEqual(['docker', 'exec', 'infra-proxy-1', 'nginx', '-t']);
  });
});

describe('issueCertificate', () => {
  it('skips issuance when a certificate already exists', async () => {
    const root = makeProxyRoot();
    const live = join(root, 'letsencrypt', 'live', 'app.example.test');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'fullchain.pem'), 'cert');

    const calls: string[][] = [];
    const result = await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      email: 'admin@example.test',
    });

    // Re-issuing on every deploy spends the rate limit for nothing, and that
    // limit is shared with every other subdomain on the same server.
    expect(result.issued).toBe(false);
    expect(calls).toEqual([]);
  });

  it('requests one with the webroot method when there is none', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      email: 'admin@example.test',
    });

    const argv = calls[0]?.join(' ') ?? '';
    expect(argv).toContain('certbot certonly');
    expect(argv).toContain('--webroot');
    expect(argv).toContain('-d app.example.test');
    expect(argv).toContain('--non-interactive');
  });

  it('passes --staging when asked', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      email: 'admin@example.test',
      staging: true,
    });

    expect(calls[0]).toContain('--staging');
  });

  it('reports rate limiting distinctly, because the fix is to wait', async () => {
    const root = makeProxyRoot();

    const error = await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({
        exitCode: 1,
        stderr: 'too many certificates already issued for exact set of domains',
      })),
      email: 'admin@example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('rate-limiting');
    // Retrying is what put them there in the first place.
    expect((error as Error).message).toContain('--staging');
  });

  it('reports an absent certificate', () => {
    const root = makeProxyRoot();
    expect(certificateStatus(target(root)).exists).toBe(false);
  });

  // ===========================================================================
  // Staging-certificate replacement (issue #196)
  // ===========================================================================

  function writeExistingCert(root: string): void {
    const live = join(root, 'letsencrypt', 'live', 'app.example.test');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'fullchain.pem'), 'cert');
  }

  function writeRenewalConf(root: string, contents: string): void {
    const renewal = join(root, 'letsencrypt', 'renewal');
    mkdirSync(renewal, { recursive: true });
    writeFileSync(join(renewal, 'app.example.test.conf'), contents);
  }

  it('replaces an existing STAGING certificate with a trusted one when not asked for staging', async () => {
    const root = makeProxyRoot();
    writeExistingCert(root);
    writeRenewalConf(
      root,
      'server = https://acme-staging-v02.api.letsencrypt.org/directory\n',
    );

    const calls: string[][] = [];
    const result = await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      email: 'admin@example.test',
    });

    expect(result.issued).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--force-renewal');
  });

  it('does not force-renew a STAGING certificate when staging is explicitly asked for again', async () => {
    const root = makeProxyRoot();
    writeExistingCert(root);
    writeRenewalConf(
      root,
      'server = https://acme-staging-v02.api.letsencrypt.org/directory\n',
    );

    const calls: string[][] = [];
    const result = await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      email: 'admin@example.test',
      staging: true,
    });

    // Already has what was asked for -- no reason to spend the rate limit.
    expect(result.issued).toBe(false);
    expect(calls).toEqual([]);
  });

  it('does not force-renew a PRODUCTION certificate (no regression)', async () => {
    const root = makeProxyRoot();
    writeExistingCert(root);
    writeRenewalConf(root, 'server = https://acme-v02.api.letsencrypt.org/directory\n');

    const calls: string[][] = [];
    const result = await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      email: 'admin@example.test',
    });

    expect(result.issued).toBe(false);
    expect(calls).toEqual([]);
  });

  it('treats a missing renewal conf as not-staging and skips as before', async () => {
    const root = makeProxyRoot();
    writeExistingCert(root);
    // No renewal/ directory at all -- renewal metadata missing/unreadable.

    const calls: string[][] = [];
    const result = await issueCertificate(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      email: 'admin@example.test',
    });

    expect(result.issued).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('removeVhost', () => {
  it('refuses to remove a vhost evopathcli did not write', async () => {
    const root = makeProxyRoot();
    const path = vhostPath(target(root));
    writeFileSync(path, 'server { listen 80; } # somebody else wrote this\n');

    await expect(
      removeVhost(target(root), { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) }),
    ).rejects.toBeInstanceOf(UsageError);

    expect(existsSync(path)).toBe(true);
  });

  it('removes one it did write', async () => {
    const root = makeProxyRoot();
    await installVhost(target(root), { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) });

    await removeVhost(target(root), { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) });

    expect(existsSync(vhostPath(target(root)))).toBe(false);
  });

  it('is a no-op when there is nothing there', async () => {
    const root = makeProxyRoot();
    await expect(
      removeVhost(target(root), { runCommand: fakeRunCommand(() => ({ exitCode: 0 })) }),
    ).resolves.toBeUndefined();
  });
});

describe('validateProxy', () => {
  it('captures nginx output on failure', async () => {
    const result = await validateProxy({
      runCommand: fakeRunCommand(() => ({ exitCode: 1, stderr: 'nginx: [emerg] oops' })),
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('oops');
  });
});

// =============================================================================
// Container vs. host runtime  (issue #389)
// =============================================================================

describe('renderVhost: container vs. host paths', () => {
  it('in container mode, uses /etc/letsencrypt and /var/www/certbot, and never the host proxy root', () => {
    const root = makeProxyRoot();
    const runtime = proxyRuntimeFor('container', root);
    const rendered = renderVhost(target(root), runtime);

    expect(rendered).toContain(`${CONTAINER_CERT_ROOT}/live/app.example.test/fullchain.pem`);
    expect(rendered).toContain(`${CONTAINER_CERT_ROOT}/live/app.example.test/privkey.pem`);
    expect(rendered).toContain(CONTAINER_WEBROOT);
    // The host proxy root must never leak into a config nginx-in-a-container
    // cannot resolve.
    expect(rendered).not.toContain(root);
  });

  it('in host mode, still uses the host proxy root paths', () => {
    const root = makeProxyRoot();
    const runtime = proxyRuntimeFor('host', root);
    const rendered = renderVhost(target(root), runtime);

    expect(rendered).toContain(join(root, 'letsencrypt', 'live', 'app.example.test', 'fullchain.pem'));
    expect(rendered).toContain(join(root, 'webroot'));
    expect(rendered).not.toContain(CONTAINER_CERT_ROOT);
    expect(rendered).not.toContain(CONTAINER_WEBROOT);
  });
});

describe('certbotArgv', () => {
  const email = 'admin@example.test';

  it('in container mode, runs the dockerised certbot with the two volumes and no --config-dir/--work-dir/--logs-dir', () => {
    const root = makeProxyRoot();
    const runtime = proxyRuntimeFor('container', root);

    const argv = certbotArgv(target(root), runtime, { email });

    expect(argv).toEqual([
      'docker', 'run', '--rm',
      '-v', `${join(root, 'letsencrypt')}:${CONTAINER_CERT_ROOT}`,
      '-v', `${join(root, 'webroot')}:${CONTAINER_WEBROOT}`,
      'certbot/certbot:latest',
      'certonly',
      '--webroot', '-w', CONTAINER_WEBROOT,
      '-d', 'app.example.test',
      '--non-interactive', '--agree-tos',
      '--email', email,
    ]);
    expect(argv).not.toContain('--config-dir');
    expect(argv).not.toContain('--work-dir');
    expect(argv).not.toContain('--logs-dir');
  });

  it('in host mode, keeps --config-dir/--work-dir/--logs-dir under the proxy root', () => {
    const root = makeProxyRoot();
    const runtime = proxyRuntimeFor('host', root);

    const argv = certbotArgv(target(root), runtime, { email });

    expect(argv[0]).toBe('certbot');
    expect(argv).toContain('--config-dir');
    expect(argv).toContain(join(root, 'letsencrypt'));
    expect(argv).toContain('--work-dir');
    expect(argv).toContain(join(root, 'letsencrypt', 'work'));
    expect(argv).toContain('--logs-dir');
    expect(argv).toContain(join(root, 'letsencrypt', 'logs'));
    expect(argv).not.toContain('docker');
  });

  it('passes --staging and --force-renewal through in both modes', () => {
    const root = makeProxyRoot();

    const container = certbotArgv(target(root), proxyRuntimeFor('container', root), {
      email,
      staging: true,
      forceRenewal: true,
    });
    expect(container).toContain('--staging');
    expect(container).toContain('--force-renewal');

    const host = certbotArgv(target(root), proxyRuntimeFor('host', root), {
      email,
      staging: true,
      forceRenewal: true,
    });
    expect(host).toContain('--staging');
    expect(host).toContain('--force-renewal');
  });
});

describe('installVhost / validateProxy / reloadProxy under a container runtime', () => {
  it('uses `docker exec <container> nginx -t` and `nginx -s reload`', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];
    const runtime = proxyRuntimeFor('container', root, 'infra-proxy-1');

    await installVhost(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
      runtime,
    });

    expect(calls).toEqual([
      ['docker', 'exec', 'infra-proxy-1', 'nginx', '-t'],
      ['docker', 'exec', 'infra-proxy-1', 'nginx', '-s', 'reload'],
    ]);
  });

  it('validateProxy alone uses docker exec under a container runtime', async () => {
    const root = makeProxyRoot();
    const runtime = proxyRuntimeFor('container', root, 'infra-proxy-1');
    const calls: string[][] = [];

    await validateProxy({ runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls), runtime });

    expect(calls).toEqual([['docker', 'exec', 'infra-proxy-1', 'nginx', '-t']]);
  });

  it('reloadProxy alone uses docker exec under a container runtime', async () => {
    const root = makeProxyRoot();
    const runtime = proxyRuntimeFor('container', root, 'infra-proxy-1');
    const calls: string[][] = [];

    await reloadProxy({ runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls), runtime });

    expect(calls).toEqual([['docker', 'exec', 'infra-proxy-1', 'nginx', '-s', 'reload']]);
  });
});

describe('assertValidContainerName', () => {
  it('accepts a normal docker container name', () => {
    expect(() => assertValidContainerName('proxy-nginx')).not.toThrow();
    expect(() => assertValidContainerName('a')).not.toThrow();
  });

  it.each(['', '-leading-hyphen', 'has spaces', 'semi;colon', 'new\nline', '../escape'])(
    'rejects %j before it reaches a docker argv',
    (name) => {
      expect(() => assertValidContainerName(name)).toThrow(UsageError);
    },
  );
});

describe('parseProxyMode', () => {
  it('accepts container and host', () => {
    expect(parseProxyMode('container')).toBe('container');
    expect(parseProxyMode('host')).toBe('host');
  });

  it('rejects anything else', () => {
    expect(() => parseProxyMode('docker')).toThrow(UsageError);
    expect(() => parseProxyMode('')).toThrow(UsageError);
  });
});

describe('resolveProxyRuntime', () => {
  function fake(respond: (argv: readonly string[]) => Canned | undefined): typeof import('./executor.js').runCommand {
    return fakeRunCommand(respond);
  }

  it('an explicit mode wins outright, without probing anything', async () => {
    const calls: string[][] = [];
    const runtime = await resolveProxyRuntime({
      proxyRoot: '/opt/infra/proxy',
      mode: 'host',
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
    });

    expect(runtime).toMatchObject({ mode: 'host', source: 'explicit' });
    expect(calls).toEqual([]);
  });

  it('detects container mode when `docker inspect` finds the named container', async () => {
    const runtime = await resolveProxyRuntime({
      proxyRoot: '/opt/infra/proxy',
      container: 'my-proxy',
      runCommand: fake((argv) =>
        argv.join(' ').startsWith('docker inspect') ? { exitCode: 0, stdout: 'my-proxy' } : undefined,
      ),
    });

    expect(runtime).toMatchObject({ mode: 'container', container: 'my-proxy', source: 'detected' });
  });

  it('falls back to host mode when no container is found but nginx -v succeeds', async () => {
    const runtime = await resolveProxyRuntime({
      proxyRoot: '/opt/infra/proxy',
      runCommand: fake((argv) => {
        if (argv.join(' ').startsWith('docker inspect')) return { exitCode: 1, stderr: 'no such container' };
        if (argv.join(' ').startsWith('nginx -v')) return { exitCode: 0, stderr: 'nginx version' };
        return undefined;
      }),
    });

    expect(runtime).toMatchObject({ mode: 'host', source: 'detected' });
  });

  it('defaults to container mode when neither probe succeeds', async () => {
    const runtime = await resolveProxyRuntime({
      proxyRoot: '/opt/infra/proxy',
      runCommand: fake(() => ({ exitCode: 1, stderr: 'nope' })),
    });

    expect(runtime).toMatchObject({ mode: 'container', container: DEFAULT_PROXY_CONTAINER, source: 'default' });
  });

  it('validates the container name before anything is probed', async () => {
    await expect(
      resolveProxyRuntime({
        proxyRoot: '/opt/infra/proxy',
        container: 'bad name;here',
        runCommand: fakeRunCommand(() => ({ exitCode: 0 })),
      }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('resolveRecordedProxyRuntime: flag > record > detect, per field', () => {
  const detectsHost: typeof import('./executor.js').runCommand = fakeRunCommand((argv) => {
    if (argv.join(' ').startsWith('docker inspect')) return { exitCode: 1, stderr: 'no such container' };
    if (argv.join(' ').startsWith('nginx -v')) return { exitCode: 0 };
    return undefined;
  });

  it('an explicit flag wins over a recorded value', async () => {
    const runtime = await resolveRecordedProxyRuntime({
      proxyRoot: '/opt/infra/proxy',
      flags: { mode: 'host' },
      recorded: { proxyMode: 'container', proxyContainer: 'recorded-proxy' },
      runCommand: fakeRunCommand(() => ({ exitCode: 0 })),
    });

    expect(runtime.mode).toBe('host');
  });

  it('the record wins over detection when no flag is given', async () => {
    const runtime = await resolveRecordedProxyRuntime({
      proxyRoot: '/opt/infra/proxy',
      flags: {},
      recorded: { proxyMode: 'container', proxyContainer: 'recorded-proxy' },
      runCommand: detectsHost, // would detect host, but the record wins
    });

    expect(runtime).toMatchObject({ mode: 'container', container: 'recorded-proxy', source: 'explicit' });
  });

  it('detection is the last resort when neither a flag nor a record says anything', async () => {
    const runtime = await resolveRecordedProxyRuntime({
      proxyRoot: '/opt/infra/proxy',
      flags: {},
      recorded: undefined,
      runCommand: detectsHost,
    });

    expect(runtime).toMatchObject({ mode: 'host', source: 'detected' });
  });

  it('each half falls back independently: a mode flag with a recorded container name keeps that name', async () => {
    const runtime = await resolveRecordedProxyRuntime({
      proxyRoot: '/opt/infra/proxy',
      flags: { mode: 'container' },
      recorded: { proxyContainer: 'recorded-proxy' },
      runCommand: fakeRunCommand(() => ({ exitCode: 0 })),
    });

    expect(runtime).toMatchObject({ mode: 'container', container: 'recorded-proxy' });
  });

  it('a container flag with a recorded mode keeps that mode', async () => {
    const runtime = await resolveRecordedProxyRuntime({
      proxyRoot: '/opt/infra/proxy',
      flags: { container: 'flagged-proxy' },
      recorded: { proxyMode: 'host' },
      runCommand: fakeRunCommand(() => ({ exitCode: 0 })),
    });

    expect(runtime).toMatchObject({ mode: 'host', container: 'flagged-proxy' });
  });
});

// =============================================================================
// certificateServedMatchesDisk (issue #205): does the certificate the proxy
// ACTUALLY SERVES over TLS match the one on disk? Neither the health probes
// (plain HTTP to 127.0.0.1) nor certificateExpiry (reads the file only) can
// answer this -- this is the one place that actually connects.
//
// X509Certificate needs real, parseable DER/PEM, so these are two small real
// self-signed certificates, generated once with:
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout /dev/null -days 3650 \
//     -subj "/CN=test-a"   (and "/CN=test-b" for the second)
// and inlined here as string constants -- not fabricated by hand.
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

describe('certificateServedMatchesDisk', () => {
  function installCert(proxyRoot: string, pem: string): void {
    const dir = join(proxyRoot, 'letsencrypt', 'live', 'app.example.test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fullchain.pem'), pem);
  }

  /** A realistic `openssl s_client` transcript wrapping the given PEM block. */
  function sClientOutput(pem: string): string {
    return `CONNECTED(00000003)\n---\nCertificate chain\n 0 s:CN = test\n${pem}---\nNo client certificate CA names sent\n---\n`;
  }

  it('reports unchecked, and never probes the network, when there is no certificate on disk', async () => {
    const root = makeProxyRoot();
    const calls: string[][] = [];

    const result = await certificateServedMatchesDisk(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0 }), calls),
    });

    expect(result).toEqual({ checked: false });
    expect(calls).toEqual([]);
  });

  it('matches when the served certificate is byte-identical to the one on disk', async () => {
    const root = makeProxyRoot();
    installCert(root, CERT_A);
    const calls: string[][] = [];

    const result = await certificateServedMatchesDisk(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: sClientOutput(CERT_A) }), calls),
    });

    expect(result.checked).toBe(true);
    expect(result.matches).toBe(true);
    expect(result.diskIssuer).toBe('CN=test-a');
    expect(result.servedIssuer).toBe('CN=test-a');
    expect(calls).toEqual([
      ['openssl', 's_client', '-connect', 'app.example.test:443', '-servername', 'app.example.test'],
    ]);
  });

  it('does not match when the served certificate differs from the one on disk', async () => {
    const root = makeProxyRoot();
    installCert(root, CERT_A);

    const result = await certificateServedMatchesDisk(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: sClientOutput(CERT_B) })),
    });

    expect(result.checked).toBe(true);
    expect(result.matches).toBe(false);
    expect(result.diskIssuer).toBe('CN=test-a');
    expect(result.servedIssuer).toBe('CN=test-b');
  });

  it('gives up cleanly, naming the domain, when openssl s_client fails with nothing usable', async () => {
    const root = makeProxyRoot();
    installCert(root, CERT_A);
    const run: typeof import('./executor.js').runCommand = (async () => {
      throw new Error('connect: connection refused');
    }) as typeof import('./executor.js').runCommand;

    const result = await certificateServedMatchesDisk(target(root), { runCommand: run });

    expect(result.checked).toBe(false);
    expect(result.detail).toContain('app.example.test');
  });

  it('still compares when s_client exits non-zero but already printed a certificate (abrupt EOF close)', async () => {
    const root = makeProxyRoot();
    installCert(root, CERT_A);

    const result = await certificateServedMatchesDisk(target(root), {
      runCommand: fakeRunCommand(() => ({
        exitCode: 1,
        stdout: sClientOutput(CERT_A),
        stderr: '4590060:error:0A000126:SSL routines::unexpected eof while reading',
      })),
    });

    expect(result.checked).toBe(true);
    expect(result.matches).toBe(true);
  });

  it('reports unchecked, naming the domain, when the output has no certificate block at all', async () => {
    const root = makeProxyRoot();
    installCert(root, CERT_A);

    const result = await certificateServedMatchesDisk(target(root), {
      runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: 'no certificate here\n' })),
    });

    expect(result.checked).toBe(false);
    expect(result.detail).toContain('app.example.test');
  });
});

describe('describeReloadCommand', () => {
  it('reuses reloadProxy\'s own argv: docker exec under a container runtime', () => {
    expect(describeReloadCommand({ mode: 'container', container: 'infra-proxy-1' })).toBe(
      'sudo docker exec infra-proxy-1 nginx -s reload',
    );
  });

  it('is plain nginx -s reload on the host', () => {
    expect(describeReloadCommand({ mode: 'host', container: 'unused' })).toBe('sudo nginx -s reload');
  });
});
