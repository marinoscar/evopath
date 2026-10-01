// =============================================================================
// The AI Coach chat stream through nginx (E7.7, #247)
// =============================================================================
//
// `POST /api/coach/chat/stream` only streams in production if the reverse
// proxy forwards it unbuffered and does not reap it after the generic `/api`
// block's 60s read timeout. Configuration, not code: asserted by reading the
// file the deployment uses, like `test/ai/ai-stream-nginx.spec.ts`. The CLI's
// generated VPS vhost has the same block, asserted by
// `apps/cli/src/deploy/proxy.test.ts`.
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AI_SSE_HEADERS, AI_SSE_HEARTBEAT_MS } from '../../src/ai/http/ai-sse';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const conf = readFileSync(resolve(repoRoot, 'infra/nginx/nginx.conf'), 'utf8');

const PATH = '/api/coach/chat/stream';

/** The body of `location <path> { … }` (no nested blocks inside a location here). */
function locationBlock(path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = conf.match(new RegExp(`location\\s+${escaped}\\s*\\{([^}]*)\\}`));

  if (!match) throw new Error(`no "location ${path}" block in infra/nginx/nginx.conf`);

  return match[1];
}

function seconds(value: string): number {
  const m = value.match(/^(\d+)(s|m|h)?$/);
  if (!m) throw new Error(`unparseable duration ${value}`);
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600 } as Record<string, number>)[m[2] ?? 's'];
}

function directive(block: string, name: string): string | undefined {
  return block.match(new RegExp(`^\\s*${name}\\s+([^;]+);`, 'm'))?.[1].trim();
}

describe(`nginx: location ${PATH}`, () => {
  const block = locationBlock(PATH);

  it('proxies to the same upstream as /api', () => {
    expect(directive(block, 'proxy_pass')).toBe(directive(locationBlock('/api'), 'proxy_pass'));
  });

  it('disables proxy buffering and caching', () => {
    expect(directive(block, 'proxy_buffering')).toBe('off');
    expect(directive(block, 'proxy_cache')).toBe('off');
  });

  it("speaks HTTP/1.1 with Connection '' (no WebSocket upgrade header)", () => {
    expect(directive(block, 'proxy_http_version')).toBe('1.1');
    expect(block).toMatch(/proxy_set_header\s+Connection\s+'';/);
  });

  it('outlasts the generic 60s read timeout, and many heartbeats', () => {
    const read = seconds(directive(block, 'proxy_read_timeout') ?? '60s');

    expect(read).toBeGreaterThan(seconds(directive(locationBlock('/api'), 'proxy_read_timeout') ?? '60s'));
    expect(read * 1000).toBeGreaterThan(AI_SSE_HEARTBEAT_MS * 4);
  });

  it('is declared before the /api block it must win over', () => {
    expect(conf.indexOf(`location ${PATH}`)).toBeLessThan(conf.indexOf('location /api {'));
  });

  it('never gzips an event stream', () => {
    const gzipTypes = conf.match(/gzip_types([^;]+);/)?.[1] ?? '';

    expect(gzipTypes).not.toContain('text/event-stream');
  });

  it('matches the header the API sends', () => {
    expect(AI_SSE_HEADERS['X-Accel-Buffering']).toBe('no');
  });
});
