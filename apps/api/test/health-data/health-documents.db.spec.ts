// =============================================================================
// Real-Postgres test: health documents and the keep-or-delete choice (H1, #185)
// =============================================================================
//
// What only real rows and a real provider can prove:
//   - an intake created without `retainFiles` stores `retention = keep`, and
//     so does its file's health document;
//   - with `retainFiles: false`, APPLY commits the measurements and the
//     `health.document.purge` job together; running the job erases the file
//     (the provider's `exists()` is false), stamps `file_deleted_at`, nulls
//     `storage_object_id`, audits `health:document:delete`; the saved
//     readings still name `healthDocumentId` and `/api/measurements` reports
//     `fileDeleted: true`;
//   - the same after DISCARD, and the intake's own cleanup does not race the
//     job (the file survives until the job runs);
//   - a KEPT file survives discard (and the intake's
//     `deleteUnreferencedObjects`), and its document outlives the intake;
//   - a purge that fails (storage outage) throws for the queue to retry,
//     leaves the document unstamped and the measurements in place; the retry
//     succeeds;
//   - another user's intake answers 404 to a retention change.
//
// The storage provider is `TmpDirStorageProvider` (real files on disk), under
// the real `ObjectsService.delete`. Every user is created with run-unique
// values and removed in `afterAll`.
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

import { Logger, NotFoundException } from '@nestjs/common';
import type { Job, PrismaClient } from '@prisma/client';

import { stubFeatureResolver } from '../../src/ai/testing/feature-resolver.stub';
import { HealthDocumentPurgeHandler } from '../../src/health-documents/handlers/health-document-purge.handler';
import { HealthDocumentObjectReferences } from '../../src/health-documents/health-document-object-references';
import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { IntakeService } from '../../src/intake/intake.service';
import { StorageObjectReferences } from '../../src/intake/storage-object-references';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import { BodyMetricReadingIntakeKind } from '../../src/measurements/photo/body-metric-reading.kind';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { ObjectsService } from '../../src/storage/objects/objects.service';
import { cleanupTmpDir, TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('health-documents.db.spec');

/** What a contributor's resolved permissions carry for this flow. */
const PERMS = ['intakes:read', 'intakes:write', 'health_data:read', 'health_data:write'];

/** A provider whose next `delete` fails, for the retry case. */
class FlakyProvider extends TmpDirStorageProvider {
  failNextDelete = false;

  override async delete(key: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error('simulated storage outage');
    }
    return super.delete(key);
  }
}

