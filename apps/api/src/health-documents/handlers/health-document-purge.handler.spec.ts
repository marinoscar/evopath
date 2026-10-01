import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JOB_TYPE_LABELS } from '../../jobs/job-type-labels';
import { HEALTH_DOCUMENT_PURGE_JOB_TYPE } from '../health-document.constants';
import { HealthDocumentPurgeHandler } from './health-document-purge.handler';

// =============================================================================
// `health.document.purge` over mocks (H1, #185)
// =============================================================================
//
// The contract: delete the object through `ObjectsService`, stamp
// `fileDeletedAt` and null `storageObjectId`, audit ids only, count the
// outcome; idempotent; a failure is counted and rethrown so the queue retries.
// Real rows and a real provider: `test/health-data/health-documents.db.spec.ts`.
// =============================================================================

const DOC = '77777777-7777-4777-8777-777777777777';
const USER = '11111111-1111-4111-8111-111111111111';
const OBJECT = '55555555-5555-4555-8555-555555555555';
const INTAKE = '33333333-3333-4333-8333-333333333333';

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC,
    userId: USER,
    retention: 'delete_after_processing',
    storageObjectId: OBJECT,
    intakeId: INTAKE,
    fileDeletedAt: null,
    ...overrides,
  };
}

function job(payload: unknown = { healthDocumentId: DOC }): Job {
  return { id: 'job-1', type: HEALTH_DOCUMENT_PURGE_JOB_TYPE, payload } as unknown as Job;
}

