// =============================================================================
// Android APK upload and download through nginx (issue #285, epic #276)
// =============================================================================
//
// A 150 MB APK only reaches the API if the edge proxy lets the body through
// (the generic `/api` block keeps nginx's 1 MB default) and only reaches the
// phone promptly if the download is not spooled first. Configuration, not
// code: asserted by reading the file the deployment uses, like
// `test/coach/coach-stream-nginx.spec.ts`.
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MAX_APK_BYTES } from '../../src/android-app/releases/android-release.constants';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const conf = readFileSync(resolve(repoRoot, 'infra/nginx/nginx.conf'), 'utf8');

function locationBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\s+/g, '\\s+');
  const match = conf.match(new RegExp(`location\\s+${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no "location ${selector}" block in infra/nginx/nginx.conf`);
  return match[1];
}

function directive(block: string, name: string): string | undefined {
  return block.match(new RegExp(`^\\s*${name}\\s+([^;]+);`, 'm'))?.[1].trim();
}

function megabytes(value: string): number {
  const m = value.match(/^(\d+)([kmg])?$/i);
  if (!m) throw new Error(`unparseable size ${value}`);
  return (Number(m[1]) * ({ k: 1 / 1024, m: 1, g: 1024 } as Record<string, number>)[(m[2] ?? 'm').toLowerCase()]);
}

describe('nginx: Android APK releases', () => {
  const api = locationBlock('/api');

  it('lets an upload of the largest APK (plus multipart overhead) through, streamed', () => {
    const block = locationBlock('= /api/admin/android-app/releases');

    expect(directive(block, 'proxy_pass')).toBe(directive(api, 'proxy_pass'));
    expect(megabytes(directive(block, 'client_max_body_size') ?? '1m')).toBeGreaterThan(MAX_APK_BYTES / (1024 * 1024));
    expect(directive(block, 'proxy_request_buffering')).toBe('off');
  });

  it('streams the download unbuffered', () => {
    const block = locationBlock('/api/android-app/download/');

    expect(directive(block, 'proxy_pass')).toBe(directive(api, 'proxy_pass'));
    expect(directive(block, 'proxy_buffering')).toBe('off');
  });

  it('declares both before the generic /api block', () => {
    expect(conf.indexOf('location = /api/admin/android-app/releases')).toBeLessThan(conf.indexOf('location /api {'));
    expect(conf.indexOf('location /api/android-app/download/')).toBeLessThan(conf.indexOf('location /api {'));
  });
});
