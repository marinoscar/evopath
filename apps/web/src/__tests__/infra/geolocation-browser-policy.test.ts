import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// =============================================================================
// "Use my location" on a gym needs geolocation permitted for this origin
// =============================================================================
//
// E3.5: a gym may carry an optional GPS position, and the gym page offers a
// one-shot "Use my location" (apps/web/src/hooks/useGeolocationOnce.ts). nginx
// used to send `Permissions-Policy: ... geolocation=() ...`; an EMPTY allowlist
// disables the feature for every origin, ours included, so
// `getCurrentPosition` failed with PERMISSION_DENIED whatever the user chose.
// The fix grants it to this origin only: `geolocation=(self)`.
//
// Sibling of voice-mode-browser-policy.test.ts, with the same header parser.
// It asserts invariants rather than the exact header string: regress to an
// empty allowlist, widen the grant to every origin, or quietly enable the
// camera (photos use `<input capture>`, which needs no policy) and it fails.
// =============================================================================

const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function withoutComments(conf: string): string {
  return conf
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
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

function permissionsPolicyDirectives(): Record<string, string[]> {
  const conf = withoutComments(read('infra/nginx/nginx.conf'));
  const matches = [...conf.matchAll(/add_header\s+Permissions-Policy\s+"([^"]*)"/g)];
  expect(matches, 'expected exactly one add_header Permissions-Policy in nginx.conf').toHaveLength(1);
  return parsePermissionsPolicy(matches[0]![1]!);
}

describe('nginx.conf Permissions-Policy geolocation', () => {
  it('grants geolocation to this origin only: geolocation=(self)', () => {
    const directives = permissionsPolicyDirectives();
    expect(directives, 'no geolocation directive in Permissions-Policy').toHaveProperty('geolocation');
    expect(directives['geolocation']).toEqual(['self']);
  });

  it('keeps camera disabled and payment disabled', () => {
    const directives = permissionsPolicyDirectives();
    expect(directives['camera']).toEqual([]);
    expect(directives['payment']).toEqual([]);
  });

  it('leaves the microphone grant for Voice mode unchanged', () => {
    expect(permissionsPolicyDirectives()['microphone']).toEqual(['self']);
  });
});

describe.each([
  ['docs/SECURITY-ARCHITECTURE.md'],
  ['docs/API.md'],
])('%s documents the header nginx sends', (relativePath) => {
  it('shows geolocation=(self)', () => {
    const doc = read(relativePath);
    expect(doc).toContain('Permissions-Policy');
    expect(doc).toContain('geolocation=(self)');
    expect(doc).not.toContain('geolocation=()');
  });
});
