// =============================================================================
// Real-Postgres test: the health documents API (H6, #190)
// =============================================================================
//
// What only real rows, the real JSON path query and a real provider can prove:
//   - the list holds only the caller's documents, with `valueCount` counted
//     from active measurements whose `source_ref->>'healthDocumentId'` names
//     each one, and sorts by document date with undated documents last;
//   - another user's id is a 404 on every route;
//   - DELETE of a kept document queues `health.document.purge` with reason
//     `user_delete`; running it erases the object (`exists()` false) and the
//     measurements stay, now `fileDeleted: true`; a second DELETE removes the
//     record and the measurements still report `fileDeleted: true`;
//   - `deleteValues=true` soft-deletes exactly that document's measurements;
//   - a stale If-Match is a 412 and changes nothing;
//   - the download link lives at most 300 s with a safe Content-Disposition.
//
// The storage provider is `TmpDirStorageProvider` (real files on disk) with a
// recording `getSignedDownloadUrl`, under the real `ObjectsService.delete`.
// Every user is created with run-unique values and removed in `afterAll`.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with
// `npm run test:db` against a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { HttpException, Logger, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { stubFeatureResolver } from '../../src/ai/testing/feature-resolver.stub';
import { listHealthDocumentsQuerySchema } from '../../src/health-documents/dto/health-document.dto';
import { HealthDocumentPurgeHandler } from '../../src/health-documents/handlers/health-document-purge.handler';
import { HealthDocumentObjectReferences } from '../../src/health-documents/health-document-object-references';
import { HealthDocumentsService } from '../../src/health-documents/health-documents.service';
import { IntakeInputInspector } from '../../src/intake/intake-input-inspector';
import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { IntakeService } from '../../src/intake/intake.service';
import { StorageObjectReferences } from '../../src/intake/storage-object-references';
import { JPEG_BYTES } from '../../src/intake/testing/pdf-bytes';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import { createMeasurementEntrySchema, updateMeasurementEntrySchema } from '../../src/measurements/dto/measurement.dto';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import { BodyMetricReadingIntakeKind } from '../../src/measurements/photo/body-metric-reading.kind';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { ObjectsService } from '../../src/storage/objects/objects.service';
import type { SignedUrlOptions } from '../../src/storage/providers/storage-provider.types';
import { cleanupTmpDir, TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('health-documents-api.db.spec');

const PERMS = ['intakes:read', 'intakes:write', 'health_data:read', 'health_data:write'];

/** The tmp-dir provider, plus a signed download URL that records how it was asked for. */
class SigningProvider extends TmpDirStorageProvider {
  readonly signed: Array<{ key: string; options?: SignedUrlOptions }> = [];

  override async getSignedDownloadUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    this.signed.push({ key, options });
    return `https://storage.test/${encodeURIComponent(key)}?expires=${options?.expiresIn}`;
  }
}