describe('HealthDocumentPurgeHandler', () => {
  let prisma: {
    healthDocument: { findUnique: jest.Mock; updateMany: jest.Mock };
    auditEvent: { create: jest.Mock };
  };
  let objects: { delete: jest.Mock };
  let metrics: { healthDocumentPurge: jest.Mock };
  let registry: { register: jest.Mock };
  let handler: HealthDocumentPurgeHandler;

  beforeEach(() => {
    prisma = {
      healthDocument: {
        findUnique: jest.fn(async () => documentRow()),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      auditEvent: { create: jest.fn(async () => ({})) },
    };
    objects = { delete: jest.fn(async () => undefined) };
    metrics = { healthDocumentPurge: jest.fn() };
    registry = { register: jest.fn() };
    handler = new HealthDocumentPurgeHandler(registry as never, prisma as never, objects as never, metrics as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('registers its permanent type, is server-only and declares a profile', () => {
    handler.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('health.document.purge');
    expect(JOB_TYPE_LABELS['health.document.purge']).toBeDefined();
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
    expect(Object.keys(handler.profile).sort()).toEqual(['maxAttempts', 'maxRuntimeMs']);
    expect(handler.profile.maxAttempts).toBeGreaterThan(1);
  });

  it('deletes the object as its owner, stamps fileDeletedAt, nulls storageObjectId, audits ids and counts', async () => {
    await handler.process(job());

    expect(objects.delete).toHaveBeenCalledWith(OBJECT, USER);
    expect(prisma.healthDocument.updateMany).toHaveBeenCalledWith({
      where: { id: DOC, fileDeletedAt: null },
      data: { fileDeletedAt: expect.any(Date), storageObjectId: null, version: { increment: 1 } },
    });
    expect(objects.delete.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.healthDocument.updateMany.mock.invocationCallOrder[0],
    );
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: USER,
        action: 'health:document:delete',
        targetType: 'health_document',
        targetId: DOC,
        meta: { storageObjectId: OBJECT, intakeId: INTAKE, files: 1, reason: 'delete_after_processing' },
      },
    });
    expect(metrics.healthDocumentPurge).toHaveBeenCalledWith('purged');
  });

  it('never puts a file name in the audit row or the log', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');

    await handler.process(job());

    const meta = prisma.auditEvent.create.mock.calls[0][0].data.meta;
    expect(Object.keys(meta).sort()).toEqual(['files', 'intakeId', 'reason', 'storageObjectId']);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/\.jpg|originalName/);
  });

  it.each([
    ['the document is gone', null, 'missing'],
    ['the file was already purged', documentRow({ fileDeletedAt: new Date(), storageObjectId: null }), 'already_purged'],
    ['the document is kept', documentRow({ retention: 'keep' }), 'kept'],
  ])('does nothing when %s', async (_name, row, result) => {
    prisma.healthDocument.findUnique.mockResolvedValue(row);

    await expect(handler.purge(DOC)).resolves.toBe(result);

    expect(objects.delete).not.toHaveBeenCalled();
    expect(prisma.healthDocument.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    expect(metrics.healthDocumentPurge).not.toHaveBeenCalled();
  });

  it('a user_delete purge erases a kept file too, and audits that reason (H6, #190)', async () => {
    prisma.healthDocument.findUnique.mockResolvedValue(documentRow({ retention: 'keep' }));

    await handler.process(job({ healthDocumentId: DOC, reason: 'user_delete' }));

    expect(objects.delete).toHaveBeenCalledWith(OBJECT, USER);
    expect(prisma.healthDocument.updateMany).toHaveBeenCalled();
    expect(prisma.auditEvent.create.mock.calls[0][0].data.meta).toEqual({
      storageObjectId: OBJECT,
      intakeId: INTAKE,
      files: 1,
      reason: 'user_delete',
    });
    expect(metrics.healthDocumentPurge).toHaveBeenCalledWith('purged');
  });

  it('a user_delete purge of an already purged file is a no-op', async () => {
    prisma.healthDocument.findUnique.mockResolvedValue(documentRow({ fileDeletedAt: new Date(), storageObjectId: null }));

    await expect(handler.purge(DOC, 'user_delete')).resolves.toBe('already_purged');
    expect(objects.delete).not.toHaveBeenCalled();
  });

  it('refuses an unknown reason', async () => {
    await expect(handler.process(job({ healthDocumentId: DOC, reason: 'because' }))).rejects.toThrow();
    expect(prisma.healthDocument.findUnique).not.toHaveBeenCalled();
  });

  it('an object that is already gone (row cascaded away, or 404) still stamps the document', async () => {
    objects.delete.mockRejectedValue(new NotFoundException('Object not found'));

    await expect(handler.purge(DOC)).resolves.toBe('purged');
    expect(prisma.healthDocument.updateMany).toHaveBeenCalled();

    prisma.healthDocument.findUnique.mockResolvedValue(documentRow({ storageObjectId: null }));
    objects.delete.mockClear();

    await expect(handler.purge(DOC)).resolves.toBe('purged');
    expect(objects.delete).not.toHaveBeenCalled();
  });

  it('a storage failure is counted and rethrown so the queue retries; the document is not stamped', async () => {
    objects.delete.mockRejectedValue(new Error('storage unavailable'));

    await expect(handler.process(job())).rejects.toThrow('storage unavailable');

    expect(prisma.healthDocument.updateMany).not.toHaveBeenCalled();
    expect(metrics.healthDocumentPurge).toHaveBeenCalledWith('failed');
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('an ownership refusal from ObjectsService is a failure, not a success', async () => {
    objects.delete.mockRejectedValue(new ForbiddenException());

    await expect(handler.purge(DOC)).rejects.toBeInstanceOf(ForbiddenException);
    expect(metrics.healthDocumentPurge).toHaveBeenCalledWith('failed');
  });

  it('a concurrent run that stamped first makes this one a no-op success', async () => {
    prisma.healthDocument.updateMany.mockResolvedValue({ count: 0 });

    await expect(handler.purge(DOC)).resolves.toBe('already_purged');
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('an audit failure does not fail the purge (the file is gone)', async () => {
    prisma.auditEvent.create.mockRejectedValue(new Error('audit down'));

    await expect(handler.purge(DOC)).resolves.toBe('purged');
  });

  it('refuses a payload without a document id', async () => {
    await expect(handler.process(job({}))).rejects.toThrow();
    expect(prisma.healthDocument.findUnique).not.toHaveBeenCalled();
  });
});
