/**
 * Choosing and writing the release version at deploy time (issue #405).
 *
 * =============================================================================
 * THE DECISION, AND ITS HONEST COST
 * =============================================================================
 *
 * The operator is prompted for the version DURING install/update, and the
 * deployment writes it into the repository. The conventional alternative --
 * bump in the repo at release time, deploy whatever is tagged -- avoids
 * everything below and was declined deliberately. Both are recorded here so a
 * later reader does not reopen this as an oversight.
 *
 * Accepted, with eyes open:
 *   - The commit running in production is NOT the commit CI built. Bounded by
 *     changing only `version` fields and the lockfile's workspace entries --
 *     nothing that changes behaviour -- and by pushing only after the
 *     deployment is healthy.
 *   - The production host can write to the repository.
 *   - The same code can carry different versions on two servers.
 *
 * =============================================================================
 * ⚠ WHY THE WRITE AND THE COMMIT ARE ONE STEP
 * =============================================================================
 *
 * The checkout step refuses a dirty tree. So writing manifests and leaving them
 * dirty across a four-minute build would WEDGE THE NEXT UPDATE behind a refusal
 * about files the operator never touched -- every time a deploy died at
 * `build`. Committing in the same step makes the dirty window milliseconds. A
 * local-only commit wedges nothing, because `checkout --force --detach` moves
 * over it.
 *
 * =============================================================================
 * ⚠ NEVER `npm install --package-lock-only`
 * =============================================================================
 *
 * It resolves dependency ranges AGAINST THE REGISTRY, so a deploy can pull
 * newer transitive versions into the lockfile and `npm ci` installs them into
 * the image -- breaking the "nothing that changes behaviour" bound this whole
 * design rests on. It also needs the registry, mid-deploy, for a
 * three-character edit. The workspace `version` entries are edited TEXTUALLY,
 * and `app-version.test.ts` asserts against the real lockfile so a future npm
 * format cannot make the edit silently partial.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { UsageError } from '../errors.js';

/** Manifests that must move in lockstep. A fork adding one adds it here. */
export const VERSIONED_MANIFESTS = [
  'apps/api/package.json',
  'apps/web/package.json',
  'apps/cli/package.json',
  'packages/shared/package.json',
] as const;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemVer(value: string): SemVer | undefined {
  const match = SEMVER.exec(value.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Negative when `a` sorts below `b`. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function formatSemVer(version: SemVer): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

/**
 * Parses a manifest, answering `undefined` rather than throwing.
 *
 * The one place this file turns JSON text into an object. A corrupt manifest
 * is an input this command must report on, not an exception that escapes it
 * mid-deploy.
 */
function parseManifest(raw: string): { version?: unknown } | undefined {
  try {
    return JSON.parse(raw) as { version?: unknown };
  } catch {
    return undefined;
  }
}

/** The clone's current version, read from the first manifest that has one. */
export function currentVersion(checkoutPath: string): string {
  for (const relative of VERSIONED_MANIFESTS) {
    try {
      const manifest = JSON.parse(readFileSync(join(checkoutPath, relative), 'utf8')) as {
        version?: unknown;
      };
      if (typeof manifest.version === 'string' && SEMVER.test(manifest.version)) {
        return manifest.version;
      }
    } catch {
      // A fork may not carry every manifest. The next one answers.
    }
  }

  // Start at 1.0.0 and let the first deploy move it. Any other starting number
  // is fiction when no release has ever been cut, and inventing one re-creates
  // the "the version means nothing" problem this feature exists to fix.
  return '1.0.0';
}

/** The patch bump offered to the operator. */
export function suggestNext(current: string): string {
  const parsed = parseSemVer(current) ?? { major: 1, minor: 0, patch: 0 };
  return formatSemVer({ ...parsed, patch: parsed.patch + 1 });
}

/**
 * Judges a proposed version against the current one.
 *
 * ⚠ REJECTS ANYTHING THAT DOES NOT SORT ABOVE THE CURRENT VERSION. A deploy
 * must never move the number backwards: two servers would then disagree about
 * which of them is newer, and the About page would report a version that
 * already meant something else.
 */
export function assertMovesForward(proposed: string, current: string): void {
  const next = parseSemVer(proposed);
  if (next === undefined) {
    throw new UsageError(
      `${proposed} is not a version of the form MAJOR.MINOR.PATCH.`,
    );
  }

  const now = parseSemVer(current);
  if (now !== undefined && compareSemVer(next, now) <= 0) {
    throw new UsageError(
      `${proposed} does not sort above the current version ${current}. A deploy must not move the version backwards.`,
    );
  }
}

/** Escapes a literal for embedding in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface VersionWriteResult {
  /** Files whose contents changed. */
  changed: string[];
  /** Manifests that were not present in this checkout. */
  absent: string[];
}

/**
 * Writes the version into every manifest and the lockfile's workspace entries.
 *
 * ⚠ TEXTUAL, and deliberately so -- see the header on
 * `npm install --package-lock-only`. The lockfile's workspace records are
 * matched by their own path key, so an unrelated dependency that happens to be
 * at the same version is never touched.
 */
export function writeVersion(
  checkoutPath: string,
  version: string,
): VersionWriteResult {
  const changed: string[] = [];
  const absent: string[] = [];

  for (const relative of VERSIONED_MANIFESTS) {
    const path = join(checkoutPath, relative);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      absent.push(relative);
      continue;
    }

    // ⚠ MATCHED ON THE CURRENT VALUE, NOT ON FORMATTING.
    //
    // The first attempt anchored to `^\s*"version"` -- start of line -- which
    // works on a pretty-printed manifest and silently does NOTHING on a compact
    // one. Running it against a real clone showed the manifest untouched while
    // the lockfile updated, producing a committed, half-applied bump: exactly
    // the "silently partial" edit this file's header says a test must prevent.
    //
    // Reading the value with JSON.parse and replacing that exact literal is
    // format-independent, and a round trip is still avoided so the diff stays
    // three characters rather than a reformat of the whole file.
    // ⚠ PARSED THROUGH A GUARD, NOT BARE. The read above is wrapped and a
    // missing manifest becomes `absent`; an unguarded `JSON.parse` right after
    // it meant a manifest that EXISTS but is malformed threw a raw
    // `SyntaxError` out of here, out of `runVersionStep`, and killed the deploy
    // with a message naming neither the file nor the reason. A corrupt manifest
    // is a bad input, not a crash, and it gets the same treatment as every
    // other unreadable one.
    const parsed = parseManifest(raw);
    if (parsed === undefined || typeof parsed.version !== 'string') {
      absent.push(relative);
      continue;
    }

    if (parsed.version === version) continue;

    const updated = raw.replace(
      new RegExp(`("version"\\s*:\\s*)"${escapeRegExp(parsed.version)}"`),
      `$1"${version}"`,
    );

    if (updated === raw) {
      // The value was read but could not be replaced. Never silent: a manifest
      // left behind is a version that disagrees with its siblings.
      throw new UsageError(
        `Could not write the version into ${relative}: its \`version\` field was not in a form this can edit.`,
      );
    }

    // Verified by re-reading rather than assumed. A partial bump that commits
    // is worse than one that refuses.
    // ⚠ The re-read is the verification, so a failure to parse here is a
    // REFUSAL, not an `absent`: this edit was applied to text that parsed a
    // moment ago, so if it no longer does, the edit broke the file.
    const after = parseManifest(updated);
    if (after === undefined || after.version !== version) {
      throw new UsageError(
        `Writing the version into ${relative} produced ${
          after === undefined ? 'a file that is no longer valid JSON' : String(after.version)
        }, not ${version}.`,
      );
    }

    writeFileSync(path, updated);
    changed.push(relative);
  }

  const lockPath = join(checkoutPath, 'package-lock.json');
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const updated = updateLockfile(raw, version);
    if (updated !== raw) {
      writeFileSync(lockPath, updated);
      changed.push('package-lock.json');
    }
  } catch {
    absent.push('package-lock.json');
  }

  return { changed, absent };
}

/**
 * Rewrites each workspace entry's `version` in the lockfile.
 *
 * Keyed on the workspace PATH (`"apps/api": {`), so this can never touch a
 * dependency that merely happens to share a version string.
 */
export function updateLockfile(raw: string, version: string): string {
  let out = raw;

  for (const relative of VERSIONED_MANIFESTS) {
    const workspace = relative.replace(/\/package\.json$/, '');
    // The entry opens with its path key; the `version` field follows within a
    // few lines. Bounded so a malformed lockfile cannot make this run away.
    const pattern = new RegExp(
      `("${workspace}"\\s*:\\s*\\{(?:[^{}]*?))"version"\\s*:\\s*"[^"]*"`,
      'g',
    );
    out = out.replace(pattern, `$1"version": "${version}"`);
  }

  return out;
}
