// =============================================================================
// Real-Postgres test: health data export (H7, #191)
// =============================================================================
//
// What only real rows, a real queue row and a real provider can prove:
//   - an export is a `health.export` job whose run writes a file to
//     `exports/<userId>/<jobId>.<ext>` and a `storage_objects` row the user
//     owns, with `payload.result` (row counts, expiry) on the same job;
//   - the range filter (a wellness score by its local day), the dataset
//     filter, owner scoping (another user's rows never appear);
//   - soft-deleted rows are never exported, not even as the history of an
//     entry that was edited and then deleted; superseded revisions appear
//     only with `includeHistory`;
//   - documents: kept files only, metadata only;
//   - the status route: owner-only (404 for another user), `ready` with a
//     5-minute signed URL and an attachment filename;
//   - the purge: files older than 7 days are erased (bytes and row) and the
//     export reads `expired`; a fresh export is untouched;
//   - the file is one of the user's storage objects, so a data reset
//     collects it.
//
// The storage provider is `TmpDirStorageProvider` (real files on disk). Users
// are created with run-unique values and removed in `afterAll`.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with
// `npm run test:db` against a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger, NotFoundException } from '@nestjs/common';
import type { Job, PrismaClient } from '@prisma/client';
import JSZip from 'jszip';

import { HealthExportPurgeHandler } from '../../src/health-export/handlers/health-export-purge.handler';
import { HealthExportHandler } from '../../src/health-export/handlers/health-export.handler';
import type { CreateHealthExportInput } from '../../src/health-export/dto/health-export.dto';
import { HealthExportService } from '../../src/health-export/health-export.service';
import { healthExportJsonFileSchema } from '../../src/health-export/writers/json.writer';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SignedUrlOptions } from '../../src/storage/providers/storage-provider.types';
import { collectUserObjectIds } from '../../src/user-data/user-data-purge';
import { cleanupTmpDir, TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('health-export.db.spec');

/** The tmp-dir provider, plus a recognisable fake signed URL. */
class SigningProvider extends TmpDirStorageProvider {
  lastSignOptions: SignedUrlOptions | undefined;

  override getSignedDownloadUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    this.lastSignOptions = options;
    return Promise.resolve(`https://signed.test/${key}?expires=${options?.expiresIn}`);
  }
}

const RANGE = { from: '2026-03-01', to: '2026-03-31' };

