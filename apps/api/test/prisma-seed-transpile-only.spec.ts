import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Static import (not `await import()`): jest.config.js's isolatedModules
// transform leaves a dynamic `import()` as a real ESM import, which Jest's
// CommonJS VM rejects at runtime.
import prismaConfig from '../prisma.config';

// =============================================================================
// prisma:seed must never type-check at runtime again (issue #329)
// =============================================================================
//
// `ts-node --project prisma/tsconfig.json prisma/seed.ts` (no `--transpile-only`)
// type-checks the full generated Prisma Client surface at runtime, which OOMs
// the 512M api container on a VPS deploy. The fix is one flag, so the
// regression this guards against is someone dropping it again while editing
// `prisma.config.ts` for an unrelated reason.
//
// Type coverage for prisma/seed.ts and prisma/seed-data.ts does not disappear
// with `--transpile-only`: it moves to the `prisma:typecheck` script (run in
// CI, see .github/workflows/ci.yml), so this also guards that the escape
// hatch stays wired up.
// =============================================================================

const apiRoot = resolve(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(resolve(apiRoot, relativePath), 'utf8');
}

describe('prisma.config.ts seed command', () => {
  it('runs with --transpile-only', () => {
    // Reads the actual resolved config object (what the Prisma CLI consumes),
    // not a regex over the source, so a harmless reformat cannot fail this
    // and a dropped flag cannot pass it.
    const seedCommand = (prismaConfig as { migrations?: { seed?: string } }).migrations?.seed;

    expect(seedCommand).toBeDefined();
    expect(seedCommand).toContain('--transpile-only');
    expect(seedCommand).toContain('prisma/seed.ts');
  });
});

describe('prisma/tsconfig.json', () => {
  it('is configured for noEmit, since only tsc -p (prisma:typecheck) uses it now', () => {
    const tsconfig = JSON.parse(read('prisma/tsconfig.json')) as {
      compilerOptions?: { noEmit?: boolean };
    };

    expect(tsconfig.compilerOptions?.noEmit).toBe(true);
  });
});

describe('package.json', () => {
  it('declares prisma:typecheck, restoring the type coverage --transpile-only removed from runtime', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['prisma:typecheck']).toBe('tsc -p prisma/tsconfig.json');
  });
});