describeWithDb('health documents API (real Postgres)', () => {
  let client: PrismaClient;
  let baseDir: string;
  let provider: SigningProvider;
  let intakes: IntakeService;
  let measurements: MeasurementsService;
  let purge: HealthDocumentPurgeHandler;
  let documents: HealthDocumentsService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];
  const LIST = listHealthDocumentsQuerySchema.parse({});

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `health-docs-api-${label}-${run}@example.com` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function upload(userId: string, label: string): Promise<{ id: string; storageKey: string }> {
    const storageKey = `test/health-docs-api/${run}/${label}-${randomUUID()}.jpg`;
    const bytes = Buffer.concat([JPEG_BYTES, Buffer.from(label)]);
    await provider.upload(storageKey, Readable.from(bytes), { mimeType: 'image/jpeg' });
    return client.storageObject.create({
      data: {
        name: `${label}.jpg`,
        size: BigInt(bytes.length),
        mimeType: 'image/jpeg',
        storageKey,
        status: 'ready',
        uploadedById: userId,
      },
      select: { id: true, storageKey: true },
    });
  }

  /** A kept `body_metric_reading` document with `readings` weights applied from it. */
  async function appliedDocument(userId: string, label: string, readings = 1) {
    const intake = await intakes.create(userId, { kind: 'body_metric_reading' }, PERMS);
    const object = await upload(userId, label);
    const photo = await intakes.attachPhoto(userId, intake.id, object.id, PERMS);
    const metrics = ['weight', 'body_fat_pct', 'waist_circumference'].slice(0, readings);
    const values: Record<string, { value: number; unit: string; method: string }> = {
      weight: { value: 81.5, unit: 'kg', method: 'scale' },
      body_fat_pct: { value: 20, unit: '%', method: 'bia' },
      waist_circumference: { value: 85, unit: 'cm', method: 'tape' },
    };
    for (const metricKey of metrics) {
      await intakes.addItem(
        userId,
        intake.id,
        { kind: 'reading', value: { metricKey, ...values[metricKey] } },
        PERMS,
      );
    }
    const result = (await intakes.apply(userId, intake.id, PERMS)) as { entryId: string };
    return { intakeId: intake.id, object, healthDocumentId: photo.healthDocumentId!, entryId: result.entryId };
  }

  async function versionOf(id: string): Promise<number> {
    return (await client.healthDocument.findUniqueOrThrow({ where: { id } })).version;
  }

  async function runPurgeJobOf(healthDocumentId: string): Promise<void> {
    const jobs = await client.job.findMany({
      where: { type: 'health.document.purge', subjectId: healthDocumentId, status: 'pending' },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ healthDocumentId, reason: 'user_delete' });
    await purge.process(jobs[0]);
    await client.job.update({ where: { id: jobs[0].id }, data: { status: 'succeeded', finishedAt: new Date() } });
  }

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    baseDir = await mkdtemp(join(tmpdir(), 'health-docs-api-'));
    provider = new SigningProvider(baseDir);

    const objects = new ObjectsService(prisma, provider, {} as never, {} as never, {} as never, {} as never);
    const references = new StorageObjectReferences();
    new HealthDocumentObjectReferences(references, prisma).onModuleInit();

    const kinds = new IntakeKindRegistry();
    measurements = new MeasurementsService(prisma);
    new BodyMetricReadingIntakeKind(kinds, measurements).onModuleInit();
    const jobs = new JobsService(prisma);
    intakes = new IntakeService(
      prisma,
      kinds,
      jobs,
      { assertUsable: jest.fn(async () => ({})) } as never,
      objects,
      stubFeatureResolver({ provider: 'openai', modelId: 'vision-model' }) as never,
      new IntakeInputInspector(provider),
      references,
    );
    purge = new HealthDocumentPurgeHandler(new JobHandlerRegistry(), prisma, objects, {
      healthDocumentPurge: jest.fn(),
    } as never);
    documents = new HealthDocumentsService(prisma, jobs, provider, {
      healthDocumentDownload: jest.fn(),
      healthDocumentDelete: jest.fn(),
    } as never);

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    const jobs = await client.job.findMany({
      where: { subjectType: 'health_document', type: 'health.document.purge' },
      select: { id: true, subjectId: true },
    });
    const docs = await client.healthDocument.findMany({
      where: { userId: { in: createdUserIds } },
      select: { id: true },
    });
    const audited = await client.auditEvent.findMany({
      where: { actorUserId: { in: createdUserIds }, targetType: 'health_document' },
      select: { targetId: true },
    });
    const subjectIds = new Set([...docs.map((d) => d.id), ...audited.map((a) => a.targetId)]);
    await client.job.deleteMany({ where: { id: { in: jobs.filter((j) => subjectIds.has(j.subjectId!)).map((j) => j.id) } } });
    await client.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await client.storageObject.deleteMany({ where: { uploadedById: { in: createdUserIds } } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
    await cleanupTmpDir(baseDir);
    jest.restoreAllMocks();
  });

  it("lists only the caller's documents, with value counts, sortable by document date", async () => {
    const userId = await makeUser('list');
    const otherId = await makeUser('list-other');
    const first = await appliedDocument(userId, 'first', 2);
    const second = await appliedDocument(userId, 'second', 1);
    await appliedDocument(otherId, 'foreign', 1);
    await client.healthDocument.update({
      where: { id: second.healthDocumentId },
      data: { documentDate: new Date('2026-01-10T00:00:00.000Z') },
    });

    const page = await documents.list(userId, LIST);

    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual([second.healthDocumentId, first.healthDocumentId]);
    expect(page.items.find((item) => item.id === first.healthDocumentId)).toMatchObject({
      kind: 'body_metric',
      mimeType: 'image/jpeg',
      retention: 'keep',
      valueCount: 2,
      fileAvailable: true,
      fileDeletionPending: false,
      fileDeletedAt: null,
      intakeId: first.intakeId,
      documentDate: null,
    });
    expect(page.items.find((item) => item.id === second.healthDocumentId)).toMatchObject({
      valueCount: 1,
      documentDate: '2026-01-10',
    });
    expect(typeof page.items[0].sizeBytes).toBe('string');

    // Undated documents sort last in both directions.
    const byDate = await documents.list(userId, listHealthDocumentsQuerySchema.parse({ sort: 'documentDate', order: 'desc' }));
    expect(byDate.items.map((item) => item.id)).toEqual([second.healthDocumentId, first.healthDocumentId]);
    const byDateAsc = await documents.list(userId, listHealthDocumentsQuerySchema.parse({ sort: 'documentDate', order: 'asc' }));
    expect(byDateAsc.items.map((item) => item.id)).toEqual([second.healthDocumentId, first.healthDocumentId]);

    // A superseded revision is not counted twice; an edit keeps the provenance.
    const [row] = await client.measurement.findMany({ where: { userId, entryId: second.entryId } });
    await measurements.updateEntry(
      userId,
      second.entryId,
      updateMeasurementEntrySchema.parse({ readings: [{ metricKey: row.metricKey, value: 80, unit: 'kg' }] }),
    );
    expect((await documents.get(userId, second.healthDocumentId)).valueCount).toBe(1);

    expect((await documents.list(userId, listHealthDocumentsQuerySchema.parse({ kind: 'lab_report' }))).total).toBe(0);
  });

  it("another user's id is a 404 on every route", async () => {
    const ownerId = await makeUser('owner');
    const strangerId = await makeUser('stranger');
    const { healthDocumentId } = await appliedDocument(ownerId, 'private');
    const version = await versionOf(healthDocumentId);

    await expect(documents.get(strangerId, healthDocumentId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(documents.downloadLink(strangerId, healthDocumentId, 'inline')).rejects.toBeInstanceOf(NotFoundException);
    await expect(documents.update(strangerId, healthDocumentId, version, { originalName: 'mine.jpg' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(documents.remove(strangerId, healthDocumentId, version, { deleteValues: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((await documents.list(strangerId, LIST)).total).toBe(0);

    // Nothing changed.
    const document = await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } });
    expect(document).toMatchObject({ originalName: 'private.jpg', version, fileDeletedAt: null });
    expect(await client.measurement.count({ where: { userId: ownerId, deletedAt: null } })).toBe(1);
  });

  it('DELETE erases a kept file through the purge job and keeps its values, which report fileDeleted; a second DELETE removes the record', async () => {
    const userId = await makeUser('delete');
    const { healthDocumentId, object, entryId } = await appliedDocument(userId, 'delete', 2);

    const result = await documents.remove(userId, healthDocumentId, await versionOf(healthDocumentId), {
      deleteValues: false,
    });

    expect(result).toMatchObject({ id: healthDocumentId, scope: 'file', valuesDeleted: 0 });
    expect(result.jobId).toEqual(expect.any(String));
    // Queued, not yet run: the file is still there and the list says it is being deleted.
    expect(await provider.exists(object.storageKey)).toBe(true);
    expect(await documents.get(userId, healthDocumentId)).toMatchObject({ fileAvailable: true, fileDeletionPending: true });
    await expect(documents.downloadLink(userId, healthDocumentId, 'inline')).rejects.toMatchObject({
      response: { details: { reason: 'HEALTH_DOCUMENT_FILE_DELETION_PENDING' } },
    });

    await runPurgeJobOf(healthDocumentId);

    expect(await provider.exists(object.storageKey)).toBe(false);
    expect(await client.storageObject.findUnique({ where: { id: object.id } })).toBeNull();
    const view = await documents.get(userId, healthDocumentId);
    expect(view).toMatchObject({ fileAvailable: false, fileDeletionPending: false, valueCount: 2, retention: 'keep' });
    expect(view.fileDeletedAt).toEqual(expect.any(String));

    const history = await measurements.list(userId, { page: 1, pageSize: 20 } as never);
    expect(history.items).toHaveLength(2);
    expect(history.items.every((item) => item.entryId === entryId && item.fileDeleted === true)).toBe(true);

    const audits = await client.auditEvent.findMany({
      where: { action: 'health:document:delete', targetId: healthDocumentId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((audit) => audit.meta)).toEqual([
      { documentId: healthDocumentId, valuesDeleted: 0, scope: 'file', reason: 'user_delete' },
      { storageObjectId: object.id, intakeId: expect.any(String), files: 1, reason: 'user_delete' },
    ]);
    expect(JSON.stringify(audits)).not.toContain('delete.jpg');

    // The record of an erased file can go too; the values keep their link and still say fileDeleted.
    await expect(documents.downloadLink(userId, healthDocumentId, 'inline')).rejects.toMatchObject({
      response: { details: { reason: 'HEALTH_DOCUMENT_FILE_DELETED' } },
    });
    const removed = await documents.remove(userId, healthDocumentId, await versionOf(healthDocumentId), {
      deleteValues: false,
    });
    expect(removed).toEqual({ id: healthDocumentId, scope: 'record', jobId: null, valuesDeleted: 0 });
    expect(await client.healthDocument.findUnique({ where: { id: healthDocumentId } })).toBeNull();
    const after = await measurements.list(userId, { page: 1, pageSize: 20 } as never);
    expect(after.items).toHaveLength(2);
    expect(after.items.every((item) => item.fileDeleted === true && item.sourceRef?.healthDocumentId === healthDocumentId)).toBe(
      true,
    );
  });

  it("deleteValues=true soft-deletes exactly that document's measurements", async () => {
    const userId = await makeUser('values');
    const target = await appliedDocument(userId, 'target', 2);
    const keep = await appliedDocument(userId, 'keep', 1);
    const manual = await measurements.createEntry(
      userId,
      createMeasurementEntrySchema.parse({ readings: [{ metricKey: 'weight', value: 79, unit: 'kg' }] }),
    );

    const result = await documents.remove(userId, target.healthDocumentId, await versionOf(target.healthDocumentId), {
      deleteValues: true,
    });

    expect(result.valuesDeleted).toBe(2);
    const rows = await client.measurement.findMany({ where: { userId } });
    const deleted = rows.filter((row) => row.deletedAt !== null);
    expect(deleted.map((row) => row.entryId).sort()).toEqual([target.entryId, target.entryId]);
    expect(rows.filter((row) => row.entryId === keep.entryId && row.deletedAt === null)).toHaveLength(1);
    expect(rows.filter((row) => row.entryId === manual.entryId && row.deletedAt === null)).toHaveLength(1);
    expect((await documents.get(userId, target.healthDocumentId)).valueCount).toBe(0);
    expect((await documents.get(userId, keep.healthDocumentId)).valueCount).toBe(1);

    const audit = await client.auditEvent.findFirstOrThrow({
      where: { action: 'health:document:delete', targetId: target.healthDocumentId },
    });
    expect(audit.meta).toMatchObject({ documentId: target.healthDocumentId, valuesDeleted: 2 });

    await runPurgeJobOf(target.healthDocumentId);
    expect(await provider.exists(target.object.storageKey)).toBe(false);
    expect(await provider.exists(keep.object.storageKey)).toBe(true);
  });

  it('a stale If-Match is a 412 and changes nothing', async () => {
    const userId = await makeUser('stale');
    const { healthDocumentId, object } = await appliedDocument(userId, 'stale');
    const loaded = await versionOf(healthDocumentId);

    const renamed = await documents.update(userId, healthDocumentId, loaded, { originalName: 'Renamed.jpg' });
    expect(renamed.version).toBe(loaded + 1);

    for (const attempt of [
      () => documents.update(userId, healthDocumentId, loaded, { documentDate: '2026-09-01' }),
      () => documents.remove(userId, healthDocumentId, loaded, { deleteValues: true }),
    ]) {
      const error = await attempt().catch((e) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(412);
      expect(error.getResponse().details).toEqual({ reason: 'HEALTH_DOCUMENT_STALE', currentVersion: loaded + 1 });
    }

    const document = await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } });
    expect(document).toMatchObject({ originalName: 'Renamed.jpg', documentDate: null, version: loaded + 1, fileDeletedAt: null });
    expect(await client.job.count({ where: { type: 'health.document.purge', subjectId: healthDocumentId } })).toBe(0);
    expect(await client.measurement.count({ where: { userId, deletedAt: null } })).toBe(1);
    expect(await provider.exists(object.storageKey)).toBe(true);
  });

  it('PATCH sets and clears the document date', async () => {
    const userId = await makeUser('date');
    const { healthDocumentId } = await appliedDocument(userId, 'date');

    const dated = await documents.update(userId, healthDocumentId, await versionOf(healthDocumentId), {
      documentDate: '2026-09-15',
    });
    expect(dated.documentDate).toBe('2026-09-15');

    const cleared = await documents.update(userId, healthDocumentId, dated.version, { documentDate: null });
    expect(cleared).toMatchObject({ documentDate: null, version: dated.version + 1, originalName: 'date.jpg' });
  });

  it('the download link lives at most 300 s and carries a safe Content-Disposition', async () => {
    const userId = await makeUser('download');
    const { healthDocumentId, object } = await appliedDocument(userId, 'download');
    await documents.update(userId, healthDocumentId, await versionOf(healthDocumentId), {
      originalName: 'análisis "final"; x.jpg',
    });

    const link = await documents.downloadLink(userId, healthDocumentId, 'inline');

    expect(link.expiresIn).toBeLessThanOrEqual(300);
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    expect(link).toMatchObject({ disposition: 'inline', mimeType: 'image/jpeg', fileName: 'análisis "final"; x.jpg' });
    const signed = provider.signed.at(-1)!;
    expect(signed.key).toBe(object.storageKey);
    expect(signed.options?.expiresIn).toBeLessThanOrEqual(300);
    expect(signed.options?.responseContentDisposition).toBe(
      `inline; filename="an_lisis _final__ x.jpg"; filename*=UTF-8''an%C3%A1lisis%20%22final%22%3B%20x.jpg`,
    );
  });
});
