import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { ANDROID_APK_STEM } from '@app/shared';

import { PreconditionError } from '../errors.js';
import type { ExecFn } from './exec.js';

// =============================================================================
// Build metadata: dist/android/<slug>-android-<versionName>.json  (issue #286)
// =============================================================================
//
// Written next to every APK `android build` produces, and read back by
// `android publish` so the upload carries exactly what was built — no aapt
// parsing: the version comes from version.properties and the signer from the
// keystore that signed it.
// =============================================================================

export interface ApkMetadata {
  packageName: string;
  versionName: string;
  versionCode: number;
  /** Lowercase hex, no colons — the form the API stores. */
  signingSha256: string;
  fileSha256: string;
  sizeBytes: number;
  builtAt: string;
  gitSha: string | null;
}

export function apkFileName(versionName: string): string {
  return `${ANDROID_APK_STEM}-${versionName}.apk`;
}

/** `foo.apk` → `foo.json`. */
export function metadataPathFor(apkPath: string): string {
  return join(dirname(apkPath), `${basename(apkPath).replace(/\.apk$/i, '')}.json`);
}

/** Streaming SHA-256 — an APK can be 100+ MB and is never read into memory whole. */
export function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** `git rev-parse HEAD`, or null outside a repository / without git. */
export async function readGitSha(exec: ExecFn, cwd: string): Promise<string | null> {
  try {
    const result = await exec('git', ['rev-parse', 'HEAD'], { cwd });
    const sha = result.stdout.trim();
    return result.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export interface BuildMetadataInput {
  apkPath: string;
  packageName: string;
  versionName: string;
  versionCode: number;
  signingSha256: string;
  gitSha: string | null;
  now?: Date | undefined;
}

export async function buildMetadata(input: BuildMetadataInput): Promise<ApkMetadata> {
  return {
    packageName: input.packageName,
    versionName: input.versionName,
    versionCode: input.versionCode,
    signingSha256: input.signingSha256.replace(/:/g, '').toLowerCase(),
    fileSha256: await fileSha256(input.apkPath),
    sizeBytes: statSync(input.apkPath).size,
    builtAt: (input.now ?? new Date()).toISOString(),
    gitSha: input.gitSha,
  };
}

export function writeMetadata(path: string, metadata: ApkMetadata): void {
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

export function readMetadata(path: string): ApkMetadata {
  if (!existsSync(path)) {
    throw new PreconditionError(`No metadata at ${path}. Build with \`android build\`, which writes it next to the APK.`);
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ApkMetadata>;
  const missing = (['packageName', 'versionName', 'versionCode', 'signingSha256'] as const).filter(
    (key) => value[key] === undefined || value[key] === '',
  );
  if (missing.length > 0) {
    throw new PreconditionError(`${path} is missing ${missing.join(', ')}.`);
  }
  return value as ApkMetadata;
}
