import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Multipart, MultipartFile } from '@fastify/multipart';
import { Prisma, type AndroidAppRelease } from '@prisma/client';

import { deriveSigningKey } from '../../common/crypto/secret-cipher';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageConfigService } from '../../storage/config/storage-config.service';
import { StorageNotConfiguredError } from '../../storage/config/storage-not-configured.error';
import { STORAGE_PROVIDER, type StorageProvider } from '../../storage/providers/storage-provider.interface';
import { AndroidAppService } from '../android-app.service';
import type { AdminRelease, DownloadLink, PublicRelease } from '../dto/android-release.dto';
import {
  ANDROID_RELEASE_AUDIT,
  ANDROID_RELEASE_REASONS,
  APK_FILE_FIELD,
  APK_MIME_TYPE,
  DOWNLOAD_LINK_TTL_SECONDS,
  DOWNLOAD_ROUTE_PREFIX,
  DOWNLOAD_TOKEN_KEY_PURPOSE,
  MAX_APK_BYTES,
  ONE_CURRENT_RELEASE_INDEX,
  androidReleaseKey,
  apkFileName,
} from './android-release.constants';
import { releaseUploadFieldsSchema, type ReleaseUploadFields, versionRuleRefusal } from './android-release.schema';
import { ApkInspector } from './apk-inspector';
import { signDownloadToken, verifyDownloadToken } from './download-token';

// =============================================================================
// AndroidReleaseService — hosted APK releases (issue #285, epic #276)
// =============================================================================
//
// UPLOAD. A multipart body: the file `apk` plus text fields. The APK is never
// buffered: it streams from the multipart parser through `ApkInspector` (ZIP
// magic, size limit, SHA-256) straight into object storage under
// `android-releases/<releaseId>.apk`. Fields may arrive before or after the
// file; when all required ones arrive first (the CLI sends them first) they are
// validated, and the version rules checked, BEFORE a byte is stored. Any
// failure after the bytes are stored deletes them (best effort).
//
// ONE CURRENT RELEASE. The raw-SQL partial unique index
// `android_app_releases_one_current_uniq_idx` decides it: making a release
// current clears the flag and sets the new one in ONE transaction, and a
// concurrent make-current that loses the race is a P2002 on that index
// (409 RELEASE_CURRENT_CONFLICT), never a `findFirst` pre-check.
//
// VERSION RULES. `(packageName, versionCode)` is unique (409
// RELEASE_VERSION_EXISTS, decided by the unique index on create). Uploading as
// current a versionCode not above the current release of the same package is
// 409 RELEASE_VERSION_NOT_NEWER unless `force`. `make-current` is the explicit
// rollback and has no such rule.
//
// TRUST. Making a release current adds its (packageName, signingSha256) to the
// trusted Android apps (assetlinks.json) when absent — an administrator's own
// act, through the same audited save the Android app settings page uses.
//
// DOWNLOAD. A signed, ten-minute, navigable link (`download-token.ts`); the
// public download route streams the object with the APK content type.
//
// Request-scoped work bounded by the upload itself: not a queue job.
// =============================================================================

const UPLOADER = { uploadedBy: { select: { id: true, email: true, displayName: true } } } as const;

type ReleaseWithUploader = AndroidAppRelease & {
  uploadedBy: { id: string; email: string; displayName: string | null } | null;
};

const REQUIRED_FIELDS = ['packageName', 'versionName', 'versionCode', 'signingSha256'] as const;

export interface OpenedDownload {
  stream: Readable;
  sizeBytes: number;
  fileName: string;
}

export function toPublicRelease(release: AndroidAppRelease): PublicRelease {
  return {
    id: release.id,
    packageName: release.packageName,
    versionName: release.versionName,
    versionCode: release.versionCode,
    fileSha256: release.fileSha256,
    sizeBytes: release.sizeBytes,
    notes: release.notes,
    createdAt: release.createdAt.toISOString(),
  };
}

