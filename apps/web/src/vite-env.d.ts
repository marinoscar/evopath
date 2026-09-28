/// <reference types="vite/client" />
// `virtual:pwa-register/react` — the module `components/pwa/UpdatePrompt.tsx`
// imports `useRegisterSW` from (issue #219). It exists only as a virtual module
// created by `VitePWA()` at build time, so without this reference `tsc` sees an
// unresolved import and the typecheck fails on a module the bundler resolves
// fine. Under Vitest the same specifier is resolved by an alias in
// `vitest.config.ts` — see the note there.
/// <reference types="vite-plugin-pwa/react" />

/**
 * `__APP_VERSION__` — the version of THIS BUNDLE, substituted at build time by
 * the `define` in `vite.config.ts`, `vitest.config.ts` and
 * `visual/vite.config.ts` (issue #401, epic #397).
 *
 * All three spread the SAME `appVersionDefine()` from `build-config/app-version.ts`,
 * which is where the argument for a baked-in constant over a fetched one lives.
 * Declared here rather than in the module that reads it so the compiler sees
 * one declaration for every consumer — and so a second consumer added later
 * needs no declaration of its own.
 */
declare const __APP_VERSION__: string;
