import { describe, expect, it } from 'vitest';

import type { CheckFs } from './checks/index.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions, type runCommand } from './executor.js';
import { proxyRuntimeFor } from './proxy.js';
import { RENEWAL_SCHEDULE, ensureRenewal, renderRenewalCron } from './renewal.js';

const ROOT = '/opt/infra/proxy';
const CONTAINER = proxyRuntimeFor('container', ROOT, 'proxy-nginx');
const HOST = proxyRuntimeFor('host', ROOT);

/** No crontab, no enabled timer: every probe fails. */
const nothingScheduled = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
  const result: CommandResult = { argv, cwd: options.cwd, exitCode: 1, stdout: '', stderr: 'no', durationMs: 0, timedOut: false };
  throw new CommandFailedError('no', result);
}) as typeof runCommand;

function fsWith(files: Record<string, string>): CheckFs {
  return {
    exists: (path) => path in files,
    isDirectory: () => false,
    isWritable: () => true,
    readFile: (path) => files[path],
    readdir: (path) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => file.slice(path.length + 1)),
  };
}

describe('renderRenewalCron', () => {
  it('renews with the dockerised certbot, then validates and reloads the proxy container', () => {
    const content = renderRenewalCron({ proxyRoot: ROOT }, CONTAINER);
    const line = content.split('\n').find((entry) => entry.startsWith(RENEWAL_SCHEDULE)) ?? '';

    expect(line).toContain(' root docker run --rm');
    expect(line).toContain(`-v ${ROOT}/letsencrypt:/etc/letsencrypt`);
    expect(line).toContain(`-v ${ROOT}/webroot:/var/www/certbot`);
    expect(line).toContain('certbot/certbot:latest renew --quiet');
    // Validate BEFORE reload, and the reload is there at all.
    expect(line.indexOf('nginx -t')).toBeLessThan(line.indexOf('nginx -s reload'));
    expect(line).toContain('docker exec proxy-nginx nginx -s reload');
    expect(line).not.toContain('--config-dir');
  });

  it('uses the host certbot with its state under the proxy root in host mode', () => {
    const line = renderRenewalCron({ proxyRoot: ROOT }, HOST);
    expect(line).toContain(`certbot renew --quiet --config-dir ${ROOT}/letsencrypt`);
    expect(line).toContain('&& nginx -t -q && nginx -s reload');
    expect(line).not.toContain('docker');
  });

  it('is deterministic', () => {
    expect(renderRenewalCron({ proxyRoot: ROOT }, CONTAINER)).toBe(renderRenewalCron({ proxyRoot: `${ROOT}/` }, CONTAINER));
  });

  it('refuses a proxy root that cannot be written into a cron line safely', () => {
    expect(() => renderRenewalCron({ proxyRoot: '/opt/my proxy' }, CONTAINER)).toThrow();
    expect(() => renderRenewalCron({ proxyRoot: '/opt/proxy;rm -rf /' }, CONTAINER)).toThrow();
  });
});

describe('ensureRenewal', () => {
  const cronPath = '/tmp/test-renewal-cron';

  it('does nothing when a central script owns renewal', async () => {
    const writes: string[] = [];
    const result = await ensureRenewal({
      proxyRoot: ROOT,
      runtime: CONTAINER,
      runCommand: nothingScheduled,
      fs: fsWith({
        '/etc/cron.d/renew-all': `0 3 * * * root ${ROOT}/renew.sh\n`,
        [`${ROOT}/renew.sh`]: '#!/bin/sh\ndocker run certbot/certbot renew\n',
      }),
      cronPath,
      readFile: () => undefined,
      writeFile: (path) => writes.push(path),
    });

    expect(result.action).toBe('owned-elsewhere');
    expect(result.detail).toContain('central');
    expect(writes).toEqual([]);
  });

  it('installs the schedule when nothing renews', async () => {
    const writes: { path: string; content: string }[] = [];
    const result = await ensureRenewal({
      proxyRoot: ROOT,
      runtime: CONTAINER,
      runCommand: nothingScheduled,
      fs: fsWith({}),
      cronPath,
      readFile: () => undefined,
      writeFile: (path, content) => writes.push({ path, content }),
    });

    expect(result.action).toBe('installed');
    expect(writes).toEqual([{ path: cronPath, content: renderRenewalCron({ proxyRoot: ROOT }, CONTAINER) }]);
  });

  it('is a no-op when the file already holds identical content', async () => {
    const writes: string[] = [];
    const result = await ensureRenewal({
      proxyRoot: ROOT,
      runtime: CONTAINER,
      runCommand: nothingScheduled,
      fs: fsWith({}),
      cronPath,
      readFile: () => renderRenewalCron({ proxyRoot: ROOT }, CONTAINER),
      writeFile: (path) => writes.push(path),
    });

    expect(result.action).toBe('current');
    expect(writes).toEqual([]);
  });

  it('reports, rather than throws, when the file cannot be written -- with the content as the remedy', async () => {
    const result = await ensureRenewal({
      proxyRoot: ROOT,
      runtime: CONTAINER,
      runCommand: nothingScheduled,
      fs: fsWith({}),
      cronPath,
      readFile: () => undefined,
      writeFile: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    });

    expect(result.action).toBe('not-writable');
    expect(result.detail).toContain('EACCES');
    expect(result.remedy).toContain(renderRenewalCron({ proxyRoot: ROOT }, CONTAINER));
  });
});
