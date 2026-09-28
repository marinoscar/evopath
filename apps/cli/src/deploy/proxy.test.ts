import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions } from './executor.js';
import {
  assertValidContainerName,
  assertValidDomain,
  certbotArgv,
  certificateStatus,
  CONTAINER_CERT_ROOT,
  CONTAINER_WEBROOT,
  DEFAULT_PROXY_CONTAINER,
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
  const root = mkdtempSync(join(tmpdir(), 'appctl-proxy-'));
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
    expect(block).toContain('proxy_buffering off;');
    expect(block).toContain('proxy_read_timeout 600s;');
    expect(block).toContain("proxy_set_header Connection        '';");
  });

  it('gives the telemetry assistant stream its own unbuffered block', () => {
    const block = rendered.slice(rendered.indexOf('location /api/admin/telemetry/assistant/stream'));
    expect(rendered).toContain('location /api/admin/telemetry/assistant/stream {');
    expect(block).toContain('proxy_buffering off;');
    expect(block).toContain('proxy_read_timeout 600s;');
    expect(block).toContain("proxy_set_header Connection        '';");
  });

  it('is deterministic, so a re-run produces no spurious diff', () => {
    expect(renderVhost(target(root), runtime)).toBe(rendered);
  });

  it('sizes client_max_body_size from the configured upload limit', () => {
    const sized = renderVhost(target(root), runtime, { maxBodyBytes: 10 * 1024 * 1024 });
    expect(sized).toContain('client_max_body_size 10m;');
  });

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
});

describe('removeVhost', () => {
  it('refuses to remove a vhost appctl did not write', async () => {
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
