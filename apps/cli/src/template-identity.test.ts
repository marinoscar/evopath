import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_SLUG } from '@app/shared';

// `scripts/rename.mjs` is real ESM with no build step, so it can be imported
// directly here (see its own `isDirectExecution` guard — importing it runs no
// CLI code, it just exposes `buildPlan`/`derive`).
import { EXAMPLE_DOC_FILES, EXAMPLE_IDENTITY, buildPlan, derive } from '../../../scripts/rename.mjs';

// =============================================================================
// The template-renameability guard (issue #343, epic #341)
// =============================================================================
//
// WHY THIS LIVES IN apps/cli, NOT SOMEWHERE REPO-WIDE
// -----------------------------------------------------------------------------
// This file scans the ENTIRE repository, not just apps/cli. It lives here
// anyway, for three practical reasons:
//
//   - `apps/cli/vitest.config.ts` already scopes to `src/**/*.test.ts` and CI
//     already runs this workspace's test script, so there is no new job to
//     wire up.
//   - This package is real ESM (`"type": "module"`), so `node:fs` /
//     `node:child_process` and `import.meta.url` are natural here in a way
//     they are not in `apps/api` (CommonJS + ts-jest) or `apps/web` (browser
//     runtime, jsdom).
//   - There is precedent for a CLI test reaching outside `apps/cli`:
//     `apps/cli/src/node/worker-env.test.ts` and
//     `apps/cli/src/deploy/repo.test.ts` both already do it. This is the same
//     move, aimed at the whole tree instead of one other package.
//
// It is the keystone of the epic: `packages/shared/identity.json` plus
// `@app/shared` gives new code a rebrand-safe way to reference the product
// name, the repo, and the brand colours. Nothing stops new code from
// hardcoding the old strings again instead of importing them. This test is
// what makes CI catch that.
//
// -----------------------------------------------------------------------------
// WHY THE FORBIDDEN PATTERNS ARE DERIVED FROM identity.json, NEVER LISTED
// -----------------------------------------------------------------------------
// A denylist that spells out `'EnterpriseAppBase'` (or `'My App'`, or
// `'marinoscar'`) literally goes vacuously green the instant a fork renames —
// the old name is gone, the new one was never forbidden, and the guard is
// quietly protecting nothing. Worse, `scripts/rename.mjs` would then have to
// rewrite THIS FILE as part of a rename, which is circular: the codemod
// editing its own guard.
//
// Instead every pattern below is built from the CURRENT contents of
// `packages/shared/identity.json` at test-run time. Immediately after a fork
// runs `rename.mjs`, this test starts protecting the NEW name with no edit of
// its own required. This is the exact model `apps/cli/src/node/env-prefix.test.ts`
// uses for `ENV_PREFIX` — read that file first; it explains the same
// derive-don't-list reasoning for a different literal.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/cli/src -> apps/cli -> apps -> <repo root>
const REPO_ROOT = join(HERE, '..', '..', '..');
const MANIFEST_PATH = join(REPO_ROOT, 'packages', 'shared', 'identity.json');

interface Identity {
  productName: string;
  tagline: string;
  repoSlug: string;
  themeColor: string;
  backgroundColor: string;
}

function readManifest(): Identity {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Identity;
}