export function toAdminRelease(release: ReleaseWithUploader): AdminRelease {
  return {
    ...toPublicRelease(release),
    signingSha256: release.signingSha256,
    isCurrent: release.isCurrent,
    uploadedBy: release.uploadedBy
      ? { id: release.uploadedBy.id, email: release.uploadedBy.email, displayName: release.uploadedBy.displayName }
      : null,
  };
}

/** Is `error` a P2002 on the index named `indexName`? */
export function isUniqueViolationOn(error: unknown, indexName: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;

  const meta = (error.meta ?? {}) as Record<string, unknown>;
  const cause = (meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined)?.cause;
  if (cause) {
    const constraint = cause.constraint as { index?: unknown } | undefined;
    if (constraint?.index === indexName) return true;
    if (typeof cause.originalMessage === 'string' && cause.originalMessage.includes(indexName)) return true;
  }

  const target = meta.target;
  if (typeof target === 'string') return target === indexName;
  if (Array.isArray(target)) return target.some((entry) => String(entry) === indexName);

  return typeof error.message === 'string' && error.message.includes(indexName);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function invalidUpload(message: string, extra: Record<string, unknown> = {}): BadRequestException {
  return new BadRequestException({ message, details: { reason: ANDROID_RELEASE_REASONS.INVALID_UPLOAD, ...extra } });
}

function notFound(): NotFoundException {
  return new NotFoundException({
    message: 'Android release not found',
    details: { reason: ANDROID_RELEASE_REASONS.NOT_FOUND },
  });
}

function versionExists(fields: { packageName: string; versionCode: number }): ConflictException {
  return new ConflictException({
    message: `${fields.packageName} versionCode ${fields.versionCode} has already been uploaded.`,
    details: {
      reason: ANDROID_RELEASE_REASONS.VERSION_EXISTS,
      packageName: fields.packageName,
      versionCode: fields.versionCode,
    },
  });
}

function currentConflict(): ConflictException {
  return new ConflictException({
    message: 'Another release was made current at the same time. Reload and try again.',
    details: { reason: ANDROID_RELEASE_REASONS.CURRENT_CONFLICT },
  });
}

/**
 * Translate `@fastify/multipart` errors (plain FastifyErrors, which the global
 * filter would otherwise turn into a 500) into client errors.
 */
export function toClientUploadError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new PayloadTooLargeException({
      message: `The APK exceeds the ${MAX_APK_BYTES / (1024 * 1024)} MB limit.`,
      details: { reason: ANDROID_RELEASE_REASONS.TOO_LARGE, maxBytes: MAX_APK_BYTES },
    });
  }
  if (typeof code === 'string' && code.startsWith('FST_')) {
    return invalidUpload(
      `Invalid multipart body. Send multipart/form-data with the APK in the "${APK_FILE_FIELD}" field and the ` +
        'release fields as text fields.',
    );
  }
  return error;
}

@Injectable()
export class AndroidReleaseService {
  private readonly logger = new Logger(AndroidReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly storageConfig: StorageConfigService,
    private readonly androidApp: AndroidAppService,
  ) {}

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  /** Throws `StorageNotConfiguredError` (503) when there is nowhere to put an APK. Reads nothing else. */
  async assertStorageWritable(): Promise<void> {
    const resolution = await this.storageConfig.resolve();
    if (!resolution.configured) {
      throw StorageNotConfiguredError.missing(resolution.provider, resolution.missing);
    }
  }

