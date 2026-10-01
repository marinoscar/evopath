import { BadRequestException, ConflictException, HttpException, Logger, NotFoundException } from '@nestjs/common';

import { listHealthDocumentsQuerySchema } from './dto/health-document.dto';
import { documentEtag, HealthDocumentsService, requireDocumentVersion } from './health-documents.service';

// =============================================================================
// HealthDocumentsService over mocks (H6, #190)
// =============================================================================
//
// Owner scoping on every read and write, the per-page facts (one grouped
// count, one job lookup), the download link (TTL, disposition, refusals), the
// If-Match contract and both delete paths. Real rows, a real provider and the
// purge job: `test/health-data/health-documents-api.db.spec.ts`.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const DOC = '77777777-7777-4777-8777-777777777777';
const OTHER_DOC = '88888888-8888-4888-8888-888888888888';
const OBJECT = '55555555-5555-4555-8555-555555555555';
const INTAKE = '33333333-3333-4333-8333-333333333333';
const SIGNED_URL = 'https://storage.example.test/bucket/key?X-Amz-Signature=secret';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC,
    userId: USER,
    kind: 'lab_report',
    storageObjectId: OBJECT,
    originalName: 'Lab report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 9_007_199_254_740_993n,
    retention: 'keep',
    intakeId: INTAKE,
    documentDate: new Date('2026-09-15T00:00:00.000Z'),
    fileDeletedAt: null,
    version: 3,
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    updatedAt: new Date('2026-09-21T10:00:00.000Z'),
    ...overrides,
  };
}