describeWithDb('health documents and file retention (real Postgres)', () => {
  let client: PrismaClient;
  let baseDir: string;
  let provider: FlakyProvider;
  let intakes: IntakeService;
  let measurements: MeasurementsService;
  let purge: HealthDocumentPurgeHandler;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `health-docs-${label}-${run}@example.com` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  /** A real file in the tmp provider plus its `ready` storage object row. */
  async function upload(userId: string, label: string): Promise<{ id: string; storageKey: string }> {
    const storageKey = `test/health-docs/${run}/${label}-${randomUUID()}.jpg`;
    const bytes = Buffer.from(`fake jpeg ${label}`);
    await provider.upload(storageKey, Readable.from(bytes), { contentType: 'image/jpeg' } as never);
    const object = await client.storageObject.create({
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
    return object;
  }

  /** A `body_metric_reading` intake with one file and one hand-entered, accepted reading. */
  async function intakeWithFile(userId: string, label: string, retainFiles?: boolean) {
    const intake = await intakes.create(
      userId,
      { kind: 'body_metric_reading', ...(retainFiles === undefined ? {} : { retainFiles }) },
      PERMS,
    );
    const object = await upload(userId, label);
    const photo = await intakes.attachPhoto(userId, intake.id, object.id, PERMS);
    await intakes.addItem(
      userId,
      intake.id,
      { kind: 'reading', value: { metricKey: 'weight', value: 81.5, unit: 'kg', method: 'scale' } },
      PERMS,
    );
    return { intakeId: intake.id, object, healthDocumentId: photo.healthDocumentId! };
  }

  const purgeJobsOf = (healthDocumentId: string) =>
    client.job.findMany({ where: { type: 'health.document.purge', subjectId: healthDocumentId } });

  /** Runs one queued purge job the way the worker would, then settles the row. */
  async function runPurge(job: Job): Promise<void> {
    await purge.process(job);
    await client.job.update({ where: { id: job.id }, data: { status: 'succeeded', finishedAt: new Date() } });
  }

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    baseDir = await mkdtemp(join(tmpdir(), 'health-docs-'));
    provider = new FlakyProvider(baseDir);

    const objects = new ObjectsService(prisma, provider, {} as never, {} as never, {} as never, {} as never);
    const references = new StorageObjectReferences();
    new HealthDocumentObjectReferences(references, prisma).onModuleInit();

    const kinds = new IntakeKindRegistry();
    measurements = new MeasurementsService(prisma);
    new BodyMetricReadingIntakeKind(kinds, measurements).onModuleInit();
    intakes = new IntakeService(
      prisma,
      kinds,
      new JobsService(prisma),
      { assertUsable: jest.fn(async () => ({})) } as never,
      objects,
      stubFeatureResolver({ provider: 'openai', modelId: 'vision-model' }) as never,
      references,
    );
    purge = new HealthDocumentPurgeHandler(new JobHandlerRegistry(), prisma, objects, {
      healthDocumentPurge: jest.fn(),
    } as never);

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    const docs = await client.healthDocument.findMany({
      where: { userId: { in: createdUserIds } },
      select: { id: true },
    });
    await client.job.deleteMany({ where: { subjectType: 'health_document', subjectId: { in: docs.map((d) => d.id) } } });
    await client.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await client.storageObject.deleteMany({ where: { uploadedById: { in: createdUserIds } } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
    await cleanupTmpDir(baseDir);
    jest.restoreAllMocks();
  });

  it('an intake created without retainFiles stores retention keep, and so does its file', async () => {
    const userId = await makeUser('default');
    const { intakeId, healthDocumentId, object } = await intakeWithFile(userId, 'default');

    const intake = await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } });
    const document = await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } });

    expect(intake.retention).toBe('keep');
    expect(document).toMatchObject({
      userId,
      kind: 'body_metric',
      retention: 'keep',
      storageObjectId: object.id,
      intakeId,
      originalName: 'default.jpg',
      mimeType: 'image/jpeg',
      fileDeletedAt: null,
    });
    expect((await intakes.get(userId, intakeId, PERMS)).retainFiles).toBe(true);
  });

  it('delete after processing, APPLY: file erased by the job, provenance kept, history says fileDeleted', async () => {
    const userId = await makeUser('apply');
    const { intakeId, healthDocumentId, object } = await intakeWithFile(userId, 'apply', false);

    const result = (await intakes.apply(userId, intakeId, PERMS)) as { entryId: string };

    // The job committed with the apply; nothing is erased before it runs.
    const [job] = await purgeJobsOf(healthDocumentId);
    expect(job).toMatchObject({ status: 'pending', subjectType: 'health_document', payload: { healthDocumentId } });
    expect(await provider.exists(object.storageKey)).toBe(true);

    await runPurge(job);

    expect(await provider.exists(object.storageKey)).toBe(false);
    expect(await client.storageObject.findUnique({ where: { id: object.id } })).toBeNull();
    const document = await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } });
    expect(document.fileDeletedAt).toBeInstanceOf(Date);
    expect(document.storageObjectId).toBeNull();

    const audit = await client.auditEvent.findFirstOrThrow({
      where: { action: 'health:document:delete', targetId: healthDocumentId },
    });
    expect(audit.meta).toEqual({ storageObjectId: object.id, intakeId, files: 1, reason: 'delete_after_processing' });

    const rows = await client.measurement.findMany({ where: { userId, entryId: result.entryId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceRef).toMatchObject({ kind: 'photo_intake', intakeId, healthDocumentId });

    const history = await measurements.list(userId, { page: 1, pageSize: 20 });
    expect(history.items).toEqual([expect.objectContaining({ entryId: result.entryId, fileDeleted: true })]);

    // Idempotent: a duplicate run changes nothing.
    await expect(purge.purge(healthDocumentId)).resolves.toBe('already_purged');
  });

  it('keep, APPLY: no purge job, the file stays and history says fileDeleted false', async () => {
    const userId = await makeUser('keep-apply');
    const { intakeId, healthDocumentId, object } = await intakeWithFile(userId, 'keep-apply');

    await intakes.apply(userId, intakeId, PERMS);

    expect(await purgeJobsOf(healthDocumentId)).toEqual([]);
    expect(await provider.exists(object.storageKey)).toBe(true);
    const history = await measurements.list(userId, { page: 1, pageSize: 20 });
    expect(history.items).toEqual([expect.objectContaining({ fileDeleted: false })]);
  });

  it('delete after processing, DISCARD: the intake cleanup leaves the file to the job, which erases it', async () => {
    const userId = await makeUser('discard');
    const { intakeId, healthDocumentId, object } = await intakeWithFile(userId, 'discard', false);

    await intakes.discard(userId, intakeId, PERMS);

    expect(await client.photoIntake.findUnique({ where: { id: intakeId } })).toBeNull();
    // The reference checker kept it from the intake's best-effort cleanup.
    expect(await provider.exists(object.storageKey)).toBe(true);
    const [job] = await purgeJobsOf(healthDocumentId);
    expect(job).toBeDefined();

    await runPurge(job);

    expect(await provider.exists(object.storageKey)).toBe(false);
    const document = await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } });
    expect(document).toMatchObject({ intakeId: null, storageObjectId: null });
    expect(document.fileDeletedAt).toBeInstanceOf(Date);
  });

  it('keep, DISCARD: the kept file survives the discard and its cleanup; the document outlives the intake', async () => {
    const userId = await makeUser('keep-discard');
    const { intakeId, healthDocumentId, object } = await intakeWithFile(userId, 'keep-discard');

    await intakes.discard(userId, intakeId, PERMS);

    expect(await purgeJobsOf(healthDocumentId)).toEqual([]);
    expect(await provider.exists(object.storageKey)).toBe(true);
    expect(await client.storageObject.findUnique({ where: { id: object.id } })).not.toBeNull();
    expect(await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } })).toMatchObject({
      intakeId: null,
      storageObjectId: object.id,
      retention: 'keep',
      fileDeletedAt: null,
    });
  });

  it('detaching a file removes its document, and the object is cleaned up as before', async () => {
    const userId = await makeUser('detach');
    const { intakeId, healthDocumentId, object } = await intakeWithFile(userId, 'detach');

    await intakes.detachPhoto(userId, intakeId, object.id, PERMS);

    expect(await client.healthDocument.findUnique({ where: { id: healthDocumentId } })).toBeNull();
    expect(await provider.exists(object.storageKey)).toBe(false);
  });

  it('a purge failure throws for the queue to retry; measurements stay; the retry erases the file', async () => {
    const userId = await makeUser('retry');
    const { intakeId, healthDocumentId, object } = await intakeWithFile(userId, 'retry', false);
    const result = (await intakes.apply(userId, intakeId, PERMS)) as { entryId: string };
    const [job] = await purgeJobsOf(healthDocumentId);

    provider.failNextDelete = true;
    await expect(purge.process(job)).rejects.toThrow('simulated storage outage');

    expect(purge.profile.maxAttempts).toBeGreaterThan(1);
    expect(await provider.exists(object.storageKey)).toBe(true);
    expect(await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } })).toMatchObject({
      storageObjectId: object.id,
      fileDeletedAt: null,
    });
    expect(await client.measurement.count({ where: { userId, entryId: result.entryId, deletedAt: null } })).toBe(1);

    await runPurge(job);

    expect(await provider.exists(object.storageKey)).toBe(false);
    expect((await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } })).fileDeletedAt).not.toBeNull();
    expect(await client.measurement.count({ where: { userId, entryId: result.entryId, deletedAt: null } })).toBe(1);
  });

  it('retainFiles can change before apply, for the intake and its files; another user gets a 404', async () => {
    const userId = await makeUser('change');
    const otherId = await makeUser('change-other');
    const { intakeId, healthDocumentId } = await intakeWithFile(userId, 'change');

    const view = await intakes.updateContext(userId, intakeId, { retainFiles: false }, PERMS);

    expect(view).toMatchObject({ retention: 'delete_after_processing', retainFiles: false });
    expect(view.photos[0]).toMatchObject({ healthDocumentId, retention: 'delete_after_processing' });
    expect((await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } })).retention).toBe(
      'delete_after_processing',
    );

    await expect(intakes.updateContext(otherId, intakeId, { retainFiles: true }, PERMS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).retention).toBe(
      'delete_after_processing',
    );
  });
});
