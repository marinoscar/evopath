import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkoutEdgeHashes,
  compareEdgeConfig,
  parseSha256sum,
  reconcileEdgeConfig,
  type RunningRead,
} from './edge-config.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A checkout holding the two nginx files with the given contents. */
function checkoutWith(nginx: string, csp: string): string {
  const root = mkdtempSync(join(tmpdir(), 'evopathcli-edge-'));
  mkdirSync(join(root, 'infra', 'nginx'), { recursive: true });
  writeFileSync(join(root, 'infra', 'nginx', 'nginx.conf'), nginx);
  writeFileSync(join(root, 'infra', 'nginx', 'csp.conf'), csp);
  return root;
}

function sha256sumOutput(nginx: string, csp: string): string {
  return `${sha(nginx)}  /etc/nginx/nginx.conf\n${sha(csp)}  /etc/nginx/csp.conf\n`;
}

describe('parseSha256sum', () => {
  it('reads GNU/busybox lines, binary-mode stars and CRLF, ignoring anything else', () => {
    const a = 'a'.repeat(64);
    const b = 'B'.repeat(64);
    const parsed = parseSha256sum(
      [
        `${a}  /etc/nginx/nginx.conf\r`,
        `${b} */etc/nginx/csp.conf`,
        'sha256sum: /etc/nginx/missing.conf: No such file or directory',
        '',
        'not-a-hash  /etc/nginx/other.conf',
      ].join('\n'),
    );

    expect(parsed).toEqual(
      new Map([
        ['/etc/nginx/nginx.conf', a],
        // Lowercased, so a comparison against Node's hex digest is exact.
        ['/etc/nginx/csp.conf', 'b'.repeat(64)],
      ]),
    );
  });

  it('returns an empty map for empty output', () => {
    expect(parseSha256sum('').size).toBe(0);
  });
});

describe('checkoutEdgeHashes and compareEdgeConfig', () => {
  it('keys the checkout hashes by container path', () => {
    const root = checkoutWith('events {}', "add_header X 'y';");
    expect(checkoutEdgeHashes(root)).toEqual(
      new Map([
        ['/etc/nginx/nginx.conf', sha('events {}')],
        ['/etc/nginx/csp.conf', sha("add_header X 'y';")],
      ]),
    );
  });

  it('reports each file that differs or is missing from the container', () => {
    const expected = new Map([
      ['/etc/nginx/nginx.conf', sha('new')],
      ['/etc/nginx/csp.conf', sha('csp')],
    ]);
    expect(compareEdgeConfig(expected, new Map([['/etc/nginx/nginx.conf', sha('old')]]))).toEqual([
      { file: '/etc/nginx/nginx.conf', expected: sha('new'), running: sha('old') },
      { file: '/etc/nginx/csp.conf', expected: sha('csp'), running: undefined },
    ]);
    expect(compareEdgeConfig(expected, new Map(expected))).toEqual([]);
  });
});

describe('reconcileEdgeConfig', () => {
  /** Answers each read in turn from `outputs`, counting recreates. */
  function harness(root: string, reads: RunningRead[]) {
    const lines: string[] = [];
    let recreates = 0;
    let index = 0;
    const options = {
      checkoutPath: root,
      readRunning: async () => reads[Math.min(index++, reads.length - 1)] as RunningRead,
      recreate: async () => {
        recreates += 1;
      },
      manualCommand: 'docker compose -p demo up -d --no-deps --force-recreate nginx',
      line: (text: string) => void lines.push(text),
    };
    return { options, lines, recreates: () => recreates, reads: () => index };
  }

  it('does nothing but say so when the running config matches', async () => {
    const root = checkoutWith('new', 'csp');
    const h = harness(root, [{ hashes: parseSha256sum(sha256sumOutput('new', 'csp')) }]);

    await expect(reconcileEdgeConfig(h.options)).resolves.toBe('current');
    expect(h.recreates()).toBe(0);
    expect(h.lines.join('\n')).toContain('current');
  });

  it('recreates ONCE on drift, naming the file, and succeeds when the new container matches', async () => {
    const root = checkoutWith('events { geolocation=(self) }', 'csp');
    const h = harness(root, [
      { hashes: parseSha256sum(sha256sumOutput('events { geolocation=() }', 'csp')) },
      { hashes: parseSha256sum(sha256sumOutput('events { geolocation=(self) }', 'csp')) },
    ]);

    await expect(reconcileEdgeConfig(h.options)).resolves.toBe('recreated');
    expect(h.recreates()).toBe(1);
    expect(h.reads()).toBe(2);
    const journal = h.lines.join('\n');
    expect(journal).toContain('/etc/nginx/nginx.conf');
    expect(journal).not.toContain('/etc/nginx/csp.conf:');
  });

  it('recreates when nginx is not running (the read failed)', async () => {
    const root = checkoutWith('new', 'csp');
    const h = harness(root, [
      { hashes: new Map(), error: 'service "nginx" is not running' },
      { hashes: parseSha256sum(sha256sumOutput('new', 'csp')) },
    ]);

    await expect(reconcileEdgeConfig(h.options)).resolves.toBe('recreated');
    expect(h.recreates()).toBe(1);
    expect(h.lines.join('\n')).toContain('not running');
  });

  it('throws an actionable error when a recreated nginx still serves the old config', async () => {
    const root = checkoutWith('new', 'csp');
    const stale = { hashes: parseSha256sum(sha256sumOutput('old', 'csp')) };
    const h = harness(root, [stale, stale]);

    const error = await reconcileEdgeConfig(h.options).catch((caught: unknown) => caught);

    expect(h.recreates()).toBe(1);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('/etc/nginx/nginx.conf');
    expect(message).toContain('OLD config');
    expect(message).toContain('docker compose -p demo up -d --no-deps --force-recreate nginx');
  });

  it('has nothing to compare when the checkout carries no nginx config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evopathcli-edge-empty-'));
    const h = harness(root, [{ hashes: new Map() }]);

    await expect(reconcileEdgeConfig(h.options)).resolves.toBe('nothing-to-check');
    expect(h.reads()).toBe(0);
    expect(h.recreates()).toBe(0);
  });
});
