// =============================================================================
// HealthDocumentsService — the caller's health documents (H6, #190)
// =============================================================================
//
// List, read, rename/date, download link and delete, every one owner-scoped:
// a document of another user is a 404, never a 403.
//
// Delete:
//   - the file still exists: the `health.document.purge` job is enqueued with
//     `reason: 'user_delete'` (it erases kept files too), inside one
//     transaction with the version bump, the optional soft-delete of the
//     document's values and the audit row. The row stays, so provenance never
//     dangles; once the job ran it lists as metadata only;
//   - the file is already gone: the row itself is removed. Measurements keep
//     `sourceRef.healthDocumentId` and report `fileDeleted: true`
//     (`fileStatesOf` reads a missing document as a deleted file).
//
// `version` guards PATCH and DELETE: a conditional write on `version` is the
// real check (the read before it only tells 404 from 412).
//
// ⚠ Never log a document name or a signed URL: ids and counts only.
// =============================================================================

import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { Prisma } from '@prisma/client';

import { EvoPathMetricsService, fallbackEvoPathMetrics } from '../app-metrics/domain-metrics.service';
import { JobsService } from '../jobs/jobs.service';
import { ACTIVE } from '../measurements/measurement-active';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../storage/providers/storage-provider.interface';
import type {
  DownloadDisposition,
  HealthDocumentDeleteResult,
  HealthDocumentDownload,
  HealthDocumentPage,
  HealthDocumentView,
  ListHealthDocumentsQuery,
  UpdateHealthDocument,
} from './dto/health-document.dto';
import { contentDispositionOf, downloadNameOf, effectiveDisposition } from './health-document-names';
import {
  FILE_RETENTIONS,
  type FileRetention,
  HEALTH_DOCUMENT_DELETE_AUDIT_ACTION,
  HEALTH_DOCUMENT_DOWNLOAD_TTL_SECONDS,
  HEALTH_DOCUMENT_PURGE_JOB_TYPE,
  HEALTH_DOCUMENT_REASONS,
  HEALTH_DOCUMENT_SUBJECT_TYPE,
  type HealthDocumentPurgeReason,
} from './health-document.constants';

