import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PreconditionError } from '../errors.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions, type runCommand } from './executor.js';
import { proxyRuntimeFor } from './proxy.js';
import {
  DEFAULT_SERVER_CONF,
  bootstrapProxy,
  ensureExternalNetworks,
  externalNetworks,
  inspectProxy,
  renderDefaultServer,
  renderProxyCompose,
} from './proxy-bootstrap.js';

const RUNTIME = proxyRuntimeFor('container', '/unused', 'proxy-nginx');

type Reply = { exitCode: number; stdout?: string; stderr?: string };

function fake(respond: (argv: readonly string[]) => Reply): {
  run: typeof runCommand;
  calls: { argv: readonly string[]; cwd: string }[];
} {
  const calls: { argv: readonly string[]; cwd: string }[] = [];
  const run = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    calls.push({ argv, cwd: options.cwd });
    const reply = respond(argv);
    const result: CommandResult = {
      argv,
      cwd: options.cwd,
      exitCode: reply.exitCode,
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      durationMs: 0,
      timedOut: false,
    };
    if (reply.exitCode !== 0) throw new CommandFailedError(result.stderr, result);
    return result;
  }) as typeof runCommand;
  return { run, calls };
}

const NO_CONTAINER: Reply = { exitCode: 1, stderr: 'Error: No such container: proxy-nginx' };

function root(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-proxy-bootstrap-'));
}

describe('renderProxyCompose', () => {
  it('names the container, uses host networking, and mounts what the rest of the CLI assumes', () => {
    const compose = renderProxyCompose(RUNTIME);
    expect(compose).toContain('container_name: proxy-nginx');
    expect(compose).toContain('image: nginx:alpine');
    expect(compose).toContain('network_mode: host');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('./nginx/conf.d:/etc/nginx/conf.d:ro');
    expect(compose).toContain('./nginx/snippets:/etc/nginx/snippets:ro');
    expect(compose).toContain('./letsencrypt:/etc/letsencrypt:ro');
    expect(compose).toContain('./webroot:/var/www/certbot:ro');
    // Compose rejects `ports:` alongside host networking.
    expect(compose).not.toMatch(/^\s*ports:/m);
  });

  it('serves the ACME challenge from the default server and drops everything else', () => {
    const conf = renderDefaultServer();
    expect(conf).toContain('location /.well-known/acme-challenge/');
    expect(conf).toContain('root /var/www/certbot;');
    expect(conf).toContain('return 444;');
    expect(conf).toContain('default_server');
  });
});

describe('externalNetworks', () => {
  it('finds the external network the real base.compose.yml declares', () => {
    const base = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', 'infra', 'compose', 'base.compose.yml'),
      'utf8',
    );
    expect(externalNetworks(base)).toEqual(['devnet']);
  });

  it('prefers `name:` over the key, and ignores internal networks', () => {
    const text = [
      'services:',
      '  api:',
      '    networks: [a]',
      'networks:',
      '  internal:',
      '    driver: bridge',
      '  shared:',
      '    external: true',
      '    name: shared-net',
      '  other:',
      '    external: true',
    ].join('\n');
    expect(externalNetworks(text)).toEqual(['shared-net', 'other']);
  });
});

describe('inspectProxy', () => {
  it('distinguishes running, stopped, configured and absent', async () => {
    const dir = root();

    const running = await inspectProxy({ proxyRoot: dir, runtime: RUNTIME, runCommand: fake(() => ({ exitCode: 0, stdout: 'true' })).run });
    expect(running.state).toBe('running');

    const stopped = await inspectProxy({ proxyRoot: dir, runtime: RUNTIME, runCommand: fake(() => ({ exitCode: 0, stdout: 'false' })).run });
    expect(stopped.state).toBe('stopped');

    const absent = await inspectProxy({ proxyRoot: dir, runtime: RUNTIME, runCommand: fake(() => NO_CONTAINER).run });
    expect(absent.state).toBe('absent');

    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const configured = await inspectProxy({ proxyRoot: dir, runtime: RUNTIME, runCommand: fake(() => NO_CONTAINER).run });
    expect(configured.state).toBe('configured');

    const unknown = await inspectProxy({
      proxyRoot: dir,
      runtime: RUNTIME,
      runCommand: fake(() => ({ exitCode: 1, stderr: 'permission denied on the docker socket' })).run,
    });
    expect(unknown.state).toBe('unknown');
  });
});

