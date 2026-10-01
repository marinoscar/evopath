import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';

import type { ApiClient } from '../api-client.js';
import { CLI_NAME } from '../branding.js';
import { ApiError } from '../errors.js';
import type { ApkMetadata } from './metadata.js';

// =============================================================================
// Server releases: upload, list, make current  (issue #286; API #285)
// =============================================================================
//
//   POST /api/admin/android-app/releases                  (system_settings:write)
//   GET  /api/admin/android-app/releases                  (system_settings:read)
//   POST /api/admin/android-app/releases/:id/make-current (system_settings:write)
//
// The upload is multipart with the file in field `apk`, streamed from disk
// via `fs.openAsBlob` — never read into memory (an APK may be 150 MB).
// =============================================================================

export const RELEASES_PATH = '/admin/android-app/releases';

/** Uploads get far longer than the client's 30 s default. */
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;

export interface AndroidRelease {
  id: string;
  packageName: string;
  versionName: string;
  versionCode: number;
  signingSha256?: string;
  fileSha256: string;
  sizeBytes: number;
  notes?: string | null;
  isCurrent?: boolean;
  createdAt: string;
}

export interface PublishOptions {
  notes?: string | undefined;
  makeCurrent: boolean;
  force: boolean;
}

/** The multipart body. Text fields first: some multipart parsers need them before the file. */
export async function buildPublishForm(
  apkPath: string,
  metadata: ApkMetadata,
  options: PublishOptions,
  openBlob: (path: string) => Promise<Blob> = (path) => openAsBlob(path, { type: 'application/vnd.android.package-archive' }),
): Promise<FormData> {
  const form = new FormData();
  form.append('versionName', metadata.versionName);
  form.append('versionCode', String(metadata.versionCode));
  form.append('packageName', metadata.packageName);
  form.append('signingSha256', metadata.signingSha256);
  if (options.notes !== undefined && options.notes !== '') form.append('notes', options.notes);
  form.append('makeCurrent', String(options.makeCurrent));
  if (options.force) form.append('force', 'true');
  form.append('apk', await openBlob(apkPath), basename(apkPath));
  return form;
}

/** Turn the API's release conflicts into what to do about them. */
export function explainPublishError(error: unknown, metadata: ApkMetadata): Error {
  if (!(error instanceof ApiError)) return error as Error;
  const bump = `Run \`${CLI_NAME} android version --bump patch\` and build again.`;
  switch (error.code) {
    case 'RELEASE_VERSION_EXISTS':
      return withMessage(error, `versionCode ${metadata.versionCode} is already published for ${metadata.packageName}. ${bump}`);
    case 'RELEASE_VERSION_NOT_NEWER':
      return withMessage(
        error,
        `The current release has a versionCode at or above ${metadata.versionCode}, and Android refuses downgrades. ${bump} ` +
          `(Or pass --force to upload it anyway, or --no-current to upload without making it current.)`,
      );
    default:
      return error;
  }
}

function withMessage(error: ApiError, sentence: string): ApiError {
  return new ApiError({
    status: error.status,
    serverMessage: `${error.serverMessage} — ${sentence}`,
    code: error.code,
    details: error.details,
    method: error.method,
    url: error.url,
    structured: error.structured,
    rawBody: error.rawBody,
  });
}

export async function publishRelease(
  client: ApiClient,
  apkPath: string,
  metadata: ApkMetadata,
  options: PublishOptions,
): Promise<AndroidRelease> {
  const formData = await buildPublishForm(apkPath, metadata, options);
  try {
    return await client.request<AndroidRelease>('POST', RELEASES_PATH, { formData, timeoutMs: UPLOAD_TIMEOUT_MS });
  } catch (error) {
    throw explainPublishError(error, metadata);
  }
}

export async function listReleases(client: ApiClient): Promise<AndroidRelease[]> {
  const result = await client.send<unknown>('GET', RELEASES_PATH);
  // `{ data: Release[] }`, possibly wrapped by the response envelope again.
  const data = result.data as unknown;
  if (Array.isArray(data)) return data as AndroidRelease[];
  const nested = (data as { data?: unknown } | undefined)?.data;
  return Array.isArray(nested) ? (nested as AndroidRelease[]) : [];
}

export async function makeCurrent(client: ApiClient, id: string): Promise<AndroidRelease> {
  return await client.request<AndroidRelease>('POST', `${RELEASES_PATH}/${encodeURIComponent(id)}/make-current`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The releases table. */
export function formatReleasesTable(releases: readonly AndroidRelease[]): string {
  if (releases.length === 0) return 'No releases have been published yet.\n';
  const rows = releases.map((release) => [
    release.isCurrent === true ? '*' : ' ',
    release.versionName,
    String(release.versionCode),
    formatBytes(release.sizeBytes),
    release.createdAt.slice(0, 16).replace('T', ' '),
    release.fileSha256.slice(0, 12),
    release.id,
  ]);
  const header = [' ', 'VERSION', 'CODE', 'SIZE', 'UPLOADED', 'SHA-256', 'ID'];
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return `${[render(header), ...rows.map(render)].join('\n')}\n\n* = current release\n`;
}

/** Where users download the app in the web UI. */
export function downloadPageUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '').replace(/\/api$/, '')}/settings/android-app`;
}
