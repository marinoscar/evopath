// =============================================================================
// No AI provider SDK leaks outside its own adapter — cross-cutting
// conformance (issue #435, epic #419)
// =============================================================================
//
// `ai/core/no-provider-sdk.spec.ts` already pins the narrow, permanent claim
// that `ai/core` itself imports nothing beyond `zod`/`@nestjs/common`. This
// suite is the wider one the issue asks for: NO file anywhere in
// `apps/api/src`, OUTSIDE `ai/providers/<provider>/`, may import a provider
// SDK — not `ai/config`, not `ai/keys`, not `ai/http`, not a controller, not
// a job handler — and NO file anywhere in `apps/web/src` may import one
// either (the browser must never hold a provider SDK any more than it may
// hold a provider key).
//
// THE BANNED LIST IS PACKAGE NAMES, NOT A GREP FOR "openai" AS A STRING —
// so a comment or a variable named `openaiKeyHint` does not fail this suite.
// It is deliberately wider than what `package.json` happens to declare today
// (only `openai`): a fork adding `@anthropic-ai/sdk` or `@google/genai`
// without also adding its adapter under `ai/providers/<id>/` should fail
// here on day one, not be missed because the list only knew about the SDK
// already in the tree.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_API = join(__dirname, '..', '..', 'src');
const SRC_WEB = join(__dirname, '..', '..', '..', 'web', 'src');
const PROVIDERS_DIR = join(SRC_API, 'ai', 'providers');

/**
 * Known AI provider SDK package names. Not exhaustive of every SDK that will
 * ever exist — exhaustive of every one worth naming so a reviewer adding a
 * new provider sees this list and extends it, the same "argued list" shape
 * `cron-enqueue-only.spec.ts`'s exemption array uses.
 */
const PROVIDER_SDK_PACKAGES = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/genai',
  '@google/generative-ai',
  '@google-cloud/vertexai',
  'cohere-ai',
  '@mistralai/mistralai',
  'mistralai',
  'groq-sdk',
  '@aws-sdk/client-bedrock-runtime',
  'replicate',
  'together-ai',
  'ollama',
] as const;

function sourceFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];

  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const stat = statSync(full);

    if (stat.isDirectory()) return sourceFiles(full);
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) return [];
    if (entry.endsWith('.spec.ts') || entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) return [];

    return [full];
  });
}

function importSpecifiers(source: string): string[] {
  const pattern =
    // named/default/namespace import or re-export ... from '...'
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g;
  const bareImportPattern = /import\s+['"]([^'"]+)['"]/g; // side-effect-only `import '...'`
  const dynamicPattern = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const specifiers: string[] = [];

  for (const re of [pattern, bareImportPattern, dynamicPattern, requirePattern]) {
    for (const match of source.matchAll(re)) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

/** True when `specifier` names (or is a subpath of) a banned provider SDK package. */
function namesProviderSdk(specifier: string): boolean {
  return PROVIDER_SDK_PACKAGES.some(
    (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
  );
}

describe('no AI provider SDK leaks outside its own adapter directory (#435)', () => {
  describe('apps/api/src', () => {
    const files = sourceFiles(SRC_API).map((file) => ({
      path: file,
      rel: relative(SRC_API, file).split('\\').join('/'),
    }));

    /** Every provider's own directory (`ai/providers/openai`, …) — the ONLY exemption. */
    const providerDirs = readdirSync(PROVIDERS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `ai/providers/${entry.name}/`);

    it('finds a non-trivial source tree and at least one provider directory, so this cannot pass vacuously', () => {
      expect(files.length).toBeGreaterThan(100);
      expect(providerDirs.length).toBeGreaterThanOrEqual(1);
      expect(providerDirs).toContain('ai/providers/openai/');
    });

    it('imports no provider SDK outside its own adapter directory', () => {
      const offenders: string[] = [];

      for (const file of files) {
        const exempt = providerDirs.some((dir) => file.rel.startsWith(dir));
        if (exempt) continue;

        const specifiers = importSpecifiers(readFileSync(file.path, 'utf8'));

        for (const specifier of specifiers) {
          if (namesProviderSdk(specifier)) {
            offenders.push(`${file.rel}: imports "${specifier}"`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });

  describe('apps/web/src', () => {
    const files = sourceFiles(SRC_WEB).map((file) => ({
      path: file,
      rel: relative(SRC_WEB, file).split('\\').join('/'),
    }));

    it('finds a non-trivial source tree, so this cannot pass vacuously', () => {
      expect(files.length).toBeGreaterThan(50);
    });

    it('imports no provider SDK anywhere — the browser must never hold one, any more than it may hold a provider key', () => {
      const offenders: string[] = [];

      for (const file of files) {
        const specifiers = importSpecifiers(readFileSync(file.path, 'utf8'));

        for (const specifier of specifiers) {
          if (namesProviderSdk(specifier)) {
            offenders.push(`${file.rel}: imports "${specifier}"`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });
});
