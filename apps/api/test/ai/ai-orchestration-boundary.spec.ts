// =============================================================================
// Orchestration libraries stay under `training-agents/` — cross-cutting
// conformance for the LangGraph boundary
// =============================================================================
//
// `@langchain/langgraph`, `@langchain/langgraph-checkpoint` and
// `@langchain/core` orchestrate model calls ABOVE `AiService`; they never make
// one. So:
//
//   (a) they may be imported only by files under `apps/api/src/training-agents/`;
//   (b) nothing in `apps/api/src` imports `langsmith` (a tracing client that
//       posts runs to a hosted endpoint) or the `langchain` umbrella package;
//   (c) nothing in `apps/web/src` imports any `@langchain/*` package (the
//       browser holds no orchestration runtime);
//   (d) `apps/api/package.json` declares no `@langchain/*` dependency beyond
//       `langgraph` and `core` (a provider integration such as
//       `@langchain/openai` is a model client of its own; the provider-SDK
//       list in `ai-no-sdk-leak.spec.ts` bans those by name).
//
// The file scan is the same package-name style as `ai-no-sdk-leak.spec.ts`
// (import specifiers, not a grep for a word), with assertions that fail if the
// scan ever stops seeing the tree. A last block pins the dual-package hazard:
// a second, differently resolved `@langchain/core` would make LangGraph's
// `instanceof` checks fail silently.
// =============================================================================

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const API_ROOT = join(__dirname, '..', '..');
const SRC_API = join(API_ROOT, 'src');
const SRC_WEB = join(API_ROOT, '..', 'web', 'src');
const TRAINING_AGENTS_DIR = 'training-agents/';

/** Orchestration packages: allowed, but only under `training-agents/`. */
const ORCHESTRATION_PACKAGES = ['@langchain/langgraph', '@langchain/langgraph-checkpoint', '@langchain/core'] as const;

/** Never imported anywhere in `apps/api/src`. */
const BANNED_IN_API = ['langsmith', 'langchain'] as const;

/** `@langchain/*` packages `apps/api/package.json` may declare (dev dependencies included). */
const ALLOWED_LANGCHAIN_DEPENDENCIES = new Set([
  '@langchain/langgraph',
  '@langchain/core',
  // Test-only: LangGraph's checkpointer conformance suite (a devDependency).
  '@langchain/langgraph-checkpoint-validation',
]);

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
  const patterns = [
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  return patterns.flatMap((re) => [...source.matchAll(re)].map((match) => match[1]));
}