describeWithDb('health data export (real Postgres)', () => {
  let client: PrismaClient;
  let baseDir: string;
  let provider: SigningProvider;
  let service: HealthExportService;
  let handler: HealthExportHandler;
  let purge: HealthExportPurgeHandler;
  let notify: jest.Mock;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];
  let owner: string;
  let other: string;

  async function makeUser(label: string, displayName: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `health-export-${label}-${run}@example.com`, displayName },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  /** One measurement row; returns its id. */
  async function measure(
    userId: string,
    data: {
      entryId?: string;
      metricKey: string;
      value: number;
      unit: string;
      measuredAt: string;
      localDate?: string;
      revision?: number;
      supersedesId?: string;
      superseded?: boolean;
      deleted?: boolean;
      referenceHigh?: number;
      flag?: string;
    },
  ): Promise<string> {
    const row = await client.measurement.create({
      data: {
        userId,
        entryId: data.entryId ?? randomUUID(),
        metricKey: data.metricKey,
        value: data.value,
        unit: data.unit,
        measuredAt: new Date(data.measuredAt),
        localDate: data.localDate ? new Date(`${data.localDate}T00:00:00.000Z`) : null,
        revision: data.revision ?? 1,
        supersedesId: data.supersedesId ?? null,
        supersededAt: data.superseded ? new Date() : null,
        deletedAt: data.deleted ? new Date() : null,
        referenceHigh: data.referenceHigh ?? null,
        flag: data.flag ?? null,
        method: data.metricKey === 'energy' ? 'self_report' : 'unspecified',
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Queues an export through the service and runs its job the way the worker would. */
  async function exportFor(userId: string, input: Partial<CreateHealthExportInput>): Promise<Job> {
    const view = await service.request(userId, {
      format: 'json',
      ...RANGE,
      datasets: ['profile', 'body', 'vitals', 'labs', 'wellness', 'documents'],
      includeHistory: false,
      ...input,
    });
    const queued = await client.job.update({
      where: { id: view.id },
      data: { status: 'running', attempts: 1, startedAt: new Date() },
    });
    await handler.process(queued);
    return client.job.update({ where: { id: view.id }, data: { status: 'succeeded', finishedAt: new Date() } });
  }

  async function storedFile(job: Job): Promise<Buffer> {
    const result = (job.payload as { result: { storageObjectId: string } }).result;
    const object = await client.storageObject.findUniqueOrThrow({ where: { id: result.storageObjectId } });
    return readFile(join(baseDir, object.storageKey));
  }

  async function exportedJson(job: Job) {
    return healthExportJsonFileSchema.parse(JSON.parse((await storedFile(job)).toString('utf8')));
  }

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    baseDir = await mkdtemp(join(tmpdir(), 'health-export-'));
    provider = new SigningProvider(baseDir);
    notify = jest.fn(async () => undefined);

    service = new HealthExportService(prisma, new JobsService(prisma), provider);
    handler = new HealthExportHandler(
      new JobHandlerRegistry(),
      prisma,
      provider,
      { activeProvider: async () => 's3' } as never,
      { notify } as never,
      { healthExportSettled: jest.fn() } as never,
    );
    purge = new HealthExportPurgeHandler(new JobHandlerRegistry(), prisma, provider);

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    owner = await makeUser('owner', 'Ana Export');
    other = await makeUser('other', 'Ben Other');

    await client.healthProfile.create({
      data: { userId: owner, dateOfBirth: new Date('1990-05-01T00:00:00.000Z'), sexAtBirth: 'female', heightMm: 1685 },
    });

    // Body: an entry edited once (rev 1 superseded, rev 2 current).
    const edited = randomUUID();
    const rev1 = await measure(owner, { entryId: edited, metricKey: 'weight', value: 80, unit: 'kg', measuredAt: '2026-03-10T07:00:00Z', superseded: true });
    await measure(owner, { entryId: edited, metricKey: 'weight', value: 79, unit: 'kg', measuredAt: '2026-03-10T07:00:00Z', revision: 2, supersedesId: rev1 });
    // A deleted entry.
    await measure(owner, { metricKey: 'weight', value: 78, unit: 'kg', measuredAt: '2026-03-15T07:00:00Z', deleted: true });
    // An entry edited and then deleted: its history is the user's deletion too.
    const gone = randomUUID();
    const goneRev1 = await measure(owner, { entryId: gone, metricKey: 'weight', value: 77, unit: 'kg', measuredAt: '2026-03-16T07:00:00Z', superseded: true });
    await measure(owner, { entryId: gone, metricKey: 'weight', value: 76, unit: 'kg', measuredAt: '2026-03-16T07:00:00Z', revision: 2, supersedesId: goneRev1, deleted: true });
    // Outside the range.
    await measure(owner, { metricKey: 'weight', value: 85, unit: 'kg', measuredAt: '2026-02-28T23:00:00Z' });
    // Vitals, labs, and a wellness score whose local day is in range but whose instant is not.
    await measure(owner, { metricKey: 'resting_hr', value: 58, unit: 'bpm', measuredAt: '2026-03-12T07:00:00Z' });
    await measure(owner, {
      metricKey: 'ldl_cholesterol',
      value: 132,
      unit: 'mg/dL',
      measuredAt: '2026-03-20T09:00:00Z',
      referenceHigh: 100,
      flag: 'high',
    });
    await measure(owner, { metricKey: 'energy', value: 4, unit: 'score', measuredAt: '2026-04-01T03:00:00Z', localDate: '2026-03-31' });
    // Another user's reading, in range.
    await measure(other, { metricKey: 'weight', value: 99, unit: 'kg', measuredAt: '2026-03-10T07:00:00Z' });

    // Documents: kept (listed), delete-after-processing and erased (not listed).
    await client.healthDocument.createMany({
      data: [
        { userId: owner, kind: 'lab_report', originalName: 'march-labs.pdf', mimeType: 'application/pdf', sizeBytes: BigInt(1234), documentDate: new Date('2026-03-20T00:00:00Z') },
        { userId: owner, kind: 'lab_report', originalName: 'transient.pdf', mimeType: 'application/pdf', sizeBytes: BigInt(1), retention: 'delete_after_processing', documentDate: new Date('2026-03-21T00:00:00Z') },
        { userId: owner, kind: 'body_metric', originalName: 'erased.jpg', mimeType: 'image/jpeg', sizeBytes: BigInt(1), fileDeletedAt: new Date(), documentDate: new Date('2026-03-22T00:00:00Z') },
      ],
    });
  });

  afterAll(async () => {
    await client.job.deleteMany({ where: { type: 'health.export', subjectId: { in: createdUserIds } } });
    await client.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await client.storageObject.deleteMany({ where: { uploadedById: { in: createdUserIds } } });
    await client.measurement.updateMany({ where: { userId: { in: createdUserIds } }, data: { supersedesId: null } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
    await cleanupTmpDir(baseDir);
    jest.restoreAllMocks();
  });

  it('writes the file and its storage object for the owner, with the result on the job', async () => {
    const job = await exportFor(owner, {});
    const result = (job.payload as any).result;

    expect(job.subjectType).toBe('user');
    expect(job.subjectId).toBe(owner);
    const object = await client.storageObject.findUniqueOrThrow({ where: { id: result.storageObjectId } });
    expect(object).toMatchObject({
      storageKey: `exports/${owner}/${job.id}.json`,
      uploadedById: owner,
      status: 'ready',
      mimeType: 'application/json',
    });
    expect(Number(object.size)).toBe(result.sizeBytes);
    expect(await provider.exists(object.storageKey)).toBe(true);
    expect(result.rowCounts).toEqual({ profile: 1, body: 1, vitals: 1, labs: 1, wellness: 1, documents: 1 });
    expect(notify).toHaveBeenCalledWith('health.export_ready', owner, { exportId: job.id, format: 'json' });

    const audit = await client.auditEvent.findFirstOrThrow({ where: { action: 'health:export:create', targetId: job.id } });
    expect(audit.actorUserId).toBe(owner);
    expect(audit.meta).toMatchObject({ format: 'json', rowCounts: result.rowCounts });
    expect(JSON.stringify(audit.meta)).not.toMatch(/132|79|march-labs/);
  });

  it('exports in-range active rows of the owner only, never a deleted row', async () => {
    const file = await exportedJson(await exportFor(owner, {}));

    expect(file.profile).toMatchObject({ name: 'Ana Export', dateOfBirth: '1990-05-01', sexAtBirth: 'female', heightCm: 168.5 });
    expect(file.datasets.body!.map((row) => row.weight_kg)).toEqual([79]);
    expect(file.datasets.vitals!.map((row) => row.resting_hr_bpm)).toEqual([58]);
    expect(file.datasets.labs![0]).toMatchObject({ analyte_key: 'ldl_cholesterol', value: 132, reference_high: 100, flag: 'high' });
    expect(file.datasets.wellness!).toEqual([expect.objectContaining({ date: '2026-03-31', energy: 4 })]);
    expect(file.datasets.documents!.map((row) => row.original_name)).toEqual(['march-labs.pdf']);
  });

  it('adds superseded revisions only with includeHistory, never those of a deleted entry', async () => {
    const file = await exportedJson(await exportFor(owner, { datasets: ['body'], includeHistory: true }));

    expect(file.datasets.body!.map((row) => [row.weight_kg, row.status, row.revision])).toEqual([
      [80, 'superseded', 1],
      [79, 'current', 2],
    ]);
  });

  it('honours the dataset filter', async () => {
    const job = await exportFor(owner, { datasets: ['labs'] });
    const file = await exportedJson(job);

    expect(file.profile).toBeNull();
    expect(Object.keys(file.datasets)).toEqual(['labs']);
    expect((job.payload as any).result.rowCounts).toMatchObject({ labs: 1, body: 0, profile: 0 });
  });

  it('writes a CSV zip with one file per dataset', async () => {
    const zip = await JSZip.loadAsync(await storedFile(await exportFor(owner, { format: 'csv', datasets: ['body', 'labs'] })));

    expect(Object.keys(zip.files).sort()).toEqual(['body.csv', 'labs.csv']);
    expect(await zip.file('body.csv')!.async('string')).toContain('79');
  });

  it('serves status and a short-lived attachment URL to the owner only', async () => {
    const job = await exportFor(owner, { format: 'pdf', datasets: ['labs'] });

    await expect(service.get(other, job.id)).rejects.toBeInstanceOf(NotFoundException);

    const view = await service.get(owner, job.id);
    expect(view.status).toBe('ready');
    expect(view.fileName).toMatch(/^[a-z0-9-]+-health-2026-03-01-2026-03-31\.pdf$/);
    expect(view.download?.url).toBe(`https://signed.test/exports/${owner}/${job.id}.pdf?expires=300`);
    expect(provider.lastSignOptions).toEqual({
      expiresIn: 300,
      responseContentDisposition: `attachment; filename="${view.fileName}"`,
    });

    const listed = await service.list(owner);
    expect(listed.items.map((item) => item.id)).toContain(job.id);
    expect(listed.items.every((item) => item.download === null)).toBe(true);
    expect((await service.list(other)).items).toEqual([]);
  });

  it('is collected with the rest of the owner files by a data reset', async () => {
    const job = await exportFor(owner, { datasets: ['profile'] });

    expect(await collectUserObjectIds(client, owner)).toContain((job.payload as any).result.storageObjectId);
  });

  it('purges files older than 7 days, bytes and row, and the export reads expired', async () => {
    const old = await exportFor(owner, { datasets: ['vitals'] });
    const fresh = await exportFor(owner, { datasets: ['vitals'] });
    const oldObjectId = (old.payload as any).result.storageObjectId;
    const freshObjectId = (fresh.payload as any).result.storageObjectId;
    const oldKey = `exports/${owner}/${old.id}.json`;
    await client.storageObject.update({
      where: { id: oldObjectId },
      data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });

    const result = await purge.purge();

    expect(result.failed).toBe(0);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await client.storageObject.findUnique({ where: { id: oldObjectId } })).toBeNull();
    expect(await provider.exists(oldKey)).toBe(false);
    expect(await client.storageObject.findUnique({ where: { id: freshObjectId } })).not.toBeNull();

    const view = await service.get(owner, old.id);
    expect(view.status).toBe('expired');
    expect(view.download).toBeNull();
    expect((await service.get(owner, fresh.id)).status).toBe('ready');
  });
});
