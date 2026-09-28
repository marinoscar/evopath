import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import {
  VERSIONED_MANIFESTS,
  assertMovesForward,
  compareSemVer,
  currentVersion,
  formatSemVer,
  parseSemVer,
  suggestNext,
  updateLockfile,
  writeVersion,
} from './app-version.js';

// =============================================================================
// ⚠ THE LOCKFILE ASSERTIONS RUN AGAINST THE REAL package-lock.json.
//
// A hand-written fixture only proves this file's own guess about the lockfile
// format is self-consistent. The real file is what `npm`'s lockfileVersion 3
// actually looks like today, so it is the only thing that can catch a future
// npm format change silently making the textual edit partial - which is
// exactly the failure mode `app-version.ts`'s own header warns about.
// =============================================================================
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const REAL_LOCKFILE = readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8');
const WORKSPACE_PATHS = ['apps/api', 'apps/web', 'apps/cli', 'packages/shared'] as const;

/** A minimal, valid manifest for one of the four versioned workspaces. */
function manifestJson(version: string): string {
  return JSON.stringify({ name: 'x', version, dependencies: { left: 'right' } }, null, 2) + '\n';
}

/** A checkout carrying all four manifests at `version`, but no lockfile. */
function makeCheckout(version = '1.0.0'): string {
  const dir = mkdtempSync(join(tmpdir(), 'appctl-appversion-'));
  for (const relative of VERSIONED_MANIFESTS) {
    mkdirSync(join(dir, dirname(relative)), { recursive: true });
    writeFileSync(join(dir, relative), manifestJson(version));
  }
  return dir;
}

describe('parseSemVer / compareSemVer / formatSemVer', () => {
  it('parses a plain MAJOR.MINOR.PATCH', () => {
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('rejects anything that is not exactly three numeric components', () => {
    for (const bad of ['1.2', '1.2.3.4', '1.2.x', 'v1.2.3', '1.2.3-rc.1', '']) {
      expect(parseSemVer(bad)).toBeUndefined();
    }
  });

  it('formats back to the same string', () => {
    expect(formatSemVer({ major: 1, minor: 10, patch: 0 })).toBe('1.10.0');
  });

  // ⚠ THE CASE A NAIVE STRING COMPARE GETS WRONG. Lexically, '1.10.0' < '1.9.0'
  // (the character '1' sorts before '9' at the second component), so a `>`
  // on the raw strings would reject a perfectly forward-moving release. This
  // is the entire reason compareSemVer exists rather than `proposed > current`.
  it('sorts 1.10.0 above 1.9.0 numerically, where string compare would not', () => {
    const a = parseSemVer('1.10.0');
    const b = parseSemVer('1.9.0');
    if (a === undefined || b === undefined) throw new Error('fixture broken');
    expect(compareSemVer(a, b)).toBeGreaterThan(0);
    expect('1.10.0' > '1.9.0').toBe(false); // the naive comparison this guards against
  });
});

describe('currentVersion', () => {
  it('reads the version from the first manifest that has a valid one', () => {
    const dir = makeCheckout('3.4.5');
    expect(currentVersion(dir)).toBe('3.4.5');
  });

  it('falls through to the next manifest when an earlier one is absent', () => {
    const dir = makeCheckout('2.0.0');
    // Remove apps/api's manifest entirely; apps/web must answer instead.
    writeFileSync(join(dir, 'apps/api/package.json'), 'not even json');
    expect(currentVersion(dir)).toBe('2.0.0');
  });

  it('falls through when the first manifest has no valid semver version', () => {
    const dir = makeCheckout('2.0.0');
    writeFileSync(join(dir, 'apps/api/package.json'), manifestJson('not-a-semver'));
    expect(currentVersion(dir)).toBe('2.0.0');
  });

  it('defaults to 1.0.0 when nothing versioned exists, rather than inventing a number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appctl-appversion-empty-'));
    expect(currentVersion(dir)).toBe('1.0.0');
  });
});

describe('suggestNext', () => {
  it('offers a patch bump', () => {
    expect(suggestNext('2.3.4')).toBe('2.3.5');
  });

  it('falls back to 1.0.0-based when the current value is unparseable', () => {
    expect(suggestNext('garbage')).toBe('1.0.1');
  });
});

