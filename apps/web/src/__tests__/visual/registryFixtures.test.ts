import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Issue #222: the visual regression harness draws FROZEN registries
 * (`apps/web/visual/fixtures/`) so that appending a settings or Today card
 * moves no pixel baseline. `apps/web/visual/vite.config.ts` swaps the live
 * modules for these at resolve time.
 *
 * That only holds while a fixture never reaches back into the registry it
 * replaces. A fixture that did `ADMIN_SECTIONS.slice(...)`, or re-exported
 * anything from the live module, would put live content back under the
 * baselines. `import type` is allowed: it is erased at build time.
 */

const VISUAL = resolve(__dirname, '../../../visual');
const FIXTURES = resolve(VISUAL, 'fixtures');

/** The live registries the harness replaces, by file name. */
const REGISTRIES = ['adminSections.tsx', 'userSettingsSections.tsx', 'todayCards.tsx'];
const LIVE_SPECIFIER = /(^|\/)config\/(adminSections|userSettingsSections|todayCards)(\.tsx)?$/;

/** Every static `import`/`export ... from`, side-effect `import '...'` and dynamic `import('...')`. */
function moduleReferences(source: string): { specifier: string; typeOnly: boolean }[] {
  const refs: { specifier: string; typeOnly: boolean }[] = [];
  const fromClause = /^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm;
  for (const m of source.matchAll(fromClause)) refs.push({ specifier: m[3], typeOnly: Boolean(m[2]) });
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    refs.push({ specifier: m[1], typeOnly: false });
  }
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    refs.push({ specifier: m[1], typeOnly: false });
  }
  return refs;
}

const fixtureFiles = readdirSync(FIXTURES).filter((f) => /\.tsx?$/.test(f));

describe('visual harness registry fixtures (#222)', () => {
  it('has exactly one fixture per swapped registry', () => {
    expect([...fixtureFiles].sort()).toEqual([...REGISTRIES].sort());
  });

  it('swaps every registry in the harness Vite config', () => {
    const config = readFileSync(resolve(VISUAL, 'vite.config.ts'), 'utf8');
    for (const file of REGISTRIES) expect(config).toContain(`'${file}'`);
  });

  it.each(fixtureFiles)('%s imports no value from a live registry', (file) => {
    const source = readFileSync(resolve(FIXTURES, file), 'utf8');
    const offending = moduleReferences(source).filter(
      (ref) => LIVE_SPECIFIER.test(ref.specifier) && !ref.typeOnly,
    );
    expect(offending).toEqual([]);
  });

  it('the reference scanner catches a value import (non-vacuity)', () => {
    const refs = moduleReferences(
      "import { ADMIN_SECTIONS } from '../../src/config/adminSections';\n" +
        "export * from '../../src/config/todayCards';\n" +
        "import type { X } from '../../src/config/userSettingsSections';\n",
    );
    expect(refs.filter((r) => LIVE_SPECIFIER.test(r.specifier) && !r.typeOnly)).toHaveLength(2);
  });

  // A consumer importing a name the fixture lacks would break the harness, not
  // the app, so parity is checked here rather than discovered on CI.
  it.each(REGISTRIES)('%s fixture exports every runtime name the live module does', async (file) => {
    const name = file.replace(/\.tsx$/, '');
    const live = await import(`../../config/${name}.tsx`);
    const fixture = await import(`../../../visual/fixtures/${name}.tsx`);
    expect(Object.keys(fixture).sort()).toEqual(expect.arrayContaining(Object.keys(live).sort()));
  });
});
