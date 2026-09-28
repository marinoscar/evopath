// The narrow, per-provider pin for the `openai` package (#448): it is imported
// ONLY by the OpenAI wire family — `ai/providers/openai/` (which also holds
// the mappers, engines and client helpers the family shares) and the two
// adapters composed from them, `ai/providers/azure-openai/` and
// `ai/providers/openai-compatible/`. `test/ai/ai-no-sdk-leak.spec.ts` already
// keeps every provider SDK inside SOME provider directory; this adds the
// stricter claim that no other provider's directory (or anything else)
// reaches for OpenAI's SDK.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_API = join(__dirname, '..', '..', '..');
const OWN_DIRS = ['ai/providers/openai/', 'ai/providers/azure-openai/', 'ai/providers/openai-compatible/'];
const PACKAGE = 'openai';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) return sourceFiles(full);

    return full.endsWith('.ts') ? [full] : [];
  });
}

function importsPackage(source: string): boolean {
  const pattern = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];

    if (specifier === PACKAGE || specifier.startsWith(`${PACKAGE}/`)) return true;
  }

  return false;
}

describe(`${PACKAGE} stays inside the OpenAI wire family`, () => {
  const files = sourceFiles(SRC_API).map((path) => ({ path, rel: relative(SRC_API, path).split('\\').join('/') }));
  const own = (rel: string) => OWN_DIRS.some((dir) => rel.startsWith(dir));

  it.each(OWN_DIRS)('finds %s importing it, so this cannot pass vacuously', (dir) => {
    expect(files.some((f) => f.rel.startsWith(dir) && importsPackage(readFileSync(f.path, 'utf8')))).toBe(true);
  });

  it('is imported nowhere else in apps/api/src', () => {
    const offenders = files
      .filter((f) => !own(f.rel))
      .filter((f) => importsPackage(readFileSync(f.path, 'utf8')))
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });
});