  /** `POST /api/admin/android-app/releases`. `parts` is the request's multipart iterator. */
  async upload(parts: AsyncIterable<Multipart>, userId: string): Promise<AdminRelease> {
    const id = randomUUID();
    const storageKey = androidReleaseKey(id);
    const raw: Record<string, string> = {};
    let file: { sizeBytes: number; fileSha256: string } | null = null;

    try {
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname in raw) throw invalidUpload(`The field "${part.fieldname}" was sent twice.`);
          raw[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
          continue;
        }

        if (part.fieldname !== APK_FILE_FIELD || file) {
          part.file.resume();
          throw invalidUpload(`Send exactly one file, in the "${APK_FILE_FIELD}" field.`);
        }

        try {
          // Fail fast, before storing a byte, when the metadata came first.
          if (REQUIRED_FIELDS.every((name) => name in raw)) {
            await this.assertUploadAllowed(this.parseFields(raw));
          }
        } catch (error) {
          part.file.resume();
          throw error;
        }

        file = await this.storeApk(storageKey, part);
      }
    } catch (error) {
      if (file) await this.deleteStoredBytes(storageKey);
      throw toClientUploadError(error);
    }

    if (!file) throw invalidUpload(`No APK: send the file in the "${APK_FILE_FIELD}" field.`);

    let fields: ReleaseUploadFields;
    let release: ReleaseWithUploader;
    try {
      fields = this.parseFields(raw);
      await this.assertUploadAllowed(fields);
      release = await this.createRelease(id, storageKey, fields, file, userId);
    } catch (error) {
      await this.deleteStoredBytes(storageKey);
      throw error;
    }

    const trustedAppAdded = release.isCurrent ? await this.trust(release, userId) : false;

    await this.audit(userId, ANDROID_RELEASE_AUDIT.UPLOADED, release.id, {
      packageName: release.packageName,
      versionName: release.versionName,
      versionCode: release.versionCode,
      sizeBytes: release.sizeBytes,
      fileSha256: release.fileSha256,
      isCurrent: release.isCurrent,
      forced: fields.force,
      trustedAppAdded,
    });
    this.logger.log(
      `Android release ${release.packageName} ${release.versionName} (${release.versionCode}) uploaded by user ` +
        `${userId}: ${release.id}${release.isCurrent ? ' [current]' : ''}`,
    );

    return toAdminRelease(release);
  }

  /** `GET /api/admin/android-app/releases` — newest first. */
  async list(): Promise<{ data: AdminRelease[] }> {
    const releases = await this.prisma.androidAppRelease.findMany({
      include: UPLOADER,
      orderBy: [{ createdAt: 'desc' }, { versionCode: 'desc' }],
    });
    return { data: releases.map(toAdminRelease) };
  }

  /** `POST /api/admin/android-app/releases/:id/make-current` — also the rollback. Idempotent. */
  async makeCurrent(id: string, userId: string): Promise<AdminRelease> {
    const existing = await this.prisma.androidAppRelease.findUnique({ where: { id }, include: UPLOADER });
    if (!existing) throw notFound();

    let release: ReleaseWithUploader = existing;
    let previousId: string | null = null;
    if (!existing.isCurrent) {
      try {
        release = await this.prisma.$transaction(async (tx) => {
          const previous = await tx.androidAppRelease.findFirst({ where: { isCurrent: true }, select: { id: true } });
          previousId = previous?.id ?? null;
          await tx.androidAppRelease.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
          return tx.androidAppRelease.update({ where: { id }, data: { isCurrent: true }, include: UPLOADER });
        });
      } catch (error) {
        if (isUniqueViolationOn(error, ONE_CURRENT_RELEASE_INDEX)) throw currentConflict();
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') throw notFound();
        throw error;
      }
    }

    const trustedAppAdded = await this.trust(release, userId);
    if (!existing.isCurrent) {
      await this.audit(userId, ANDROID_RELEASE_AUDIT.MADE_CURRENT, release.id, {
        packageName: release.packageName,
        versionName: release.versionName,
        versionCode: release.versionCode,
        previousReleaseId: previousId,
        trustedAppAdded,
      });
    }

    return toAdminRelease(release);
  }

  /** `DELETE /api/admin/android-app/releases/:id` — the stored APK first, then the row. */
  async remove(id: string, userId: string): Promise<void> {
    const release = await this.prisma.androidAppRelease.findUnique({ where: { id } });
    if (!release) throw notFound();
    if (release.isCurrent) {
      throw new ConflictException({
        message: 'The current release cannot be deleted. Make another release current first.',
        details: { reason: ANDROID_RELEASE_REASONS.IS_CURRENT },
      });
    }

    // Bytes first: a storage failure (503 when storage is not configured)
    // keeps the row, so the delete can be retried; the reverse order would
    // leave invisible billable bytes.
    await this.storage.delete(release.storageKey);
    await this.prisma.androidAppRelease.deleteMany({ where: { id, isCurrent: false } });

    await this.audit(userId, ANDROID_RELEASE_AUDIT.DELETED, release.id, {
      packageName: release.packageName,
      versionName: release.versionName,
      versionCode: release.versionCode,
    });
  }

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  /** The current release, or null. */
  async current(): Promise<AndroidAppRelease | null> {
    return this.prisma.androidAppRelease.findFirst({ where: { isCurrent: true } });
  }

  /** `GET /api/android-app/releases/latest`. */
  async latest(): Promise<PublicRelease> {
    const release = await this.current();
    if (!release) {
      throw new NotFoundException({
        message: 'No Android release has been published on this server.',
        details: { reason: ANDROID_RELEASE_REASONS.NO_RELEASE },
      });
    }
    return toPublicRelease(release);
  }

  /** `POST /api/android-app/releases/:id/download-link`. */
  async createDownloadLink(id: string, userId: string, now: Date = new Date()): Promise<DownloadLink> {
    const release = await this.prisma.androidAppRelease.findUnique({ where: { id }, select: { id: true } });
    if (!release) throw notFound();

    const expiresAt = Math.floor(now.getTime() / 1000) + DOWNLOAD_LINK_TTL_SECONDS;
    const token = signDownloadToken(deriveSigningKey(DOWNLOAD_TOKEN_KEY_PURPOSE), {
      releaseId: release.id,
      userId,
      expiresAt,
    });

    return { url: `${DOWNLOAD_ROUTE_PREFIX}${token}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }

  /**
   * `GET /api/android-app/download/:token`: validates the token (404 invalid,
   * 410 expired), that the release still exists and the user is still active,
   * then opens the stored APK.
   */
  async openDownload(token: string, now: Date = new Date()): Promise<OpenedDownload> {
    const verdict = verifyDownloadToken(
      deriveSigningKey(DOWNLOAD_TOKEN_KEY_PURPOSE),
      token,
      Math.floor(now.getTime() / 1000),
    );

    if (!verdict.ok && verdict.reason === 'expired') {
      throw new GoneException({
        message: 'This download link has expired. Request a new one.',
        details: { reason: ANDROID_RELEASE_REASONS.LINK_EXPIRED },
      });
    }
    const invalid = new NotFoundException({
      message: 'Download link not found.',
      details: { reason: ANDROID_RELEASE_REASONS.LINK_INVALID },
    });
    if (!verdict.ok) throw invalid;

    const [release, user] = await Promise.all([
      this.prisma.androidAppRelease.findUnique({ where: { id: verdict.claims.releaseId } }),
      this.prisma.user.findUnique({ where: { id: verdict.claims.userId }, select: { isActive: true } }),
    ]);
    if (!release || !user?.isActive) throw invalid;

    const stream = await this.storage.download(release.storageKey);
    return { stream, sizeBytes: release.sizeBytes, fileName: apkFileName(release.versionName) };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private parseFields(raw: Record<string, string>): ReleaseUploadFields {
    const parsed = releaseUploadFieldsSchema.safeParse(raw);
    if (!parsed.success) {
      throw invalidUpload('The release fields are invalid.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    return parsed.data;
  }

  /**
   * The version rules, as a fast refusal. Authoritative only together with
   * the unique indexes `createRelease` relies on.
   */
  private async assertUploadAllowed(fields: ReleaseUploadFields): Promise<void> {
    const existing = await this.prisma.androidAppRelease.findUnique({
      where: { packageName_versionCode: { packageName: fields.packageName, versionCode: fields.versionCode } },
      select: { id: true },
    });
    if (existing) throw versionExists(fields);

    if (fields.makeCurrent) {
      const current = await this.current();
      this.assertNewer(current, fields);
    }
  }

  private assertNewer(current: AndroidAppRelease | null, fields: ReleaseUploadFields): void {
    if (versionRuleRefusal(current, fields, fields.force) && current) {
      throw new ConflictException({
        message:
          `versionCode ${fields.versionCode} is not newer than the current ${current.packageName} release ` +
          `(${current.versionCode}); Android refuses downgrades. Bump versionCode, upload without making it ` +
          'current, or force it.',
        details: {
          reason: ANDROID_RELEASE_REASONS.VERSION_NOT_NEWER,
          currentReleaseId: current.id,
          currentVersionCode: current.versionCode,
        },
      });
    }
  }

  private async storeApk(storageKey: string, part: MultipartFile): Promise<{ sizeBytes: number; fileSha256: string }> {
    const inspector = new ApkInspector(MAX_APK_BYTES);
    part.file.on('limit', () => inspector.rejectTooLarge());
    part.file.on('error', (error) => inspector.destroy(error));
    part.file.pipe(inspector);

    try {
      await this.storage.upload(storageKey, inspector, {
        mimeType: APK_MIME_TYPE,
        metadata: { purpose: 'android-release' },
      });
    } catch (error) {
      part.file.resume();
      await this.deleteStoredBytes(storageKey);
      throw inspector.failure ?? error;
    }

    if (inspector.failure || part.file.truncated) {
      await this.deleteStoredBytes(storageKey);
      throw inspector.failure ?? toClientUploadError({ code: 'FST_REQ_FILE_TOO_LARGE' });
    }

    return { sizeBytes: inspector.sizeBytes, fileSha256: inspector.digest() };
  }

  private async createRelease(
    id: string,
    storageKey: string,
    fields: ReleaseUploadFields,
    file: { sizeBytes: number; fileSha256: string },
    userId: string,
  ): Promise<ReleaseWithUploader> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (fields.makeCurrent) {
          this.assertNewer(await tx.androidAppRelease.findFirst({ where: { isCurrent: true } }), fields);
          await tx.androidAppRelease.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
        }
        return tx.androidAppRelease.create({
          data: {
            id,
            packageName: fields.packageName,
            versionName: fields.versionName,
            versionCode: fields.versionCode,
            signingSha256: fields.signingSha256,
            fileSha256: file.fileSha256,
            sizeBytes: file.sizeBytes,
            storageKey,
            notes: fields.notes,
            isCurrent: fields.makeCurrent,
            uploadedById: userId,
          },
          include: UPLOADER,
        });
      });
    } catch (error) {
      if (isUniqueViolationOn(error, ONE_CURRENT_RELEASE_INDEX)) throw currentConflict();
      if (isUniqueViolation(error)) throw versionExists(fields);
      throw error;
    }
  }

  private async trust(release: AndroidAppRelease, userId: string): Promise<boolean> {
    try {
      return await this.androidApp.ensureTrusted(
        { packageName: release.packageName, sha256: release.signingSha256 },
        userId,
      );
    } catch (error) {
      // The release itself is saved; trust can be added by hand.
      this.logger.warn(
        `Could not trust ${release.packageName} for release ${release.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async deleteStoredBytes(storageKey: string): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch (error) {
      this.logger.warn(
        `Failed to delete stored APK bytes at ${storageKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async audit(userId: string, action: string, releaseId: string, meta: Record<string, unknown>): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'android_app_release',
        targetId: releaseId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}
