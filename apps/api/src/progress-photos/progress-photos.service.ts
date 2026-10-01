// =============================================================================
// ProgressPhotosService — the caller's private progress photos (E7.9, #249)
// =============================================================================
//
// Bytes never pass through here. The browser downscales the image (which also
// drops its EXIF block, `ImageIntake`), uploads it to `POST /api/storage/objects`
// and adds the object by id. The server stores that object as uploaded: it does
// NOT strip EXIF itself, so a client that skips the downscale keeps its
// metadata (a follow-up in the coach spec §7).
//
// Create checks, cheapest first:
//   1. the object exists (404) and is the caller's (403
//      `PROGRESS_PHOTO_OBJECT_NOT_OWNED`; no row is created);
//   2. it is `ready` (400 `PROGRESS_PHOTO_OBJECT_NOT_READY`);
//   3. its recorded size is within `PROGRESS_PHOTO_MAX_BYTES` (413
//      `PROGRESS_PHOTO_TOO_LARGE`);
//   4. its declared type is JPEG, PNG or WebP AND its STORED leading bytes say
//      so too, whatever the declared type claims (400 `PROGRESS_PHOTO_NOT_IMAGE`).
//
// Ordering is transaction-free: the object exists first, then the row. A row
// write that fails leaves an unreferenced object for the ordinary storage
// cleanup, which is safe precisely because nothing references it.
//
// Delete removes the row, then the storage object unless something else still
// holds it (another feature registered with `StorageObjectReferences`, or a
// photo intake that can still use it). The object delete is best effort: the
// user's delete succeeds and a provider failure is logged by id only.
//
// ⚠ PRIVACY. Progress photos are never sent to a model and never appear in a
// notification, push or email. Nothing here imports the AI platform or the
// notifications module (`test/coach/coach-photo-privacy.spec.ts`), and nothing
// here logs a storage key, a URL or a note: ids only.
// =============================================================================

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Readable } from 'node:stream';
import { z } from 'zod';

import { fromDbDate, toDbDate } from '../check-ins/local-date';
import { AppMetricsService, fallbackAppMetrics } from '../common/otel/app-metrics.service';
import { detectImageType } from '../common/profile-image/profile-image';
import { StorageObjectReferences } from '../intake/storage-object-references';
import { PrismaService } from '../prisma/prisma.service';
import { mimeTypeMatches, normaliseMimeType } from '../storage/mime-type-match';
import { ObjectsService } from '../storage/objects/objects.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../storage/providers/storage-provider.interface';
import type {
  CreateProgressPhotoInput,
  ListProgressPhotosQuery,
  ProgressPhotoPage,
  ProgressPhotoViewData,
} from './dto/progress-photo.dto';
import {
  PROGRESS_PHOTO_MAX_BYTES,
  PROGRESS_PHOTO_MIME_TYPES,
  PROGRESS_PHOTO_POSES,
  PROGRESS_PHOTO_REASONS,
  PROGRESS_PHOTO_SNIFF_BYTES,
  type ProgressPhotoPose,
} from './progress-photos.constants';

const PHOTO_SELECT = {
  id: true,
  storageObjectId: true,
  localDate: true,
  pose: true,
  note: true,
  createdAt: true,
} satisfies Prisma.ProgressPhotoSelect;

type PhotoRow = Prisma.ProgressPhotoGetPayload<{ select: typeof PHOTO_SELECT }>;

function poseOf(value: string): ProgressPhotoPose {
  return (PROGRESS_PHOTO_POSES as readonly string[]).includes(value) ? (value as ProgressPhotoPose) : 'other';
}