describe('HealthDocumentsService', () => {
  let prisma: any;
  let jobs: { enqueueWithin: jest.Mock };
  let storage: { getSignedDownloadUrl: jest.Mock };
  let metrics: { healthDocumentDownload: jest.Mock; healthDocumentDelete: jest.Mock };
  let service: HealthDocumentsService;

  beforeEach(() => {
    prisma = {
      healthDocument: {
        findMany: jest.fn(async () => [row()]),
        findFirst: jest.fn(async ({ where }: any) => (where.id === DOC && where.userId === USER ? row() : null)),
        count: jest.fn(async () => 1),
        updateMany: jest.fn(async () => ({ count: 1 })),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
      measurement: { updateMany: jest.fn(async () => ({ count: 2 })) },
      job: { findMany: jest.fn(async () => []) },
      storageObject: { findFirst: jest.fn(async () => ({ storageKey: 'users/u/doc.pdf', status: 'ready' })) },
      auditEvent: { create: jest.fn(async () => ({})) },
      $queryRaw: jest.fn(async () => [{ id: DOC, n: 4 }]),
    };
    prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    jobs = { enqueueWithin: jest.fn(async () => ({ id: '99999999-9999-4999-8999-999999999999' })) };
    storage = { getSignedDownloadUrl: jest.fn(async () => SIGNED_URL) };
    metrics = { healthDocumentDownload: jest.fn(), healthDocumentDelete: jest.fn() };
    service = new HealthDocumentsService(prisma, jobs as never, storage as never, metrics as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  describe('list', () => {
    it('scopes to the owner, pages, and maps one item with its value count', async () => {
      const page = await service.list(USER, listHealthDocumentsQuerySchema.parse({ kind: 'lab_report', pageSize: '10', page: '2' }));

      expect(prisma.healthDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER, kind: 'lab_report' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: 10,
          take: 10,
        }),
      );
      expect(prisma.healthDocument.count).toHaveBeenCalledWith({ where: { userId: USER, kind: 'lab_report' } });
      expect(page).toEqual({
        items: [
          {
            id: DOC,
            kind: 'lab_report',
            originalName: 'Lab report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: '9007199254740993',
            documentDate: '2026-09-15',
            createdAt: '2026-09-20T10:00:00.000Z',
            updatedAt: '2026-09-21T10:00:00.000Z',
            retention: 'keep',
            valueCount: 4,
            fileAvailable: true,
            fileDeletedAt: null,
            fileDeletionPending: false,
            intakeId: INTAKE,
            version: 3,
          },
        ],
        total: 1,
        page: 2,
        pageSize: 10,
        totalPages: 1,
      });
      expect(() => JSON.stringify(page)).not.toThrow();
    });

    it('sorts by document date with undated documents last', async () => {
      await service.list(USER, listHealthDocumentsQuerySchema.parse({ sort: 'documentDate', order: 'asc' }));

      expect(prisma.healthDocument.findMany.mock.calls[0][0].orderBy).toEqual([
        { documentDate: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
    });

    it('looks the facts up once per page: one grouped count, one job query', async () => {
      prisma.healthDocument.findMany.mockResolvedValue([row(), row({ id: OTHER_DOC })]);
      prisma.$queryRaw.mockResolvedValue([{ id: OTHER_DOC, n: 1 }]);
      prisma.job.findMany.mockResolvedValue([{ subjectId: DOC }]);

      const page = await service.list(USER, listHealthDocumentsQuerySchema.parse({}));

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.job.findMany).toHaveBeenCalledTimes(1);
      const sql = prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray;
      expect(sql.join('?')).toMatch(/source_ref->>'healthDocumentId'/);
      expect(sql.join('?')).toMatch(/deleted_at IS NULL[\s\S]*superseded_at IS NULL/);
      expect(sql.join('?')).toMatch(/GROUP BY 1/);
      expect(prisma.job.findMany.mock.calls[0][0].where).toEqual({
        type: 'health.document.purge',
        subjectType: 'health_document',
        subjectId: { in: [DOC, OTHER_DOC] },
        status: { in: ['pending', 'running'] },
      });
      expect(page.items.map((item) => [item.valueCount, item.fileDeletionPending])).toEqual([
        [0, true],
        [1, false],
      ]);
    });

    it('an empty page makes no fact query', async () => {
      prisma.healthDocument.findMany.mockResolvedValue([]);
      prisma.healthDocument.count.mockResolvedValue(0);

      await expect(service.list(USER, listHealthDocumentsQuerySchema.parse({}))).resolves.toMatchObject({
        items: [],
        total: 0,
        totalPages: 0,
      });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });

    it('an erased file reads as metadata only, never pending', async () => {
      prisma.healthDocument.findMany.mockResolvedValue([
        row({ storageObjectId: null, fileDeletedAt: new Date('2026-09-22T00:00:00.000Z') }),
      ]);
      prisma.job.findMany.mockResolvedValue([{ subjectId: DOC }]);

      const { items } = await service.list(USER, listHealthDocumentsQuerySchema.parse({}));

      expect(items[0]).toMatchObject({
        fileAvailable: false,
        fileDeletedAt: '2026-09-22T00:00:00.000Z',
        fileDeletionPending: false,
      });
    });
  });

  it("get is owner-scoped: another user's document is a 404", async () => {
    await expect(service.get(USER, DOC)).resolves.toMatchObject({ id: DOC, version: 3 });
    await expect(service.get('22222222-2222-4222-8222-222222222222', DOC)).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  describe('downloadLink', () => {
    it('signs the owner\'s object for at most 300 s with a safe disposition, counts it and never logs the URL', async () => {
      const log = jest.spyOn(Logger.prototype, 'log');

      const link = await service.downloadLink(USER, DOC, 'attachment');

      expect(prisma.storageObject.findFirst).toHaveBeenCalledWith({
        where: { id: OBJECT, uploadedById: USER },
        select: { storageKey: true, status: true },
      });
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith('users/u/doc.pdf', {
        expiresIn: 300,
        responseContentDisposition: `attachment; filename="Lab report.pdf"; filename*=UTF-8''Lab%20report.pdf`,
      });
      expect(link).toMatchObject({
        url: SIGNED_URL,
        expiresIn: 300,
        disposition: 'attachment',
        fileName: 'Lab report.pdf',
        mimeType: 'application/pdf',
      });
      expect(link.expiresIn).toBeLessThanOrEqual(300);
      expect(metrics.healthDocumentDownload).toHaveBeenCalledWith('attachment');
      expect(JSON.stringify(log.mock.calls)).not.toContain('X-Amz-Signature');
      expect(JSON.stringify(log.mock.calls)).not.toContain('Lab report');
    });

    it('forces attachment for a type a browser should not render inline', async () => {
      prisma.healthDocument.findFirst.mockResolvedValue(row({ mimeType: 'image/svg+xml' }));

      const link = await service.downloadLink(USER, DOC, 'inline');

      expect(link.disposition).toBe('attachment');
      expect(storage.getSignedDownloadUrl.mock.calls[0][1].responseContentDisposition).toMatch(/^attachment;/);
    });

    it.each([
      ['the file was erased', { storageObjectId: null, fileDeletedAt: new Date() }, null, 'HEALTH_DOCUMENT_FILE_DELETED'],
      ['the purge is queued', {}, [{ subjectId: DOC }], 'HEALTH_DOCUMENT_FILE_DELETION_PENDING'],
    ])('409 when %s, signing nothing', async (_name, overrides, pending, reason) => {
      prisma.healthDocument.findFirst.mockResolvedValue(row(overrides));
      if (pending) prisma.job.findMany.mockResolvedValue(pending);

      const error = await service.downloadLink(USER, DOC, 'inline').catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().details.reason).toBe(reason);
      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
      expect(metrics.healthDocumentDownload).not.toHaveBeenCalled();
    });

    it('409 when the storage object is not ready (or not the owner\'s)', async () => {
      prisma.storageObject.findFirst.mockResolvedValue(null);

      const error = await service.downloadLink(USER, DOC, 'inline').catch((e) => e);

      expect(error.getResponse().details.reason).toBe('HEALTH_DOCUMENT_FILE_NOT_READY');
      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it("404 for another user's document", async () => {
      await expect(service.downloadLink('22222222-2222-4222-8222-222222222222', DOC, 'inline')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  describe('update', () => {
    it('writes conditionally on the version and bumps it', async () => {
      await service.update(USER, DOC, 3, { originalName: 'Bloods.pdf', documentDate: '2026-09-14' });

      expect(prisma.healthDocument.updateMany).toHaveBeenCalledWith({
        where: { id: DOC, userId: USER, version: 3 },
        data: {
          version: { increment: 1 },
          originalName: 'Bloods.pdf',
          documentDate: new Date('2026-09-14T00:00:00.000Z'),
        },
      });
    });

    it('clears the date with null and leaves the name alone when absent', async () => {
      await service.update(USER, DOC, 3, { documentDate: null });

      expect(prisma.healthDocument.updateMany.mock.calls[0][0].data).toEqual({
        version: { increment: 1 },
        documentDate: null,
      });
    });

    it('412 with the current version when stale', async () => {
      prisma.healthDocument.updateMany.mockResolvedValue({ count: 0 });

      const error = await service.update(USER, DOC, 2, { originalName: 'x' }).catch((e) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(412);
      expect(error.getResponse().details).toEqual({ reason: 'HEALTH_DOCUMENT_STALE', currentVersion: 3 });
    });

    it("404 for another user's document", async () => {
      prisma.healthDocument.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.update('22222222-2222-4222-8222-222222222222', DOC, 3, { originalName: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  describe('remove', () => {
    it('with a file: bumps the version, enqueues a user_delete purge, audits ids and counts, in one transaction', async () => {
      const result = await service.remove(USER, DOC, 3, { deleteValues: false });

      expect(result).toEqual({ id: DOC, scope: 'file', jobId: '99999999-9999-4999-8999-999999999999', valuesDeleted: 0 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.healthDocument.updateMany).toHaveBeenCalledWith({
        where: { id: DOC, userId: USER, version: 3 },
        data: { version: { increment: 1 } },
      });
      expect(jobs.enqueueWithin).toHaveBeenCalledWith(prisma, {
        type: 'health.document.purge',
        reason: 'upload',
        subjectType: 'health_document',
        subjectId: DOC,
        payload: { healthDocumentId: DOC, reason: 'user_delete' },
        skipDedup: true,
      });
      expect(prisma.healthDocument.deleteMany).not.toHaveBeenCalled();
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: USER,
          action: 'health:document:delete',
          targetType: 'health_document',
          targetId: DOC,
          meta: { documentId: DOC, valuesDeleted: 0, scope: 'file', reason: 'user_delete' },
        },
      });
      expect(JSON.stringify(prisma.auditEvent.create.mock.calls)).not.toContain('Lab report');
      expect(metrics.healthDocumentDelete).toHaveBeenCalledWith('file', false);
    });

    it("deleteValues soft-deletes exactly the document's active measurements in the same transaction", async () => {
      const result = await service.remove(USER, DOC, 3, { deleteValues: true });

      expect(prisma.measurement.updateMany).toHaveBeenCalledWith({
        where: {
          userId: USER,
          supersededAt: null,
          deletedAt: null,
          sourceRef: { path: ['healthDocumentId'], equals: DOC },
        },
        data: { deletedAt: expect.any(Date) },
      });
      expect(result.valuesDeleted).toBe(2);
      expect(prisma.auditEvent.create.mock.calls[0][0].data.meta.valuesDeleted).toBe(2);
      expect(metrics.healthDocumentDelete).toHaveBeenCalledWith('file', true);
    });

    it('with the file already gone: removes the record, queues nothing', async () => {
      prisma.healthDocument.findFirst.mockResolvedValue(row({ storageObjectId: null, fileDeletedAt: new Date() }));

      const result = await service.remove(USER, DOC, 3, { deleteValues: false });

      expect(result).toEqual({ id: DOC, scope: 'record', jobId: null, valuesDeleted: 0 });
      expect(prisma.healthDocument.deleteMany).toHaveBeenCalledWith({ where: { id: DOC, userId: USER, version: 3 } });
      expect(jobs.enqueueWithin).not.toHaveBeenCalled();
      expect(metrics.healthDocumentDelete).toHaveBeenCalledWith('record', false);
    });

    it('412 when stale, changing nothing', async () => {
      const error = await service.remove(USER, DOC, 2, { deleteValues: true }).catch((e) => e);

      expect(error.getStatus()).toBe(412);
      expect(error.getResponse().details).toEqual({ reason: 'HEALTH_DOCUMENT_STALE', currentVersion: 3 });
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
      expect(jobs.enqueueWithin).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
      expect(metrics.healthDocumentDelete).not.toHaveBeenCalled();
    });

    it('412 when a concurrent write wins between the read and the conditional write', async () => {
      prisma.healthDocument.updateMany.mockResolvedValue({ count: 0 });

      const error = await service.remove(USER, DOC, 3, { deleteValues: false }).catch((e) => e);

      expect(error.getStatus()).toBe(412);
      expect(jobs.enqueueWithin).not.toHaveBeenCalled();
    });

    it("404 for another user's document", async () => {
      await expect(
        service.remove('22222222-2222-4222-8222-222222222222', DOC, 3, { deleteValues: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('If-Match', () => {
    it.each([
      ['3', 3],
      ['"3"', 3],
      ['W/"3"', 3],
      [' 12 ', 12],
    ])('reads %s as %d', (header, version) => {
      expect(requireDocumentVersion(header)).toBe(version);
    });

    it.each([undefined, '', '*', '"abc"', '0', '-1', '1.5'])('refuses %p with IF_MATCH_REQUIRED', (header) => {
      const error = (() => {
        try {
          return requireDocumentVersion(header);
        } catch (e) {
          return e;
        }
      })() as BadRequestException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error.getResponse() as { details: { reason: string } }).details.reason).toBe('IF_MATCH_REQUIRED');
    });

    it('the ETag is the quoted version', () => {
      expect(documentEtag(4)).toBe('"4"');
    });
  });
});