/** True when `specifier` is `pkg` or a subpath of it. */
function names(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

interface ScannedFile {
  rel: string;
  specifiers: string[];
}

function scan(root: string): ScannedFile[] {
  return sourceFiles(root).map((file) => ({
    rel: relative(root, file).split('\\').join('/'),
    specifiers: importSpecifiers(readFileSync(file, 'utf8')),
  }));
}

describe('orchestration libraries stay under training-agents/', () => {
  it('matches a package and its subpaths but not look-alikes', () => {
    expect(names('@langchain/core/runnables', '@langchain/core')).toBe(true);
    expect(names('@langchain/langgraph-checkpoint', '@langchain/langgraph')).toBe(false);
    expect(names('langchain/agents', 'langchain')).toBe(true);
    expect(names('langchain-community', 'langchain')).toBe(false);
    expect(names('./langsmith', 'langsmith')).toBe(false);
  });

  describe('apps/api/src', () => {
    const files = scan(SRC_API);

    it('finds a non-trivial tree and real orchestration imports, so this cannot pass vacuously', () => {
      expect(files.length).toBeGreaterThan(100);

      const importing = files.filter((file) =>
        file.specifiers.some((s) => ORCHESTRATION_PACKAGES.some((pkg) => names(s, pkg))),
      );
      const importsOf = (pkg: string) =>
        importing.filter((file) => file.specifiers.some((s) => names(s, pkg))).map((file) => file.rel);

      expect(importing.length).toBeGreaterThan(0);
      expect(importsOf('@langchain/langgraph').length).toBeGreaterThan(0);
      expect(importsOf('@langchain/langgraph-checkpoint').length).toBeGreaterThan(0);
      expect(importsOf('@langchain/core').length).toBeGreaterThan(0);
    });

    it('imports langgraph, its checkpoint package and core only from training-agents/', () => {
      const offenders: string[] = [];

      for (const file of files) {
        if (file.rel.startsWith(TRAINING_AGENTS_DIR)) continue;

        for (const specifier of file.specifiers) {
          if (ORCHESTRATION_PACKAGES.some((pkg) => names(specifier, pkg))) {
            offenders.push(`${file.rel}: imports "${specifier}"`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });

    it('imports neither langsmith nor langchain anywhere, training-agents/ included', () => {
      const offenders: string[] = [];

      for (const file of files) {
        for (const specifier of file.specifiers) {
          if (BANNED_IN_API.some((pkg) => names(specifier, pkg))) {
            offenders.push(`${file.rel}: imports "${specifier}"`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });

  describe('apps/web/src', () => {
    const files = scan(SRC_WEB);

    it('finds a non-trivial tree, so this cannot pass vacuously', () => {
      expect(files.length).toBeGreaterThan(50);
    });

    it('imports no @langchain/* package', () => {
      const offenders: string[] = [];

      for (const file of files) {
        for (const specifier of file.specifiers) {
          if (specifier.startsWith('@langchain/')) offenders.push(`${file.rel}: imports "${specifier}"`);
        }
      }

      expect(offenders).toEqual([]);
    });
  });

  describe('apps/api/package.json', () => {
    const manifest = JSON.parse(readFileSync(join(API_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];

    it('declares the two orchestration packages, so this cannot pass vacuously', () => {
      expect(Object.keys(manifest.dependencies ?? {})).toEqual(
        expect.arrayContaining(['@langchain/langgraph', '@langchain/core']),
      );
    });

    it('declares no @langchain/* package beyond langgraph and core', () => {
      const unexpected = declared.filter((name) => name.startsWith('@langchain/') && !ALLOWED_LANGCHAIN_DEPENDENCIES.has(name));

      expect(unexpected).toEqual([]);
    });

    it('declares no langchain, langsmith or @ai-sdk/* package', () => {
      const unexpected = declared.filter(
        (name) => name === 'langchain' || name === 'langsmith' || name.startsWith('@ai-sdk/'),
      );

      expect(unexpected).toEqual([]);
    });

    it('keeps the checkpointer conformance suite a devDependency, never a runtime one', () => {
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@langchain/langgraph-checkpoint-validation');
    });
  });

  describe('dual-package hazard', () => {
    /** Every `node_modules/@langchain/core` directory reachable from the API and from LangGraph. */
    function coreCopies(): string[] {
      const roots = [__dirname, dirname(require.resolve('@langchain/langgraph/package.json'))];
      const found = new Set<string>();

      for (const start of roots) {
        for (let dir = start; ; dir = dirname(dir)) {
          const candidate = join(dir, 'node_modules', '@langchain', 'core');
          if (existsSync(join(candidate, 'package.json'))) found.add(realpathSync(candidate));
          if (dirname(dir) === dir) break;
        }
      }

      return [...found];
    }

    it('resolves exactly one @langchain/core, the same one from the API and from LangGraph', () => {
      const fromApi = require.resolve('@langchain/core/package.json');
      const langgraphDir = dirname(require.resolve('@langchain/langgraph/package.json'));
      const fromLangGraph = require.resolve('@langchain/core/package.json', { paths: [langgraphDir] });

      expect(realpathSync(fromApi)).toBe(realpathSync(fromLangGraph));
      expect(coreCopies()).toHaveLength(1);
    });

    it('resolves the CommonJS entry of @langchain/core, not an ESM copy', () => {
      const entry = require.resolve('@langchain/core/runnables');

      expect(entry).toMatch(/\.cjs$|\/dist\/.*\.js$/);
      expect(entry).not.toMatch(/\.mjs$/);
      expect(require('@langchain/core/runnables')).toBe(require('@langchain/core/runnables'));
    });
  });
});
