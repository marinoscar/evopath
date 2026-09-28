/**
 * `__APP_VERSION__` — the version of THE BUNDLE, baked in at build time.
 *
 * Issue #401, epic #397. Config-side code: `vite.config.ts`,
 * `vitest.config.ts` and `visual/vite.config.ts` all import this, and the
 * React tree never does — it sees only the `__APP_VERSION__` constant the
 * define substitutes. Lives in its own top-level directory beside `pwa/` for
 * the same reason that directory gives: it is build configuration the browser
 * must not bundle, and a function is something the test suite can call.
 *
 * ⚠ THE DIRECTORY IS `build-config/`, NOT `build/`, and the hyphen is
 * load-bearing: the repository's `.gitignore` ignores `build/` outright as a
 * build OUTPUT directory, so a source file placed there typecheck-passes,
 * test-passes, builds — and is silently never committed, leaving CI to fail on
 * three configs importing a module that does not exist in the checkout.
 *
 * =============================================================================
 * ⚠ WHY THIS IS A BUILD-TIME CONSTANT AND NOT A FETCH
 * =============================================================================
 *
 * `GET /api/admin/about` already reports a version, and using it for the
 * version line in the user menu would be the obvious move and the wrong one.
 * That number describes the API PROCESS. This one describes the JavaScript the
 * browser is currently executing, and the entire value of a version line is
 * that the two can differ:
 *
 *   - A browser (or a CDN, or a service worker) holding a stale bundle serves
 *     yesterday's JavaScript against today's API. Baked in, the line says the
 *     old version and the mismatch is visible — which is exactly the bug the
 *     user is reporting when they say "it still does the old thing". Fetched,
 *     the stale bundle cheerfully renders the NEW number and hides it.
 *   - A user reporting a bug reads this line. It must describe the code that
 *     produced the behaviour they saw, not the code the server happens to be
 *     running when the report is written.
 *
 * So this is deliberately unreachable by any runtime lookup, and the About page
 * says so in as many words beside the API's own version.
 *
 * =============================================================================
 * ⚠ WHY EVERY CONFIG MUST SPREAD IT, AND WHY IT LIVES IN ONE FILE
 * =============================================================================
 *
 * `vite.config.ts`, `vitest.config.ts` and `visual/vite.config.ts` are three
 * separate files with NO shared base — Vite configs do not inherit. A define
 * declared in only the build config leaves `__APP_VERSION__` as a free
 * identifier everywhere else:
 *
 *   - under Vitest, every test that renders `UserMenu` throws
 *     `__APP_VERSION__ is not defined`;
 *   - in the visual harness, the AppBar mounts `UserMenu`, so all eleven pixel
 *     specs fail on a blank page rather than on a diff — the failure mode
 *     `apps/web/visual/vite.config.ts` already documents for `@app/shared`.
 *
 * One exported object, spread into all three, is what makes that
 * unrepresentable rather than merely remembered.
 *
 * =============================================================================
 * ⚠ WHY THE VERSION IS IMPORTED, NOT READ FROM `import.meta.url`
 * =============================================================================
 *
 * Vite and Vitest both BUNDLE a config file with esbuild before executing it,
 * and the bundle is written to a temporary directory. `import.meta.url` (and
 * `__dirname`) therefore point at that temp directory, not at `apps/web`, so
 * `readFileSync(new URL('../package.json', import.meta.url))` resolves
 * somewhere else entirely — and it fails at a different path depending on which
 * config is loading, which is the worst possible shape for this bug.
 *
 * A static `import` has no such problem: it is resolved by the bundler at build
 * time, relative to THIS file's real location on disk, and the JSON is inlined
 * into the bundle before any of it runs.
 */

import pkg from '../package.json' with { type: 'json' };

/**
 * Resolution order, mirroring `apps/api/src/openapi/version.ts` so the two
 * halves of a deployment can be stamped by one pipeline step:
 *
 *  1. `APP_VERSION` from the build environment — the only source that knows
 *     about a release tag, so it wins. This is what epic #397's deploy bump
 *     (#405) sets.
 *  2. `apps/web/package.json`, imported above.
 *
 * Never throws and never yields an empty string: a missing version degrades to
 * `'0.0.0'` exactly as the API's resolver does, because a blank version line is
 * indistinguishable from a broken define.
 */
export function resolveAppVersion(): string {
  const fromEnv = process.env.APP_VERSION;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  const fromPackage = (pkg as { version?: unknown }).version;
  if (typeof fromPackage === 'string' && fromPackage.length > 0) return fromPackage;

  return '0.0.0';
}

/**
 * The `define` entries every config spreads:
 *
 * ```ts
 * define: { ...appVersionDefine() }
 * ```
 *
 * The value is `JSON.stringify`d because a Vite/esbuild define is a raw source
 * substitution, not a value binding — an unquoted `1.4.0` would be spliced in
 * as an expression and fail to parse.
 */
export function appVersionDefine(): Record<string, string> {
  return {
    __APP_VERSION__: JSON.stringify(resolveAppVersion()),
  };
}
