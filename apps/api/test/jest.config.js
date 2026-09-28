/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // .ts only. Matching .js too made ts-jest warn whenever a test requires a
    // plain CommonJS script (src/common/database-url.spec.ts requires
    // scripts/prisma-env.js to hold the two connection-string builders
    // together), and `allowJs` cannot be turned on to satisfy it because this
    // project sets `declaration: true`, which conflicts with it. Those scripts
    // are already CommonJS and need no transform.
    // isolatedModules: ts-jest reads this out of the resolved tsconfig and
    // then transpiles each file with `ts.transpileModule` instead of
    // building a full TypeScript LanguageService per worker - that's what
    // makes the suite fast (measured locally: 262s -> 116s, ~2.3x). The
    // inline `tsconfig` object here MERGES on top of the discovered
    // apps/api/tsconfig.json, so this flag applies to Jest only. It must
    // NOT be set in tsconfig.json itself: `tsc` would then report
    // TS1272/TS1205 on the ~38 decorated signatures and type re-exports
    // that would need `import type`, and at runtime those already resolve
    // to `Object` in decorator metadata exactly as they do under full
    // compilation, so nothing observable changes there.
    //
    // Type-checking is not lost - it moves to `npm run typecheck`
    // (tsc --noEmit), which now covers src/** AND test/**. The one rule
    // this imposes on spec authors: no `await import()` in a spec (use a
    // static import instead) - `transpileModule` under `module: NodeNext`
    // leaves a dynamic `import()` as a real ESM dynamic import, which
    // Jest's CommonJS VM rejects at runtime.
    //
    // apps/api/tsconfig.json sets `rootDir: "."` explicitly for this path
    // too: TypeScript 6 reports TS5011 from `transpileModule` when rootDir
    // is left implicit, and a plain `tsc --noEmit` never shows it.
    '^.+\\.ts$': ['ts-jest', { tsconfig: { isolatedModules: true } }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/main.ts',
    '!src/**/*.spec.ts',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalTeardown: '<rootDir>/test/teardown.ts',
  testTimeout: 30000,
  verbose: true,
};