describe('assertMovesForward', () => {
  it('accepts a version that sorts strictly above the current one', () => {
    expect(() => assertMovesForward('1.0.1', '1.0.0')).not.toThrow();
  });

  it('rejects an equal version - a deploy that changes nothing must not commit', () => {
    expect(() => assertMovesForward('1.0.0', '1.0.0')).toThrow(UsageError);
  });

  it('rejects a version that sorts below the current one', () => {
    expect(() => assertMovesForward('0.9.9', '1.0.0')).toThrow(UsageError);
  });

  it('rejects a malformed proposed version outright', () => {
    for (const bad of ['1.0', 'v1.0.0', 'latest', '1.0.0.0', '']) {
      expect(() => assertMovesForward(bad, '1.0.0')).toThrow(UsageError);
    }
  });

  // ⚠ THE SEMVER-ORDERING CASE PLAIN STRING COMPARISON GETS WRONG. If this
  // were `proposed > current` on the raw strings, '1.10.0' would be judged
  // to NOT sort above '1.9.0' and a perfectly good release would be refused.
  it('accepts 1.10.0 as forward of 1.9.0, where a string compare would refuse it', () => {
    expect(() => assertMovesForward('1.10.0', '1.9.0')).not.toThrow();
  });

  it('rejects 1.9.0 as forward of 1.10.0 - real backward motion, not a string-sort artifact', () => {
    expect(() => assertMovesForward('1.9.0', '1.10.0')).toThrow(UsageError);
  });

  it('names both versions in the message, so the operator sees why it was refused', () => {
    expect(() => assertMovesForward('1.0.0', '1.5.0')).toThrow(/1\.0\.0/);
    expect(() => assertMovesForward('1.0.0', '1.5.0')).toThrow(/1\.5\.0/);
  });
});

