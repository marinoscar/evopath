import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// =============================================================================
// Voice mode needs the microphone permitted and the SDP fetch not blocked
// =============================================================================
//
// Issue #559: nginx sent `Permissions-Policy: ... microphone=(), ...`. An
// EMPTY allowlist disables a device for EVERY origin, our own included, and
// no browser or site setting can override it — `getUserMedia()` rejected and
// `permissions.query({ name: 'microphone' })` reported `denied` everywhere,
// so the AI Playground's Voice mode
// (apps/web/src/hooks/useAiRealtimeSession.ts) could never start capturing
// audio. The fix grants the device to this origin only: `microphone=(self)`.
//
// The default CSP's `connect-src 'self'` had the same effect one step later:
// Voice mode's browser-side fetch of the SDP offer goes straight to the
// realtime provider's connect URL (e.g. https://api.openai.com/v1/realtime/calls),
// which is cross-origin, so `'self'` alone refused it. `connect-src 'self' https:`
// lets that fetch through.
//
// This asserts the invariants rather than exact strings: change the policy's
// wording and this still passes; regress either fix — an empty microphone
// allowlist, a microphone grant broad enough to leak to other origins, or a
// connect-src that drops back to 'self' only — and it fails naming the file.
// =============================================================================

const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

/** Strip commented-out lines the way the header comments explain they should be ignored. */
function withoutComments(conf: string): string {
  return conf
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** Extract the `default` entry's policy string from a `map $uri $csp_policy { ... }` block. */
function defaultPolicy(relativePath: string): string {
  const conf = withoutComments(read(relativePath));
  const block = conf.match(/map\s+\$uri\s+\$csp_policy\s*\{([\s\S]*)\}/);
  expect(block, `no map $uri $csp_policy block in ${relativePath}`).not.toBeNull();
  const match = block![1]!.match(/^\s*default\s+"([^"]*)"\s*;/m);
  expect(match, `no default entry in the csp_policy map in ${relativePath}`).not.toBeNull();
  return match![1]!;
}

/** Parse a CSP policy string into a map of directive name -> list of sources. */
function parseDirectives(policy: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...sources] = trimmed.split(/\s+/);
    directives[name!] = sources;
  }
  return directives;
}

/** Parse a `Permissions-Policy` header value into a map of directive name -> allowlist entries. */
function parsePermissionsPolicy(header: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([\w-]+)=\(([^)]*)\)$/);
    expect(match, `could not parse Permissions-Policy directive: "${trimmed}"`).not.toBeNull();
    const [, name, allowlist] = match!;
    directives[name!] = allowlist!.trim() === '' ? [] : allowlist!.trim().split(/\s+/);
  }
  return directives;
}

describe('nginx.conf Permissions-Policy header', () => {
  function permissionsPolicyDirectives(): Record<string, string[]> {
    const conf = withoutComments(read('infra/nginx/nginx.conf'));
    const matches = [...conf.matchAll(/add_header\s+Permissions-Policy\s+"([^"]*)"/g)];
    expect(matches, 'expected exactly one add_header Permissions-Policy in nginx.conf').toHaveLength(1);
    return parsePermissionsPolicy(matches[0]![1]!);
  }

  it('grants the microphone to this origin, not an empty allowlist', () => {
    const directives = permissionsPolicyDirectives();
    expect(directives, 'no microphone directive in Permissions-Policy').toHaveProperty('microphone');
    // An empty () disables the device for every origin, ours included — the
    // exact bug in issue #559 — so the allowlist must be non-empty.
    expect(directives['microphone']!.length).toBeGreaterThan(0);
    expect(directives['microphone']).toContain('self');
  });

  it('does not grant the microphone to every origin (*)', () => {
    const directives = permissionsPolicyDirectives();
    expect(directives['microphone']).not.toContain('*');
  });

  it('keeps camera disabled: the device is unused', () => {
    const directives = permissionsPolicyDirectives();
    expect(directives).toHaveProperty('camera');
    expect(directives['camera']).toEqual([]);
  });
});

describe.each([
  ['infra/nginx/csp.conf', 'production'],
  ['infra/nginx/csp.dev.conf', 'development'],
])('%s (%s) default CSP policy', (relativePath) => {
  it("includes 'self' and https: in connect-src, so Voice mode's SDP fetch to the provider is allowed", () => {
    const directives = parseDirectives(defaultPolicy(relativePath));
    expect(directives, `no connect-src directive in ${relativePath}`).toHaveProperty('connect-src');
    expect(directives['connect-src']).toContain("'self'");
    expect(directives['connect-src']).toContain('https:');
  });
});
