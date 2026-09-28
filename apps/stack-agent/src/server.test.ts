import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { DiscoveryError, type ComposeTarget } from './compose.js';
import type { CommandRunner, RunResult } from './runner.js';
import { createAgent, tokenMatches, UP_TIMEOUT_MS, type AgentOptions, type LogEntry } from './server.js';

const TOKEN = 'a'.repeat(24) + 'b'.repeat(24);
const TARGET: ComposeTarget = {
  project: 'acme',
  workingDir: '/opt/infra/apps/acme/repo/infra/compose',
  files: ['/opt/infra/apps/acme/repo/infra/compose/base.compose.yml'],
};

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

interface Harness {
  url: string;
  calls: Array<{ argv: string[]; cwd: string | undefined; timeoutMs: number }>;
  logs: LogEntry[];
}

async function start(options: Partial<AgentOptions> & { result?: Partial<RunResult> } = {}): Promise<Harness> {
  const calls: Harness['calls'] = [];
  const logs: LogEntry[] = [];
  const runner: CommandRunner =
    options.runner ??
    (async (argv, runOptions) => {
      calls.push({ argv: [...argv], cwd: runOptions.cwd, timeoutMs: runOptions.timeoutMs });
      return { exitCode: 0, stdout: '', output: 'done', ...options.result };
    });

  server = createServer(
    createAgent({
      token: 'token' in options ? options.token : TOKEN,
      runner,
      discover: options.discover ?? (async () => TARGET),
      log: (entry) => logs.push(entry),
    }),
  );
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls, logs };
}

const auth = (token = TOKEN): Record<string, string> => ({ authorization: `Bearer ${token}` });

