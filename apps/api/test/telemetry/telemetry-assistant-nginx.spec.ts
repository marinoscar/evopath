// =============================================================================
// The telemetry assistant's stream through nginx (issue #536, epic #528)
// =============================================================================
//
// `POST /api/admin/telemetry/assistant/stream` only streams if nginx forwards
// it unbuffered and does not reap it after the generic `/api` block's read
// timeout — asserted against the file the deployment uses, like
// `test/ai/ai-stream-nginx.spec.ts` does for the AI response stream.
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AI_SSE_HEARTBEAT_MS } from '../../src/ai/http/ai-sse';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const conf = readFileSync(resolve(repoRoot, 'infra/nginx/nginx.conf'), 'utf8');

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

describe('nginx: location /api/admin/telemetry/assistant/stream', () => {
  const block = locationBlock('/api/admin/telemetry/assistant/stream');

  it('proxies to the same upstream as /api', () => {
    expect(directive(block, 'proxy_pass')).toBe(directive(locationBlock('/api'), 'proxy_pass'));
  });

  it('disables proxy buffering and caching', () => {
    expect(directive(block, 'proxy_buffering')).toBe('off');
    expect(directive(block, 'proxy_cache')).toBe('off');
  });

  it('speaks HTTP/1.1 without a WebSocket upgrade header', () => {
    expect(directive(block, 'proxy_http_version')).toBe('1.1');
    expect(block).toMatch(/proxy_set_header\s+Connection\s+'';/);
  });

  it('outlasts the generic read timeout, and many heartbeats', () => {
    const read = seconds(directive(block, 'proxy_read_timeout') ?? '60s');

    expect(read).toBeGreaterThan(seconds(directive(locationBlock('/api'), 'proxy_read_timeout') ?? '60s'));
    expect(read * 1000).toBeGreaterThan(AI_SSE_HEARTBEAT_MS * 4);
  });
});