describe('bootstrapProxy', () => {
  it('lays out the proxy, creates a missing network, and brings it up in the proxy root', async () => {
    const dir = root();
    const { run, calls } = fake((argv) =>
      argv.join(' ').startsWith('docker network inspect') ? { exitCode: 1, stderr: 'not found' } : { exitCode: 0 },
    );

    const result = await bootstrapProxy({ proxyRoot: dir, runtime: RUNTIME, runCommand: run, networks: ['devnet'] });

    for (const path of ['nginx/conf.d', 'nginx/snippets', 'letsencrypt', 'webroot']) {
      expect(existsSync(join(dir, path))).toBe(true);
    }
    expect(readFileSync(join(dir, 'compose.yml'), 'utf8')).toBe(renderProxyCompose(RUNTIME));
    expect(readFileSync(join(dir, 'nginx', 'conf.d', DEFAULT_SERVER_CONF), 'utf8')).toBe(renderDefaultServer());
    expect(result.networksCreated).toEqual(['devnet']);

    const lines = calls.map((call) => call.argv.join(' '));
    expect(lines).toContain('docker network create devnet');
    const up = calls.find((call) => call.argv.join(' ') === 'docker compose up -d');
    expect(up?.cwd).toBe(dir);
    expect(lines).toContain('docker exec proxy-nginx nginx -t');
  });

  it('NEVER touches an existing proxy root that has a compose file', async () => {
    const dir = root();
    const theirs = 'services:\n  proxy:\n    image: caddy\n';
    writeFileSync(join(dir, 'compose.yml'), theirs);
    const { run, calls } = fake(() => ({ exitCode: 0 }));

    await expect(bootstrapProxy({ proxyRoot: dir, runtime: RUNTIME, runCommand: run })).rejects.toThrow(
      PreconditionError,
    );

    expect(readFileSync(join(dir, 'compose.yml'), 'utf8')).toBe(theirs);
    expect(existsSync(join(dir, 'nginx'))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('never overwrites an existing default server', async () => {
    const dir = root();
    mkdirSync(join(dir, 'nginx', 'conf.d'), { recursive: true });
    writeFileSync(join(dir, 'nginx', 'conf.d', DEFAULT_SERVER_CONF), '# mine\n');
    const { run } = fake(() => ({ exitCode: 0 }));

    await bootstrapProxy({ proxyRoot: dir, runtime: RUNTIME, runCommand: run });

    expect(readFileSync(join(dir, 'nginx', 'conf.d', DEFAULT_SERVER_CONF), 'utf8')).toBe('# mine\n');
  });
});

describe('ensureExternalNetworks', () => {
  function composeFile(): string {
    const dir = root();
    const path = join(dir, 'base.compose.yml');
    writeFileSync(path, 'networks:\n  app-network:\n    driver: bridge\n  devnet:\n    external: true\n    name: devnet\n');
    return path;
  }

  it('creates an external network that inspect cannot find', async () => {
    const { run, calls } = fake((argv) =>
      argv.join(' ').startsWith('docker network inspect') ? { exitCode: 1, stderr: 'not found' } : { exitCode: 0 },
    );
    const lines: string[] = [];
    const result = await ensureExternalNetworks({ composeFiles: [composeFile()], runCommand: run, onLine: (l) => lines.push(l) });
    expect(result).toEqual({ checked: ['devnet'], created: ['devnet'] });
    expect(calls.map((call) => call.argv.join(' '))).toEqual(['docker network inspect devnet', 'docker network create devnet']);
    expect(lines).toContain('Created docker network devnet');
  });

  it('is a no-op when the network exists, and ignores internal networks and absent files', async () => {
    const { run, calls } = fake(() => ({ exitCode: 0 }));
    const result = await ensureExternalNetworks({
      composeFiles: [composeFile(), join(root(), 'missing.compose.yml')],
      runCommand: run,
    });
    expect(result.created).toEqual([]);
    expect(calls.map((call) => call.argv.join(' '))).toEqual(['docker network inspect devnet']);
  });
});
