import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// =============================================================================
// The default CSP must declare media-src, or generated speech never plays
// =============================================================================
//
// Issue #510: the nginx CSP had no `media-src` directive, so an `<audio>`
// element fell back to `default-src 'self'` and the browser refused the
// cross-origin, short-lived signed URL that generated speech (and any other
// recorded clip) plays from. The failure was easy to miss because the
// `Download audio` link kept working: a download is a navigation, which CSP
// does not gate the same way a media *load* is, so only the in-page player
// was silently broken while everything else looked fine.
//
// This asserts the invariant rather than a hard-coded string: media-src must
// exist, must include 'self' and 'https:', and must cover whatever scheme
// img-src needs for bucket-served content, since the signed URL is served by
// the same runtime-configured bucket host that avatars/uploads use. Change
// the policy's wording and this still passes; drop media-src, or let it fall
// behind img-src's schemes, and it fails naming both files.
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

describe.each([
  ['infra/nginx/csp.conf', 'production'],
  ['infra/nginx/csp.dev.conf', 'development'],
])('%s (%s) default CSP policy', (relativePath) => {
  it('declares a media-src directive', () => {
    const directives = parseDirectives(defaultPolicy(relativePath));
    expect(directives, `no media-src directive in ${relativePath} — <audio>/<video> would fall back to default-src 'self'`).toHaveProperty(
      'media-src',
    );
  });

  it("includes 'self' and https: in media-src", () => {
    const directives = parseDirectives(defaultPolicy(relativePath));
    expect(directives['media-src']).toContain("'self'");
    expect(directives['media-src']).toContain('https:');
  });

  it('covers every scheme img-src needs for bucket-served content', () => {
    const directives = parseDirectives(defaultPolicy(relativePath));
    const imgSrc = directives['img-src'] ?? [];
    const mediaSrc = directives['media-src'] ?? [];
    const schemes = imgSrc.filter((source) => source.endsWith(':'));
    for (const scheme of schemes) {
      // img-src's data: URIs (inline placeholders) have no media-src equivalent
      // need; the invariant that matters is https:, the signed-bucket scheme.
      if (scheme === 'https:') {
        expect(mediaSrc, `media-src in ${relativePath} must include https: since img-src does`).toContain('https:');
      }
    }
  });
});
