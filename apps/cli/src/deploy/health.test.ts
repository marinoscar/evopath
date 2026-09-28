import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions } from './executor.js';
import {
  collectHealth,
  containerStates,
  migrationState,
  describeFetchFailure,
  isHealthy,
  oauthSmoke,
  probe,
  waitForHealthy,
  type HealthReport,
} from './health.js';
import { composeFilesFor } from './compose-files.js';
import { composeArgv } from './install.js';

type Canned = { exitCode: number; stdout?: string; stderr?: string };

function fakeRunCommand(
  respond: (argv: readonly string[]) => Canned | undefined,
): typeof import('./executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const canned = respond(argv) ?? { exitCode: 1, stderr: 'no' };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    const allowed = options.allowExitCodes ?? [];
    if (result.exitCode !== 0 && !allowed.includes(result.exitCode)) {
      throw new CommandFailedError(result.stderr || 'failed', result);
    }
    return result;
  }) as typeof import('./executor.js').runCommand;
}

function response(status: number): Response {
  return new Response('', { status });
}

const RUNNING_PS = JSON.stringify([
  { Name: 'demo-api-1', Service: 'api', State: 'running', Image: 'demo-api', Health: 'healthy' },
  { Name: 'demo-web-1', Service: 'web', State: 'running', Image: 'demo-web' },
  { Name: 'demo-nginx-1', Service: 'nginx', State: 'running', Image: 'nginx:1.30-alpine' },
]);

function healthyRunCommand(): typeof import('./executor.js').runCommand {
  return fakeRunCommand((argv) => {
    const line = argv.join(' ');
    if (line.includes(' ps ')) return { exitCode: 0, stdout: RUNNING_PS };
    if (line.includes('migrate status')) {
      return { exitCode: 0, stdout: '3 migrations found\nDatabase schema is up to date!' };
    }
    return { exitCode: 0 };
  });
}

function okFetch(): typeof globalThis.fetch {
  return (async () => response(200)) as typeof globalThis.fetch;
}