export function toProgressPhotoView(row: PhotoRow): ProgressPhotoViewData {
  return {
    id: row.id,
    storageObjectId: row.storageObjectId,
    localDate: fromDbDate(row.localDate),
    pose: poseOf(row.pose),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

export function progressPhotoNotFound(): NotFoundException {
  return new NotFoundException({
    message: 'Progress photo not found',
    details: { reason: PROGRESS_PHOTO_REASONS.NOT_FOUND },
  });
}

// -----------------------------------------------------------------------------
// Keyset cursor: (localDate, createdAt, id), newest first
// -----------------------------------------------------------------------------

const CURSOR_SEPARATOR = '|';

interface PhotoCursor {
  localDate: string;
  createdAt: Date;
  id: string;
}

export function encodePhotoCursor(row: Pick<PhotoRow, 'localDate' | 'createdAt' | 'id'>): string {
  return Buffer.from(
    [fromDbDate(row.localDate), row.createdAt.toISOString(), row.id].join(CURSOR_SEPARATOR),
    'utf8',
  ).toString('base64url');
}

export function decodePhotoCursor(cursor: string): PhotoCursor {
  const [localDate, at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(CURSOR_SEPARATOR);
  const createdAt = new Date(at ?? '');
  if (
    !id ||
    !z.uuid().safeParse(id).success ||
    !/^\d{4}-\d{2}-\d{2}$/.test(localDate ?? '') ||
    Number.isNaN(createdAt.getTime())
  ) {
    throw new BadRequestException({
      message: 'Invalid cursor',
      details: { issues: [{ path: 'cursor', message: 'Invalid cursor' }] },
    });
  }
  return { localDate, createdAt, id };
}

function afterCursor(cursor: PhotoCursor): Prisma.ProgressPhotoWhereInput {
  const day = toDbDate(cursor.localDate);
  return {
    OR: [
      { localDate: { lt: day } },
      { localDate: day, createdAt: { lt: cursor.createdAt } },
      { localDate: day, createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

@Injectable()
export class ProgressPhotosService {
  private readonly logger = new Logger(ProgressPhotosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: ObjectsService,
    private readonly references: StorageObjectReferences,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Optional() private readonly metrics: AppMetricsService = fallbackAppMetrics(),
  ) {}

  /** The caller's photos, newest day first (then newest upload), keyset-paged. */
  async list(userId: string, query: ListProgressPhotosQuery): Promise<ProgressPhotoPage> {
    const cursor = query.cursor ? decodePhotoCursor(query.cursor) : null;

    const rows = await this.prisma.progressPhoto.findMany({
      where: {
        userId,
        ...(query.pose ? { pose: query.pose } : {}),
        ...(cursor ? afterCursor(cursor) : {}),
      },
      orderBy: [{ localDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: PHOTO_SELECT,
    });

    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? encodePhotoCursor(page[page.length - 1]) : null;

    return { items: page.map(toProgressPhotoView), nextCursor };
  }

  async create(userId: string, input: CreateProgressPhotoInput): Promise<ProgressPhotoViewData> {
    const { storageObjectId } = input;
    const object = await this.prisma.storageObject.findUnique({
      where: { id: storageObjectId },
      select: { id: true, uploadedById: true, status: true, mimeType: true, size: true, storageKey: true },
    });

    if (!object) {
      throw new NotFoundException({ message: 'Storage object not found', details: { storageObjectId } });
    }

    if (object.uploadedById !== userId) {
      throw new ForbiddenException({
        message: 'The storage object is not yours',
        details: { reason: PROGRESS_PHOTO_REASONS.OBJECT_NOT_OWNED, storageObjectId },
      });
    }

    if (object.status !== 'ready') {
      throw new BadRequestException({
        message: 'The storage object is not ready yet',
        details: { reason: PROGRESS_PHOTO_REASONS.OBJECT_NOT_READY, storageObjectId },
      });
    }

    if (Number(object.size) > PROGRESS_PHOTO_MAX_BYTES) {
      throw new HttpException(
        {
          message: `The image is larger than ${PROGRESS_PHOTO_MAX_BYTES / (1024 * 1024)} MiB`,
          details: { reason: PROGRESS_PHOTO_REASONS.TOO_LARGE, storageObjectId, maxBytes: PROGRESS_PHOTO_MAX_BYTES },
        },
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const declaredOk = mimeTypeMatches(normaliseMimeType(object.mimeType), PROGRESS_PHOTO_MIME_TYPES);
    if (!declaredOk || !(await this.storedBytesAreImage(object.storageKey))) {
      throw new BadRequestException({
        message: 'Only JPEG, PNG and WebP images can be progress photos',
        details: {
          reason: PROGRESS_PHOTO_REASONS.NOT_IMAGE,
          storageObjectId,
          allowed: [...PROGRESS_PHOTO_MIME_TYPES],
        },
      });
    }

    // One object is one progress photo. The race is harmless (a second row
    // would only make delete keep the object until both rows are gone).
    const existing = await this.prisma.progressPhoto.count({ where: { storageObjectId } });
    if (existing > 0) {
      throw new HttpException(
        {
          message: 'This storage object is already a progress photo',
          details: { reason: PROGRESS_PHOTO_REASONS.ALREADY_ADDED, storageObjectId },
        },
        HttpStatus.CONFLICT,
      );
    }

    const row = await this.prisma.progressPhoto.create({
      data: {
        userId,
        storageObjectId,
        localDate: toDbDate(input.localDate),
        pose: input.pose,
        note: input.note ?? null,
      },
      select: PHOTO_SELECT,
    });

    this.metrics.progressPhotoChanged('added');
    return toProgressPhotoView(row);
  }

  /** Removes the photo, then its storage object unless something else still holds it. */
  async remove(userId: string, id: string): Promise<void> {
    const row = await this.prisma.progressPhoto.findFirst({
      where: { id, userId },
      select: { id: true, storageObjectId: true },
    });

    if (!row) throw progressPhotoNotFound();

    const { count } = await this.prisma.progressPhoto.deleteMany({ where: { id, userId } });
    if (count === 0) throw progressPhotoNotFound();

    this.metrics.progressPhotoChanged('deleted');
    await this.releaseObject(userId, row.storageObjectId);
  }

  // ---------------------------------------------------------------------------

  /** Deletes the object when no feature and no unapplied intake still holds it. Best effort. */
  private async releaseObject(userId: string, storageObjectId: string): Promise<void> {
    try {
      const [held, intakeHolders] = await Promise.all([
        this.references.isReferenced(storageObjectId),
        this.prisma.photoIntakePhoto.count({
          where: { storageObjectId, intake: { status: { not: 'applied' } } },
        }),
      ]);

      if (!held && intakeHolders === 0) {
        await this.objects.delete(storageObjectId, userId);
      }
    } catch (error) {
      this.logger.warn(
        `Could not delete storage object ${storageObjectId} of a removed progress photo: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Reads the object's leading bytes back: JPEG, PNG or WebP by signature. Never logs them. */
  private async storedBytesAreImage(storageKey: string): Promise<boolean> {
    const head = await readHead(await this.storage.download(storageKey), PROGRESS_PHOTO_SNIFF_BYTES);
    const detected = detectImageType(head);
    return detected !== null && (PROGRESS_PHOTO_MIME_TYPES as readonly string[]).includes(detected.mimeType);
  }
}

/** Up to `limit` leading bytes of `stream`; the download is always released. */
async function readHead(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buffer.subarray(0, limit - total));
      total += Math.min(buffer.length, limit - total);
      if (total >= limit) break;
    }
  } finally {
    stream.destroy();
  }

  return Buffer.concat(chunks, total);
}
