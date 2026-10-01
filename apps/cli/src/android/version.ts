import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { UsageError } from '../errors.js';

// =============================================================================
// apps/android/version.properties  (issue #286, epic #276)
// =============================================================================
//
// The committed source of truth for the APK version:
//
//   versionName=0.1.0
//   versionCode=1
//
// versionCode must STRICTLY increase for every published APK — Android refuses
// to install a lower code over a higher one — so every bump or set moves it by
// one (or to an explicit `--code`, which must still move forward).
// =============================================================================

export const DEFAULT_VERSION_NAME = '0.1.0';
export const DEFAULT_VERSION_CODE = 1;
/** Google Play's ceiling; the API enforces the same. */
export const MAX_VERSION_CODE = 2_100_000_000;

export type BumpPart = 'patch' | 'minor' | 'major';

export interface AppVersion {
  versionName: string;
  versionCode: number;
}

export interface ReadVersionResult extends AppVersion {
  /** False when the file is absent and the defaults were returned. */
  exists: boolean;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function isSemver(value: string): boolean {
  return SEMVER.test(value);
}

export function parseBumpPart(value: string): BumpPart {
  if (value === 'patch' || value === 'minor' || value === 'major') return value;
  throw new UsageError(`--bump must be patch, minor or major (got ${JSON.stringify(value)}).`);
}

export function bumpSemver(version: string, part: BumpPart): string {
  const match = SEMVER.exec(version);
  if (match === null) {
    throw new UsageError(`versionName "${version}" is not x.y.z, so it cannot be bumped. Use --set x.y.z.`);
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  switch (part) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
  }
}

/** Parse a `.properties` body into key → value. `#`/`!` comments and blanks skipped. */
export function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const match = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(trimmed);
    if (match?.[1] !== undefined) out.set(match[1], (match[2] ?? '').trim());
  }
  return out;
}

/**
 * Rewrite `key=value` lines in place, keeping comments, ordering and any
 * other keys; keys not present are appended.
 */
export function updateProperties(text: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const updated = lines.map((line) => {
    const match = /^(\s*)([^=:\s#!]+)(\s*[=:]\s*)(.*)$/.exec(line);
    const key = match?.[2];
    if (match === null || key === undefined || !pending.has(key)) return line;
    const value = pending.get(key) as string;
    pending.delete(key);
    return `${match[1] ?? ''}${key}${match[3] ?? '='}${value}`;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  return `${updated.join('\n')}\n`;
}

function parseCode(raw: string | undefined, file: string): number {
  const code = Number(raw);
  if (raw === undefined || !Number.isInteger(code) || code < 1 || code > MAX_VERSION_CODE) {
    throw new UsageError(`${file}: versionCode must be a whole number from 1 to ${MAX_VERSION_CODE} (got ${JSON.stringify(raw)}).`);
  }
  return code;
}

/** Read the file; a missing file yields the defaults with `exists: false`. */
export function readVersion(file: string): ReadVersionResult {
  if (!existsSync(file)) {
    return { versionName: DEFAULT_VERSION_NAME, versionCode: DEFAULT_VERSION_CODE, exists: false };
  }
  const props = parseProperties(readFileSync(file, 'utf8'));
  const versionName = props.get('versionName') ?? DEFAULT_VERSION_NAME;
  const versionCode = props.has('versionCode') ? parseCode(props.get('versionCode'), file) : DEFAULT_VERSION_CODE;
  return { versionName, versionCode, exists: true };
}

export function writeVersion(file: string, version: AppVersion): void {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(
    file,
    updateProperties(current, {
      versionName: version.versionName,
      versionCode: String(version.versionCode),
    }),
    'utf8',
  );
}

export interface VersionChange {
  bump?: BumpPart | undefined;
  set?: string | undefined;
  code?: number | undefined;
}

/**
 * Apply a `version` command's flags. Returns `undefined` when no change was
 * asked for. Any change moves versionCode forward by one unless `code` is
 * given; an explicit code must still be greater than the current one.
 *
 * A file that does not exist yet is created at the defaults (0.1.0 / 1) by
 * this change: `--bump patch` on a missing file yields 0.1.0 / 1 rather than
 * skipping 0.1.0, so the first release is the documented starting point.
 */
export function applyVersionChange(
  current: ReadVersionResult,
  change: VersionChange,
): AppVersion | undefined {
  if (change.bump !== undefined && change.set !== undefined) {
    throw new UsageError('Pass --bump or --set, not both.');
  }
  if (change.bump === undefined && change.set === undefined && change.code === undefined) return undefined;

  if (change.set !== undefined && !isSemver(change.set)) {
    throw new UsageError(`--set must be x.y.z (got ${JSON.stringify(change.set)}).`);
  }

  if (!current.exists) {
    return {
      versionName: change.set ?? current.versionName,
      versionCode: change.code ?? current.versionCode,
    };
  }

  const versionName =
    change.set ?? (change.bump !== undefined ? bumpSemver(current.versionName, change.bump) : current.versionName);

  if (change.code !== undefined) {
    if (!Number.isInteger(change.code) || change.code < 1 || change.code > MAX_VERSION_CODE) {
      throw new UsageError(`--code must be a whole number from 1 to ${MAX_VERSION_CODE}.`);
    }
    if (change.code <= current.versionCode) {
      throw new UsageError(
        `--code ${change.code} is not greater than the current versionCode ${current.versionCode}; Android refuses to install a lower or equal code over a newer one.`,
      );
    }
  }
  return { versionName, versionCode: change.code ?? current.versionCode + 1 };
}
