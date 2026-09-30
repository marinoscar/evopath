// =============================================================================
// nginx's stub_status stays internal (issue #124)
// =============================================================================
//
// The telemetry collector scrapes nginx edge counters from `stub_status`. That
// page must be reachable from the compose network and from nowhere else, and
// the guarantee rests on three files agreeing:
//
//   - infra/nginx/nginx.conf serves it only on a SEPARATE listener, allow-listed
//     to loopback and private ranges, and answers 404 for the path on the
//     public listener (which would otherwise hand it to the SPA);
//   - no compose file publishes that listener's port;
//   - the collector's `nginx` receiver scrapes exactly that port and path.
//
// Asserted against the files the deployment uses, like the other nginx specs.
// =============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

/** nginx.conf with comments removed, so prose mentioning a directive never matches. */
const conf = read('infra/nginx/nginx.conf')
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

/** Every top-level `server { ... }` block inside `http`, braces balanced. */
function serverBlocks(): string[] {
  const blocks: string[] = [];
  const re = /\bserver\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(conf)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (depth > 0 && i < conf.length) {
      if (conf[i] === '{') depth++;
      if (conf[i] === '}') depth--;
      i++;
    }
    blocks.push(conf.slice(match.index, i));
    re.lastIndex = i;
  }

  return blocks;
}

function listenPorts(block: string): string[] {
  return [...block.matchAll(/^\s*listen\s+(\d+)[^;]*;/gm)].map((m) => m[1]);
}

function location(block: string, spec: string): string | undefined {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return block.match(new RegExp(`location\\s+${escaped}\\s*\\{([^}]*)\\}`))?.[1];
}

const servers = serverBlocks();
const statusServers = servers.filter((block) => /\bstub_status\s*;/.test(block));
const publicServer = servers.find((block) => listenPorts(block).includes('80'));

describe('nginx stub_status (issue #124)', () => {
  it('is served by exactly one server block, not the public one', () => {
    expect(statusServers).toHaveLength(1);
    expect(publicServer).toBeDefined();
    expect(publicServer).not.toMatch(/\bstub_status\b/);
  });

  const status = statusServers[0] ?? '';
  const statusPorts = listenPorts(status);

  it('listens on its own port, never on the public 80', () => {
    expect(statusPorts).toHaveLength(1);
    expect(statusPorts).not.toContain('80');
  });

  it('admits only loopback and private ranges, and denies everything else last', () => {
    const rules = [...status.matchAll(/^\s*(allow|deny)\s+([^;]+);/gm)].map((m) => `${m[1]} ${m[2].trim()}`);

    expect(rules.at(-1)).toBe('deny all');
    for (const rule of rules.slice(0, -1)) {
      expect(rule).toMatch(/^allow (127\.0\.0\.1|10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16)$/);
    }
  });

  it('answers the status path with 404 on the public listener', () => {
    const block = location(publicServer ?? '', '= /nginx_status');

    expect(block).toBeDefined();
    expect(block).toMatch(/^\s*return\s+404\s*;/m);
  });

  it('is published by no compose file', () => {
    const composeDir = resolve(repoRoot, 'infra/compose');
    const port = statusPorts[0];

    for (const file of readdirSync(composeDir).filter((name) => name.endsWith('.yml'))) {
      const text = read(`infra/compose/${file}`);
      // A container-side port in any `ports:` mapping: "...:8081" or "8081".
      expect({ file, publishes: new RegExp(`^\\s+- "?(?:[^"\\s]*:)?${port}(?:/tcp)?"?\\s*$`, 'm').test(text) })
        .toEqual({ file, publishes: false });
    }
  });

  it('is the port and path the collector nginx receiver scrapes', () => {
    const collector = read('infra/otel/otel-collector-config.yaml');
    const receiver = collector.match(/^ {2}nginx:\s*\n((?: {4}.*\n)+)/m)?.[1] ?? '';

    expect(receiver).toMatch(new RegExp(`endpoint:\\s*http://nginx:${statusPorts[0]}/nginx_status\\s*$`, 'm'));
    expect(collector).toMatch(/receivers: \[[^\]]*\bnginx\b[^\]]*\]/);
  });
});