describe('writeVersion', () => {
  it('writes the new version into every present manifest', () => {
    const dir = makeCheckout('1.0.0');
    const result = writeVersion(dir, '1.2.3');

    expect(result.changed.sort()).toEqual([...VERSIONED_MANIFESTS].sort());
    expect(result.absent).toEqual(['package-lock.json']); // this fixture has no lockfile

    for (const relative of VERSIONED_MANIFESTS) {
      const parsed = JSON.parse(readFileSync(join(dir, relative), 'utf8')) as { version: string };
      expect(parsed.version).toBe('1.2.3');
    }
  });

  it('leaves unrelated manifest fields untouched - a textual edit, not a reformat', () => {
    const dir = makeCheckout('1.0.0');
    writeVersion(dir, '1.2.3');

    const raw = readFileSync(join(dir, 'apps/api/package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name: string; dependencies: Record<string, string> };
    expect(parsed.name).toBe('x');
    expect(parsed.dependencies).toEqual({ left: 'right' });
  });

  it('reports absent manifests separately from changed ones, for a fork missing one', () => {
    const dir = makeCheckout('1.0.0');
    // packages/shared is one this fork does not carry - valid JSON, no
    // `version` field at all (NOT malformed JSON; see the finding below).
    writeFileSync(join(dir, 'packages/shared/package.json'), JSON.stringify({ name: 'x' }));

    const result = writeVersion(dir, '1.2.3');

    expect(result.absent).toContain('packages/shared/package.json');
    expect(result.changed).not.toContain('packages/shared/package.json');
  });

  // ⚠ A CORRUPT MANIFEST IS A BAD INPUT, NOT A CRASH.
  //
  // The `readFileSync` was wrapped, so a MISSING manifest became `absent`
  // properly -- but the `JSON.parse` immediately after it was not, so a
  // manifest that EXISTS and is malformed threw a raw `SyntaxError` out of
  // `writeVersion`, out of `runVersionStep`, and killed the deploy with a
  // message naming neither the file nor the reason. Two failure modes for the
  // same class of input, one of them unhandled.
  //
  // ⚠ And it threw MID-WRITE: `VERSIONED_MANIFESTS` is walked in order, so a
  // corrupt fourth manifest threw after three had already been rewritten,
  // leaving the tree in exactly the half-applied state the rest of this file
  // exists to rule out.
  it('reports a manifest that is not valid JSON as absent rather than throwing', () => {
    const dir = makeCheckout('1.0.0');
    writeFileSync(join(dir, 'packages/shared/package.json'), 'this is not valid json');

    const result = writeVersion(dir, '1.2.3');

    expect(result.absent).toContain('packages/shared/package.json');
    expect(result.changed).not.toContain('packages/shared/package.json');
    // The sound manifests are still written: one corrupt file does not veto
    // the bump, it just cannot take part in it.
    expect(result.changed).toContain('apps/api/package.json');
  });

  it('treats a non-string version field as absent rather than throwing', () => {
    const dir = makeCheckout('1.0.0');
    writeFileSync(join(dir, 'apps/cli/package.json'), JSON.stringify({ name: 'x', version: 123 }));

    const result = writeVersion(dir, '1.2.3');

    expect(result.absent).toContain('apps/cli/package.json');
  });

  // ⚠ REGRESSION FOR THE ANCHOR BUG THE HEADER DESCRIBES. The first attempt at
  // this replacement anchored to start-of-line (`^\s*"version"`), which works
  // on pretty-printed JSON and silently does nothing on a single-line, compact
  // manifest - producing a committed, half-applied bump. This manifest is
  // deliberately compact.
  it('rewrites the version on a compact, single-line manifest', () => {
    const dir = makeCheckout('1.0.0');
    writeFileSync(
      join(dir, 'apps/web/package.json'),
      '{"name":"x","version":"1.0.0","dependencies":{"left":"right"}}',
    );

    const result = writeVersion(dir, '1.2.3');

    expect(result.changed).toContain('apps/web/package.json');
    const parsed = JSON.parse(readFileSync(join(dir, 'apps/web/package.json'), 'utf8')) as {
      version: string;
    };
    expect(parsed.version).toBe('1.2.3');
  });

  it('reports zero changed files when every manifest already carries the target version', () => {
    // ⚠ This is the exact state that makes runVersionStep return
    // `bumped: false` instead of creating an empty commit - see
    // version-step.test.ts for that half of the guarantee.
    const dir = makeCheckout('2.0.0');
    const result = writeVersion(dir, '2.0.0');

    expect(result.changed).toEqual([]);
  });

  describe('against the real repository lockfile', () => {
    it('updates every workspace entry, and touches nothing else in the file', () => {
      const dir = makeCheckout('1.0.0');
      writeFileSync(join(dir, 'package-lock.json'), REAL_LOCKFILE);

      const result = writeVersion(dir, '1.2.3');

      expect(result.changed).toContain('package-lock.json');

      const updatedRaw = readFileSync(join(dir, 'package-lock.json'), 'utf8');
      // Still parses - the edit must never leave broken JSON behind.
      const updated = JSON.parse(updatedRaw) as {
        packages: Record<string, { version?: string }>;
      };
      const original = JSON.parse(REAL_LOCKFILE) as {
        packages: Record<string, { version?: string }>;
      };

      for (const path of WORKSPACE_PATHS) {
        expect(original.packages[path]?.version).not.toBe('1.2.3');
        expect(updated.packages[path]?.version).toBe('1.2.3');
      }

      // No unrelated dependency version changed: patch a deep clone of the
      // ORIGINAL parsed lockfile at exactly the four workspace version
      // fields and deep-equal it against the updated one. Any other
      // difference anywhere in the file fails this assertion.
      const expected = structuredClone(original) as typeof original;
      for (const path of WORKSPACE_PATHS) {
        const entry = expected.packages[path];
        if (entry === undefined) throw new Error(`fixture missing ${path}`);
        entry.version = '1.2.3';
      }
      expect(updated).toEqual(expected);
    });

    it('reports zero changes when the real lockfile already carries the target version', () => {
      const dir = makeCheckout('1.0.0');
      writeFileSync(join(dir, 'package-lock.json'), REAL_LOCKFILE);

      // The real lockfile's workspace entries are all "1.0.0" today.
      const result = writeVersion(dir, '1.0.0');

      expect(result.changed).toEqual([]);
    });
  });
});

describe('updateLockfile', () => {
  it('keys on the workspace PATH, never touching a dependency at the same version', () => {
    const raw = JSON.stringify(
      {
        packages: {
          'apps/api': { version: '1.0.0', dependencies: {} },
          'node_modules/some-lib': { version: '1.0.0' }, // same version, unrelated package
        },
      },
      null,
      2,
    );

    const updated = updateLockfile(raw, '1.2.3');
    const parsed = JSON.parse(updated) as {
      packages: Record<string, { version: string }>;
    };

    expect(parsed.packages['apps/api']?.version).toBe('1.2.3');
    // Same starting version, but not a workspace entry - must be untouched.
    expect(parsed.packages['node_modules/some-lib']?.version).toBe('1.0.0');
  });

  it('is a no-op for a lockfile that carries none of the versioned workspaces', () => {
    const raw = JSON.stringify({ packages: { 'node_modules/left-pad': { version: '1.0.0' } } });
    expect(updateLockfile(raw, '9.9.9')).toBe(raw);
  });
});
