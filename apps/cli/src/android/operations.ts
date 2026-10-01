import { existsSync } from 'node:fs';

import { ApiClient, resolveApiBaseUrl } from '../api-client.js';
import { CLI_NAME } from '../branding.js';
import { PreconditionError } from '../errors.js';
import { metadataPathFor, readMetadata, type ApkMetadata } from './metadata.js';
import { versionPropertiesPath } from './paths.js';
import { publishRelease, type AndroidRelease } from './publish.js';
import { withUploadProgress, type UploadProgressFn } from './upload-progress.js';
import { applyVersionChange, readVersion, writeVersion, type AppVersion, type BumpPart } from './version.js';

// =============================================================================
// The android actions the command, the TUI screen and deploy all perform  (#291)
// =============================================================================
//
// `android version --bump`, `android publish` and `android release` were
// written as closures inside commands/android.ts. The TUI's Android screen
// (#291) and `deploy --with-android` (#292) perform the same two actions, so
// they live here once — the command, the screen and the deploy step differ
// only in how they render what happened.
// =============================================================================

export interface VersionBump {
  before: AppVersion;
  after: AppVersion;
  /** version.properties did not exist and is created by this bump. */
  created: boolean;
}

/** What `bumpVersionFile` would do, without writing — for a confirmation. */
export function previewBump(repoRoot: string, part: BumpPart): VersionBump {
  const current = readVersion(versionPropertiesPath(repoRoot));
  const after = applyVersionChange(current, { bump: part }) as AppVersion;
  return {
    before: { versionName: current.versionName, versionCode: current.versionCode },
    after,
    created: !current.exists,
  };
}

/** Bump version.properties (name and code). Never commits. */
export function bumpVersionFile(repoRoot: string, part: BumpPart): VersionBump {
  const bump = previewBump(repoRoot, part);
  writeVersion(versionPropertiesPath(repoRoot), bump.after);
  return bump;
}

export interface PublishCredentials {
  serverUrl: string;
  token: string;
}

export interface PublishBuiltApkOptions {
  apkPath: string;
  credentials: PublishCredentials;
  notes?: string | undefined;
  makeCurrent: boolean;
  force?: boolean | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  /** Bytes sent so far; the total is about `metadata.sizeBytes`. Streams the body chunked. */
  onUploadProgress?: UploadProgressFn | undefined;
}

export interface PublishedApk {
  release: AndroidRelease;
  metadata: ApkMetadata;
}

/** The metadata `android build` wrote next to an APK. Throws when the APK is missing. */
export function readBuiltApk(apkPath: string): ApkMetadata {
  if (!existsSync(apkPath)) {
    throw new PreconditionError(`${apkPath} does not exist. Build it with \`${CLI_NAME} android build\`.`);
  }
  return readMetadata(metadataPathFor(apkPath));
}

/** Upload a built APK (with its metadata JSON) to a server. */
export async function publishBuiltApk(options: PublishBuiltApkOptions): Promise<PublishedApk> {
  const metadata = readBuiltApk(options.apkPath);
  const base = options.fetch ?? globalThis.fetch.bind(globalThis);
  const fetch = options.onUploadProgress === undefined ? options.fetch : withUploadProgress(base, options.onUploadProgress);
  const client = new ApiClient({
    baseUrl: resolveApiBaseUrl(options.credentials.serverUrl),
    token: options.credentials.token,
    ...(fetch === undefined ? {} : { fetch }),
  });
  const release = await publishRelease(client, options.apkPath, metadata, {
    notes: options.notes,
    makeCurrent: options.makeCurrent,
    force: options.force === true,
  });
  return { release, metadata };
}

/** An authenticated client for the release endpoints. */
export function releasesClient(credentials: PublishCredentials, fetch?: typeof globalThis.fetch): ApiClient {
  return new ApiClient({
    baseUrl: resolveApiBaseUrl(credentials.serverUrl),
    token: credentials.token,
    ...(fetch === undefined ? {} : { fetch }),
  });
}