const DOCUMENT_SELECT = {
  id: true,
  userId: true,
  kind: true,
  storageObjectId: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  retention: true,
  intakeId: true,
  documentDate: true,
  fileDeletedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.HealthDocumentSelect;

type DocumentRow = Prisma.HealthDocumentGetPayload<{ select: typeof DOCUMENT_SELECT }>;

/** Per-page lookups the view needs: value counts and pending purges. */
interface PageFacts {
  valueCounts: ReadonlyMap<string, number>;
  pendingPurges: ReadonlySet<string>;
}

export function documentNotFound(): NotFoundException {
  return new NotFoundException('Health document not found');
}

export function staleDocument(currentVersion: number): HttpException {
  return new HttpException(
    {
      message: 'The document changed since you loaded it. Reload and try again.',
      details: { reason: HEALTH_DOCUMENT_REASONS.STALE, currentVersion },
    },
    HttpStatus.PRECONDITION_FAILED,
  );
}

/**
 * The version an `If-Match` header names: an integer, bare (`4`) or as the
 * ETag the API returns (`"4"`, `W/"4"`). Required: missing or unparseable is
 * a 400 with `details.reason: IF_MATCH_REQUIRED`.
 */
export function requireDocumentVersion(header: string | undefined): number {
  const value = header?.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1').trim();
  if (value && /^\d{1,9}$/.test(value)) {
    const version = Number(value);
    if (version >= 1) return version;
  }
  throw new BadRequestException({
    message: 'Send If-Match with the document version you loaded (version).',
    details: { reason: HEALTH_DOCUMENT_REASONS.IF_MATCH_REQUIRED },
  });
}

/** The ETag of a document at `version`. */
export function documentEtag(version: number): string {
  return `"${version}"`;
}

function hasFile(row: Pick<DocumentRow, 'storageObjectId' | 'fileDeletedAt'>): boolean {
  return row.storageObjectId !== null && row.fileDeletedAt === null;
}

function retentionOfRow(value: string): FileRetention {
  return (FILE_RETENTIONS as readonly string[]).includes(value) ? (value as FileRetention) : 'keep';
}

export function toHealthDocumentView(row: DocumentRow, facts: PageFacts): HealthDocumentView {
  return {
    id: row.id,
    kind: row.kind,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes.toString(),
    documentDate: row.documentDate ? row.documentDate.toISOString().slice(0, 10) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    retention: retentionOfRow(row.retention),
    valueCount: facts.valueCounts.get(row.id) ?? 0,
    fileAvailable: hasFile(row),
    fileDeletedAt: row.fileDeletedAt ? row.fileDeletedAt.toISOString() : null,
    fileDeletionPending: hasFile(row) && facts.pendingPurges.has(row.id),
    intakeId: row.intakeId,
    version: row.version,
  };
}

@Injectable()
export class HealthDocumentsService {
  private readonly logger = new Logger(HealthDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Optional() private readonly metrics: EvoPathMetricsService = fallbackEvoPathMetrics(),
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async list(userId: string, query: ListHealthDocumentsQuery): Promise<HealthDocumentPage> {
    const where: Prisma.HealthDocumentWhereInput = { userId, ...(query.kind ? { kind: query.kind } : {}) };
    const orderBy: Prisma.HealthDocumentOrderByWithRelationInput[] =
      query.sort === 'documentDate'
        ? [{ documentDate: { sort: query.order, nulls: 'last' } }, { createdAt: query.order }, { id: query.order }]
        : [{ createdAt: query.order }, { id: query.order }];

    const [rows, total] = await Promise.all([
      this.prisma.healthDocument.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: DOCUMENT_SELECT,
      }),
      this.prisma.healthDocument.count({ where }),
    ]);

    const facts = await this.factsOf(userId, rows.map((row) => row.id));

    return {
      items: rows.map((row) => toHealthDocumentView(row, facts)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async get(userId: string, id: string): Promise<HealthDocumentView> {
    const row = await this.findOwned(userId, id);
    return toHealthDocumentView(row, await this.factsOf(userId, [row.id]));
  }

  /**
   * A signed URL for the file, valid {@link HEALTH_DOCUMENT_DOWNLOAD_TTL_SECONDS}
   * seconds, with a safe `Content-Disposition`. 409 when the file is gone,
   * being purged, or not uploaded completely.
   */
  async downloadLink(userId: string, id: string, requested: DownloadDisposition): Promise<HealthDocumentDownload> {
    const row = await this.findOwned(userId, id);
    trace.getActiveSpan()?.setAttribute('health.document.id', row.id);

    if (!hasFile(row)) {
      throw new ConflictException({
        message: 'This file was deleted. The document is kept as a record only.',
        details: { reason: HEALTH_DOCUMENT_REASONS.FILE_DELETED },
      });
    }

    const facts = await this.factsOf(userId, [row.id]);
    if (facts.pendingPurges.has(row.id)) {
      throw new ConflictException({
        message: 'This file is being deleted.',
        details: { reason: HEALTH_DOCUMENT_REASONS.FILE_DELETION_PENDING },
      });
    }

    const object = await this.prisma.storageObject.findFirst({
      where: { id: row.storageObjectId!, uploadedById: userId },
      select: { storageKey: true, status: true },
    });
    if (!object || object.status !== 'ready') {
      throw new ConflictException({
        message: 'This file is not available for download.',
        details: { reason: HEALTH_DOCUMENT_REASONS.FILE_NOT_READY },
      });
    }

    const disposition = effectiveDisposition(requested, row.mimeType);
    const fileName = downloadNameOf(row.originalName);
    const expiresIn = HEALTH_DOCUMENT_DOWNLOAD_TTL_SECONDS;
    const url = await this.storage.getSignedDownloadUrl(object.storageKey, {
      expiresIn,
      responseContentDisposition: contentDispositionOf(disposition, fileName),
    });

    this.metrics.healthDocumentDownload(disposition);
    this.logger.log(`Issued a ${disposition} download link for health document ${row.id} (${expiresIn}s)`);

    return {
      url,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      disposition,
      fileName,
      mimeType: row.mimeType,
    };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** Rename and/or set the document date, conditional on `expectedVersion`. */
  async update(
    userId: string,
    id: string,
    expectedVersion: number,
    changes: UpdateHealthDocument,
  ): Promise<HealthDocumentView> {
    const data: Prisma.HealthDocumentUpdateManyMutationInput = { version: { increment: 1 } };
    if (changes.originalName !== undefined) data.originalName = changes.originalName;
    if (changes.documentDate !== undefined) {
      data.documentDate = changes.documentDate === null ? null : new Date(`${changes.documentDate}T00:00:00.000Z`);
    }

    const { count } = await this.prisma.healthDocument.updateMany({
      where: { id, userId, version: expectedVersion },
      data,
    });

    if (count === 0) {
      const current = await this.findOwned(userId, id);
      throw staleDocument(current.version);
    }

    return this.get(userId, id);
  }

  /**
   * Delete the document's file (queue its purge) or, when the file is already
   * gone, the document itself; with `deleteValues`, soft-delete its active
   * measurements in the same transaction. Audited, counted.
   */
  async remove(
    userId: string,
    id: string,
    expectedVersion: number,
    options: { deleteValues: boolean },
  ): Promise<HealthDocumentDeleteResult> {
    const span = trace.getActiveSpan();
    span?.setAttribute('health.document.id', id);

    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.healthDocument.findFirst({
        where: { id, userId },
        select: { id: true, version: true, storageObjectId: true, fileDeletedAt: true },
      });
      if (!row) throw documentNotFound();
      if (row.version !== expectedVersion) throw staleDocument(row.version);

      let valuesDeleted = 0;
      if (options.deleteValues) {
        const deleted = await tx.measurement.updateMany({
          where: { userId, ...ACTIVE, sourceRef: { path: ['healthDocumentId'], equals: id } },
          data: { deletedAt: new Date() },
        });
        valuesDeleted = deleted.count;
      }

      const scope: HealthDocumentDeleteResult['scope'] = hasFile(row) ? 'file' : 'record';
      let jobId: string | null = null;

      if (scope === 'record') {
        const { count } = await tx.healthDocument.deleteMany({ where: { id, userId, version: expectedVersion } });
        if (count === 0) throw staleDocument(row.version + 1);
      } else {
        const { count } = await tx.healthDocument.updateMany({
          where: { id, userId, version: expectedVersion },
          data: { version: { increment: 1 } },
        });
        if (count === 0) throw staleDocument(row.version + 1);

        const reason: HealthDocumentPurgeReason = 'user_delete';
        const job = await this.jobs.enqueueWithin(tx, {
          type: HEALTH_DOCUMENT_PURGE_JOB_TYPE,
          reason: 'upload',
          subjectType: HEALTH_DOCUMENT_SUBJECT_TYPE,
          subjectId: id,
          payload: { healthDocumentId: id, reason },
          // A unique violation would abort this transaction; the purge is idempotent.
          skipDedup: true,
        });
        jobId = job.id;
      }

      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          action: HEALTH_DOCUMENT_DELETE_AUDIT_ACTION,
          targetType: HEALTH_DOCUMENT_SUBJECT_TYPE,
          targetId: id,
          meta: { documentId: id, valuesDeleted, scope, reason: 'user_delete' },
        },
      });

      return { id, scope, jobId, valuesDeleted };
    });

    span?.setAttribute('health.document.delete_scope', result.scope);
    span?.setAttribute('health.document.values_deleted', result.valuesDeleted);
    this.metrics.healthDocumentDelete(result.scope, options.deleteValues);
    this.logger.log(
      `Health document ${id} deleted by its owner: scope ${result.scope}, ${result.valuesDeleted} value(s) deleted`,
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async findOwned(userId: string, id: string): Promise<DocumentRow> {
    const row = await this.prisma.healthDocument.findFirst({ where: { id, userId }, select: DOCUMENT_SELECT });
    if (!row) throw documentNotFound();
    return row;
  }

  /**
   * Value counts and pending purges for a page of documents: ONE grouped
   * query on `measurements` (owner and active rows only, matched on
   * `source_ref->>'healthDocumentId'`) and ONE on `jobs`. None for an empty page.
   */
  private async factsOf(userId: string, ids: readonly string[]): Promise<PageFacts> {
    if (ids.length === 0) return { valueCounts: new Map(), pendingPurges: new Set() };

    const [counts, jobs] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; n: number }>>`
        SELECT source_ref->>'healthDocumentId' AS id, COUNT(*)::int AS n
          FROM measurements
         WHERE user_id = ${userId}::uuid
           AND deleted_at IS NULL
           AND superseded_at IS NULL
           AND source_ref->>'healthDocumentId' IN (${Prisma.join([...ids])})
         GROUP BY 1`,
      this.prisma.job.findMany({
        where: {
          type: HEALTH_DOCUMENT_PURGE_JOB_TYPE,
          subjectType: HEALTH_DOCUMENT_SUBJECT_TYPE,
          subjectId: { in: [...ids] },
          status: { in: ['pending', 'running'] },
        },
        select: { subjectId: true },
      }),
    ]);

    return {
      valueCounts: new Map(counts.map((row) => [row.id, Number(row.n)])),
      pendingPurges: new Set(jobs.map((job) => job.subjectId).filter((subjectId): subjectId is string => !!subjectId)),
    };
  }
}