describe('GET /health', () => {
  it('answers without a token', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers even when the agent is not configured', async () => {
    const { url } = await start({ token: undefined });
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});

describe('authentication', () => {
  it('rejects a missing token', async () => {
    const { url, calls } = await start();
    const response = await fetch(`${url}/v1/telemetry`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(calls).toEqual([]);
  });

  it('rejects a wrong token, including a prefix of the right one', async () => {
    const { url, calls } = await start();
    for (const token of ['wrong', TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const response = await fetch(`${url}/v1/telemetry/up`, { method: 'POST', headers: auth(token) });
      expect(response.status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('rejects a scheme other than Bearer', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/v1/telemetry`, { headers: { authorization: `Basic ${TOKEN}` } });
    expect(response.status).toBe(401);
  });

  it('accepts the right token', async () => {
    const { url } = await start();
    expect((await fetch(`${url}/v1/telemetry`, { headers: auth() })).status).toBe(200);
  });

  it('answers 503 not_configured to every /v1 call when the token is unset or short', async () => {
    for (const token of [undefined, '', 'x'.repeat(31)]) {
      const { url, calls } = await start({ token });
      for (const [path, method] of [
        ['/v1/telemetry', 'GET'],
        ['/v1/telemetry/up', 'POST'],
        ['/v1/anything', 'GET'],
      ] as const) {
        const response = await fetch(`${url}${path}`, { method, headers: auth(token ?? '') });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'not_configured' });
      }
      expect(calls).toEqual([]);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('tokenMatches is exact', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches('Bearer ', TOKEN)).toBe(false);
    expect(tokenMatches(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
  });
});

describe('routing', () => {
  it('404s an unknown path, a wrong method and any query string', async () => {
    const { url, calls } = await start();
    const cases: Array<[string, string]> = [
      ['/', 'GET'],
      ['/v1', 'GET'],
      ['/v1/telemetry/down', 'POST'],
      ['/v1/telemetry', 'POST'],
      ['/v1/telemetry/up', 'GET'],
      ['/v1/telemetry?service=api', 'GET'],
      ['/v1/telemetry/up?project=other', 'POST'],
      ['/health', 'POST'],
    ];
    for (const [path, method] of cases) {
      const response = await fetch(`${url}${path}`, { method, headers: auth() });
      expect({ path, method, status: response.status }).toEqual({ path, method, status: 404 });
    }
    expect(calls).toEqual([]);
  });

  it('authenticates an unknown /v1 path before revealing that it does not exist', async () => {
    const { url } = await start();
    expect((await fetch(`${url}/v1/nothing-here`)).status).toBe(401);
  });

  it('refuses a body over 1 KB', async () => {
    const { url, calls } = await start();
    const response = await fetch(`${url}/v1/telemetry/up`, {
      method: 'POST',
      headers: auth(),
      body: 'x'.repeat(2048),
    });
    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('ignores a small body: nothing in it reaches the command', async () => {
    const { url, calls } = await start();
    const response = await fetch(`${url}/v1/telemetry/up`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ services: ['api'], project: 'other', files: ['/etc/passwd'] }),
    });
    expect(response.status).toBe(200);
    const argv = calls[0]?.argv ?? [];
    expect(argv).not.toContain('api');
    expect(argv).not.toContain('other');
    expect(argv).not.toContain('/etc/passwd');
  });
});

describe('GET /v1/telemetry', () => {
  it('runs compose ps in the working dir and reports both services', async () => {
    const { url, calls } = await start({
      result: {
        stdout: JSON.stringify({ Service: 'greptimedb', State: 'running', Health: 'healthy' }),
      },
    });
    const response = await fetch(`${url}/v1/telemetry`, { headers: auth() });
    expect(await response.json()).toEqual({
      services: [
        { name: 'greptimedb', state: 'running', health: 'healthy' },
        { name: 'otel-collector', state: 'missing', health: null },
      ],
    });
    expect(calls[0]?.cwd).toBe(TARGET.workingDir);
    expect(calls[0]?.argv).toContain('ps');
  });

  it('answers 502 when compose fails', async () => {
    const { url } = await start({ result: { exitCode: 1 } });
    const response = await fetch(`${url}/v1/telemetry`, { headers: auth() });
    expect(response.status).toBe(502);
  });

  it('answers 503 discovery_failed when its own labels cannot be read', async () => {
    const { url } = await start({
      discover: async () => {
        throw new DiscoveryError('no labels');
      },
    });
    const response = await fetch(`${url}/v1/telemetry`, { headers: auth() });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'discovery_failed' });
  });
});

describe('POST /v1/telemetry/up', () => {
  it('runs compose up with a 10-minute timeout and returns the output', async () => {
    const { url, calls } = await start({ result: { output: 'Container acme-greptimedb-1 Started' } });
    const response = await fetch(`${url}/v1/telemetry/up`, { method: 'POST', headers: auth() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      exitCode: 0,
      output: 'Container acme-greptimedb-1 Started',
    });
    expect(calls[0]?.timeoutMs).toBe(UP_TIMEOUT_MS);
    expect(UP_TIMEOUT_MS).toBe(600_000);
    expect(calls[0]?.cwd).toBe(TARGET.workingDir);
    expect(calls[0]?.argv.slice(-5)).toEqual(['up', '-d', '--no-build', 'greptimedb', 'otel-collector']);
  });

  it('answers 500 with the exit code when compose fails', async () => {
    const { url } = await start({ result: { exitCode: 18, output: 'pull access denied' } });
    const response = await fetch(`${url}/v1/telemetry/up`, { method: 'POST', headers: auth() });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, exitCode: 18, output: 'pull access denied' });
  });

  it('caps the output at the last 4 KB and never returns the token', async () => {
    const { url } = await start({ result: { output: `${'z'.repeat(20_000)}${TOKEN}END` } });
    const body = (await (
      await fetch(`${url}/v1/telemetry/up`, { method: 'POST', headers: auth() })
    ).json()) as { output: string };
    expect(Buffer.byteLength(body.output)).toBeLessThanOrEqual(4096);
    expect(body.output.endsWith('[redacted]END')).toBe(true);
    expect(body.output).not.toContain(TOKEN);
  });

  it('is single-flight: a concurrent call gets 409 busy, and the next one runs', async () => {
    const releases: Array<() => void> = [];
    const calls: string[][] = [];
    const runner: CommandRunner = (argv) => {
      calls.push([...argv]);
      return new Promise((resolve) => {
        releases.push(() => resolve({ exitCode: 0, stdout: '', output: '' }));
      });
    };
    const { url } = await start({ runner });

    const first = fetch(`${url}/v1/telemetry/up`, { method: 'POST', headers: auth() });
    await expect.poll(() => calls.length).toBe(1);

    const second = await fetch(`${url}/v1/telemetry/up`, { method: 'POST', headers: auth() });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'busy' });
    expect(calls).toHaveLength(1);

    // Status stays available while an `up` is running.
    const status = fetch(`${url}/v1/telemetry`, { headers: auth() });
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toContain('ps');

    for (const release of releases) release();
    expect((await first).status).toBe(200);
    expect((await status).status).toBe(200);

    // The lock is released: the next `up` runs.
    const third = fetch(`${url}/v1/telemetry/up`, { method: 'POST', headers: auth() });
    await expect.poll(() => calls.length).toBe(3);
    releases[2]?.();
    expect((await third).status).toBe(200);
  });

  it('releases the lock after a failure', async () => {
    let attempt = 0;
    const runner: CommandRunner = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('boom');
      return { exitCode: 0, stdout: '', output: '' };
    };
    const { url } = await start({ runner });
    expect((await fetch(`${url}/v1/telemetry/up`, { method: 'POST', headers: auth() })).status).toBe(500);
    expect((await fetch(`${url}/v1/telemetry/up`, { method: 'POST', headers: auth() })).status).toBe(200);
  });
});

describe('logging', () => {
  it('logs one line per request with method, path, status and ms, never the token or headers', async () => {
    const { url, logs } = await start();
    await fetch(`${url}/v1/telemetry?x=${TOKEN}`, { headers: { ...auth(), 'x-secret': 'hdr' } });
    await expect.poll(() => logs.filter((entry) => entry['msg'] === 'request').length).toBe(1);

    const line = logs.find((entry) => entry['msg'] === 'request') as LogEntry;
    expect(line).toMatchObject({ method: 'GET', path: '/v1/telemetry', status: 404 });
    expect(typeof line['ms']).toBe('number');
    const text = JSON.stringify(logs);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('hdr');
    expect(text.toLowerCase()).not.toContain('authorization');
  });
});

// A raw request, to prove a body larger than the limit is refused even with no
// content-length (chunked).
describe('chunked body over the limit', () => {
  it('is refused with 413', async () => {
    const { url } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${url}/v1/telemetry/up`, { method: 'POST', headers: auth() }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write('x'.repeat(800));
      req.write('x'.repeat(800));
      req.end();
    });
    expect(status).toBe(413);
  });
});