describe('probe', () => {
  it('reports a 2xx as ok, with a duration', async () => {
    const result = await probe('http://x/', { fetch: okFetch() });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a 503 as not ok, keeping the status', async () => {
    const result = await probe('http://x/', {
      fetch: (async () => response(503)) as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });
});

describe('describeFetchFailure', () => {
  it.each([
    ['ECONNREFUSED', 'connection refused'],
    ['ENOTFOUND', 'host does not resolve'],
    ['CERT_HAS_EXPIRED', 'the TLS certificate has expired'],
  ])('turns %s into something actionable', (code, expected) => {
    const error = Object.assign(new Error('fetch failed'), { cause: { code } });
    expect(describeFetchFailure(error)).toBe(expected);
  });

  it('recognises a timeout', () => {
    const error = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(describeFetchFailure(error)).toBe('timed out');
  });
});

describe('collectHealth', () => {
  const base = {
    deployRoot: '/opt/infra/apps/demo',
    bindPort: 3535,
  };

  it('reports containers, probes and migration state', async () => {
    const report = await collectHealth({
      ...base,
      runCommand: healthyRunCommand(),
      fetch: okFetch(),
    });

    expect(report.containers.map((c) => c.service)).toEqual(['api', 'web', 'nginx']);
    expect(report.local.ready.ok).toBe(true);
    expect(report.migrations).toEqual({ known: true, applied: 3, pending: [] });
    expect(isHealthy(report)).toBe(true);
  });

  it('probes the frontend separately from the API', async () => {
    const urls: string[] = [];
    await collectHealth({
      ...base,
      runCommand: healthyRunCommand(),
      fetch: (async (url: string | URL) => {
        urls.push(String(url));
        return response(200);
      }) as typeof globalThis.fetch,
    });

    // The frontend fails independently of the API - #169 is exactly the case
    // where every API check passes and the site serves nothing.
    expect(urls).toContain('http://127.0.0.1:3535/');
    expect(urls).toContain('http://127.0.0.1:3535/api/health/live');
    expect(urls).toContain('http://127.0.0.1:3535/api/health/ready');
  });

  it('adds an external check only when a domain is given', async () => {
    const without = await collectHealth({
      ...base,
      runCommand: healthyRunCommand(),
      fetch: okFetch(),
    });
    expect(without.external).toBeUndefined();

    const withDomain = await collectHealth({
      ...base,
      domain: 'app.example.test',
      runCommand: healthyRunCommand(),
      fetch: okFetch(),
    });
    expect(withDomain.external?.url).toBe('https://app.example.test/api/health/ready');
  });

  it('parses compose output emitted one object per line', async () => {
    const report = await collectHealth({
      ...base,
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ').includes(' ps ')
          ? {
              exitCode: 0,
              stdout: [
                '{"Name":"a","Service":"api","State":"running","Image":"i"}',
                '{"Name":"b","Service":"web","State":"exited","Image":"i"}',
              ].join('\n'),
            }
          : { exitCode: 0, stdout: 'Database schema is up to date!' },
      ),
      fetch: okFetch(),
    });

    expect(report.containers).toHaveLength(2);
  });

  it('reports unknown migration state rather than assuming it is fine', async () => {
    const report = await collectHealth({
      ...base,
      runCommand: fakeRunCommand((argv) =>
        argv.join(' ').includes(' ps ') ? { exitCode: 0, stdout: RUNNING_PS } : undefined,
      ),
      fetch: okFetch(),
    });

    expect(report.migrations.known).toBe(false);
  });
});

describe('isHealthy', () => {
  function report(overrides: Partial<HealthReport> = {}): HealthReport {
    return {
      containers: [
        { name: 'demo-api-1', service: 'api', state: 'running', image: 'i' },
        { name: 'demo-web-1', service: 'web', state: 'running', image: 'i' },
      ],
      local: {
        live: { ok: true, status: 200, durationMs: 1 },
        ready: { ok: true, status: 200, durationMs: 1 },
        frontend: { ok: true, status: 200, durationMs: 1 },
      },
      migrations: { known: true, pending: [] },
      ...overrides,
    };
  }

  it('is healthy when everything is serving and the schema is current', () => {
    expect(isHealthy(report())).toBe(true);
  });

  it('is unhealthy when the web container is stopped, even with the API green', () => {
    // The #169 scenario: API answers, site serves nothing.
    expect(
      isHealthy(
        report({
          containers: [
            { name: 'demo-api-1', service: 'api', state: 'running', image: 'i' },
            { name: 'demo-web-1', service: 'web', state: 'exited', image: 'i' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('is unhealthy when a container is restarting', () => {
    expect(
      isHealthy(
        report({
          containers: [{ name: 'a', service: 'api', state: 'restarting', image: 'i' }],
        }),
      ),
    ).toBe(false);
  });

  it('is unhealthy with pending migrations even though readiness is green', () => {
    // /api/health/ready issues SELECT 1, which passes against an empty
    // database. A green probe is not proof that the schema is there.
    expect(
      isHealthy(report({ migrations: { known: true, pending: ['20260101000000_add_x'] } })),
    ).toBe(false);
  });

  it('is unhealthy when the frontend probe fails', () => {
    expect(
      isHealthy(
        report({
          local: {
            live: { ok: true, status: 200, durationMs: 1 },
            ready: { ok: true, status: 200, durationMs: 1 },
            frontend: { ok: false, status: 502, durationMs: 1 },
          },
        }),
      ),
    ).toBe(false);
  });

  it('is unhealthy when the external check fails', () => {
    expect(
      isHealthy(
        report({
          external: {
            url: 'https://x/api/health/ready',
            probe: { ok: false, durationMs: 1, error: 'the TLS certificate has expired' },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('waitForHealthy', () => {
  it('returns as soon as readiness answers', async () => {
    let calls = 0;
    const result = await waitForHealthy({
      deployRoot: '/x',
      bindPort: 3535,
      runCommand: healthyRunCommand(),
      fetch: (async () => {
        calls += 1;
        return response(calls >= 3 ? 200 : 503);
      }) as typeof globalThis.fetch,
      sleep: async () => undefined,
      intervalMs: 1,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('reports progress on each attempt', async () => {
    const progress: string[] = [];
    let calls = 0;

    await waitForHealthy({
      deployRoot: '/x',
      bindPort: 3535,
      runCommand: healthyRunCommand(),
      fetch: (async () => {
        calls += 1;
        return response(calls >= 2 ? 200 : 503);
      }) as typeof globalThis.fetch,
      sleep: async () => undefined,
      intervalMs: 1,
      hooks: { onProgress: (message) => progress.push(message) },
    });

    expect(progress.some((line) => line.includes('attempt 1'))).toBe(true);
    expect(progress.some((line) => line.includes('Ready after'))).toBe(true);
  });

  it('surfaces the last failure on timeout, not a generic message', async () => {
    const result = await waitForHealthy({
      deployRoot: '/x',
      bindPort: 3535,
      runCommand: healthyRunCommand(),
      fetch: (async () => {
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }) as typeof globalThis.fetch,
      sleep: async () => undefined,
      waitMs: 0,
      intervalMs: 1,
    });

    // "connection refused" and "503" send you to completely different places.
    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection refused');
  });
});

describe('the compose project the health gate inspects', () => {
  it('passes -p when the deployment has its own project name', async () => {
    const seen: string[][] = [];
    const runCommand = fakeRunCommand((argv) => {
      seen.push([...argv]);
      return { exitCode: 0, stdout: '[]' };
    });

    await containerStates({
      runCommand,
      deployRoot: '/opt/infra/apps/myapp',
      bindPort: 3535,
      composeProject: 'myapp',
    });

    // ⚠ THE DEFECT THIS PINS. `install` and `update` pass `-p <name>` on every
    // compose invocation, but this module built its own argv and passed none --
    // so `compose ps` was answered by the DIRECTORY-DERIVED default project
    // (`compose`), and the gate reported no containers for a stack that was up.
    // It failed only on deployments that have their own project name, which is
    // every deployment installed since the naming landed.
    expect(seen[0]).toContain('-p');
    expect(seen[0]?.[seen[0].indexOf('-p') + 1]).toBe('myapp');
  });

  it('passes no -p when none is recorded, which is the pre-naming default', async () => {
    const seen: string[][] = [];
    const runCommand = fakeRunCommand((argv) => {
      seen.push([...argv]);
      return { exitCode: 0, stdout: '[]' };
    });

    await containerStates({
      runCommand,
      deployRoot: '/opt/infra/apps/myapp',
      bindPort: 3535,
    });

    // ⚠ Absent means `compose`, the directory-derived name every deployment in
    // the field already runs under. Inventing one here would look at a project
    // that does not exist and report a healthy deployment as gone.
    expect(seen[0]).not.toContain('-p');
  });

  it('asks prisma for the migration state in that same project', async () => {
    const seen: string[][] = [];
    const runCommand = fakeRunCommand((argv) => {
      seen.push([...argv]);
      return { exitCode: 0, stdout: 'Database schema is up to date!' };
    });

    await migrationState({
      runCommand,
      deployRoot: '/opt/infra/apps/myapp',
      bindPort: 3535,
      composeProject: 'myapp',
    });

    // The migration probe is `compose run` -- a container in the project. Aimed
    // at the wrong one it starts a SECOND api container against the same
    // database, which is worse than the wrong answer it also gives.
    expect(seen[0]).toContain('-p');
    expect(seen[0]?.[seen[0].indexOf('-p') + 1]).toBe('myapp');
  });
});

describe('the compose files the health gate names (#531)', () => {
  function filesOf(argv: readonly string[] | undefined): string[] {
    return (argv ?? []).filter((_, index) => argv?.[index - 1] === '-f');
  }

  it('names the same files as install and update, from one shared list', async () => {
    const seen: string[][] = [];
    const runCommand = fakeRunCommand((argv) => {
      seen.push([...argv]);
      return { exitCode: 0, stdout: '[]' };
    });

    await containerStates({ runCommand, deployRoot: '/opt/infra/apps/myapp', bindPort: 3535 });
    await containerStates({
      runCommand,
      deployRoot: '/opt/infra/apps/myapp',
      bindPort: 3535,
      groups: ['observability'],
    });

    expect(filesOf(seen[0])).toEqual(composeFilesFor());
    expect(filesOf(seen[1])).toEqual(composeFilesFor(['observability']));
    expect(filesOf(seen[0])).toEqual(filesOf(composeArgv(['ps'])));
    expect(filesOf(seen[1])).toEqual(filesOf(composeArgv(['ps'], undefined, ['observability'])));
  });

  it('includes the telemetry stack in the migration probe when observability is on', async () => {
    const seen: string[][] = [];
    const runCommand = fakeRunCommand((argv) => {
      seen.push([...argv]);
      return { exitCode: 0, stdout: 'Database schema is up to date!' };
    });

    await migrationState({
      runCommand,
      deployRoot: '/opt/infra/apps/myapp',
      bindPort: 3535,
      groups: ['observability'],
    });

    expect(filesOf(seen[0])).toContain('telemetry.compose.yml');
    expect(filesOf(seen[0])).toContain('vps.telemetry.compose.yml');
  });

  it('names the telemetry stack even for a deployment recorded without it (#567)', async () => {
    const seen: string[][] = [];
    const runCommand = fakeRunCommand((argv) => {
      seen.push([...argv]);
      return { exitCode: 0, stdout: 'Database schema is up to date!' };
    });

    await migrationState({
      runCommand,
      deployRoot: '/opt/infra/apps/myapp',
      bindPort: 3535,
      groups: ['email'],
    });

    // Telemetry ships with every VPS deployment; `update` writes its keys.
    expect(filesOf(seen[0])).toContain('telemetry.compose.yml');
    expect(filesOf(seen[0])).toContain('vps.telemetry.compose.yml');
  });
});

describe('oauthSmoke (#391)', () => {
  const CLIENT = '123-abc.apps.googleusercontent.com';
  const CALLBACK = 'https://app.example.test/api/auth/google/callback';

  function api(options: { providers?: string[]; location?: string | null; status?: number }): typeof globalThis.fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/auth/providers')) {
        return new Response(
          JSON.stringify({ data: { providers: (options.providers ?? ['google']).map((name) => ({ name, enabled: true })) } }),
          { status: 200 },
        );
      }
      const headers = options.location === null ? undefined : { location: options.location ?? '' };
      return new Response(null, { status: options.status ?? 302, ...(headers === undefined ? {} : { headers }) });
    }) as typeof globalThis.fetch;
  }

  const good = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(CLIENT)}&redirect_uri=${encodeURIComponent(CALLBACK)}`;

  it('passes when google is listed and the redirect carries the configured client and callback', async () => {
    const smoke = await oauthSmoke({ base: 'http://x', clientId: CLIENT, callbackUrl: CALLBACK, fetch: api({ location: good }) });
    expect(smoke.status).toBe('pass');
  });

  it('fails when google is not listed', async () => {
    const smoke = await oauthSmoke({ base: 'http://x', clientId: CLIENT, callbackUrl: CALLBACK, fetch: api({ providers: [], location: good }) });
    expect(smoke.status).toBe('fail');
  });

  it('fails when the redirect carries another client id or callback', async () => {
    const other = good.replace(encodeURIComponent(CLIENT), 'someone-else');
    const smoke = await oauthSmoke({ base: 'http://x', clientId: CLIENT, callbackUrl: CALLBACK, fetch: api({ location: other }) });
    expect(smoke.status).toBe('fail');
    expect(smoke.detail).toContain('client_id');
  });

  it('fails when there is no redirect to Google', async () => {
    const smoke = await oauthSmoke({ base: 'http://x', clientId: CLIENT, callbackUrl: CALLBACK, fetch: api({ status: 500, location: null }) });
    expect(smoke.status).toBe('fail');
  });

  it('only warns when the API cannot be asked', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof globalThis.fetch;
    const smoke = await oauthSmoke({ base: 'http://x', clientId: CLIENT, callbackUrl: CALLBACK, fetch });
    expect(smoke.status).toBe('warn');
  });
});