describe('the manifest shape (packages/shared/identity.json)', () => {
  const identity = readManifest();

  it('has a non-empty productName', () => {
    expect(typeof identity.productName).toBe('string');
    expect(identity.productName.trim().length).toBeGreaterThan(0);
  });

  it('has a non-empty tagline', () => {
    expect(typeof identity.tagline).toBe('string');
    expect(identity.tagline.trim().length).toBeGreaterThan(0);
  });

  it('has a repoSlug shaped like owner/name', () => {
    expect(identity.repoSlug).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  // Lowercase, 6-digit `#rrggbb` is load-bearing, not a style preference: a
  // PWA manifest's `theme_color`/`background_color` are parsed by the
  // PLATFORM, not by a CSS engine, and the 3-digit shorthand and `rgb(...)`
  // forms are not reliably accepted there. `scripts/rename.mjs` enforces the
  // same shape on the way in (`HEX` regex there); this asserts it held.
  it('has a lowercase 6-digit hex themeColor', () => {
    expect(identity.themeColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('has a lowercase 6-digit hex backgroundColor', () => {
    expect(identity.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('exposes a non-empty APP_SLUG from @app/shared', () => {
    expect(typeof APP_SLUG).toBe('string');
    expect(APP_SLUG.trim().length).toBeGreaterThan(0);
  });
});

// =============================================================================
// The no-stale-identity-literal guard
// =============================================================================

/**
 * Files allowed to carry an identity literal outright, each with its own
 * reason. This is for whole-file exemptions ONLY — prose-heavy files, or
 * files a rename can never reach at all. It is deliberately NOT where the
 * per-token codemod targets (`package.json`'s `"name"`, the `.env.example` /
 * `base.compose.yml` `OTEL_SERVICE_NAME`, `test.compose.yml`'s
 * `container_name`, etc.) live any more — see `codemodExemptions` below,
 * which derives those from `scripts/rename.mjs`'s own `buildPlan()` so an
 * *other*, non-codemod occurrence of the same literal in the same file still
 * fails.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // The definition itself — this IS where the values live.
  'packages/shared/identity.json',
  // The shop window: deliberately carries the real name and repo slug as
  // prose (sentences, a directory listing), not a single substitutable
  // token, so a per-line codemod-output check does not fit it.
  'README.md',
  // Install one-liners carrying the repo URL for `npm install -g`/`npx`.
  'apps/cli/README.md',
  // Fetched and run via `curl | bash` BEFORE the repository exists on disk —
  // it can never read the manifest. A permanent codemod target, not a bug.
  'install.sh',
  // A cross-realm `Symbol.for()` registry key. It is a REGISTRY KEY, not a
  // display string — see the file's own comment on `VERBATIM_ERROR_BODY` for
  // why it must be a stable, globally-unique string, not why it happens to be
  // spelled like the product name.
  'apps/api/src/common/exceptions/verbatim-error-body.exception.ts',
]);

// Deliberately NOT allowlisted, on purpose, spelled out so nobody "fixes" this
// guard by adding them back:
//   - apps/api/src/openapi/document.ts
//   - apps/api/src/openapi/description.ts
// Both now import `REPO_URL` from `@app/shared` instead of hardcoding the
// repository. This guard is what keeps them that way — allowlisting them
// would silently permit the regression it exists to catch.

/**
 * The exact (file, literal) pairs `scripts/rename.mjs` itself writes for the
 * CURRENT identity — derived from its own `buildPlan()`, never hand-listed.
 *
 * Why this exists at all: the codemod substitutes the derived slug/name
 * tokens into a handful of files (`package.json`'s `"name"`,
 * `infra/compose/.env.example` and `base.compose.yml`'s
 * `OTEL_SERVICE_NAME`, `infra/compose/test.compose.yml`'s `container_name`
 * and `POSTGRES_DB`). Whenever a fork's product slug equals its repo name —
 * the common case — those substitutions write literally the bare repo name
 * into those files. A blanket per-file allowlist entry would then also
 * excuse any OTHER, unrelated occurrence of that name landing in the same
 * file later; this instead only excuses the exact substring the codemod
 * itself would produce.
 *
 * `old` here is a throwaway identity distinct from `next` in every field, so
 * every edit in `buildPlan()` is included (it skips an edit only when
 * `find === replace`) regardless of what the CLI-name/theme-color fields of
 * the real "old" identity happen to be — this guard only cares what the
 * codemod would write for the CURRENT identity, not what it changed FROM.
 */
function codemodExemptions(identity: Identity): Map<string, string[]> {
  // Deliberately not derived from the real "old" state (there isn't one at
  // test time — only the current, already-renamed identity exists). Any
  // cliName works too: the CLI-binary-specific edits are gated on
  // `next.cliName !== old.cliName`, so passing the same value for both here
  // excludes them, which is correct — this guard is not about the CLI name.
  const cliName = 'placeholder-cli';
  const next = derive(identity, cliName);
  const old = derive(
    {
      productName: '__rename_placeholder_product__',
      tagline: '__rename_placeholder_tagline__',
      repoSlug: 'placeholder-owner/placeholder-repo',
      themeColor: '#000000',
      backgroundColor: '#000000',
    },
    cliName,
  );

  const byFile = new Map<string, string[]>();
  for (const edit of buildPlan(old, next)) {
    const existing = byFile.get(edit.file);
    if (existing) existing.push(edit.replace);
    else byFile.set(edit.file, [edit.replace]);
  }
  return byFile;
}

/**
 * Exempts `EXAMPLE_IDENTITY`'s literals (product name, repo slug, repo name),
 * but ONLY inside `EXAMPLE_DOC_FILES`, and ONLY when the CURRENT identity
 * actually equals that documented example.
 *
 * Why this exists: `docs/RENAMING.md`, `packages/shared/README.md` and
 * `scripts/rename.mjs`'s own `USAGE` string all walk through
 * `node scripts/rename.mjs --name "Acme Hub" --repo oscar/acme-hub ...` as a
 * worked example — the exact command the issue's own repro uses. A fork that
 * copies that example verbatim ends up with an identity equal to the
 * example, and this guard's patterns (built from the CURRENT identity) then
 * match that same example prose in those three files. It is not a stale
 * leftover — the prose was never rewritten by a rename, it always said
 * "Acme Hub" — so it needs its own exemption, separate from
 * `codemodExemptions` above (which is about the codemod's OUTPUT, not
 * unrelated documentation that happens to share the new name by
 * coincidence).
 *
 * This returns nothing when the identity does not match `EXAMPLE_IDENTITY`:
 * a fork named anything else still fully guards these three files, exactly
 * as before.
 */
function exampleDocExemptions(identity: Identity): Map<string, string[]> {
  const matchesExample =
    identity.productName === EXAMPLE_IDENTITY.name || identity.repoSlug === EXAMPLE_IDENTITY.repo;
  if (!matchesExample) return new Map();

  const exampleRepoName = EXAMPLE_IDENTITY.repo.split('/')[1] ?? '';
  const literals = [EXAMPLE_IDENTITY.name, EXAMPLE_IDENTITY.repo, exampleRepoName].filter(Boolean);

  const byFile = new Map<string, string[]>();
  for (const file of EXAMPLE_DOC_FILES) byFile.set(file, literals);
  return byFile;
}

/** Combines several (file -> exempt literal) maps into one. */
function mergeExemptions(...maps: Map<string, string[]>[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const map of maps) {
    for (const [file, literals] of map) {
      const existing = merged.get(file);
      if (existing) existing.push(...literals);
      else merged.set(file, [...literals]);
    }
  }
  return merged;
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const BINARY_EXT_RE = /\.(png|ico|jpg|jpeg|gif|woff2?|ttf|pdf|zip)$/i;
const EXTRA_EXEMPT: ReadonlySet<string> = new Set([
  // A generated lockfile, not authored prose; renaming rewrites it via
  // `npm install`, never via this codemod or this guard.
  'package-lock.json',
  // History is never rewritten.
  'CHANGELOG.md',
]);

/**
 * Enumerate every file the guard should consider.
 *
 * `git ls-files -z` rather than a filesystem walk, for three reasons stated
 * here because they are easy to lose on a later edit:
 *
 *   1. It respects `.gitignore` for free. `node_modules`, `dist`, and any
 *      build output never enter the scan, without this file having to know
 *      their names.
 *   2. It cannot wander into a directory that merely EXISTS on disk but was
 *      never committed — three build artifacts were untracked out of this
 *      repository and are still sitting on disk in some checkouts; a
 *      filesystem walk would happily scan them, a git-based one will not.
 *   3. It is what makes the non-vacuity check below meaningful: "scanned
 *      1059 tracked files" is a real claim about the repository, not an
 *      artifact of whatever happens to be present in this container.
 *
 * `-z` (NUL-separated) rather than newline-separated output, because a
 * filename could in principle contain a newline; NUL cannot appear in a path.
 *
 * If git itself fails, THIS TEST FAILS LOUDLY rather than falling back to an
 * empty list. A guard that silently scans nothing on a broken git and reports
 * green is worse than having no guard at all — it would look like protection
 * while providing none.
 */
function listTrackedFiles(): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    throw new Error(
      `template-identity guard: \`git ls-files -z\` failed, so this test cannot ` +
        `verify anything and must not report a pass. Underlying error: ${String(err)}`,
    );
  }
  return output.split('\0').filter(Boolean);
}

/** Escape regex metacharacters in a literal value. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a word-boundary pattern for one forbidden value.
 *
 * Plain substring matching would flag a product named `Bit` inside the word
 * `Bitmap`. `\b` is only meaningful next to a word character, so it is added
 * at an end of the pattern only when the value itself starts/ends with one
 * (a slug like `owner/repo` starts and ends with word characters; this still
 * does the right thing for values that don't).
 */
function wordBoundaryPattern(value: string): RegExp {
  const escaped = escapeRegExp(value);
  const lead = /^\w/.test(value) ? '\\b' : '';
  const tail = /\w$/.test(value) ? '\\b' : '';
  // Deliberately CASE-SENSITIVE (no `i` flag). This is what lets
  // `apps/api/src/common/crypto/secret-cipher.ts`'s HKDF label
  // `'enterpriseappbase:secret-cipher:v1:'` (lowercase) pass with no
  // allowlist entry — that label must NEVER change, because doing so makes
  // every already-stored credential permanently undecryptable. A
  // case-insensitive guard would force either rewriting that label (forbidden)
  // or adding a special-case allowlist entry to excuse it; case-sensitivity
  // needs neither.
  return new RegExp(`${lead}${escaped}${tail}`);
}

interface Offender {
  file: string;
  line: number;
  text: string;
  value: string;
}

function findOffenders(
  files: string[],
  patterns: { value: string; re: RegExp }[],
  exemptions: Map<string, string[]>,
): Offender[] {
  const offenders: Offender[] = [];

  for (const file of files) {
    if (ALLOWLIST.has(file) || EXTRA_EXEMPT.has(file)) continue;
    if (TEST_FILE_RE.test(file)) continue; // .test.ts/.spec.ts/.test.tsx/.spec.tsx — see below
    if (BINARY_EXT_RE.test(file)) continue;

    let content: string;
    try {
      content = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      // Unreadable (e.g. a binary file with an extension this list doesn't
      // know about, or a broken symlink) — nothing to scan as text.
      continue;
    }

    const codemodLiterals = exemptions.get(file) ?? [];
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      // Skip a line that IS exactly what `scripts/rename.mjs` would itself
      // write into this file for the current identity — the codemod's own
      // output, not a stale leftover. Any other line in the same file still
      // fails, so this excuses only the substituted token, not the file.
      if (codemodLiterals.some((literal) => lineText.includes(literal))) return;
      for (const { value, re } of patterns) {
        if (re.test(lineText)) {
          offenders.push({ file, line: idx + 1, text: lineText.trim().slice(0, 160), value });
        }
      }
    });
  }

  return offenders;
}

describe('exampleDocExemptions (issue #514)', () => {
  const exampleIdentity: Identity = {
    productName: EXAMPLE_IDENTITY.name,
    tagline: 'A worked example.',
    repoSlug: EXAMPLE_IDENTITY.repo,
    themeColor: '#7c3aed',
    backgroundColor: '#ffffff',
  };

  it('exempts the example literals in exactly EXAMPLE_DOC_FILES when the identity matches the documented example', () => {
    const exemptions = exampleDocExemptions(exampleIdentity);

    expect([...exemptions.keys()].sort()).toEqual([...EXAMPLE_DOC_FILES].sort());
    for (const file of EXAMPLE_DOC_FILES) {
      expect(exemptions.get(file)).toEqual(
        expect.arrayContaining([EXAMPLE_IDENTITY.name, EXAMPLE_IDENTITY.repo, 'acme-hub']),
      );
    }
  });

  it('exempts nothing for a real fork whose identity does not match the example', () => {
    const realFork: Identity = {
      productName: 'Nimbus Works',
      tagline: 'A real product.',
      repoSlug: 'someone/nimbus-works',
      themeColor: '#7c3aed',
      backgroundColor: '#ffffff',
    };

    expect(exampleDocExemptions(realFork).size).toBe(0);
  });

  it('still matches when only the product name (not the repo slug) equals the example', () => {
    const partialMatch: Identity = { ...exampleIdentity, repoSlug: 'someone/unrelated-repo' };

    expect(exampleDocExemptions(partialMatch).size).toBe(EXAMPLE_DOC_FILES.length);
  });

  it('never exempts a file outside EXAMPLE_DOC_FILES, even when the identity matches the example', () => {
    const exemptions = exampleDocExemptions(exampleIdentity);

    expect(exemptions.has('README.md')).toBe(false);
    expect(exemptions.has('infra/compose/.env.example')).toBe(false);
  });
});

describe('no stale identity literal outside the allowlist (issue #343, epic #341)', () => {
  const identity = readManifest();

  // `split` is typed as possibly-sparse under `noUncheckedIndexedAccess`, so the
  // halves have to be narrowed rather than asserted. Throwing here is the right
  // failure: a repoSlug that is not `owner/name` means the guard would silently
  // scan for `undefined` and pass while protecting nothing, which is the one
  // outcome this file exists to prevent. The shape test above covers the same
  // ground with a readable message; this is the belt to its braces.
  const slugParts = identity.repoSlug.split('/');
  const [owner, repoName] = slugParts;
  if (slugParts.length !== 2 || !owner || !repoName) {
    throw new Error(
      `identity.json repoSlug must be "owner/name", got ${JSON.stringify(identity.repoSlug)}`,
    );
  }

  // The bare owner alone is deliberately NOT scanned for: unlike a product
  // name or a repo name, an owner (a person's GitHub username, e.g. `oscar`)
  // is not a distinctive enough token to search the whole tree for — it
  // false-positives on unrelated prose (`Device: oscar-laptop` in a DTO
  // example). `scripts/rename.mjs`'s own `residualScan` already makes this
  // same call (it never scans for the bare owner either); this guard now
  // matches it.
  const patterns = [
    { value: identity.productName, re: wordBoundaryPattern(identity.productName) },
    { value: identity.repoSlug, re: wordBoundaryPattern(identity.repoSlug) },
    { value: repoName, re: wordBoundaryPattern(repoName) },
  ];

  const files = listTrackedFiles();
  const exemptions = mergeExemptions(codemodExemptions(identity), exampleDocExemptions(identity));

  it('scans a real corpus (the guard is not vacuously green)', () => {
    // ~1059 tracked files at the time this guard was written.
    expect(files.length).toBeGreaterThan(500);
  });

  it('finds no occurrence of the product name, repo slug, or repo name outside the allowlist', () => {
    const offenders = findOffenders(files, patterns, exemptions);

    if (offenders.length > 0) {
      const report = offenders
        .map(
          (o) =>
            `  ${o.file}:${o.line}  [${o.value}]  ${o.text}\n` +
            `      -> import from '@app/shared' (APP_NAME/REPO_SLUG/REPO_URL/...) instead of ` +
            `hardcoding it, or add a one-line-reason allowlist entry to this test if the literal ` +
            `is genuinely not a rebrand target (e.g. a registry key or a permanent codemod anchor).`,
        )
        .join('\n');
      throw new Error(
        `Found ${offenders.length} stale identity literal(s) outside the allowlist:\n\n${report}`,
      );
    }

    expect(offenders).toEqual([]);
  });
});

// =============================================================================
// The two hand-written SVGs
// =============================================================================
//
// `apps/web/scripts/generate-icons.py` explicitly does NOT rasterise these two
// files — rendering an SVG needs a toolchain this template refuses to require
// — so nothing else keeps their hardcoded colour in step with a rebrand. A
// rename that missed them would leave the browser tab (favicon) or the PWA's
// master icon on the old brand colour forever.
//
// This deliberately does NOT scan the repository generally for THEME_COLOR:
// `#1976d2` (and `#ffffff`) legitimately appear elsewhere on purpose —
// `OAuthButton.tsx`, `theme/light.ts`, `theme/dark.ts`,
// `email/templates/layout.ts`, and three contrast-ratio test utilities (~15
// hits today) — so a general scan would be unworkable noise, not a guard.
// `scripts/rename.mjs`'s own `residualScan` makes the identical decision for
// the identical reason. These two files are singled out instead, anchored on
// the exact `fill="..."` attribute `rename.mjs` edits on the background rect.
describe('the hand-written brand SVGs carry the current THEME_COLOR', () => {
  const identity = readManifest();

  it.each(['apps/web/public/favicon.svg', 'apps/web/public/icons/source.svg'])(
    '%s has fill="<THEME_COLOR>" on its background rect',
    (relPath) => {
      const content = readFileSync(join(REPO_ROOT, relPath), 'utf8');
      expect(content).toContain(`fill="${identity.themeColor}"`);
    },
  );
});
