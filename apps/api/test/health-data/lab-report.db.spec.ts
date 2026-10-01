// =============================================================================
// Real-Postgres test: lab report extraction (H4, #188)
// =============================================================================
//
// What only real rows, a real PDF and a real file store can prove:
//   - a lab PDF attached to a `lab_report` intake becomes a `lab_report`
//     health document; analyze queues `ai.health.lab_report`; the handler
//     (model stubbed with the fixture panel) stores seven pending drafts, the
//     unmatched analyte included, glucose converted, and the collection date
//     and lab name in the intake's context;
//   - apply is refused (409 UNRESOLVED_ANALYTES, with the item id) while the
//     unmatched row is accepted, and nothing is written;
//   - after rejecting it, apply writes ONE lab entry dated with the
//     collection date: range, flag, method `lab`, `origin: ai`,
//     `healthDocumentId`; an edited row carries `userEdited` and
//     `originalAiValue`; glucose is stored in mg/dL with mmol/L kept in the
//     provenance; the document gets `documentDate`; history lists the rows;
//   - an unmatched row mapped to a catalog key by the user is saved;
//   - re-importing the same report shows the duplicate warning (and the
//     edited value does not match);
//   - delete after processing: the purge job erases the file after apply.
//
// The model is stubbed at `AiService.forUser(...).respondStructured`; the
// gate pipeline is covered by the mocked suites and the AI guardrails.
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

import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import type { AiService } from '../../src/ai/runtime/ai.service';
import { stubFeatureResolver } from '../../src/ai/testing/feature-resolver.stub';
import { HealthDocumentPurgeHandler } from '../../src/health-documents/handlers/health-document-purge.handler';
import { HealthDocumentObjectReferences } from '../../src/health-documents/health-document-object-references';
import { IntakeInputInspector } from '../../src/intake/intake-input-inspector';
import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { IntakeService } from '../../src/intake/intake.service';
import { StorageObjectReferences } from '../../src/intake/storage-object-references';
import { plainPdf } from '../../src/intake/testing/pdf-bytes';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import { LabReportDuplicatesService } from '../../src/measurements/lab-report/lab-report-duplicates.service';
import { LabReportHandler } from '../../src/measurements/lab-report/lab-report.handler';
import { LabReportIntakeKind } from '../../src/measurements/lab-report/lab-report.kind';
import { labReportOutputSchema } from '../../src/measurements/lab-report/lab-report.prompt';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { ObjectsService } from '../../src/storage/objects/objects.service';
import { labReportFixture } from '../fixtures/lab-report/load';
import { cleanupTmpDir, TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('lab-report.db.spec');

const PERMS = ['intakes:read', 'intakes:write', 'health_data:read', 'health_data:write'];
const COLLECTED_AT = new Date('2026-09-15T12:00:00.000Z');

describeWithDb('lab report extraction (real Postgres)', () => {
  let client: PrismaClient;
  let baseDir: string;
  let provider: TmpDirStorageProvider;
  let intakes: IntakeService;
  let measurements: MeasurementsService;
  let handler: LabReportHandler;
  let purge: HealthDocumentPurgeHandler;
  let duplicates: LabReportDuplicatesService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `lab-report-${label}-${run}@example.com` }, select: { id: true } });
    createdUserIds.push(user.id);
    return user.id;
  }

  /** A real two-page PDF in the tmp provider plus its `ready` storage object row. */
  async function uploadPdf(userId: string, label: string) {
    const storageKey = `test/lab-report/${run}/${label}-${randomUUID()}.pdf`;
    const bytes = plainPdf(2);
    await provider.upload(storageKey, Readable.from(bytes), { contentType: 'application/pdf' } as never);
    return client.storageObject.create({
      data: { name: `${label}.pdf`, size: BigInt(bytes.length), mimeType: 'application/pdf', storageKey, status: 'ready', uploadedById: userId },
      select: { id: true, storageKey: true },
    });
  }

  /** Create, attach the PDF, analyze (queues the job), run the job with the fixture answer. */
  async function importReport(userId: string, label: string, retainFiles?: boolean) {
    const intake = await intakes.create(userId, { kind: 'lab_report', ...(retainFiles === undefined ? {} : { retainFiles }) }, PERMS);
    const object = await uploadPdf(userId, label);
    const photo = await intakes.attachPhoto(userId, intake.id, object.id, PERMS);
    const { jobId } = await intakes.analyze(userId, intake.id, { provider: 'openai', modelId: 'vision-model' }, PERMS);

    const job = await client.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ type: 'ai.health.lab_report', subjectType: 'photo_intake', subjectId: intake.id });
    await handler.process(job);
    await client.job.update({ where: { id: jobId }, data: { status: 'succeeded', finishedAt: new Date() } });

    return { intakeId: intake.id, object, healthDocumentId: photo.healthDocumentId! };
  }

  const items = (intakeId: string) =>
    client.draftItem.findMany({ where: { intakeId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  const byName = async (intakeId: string, name: string) =>
    (await items(intakeId)).find((item) => (item.value as { nameAsPrinted: string }).nameAsPrinted === name)!;

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    baseDir = await mkdtemp(join(tmpdir(), 'lab-report-'));
    provider = new TmpDirStorageProvider(baseDir);

    const objects = new ObjectsService(prisma, provider, {} as never, {} as never, {} as never, {} as never);
    const references = new StorageObjectReferences();
    new HealthDocumentObjectReferences(references, prisma).onModuleInit();

    const kinds = new IntakeKindRegistry();
    measurements = new MeasurementsService(prisma);
    new LabReportIntakeKind(kinds, measurements).onModuleInit();
    intakes = new IntakeService(
      prisma,
      kinds,
      new JobsService(prisma),
      { assertUsable: jest.fn(async () => ({})) } as never,
      objects,
      stubFeatureResolver({ provider: 'openai', modelId: 'vision-model' }) as never,
      new IntakeInputInspector(provider),
      references,
    );
    const respondStructured = jest.fn(async () => ({
      parsed: labReportOutputSchema.parse(labReportFixture('lipid-glucose-panel')),
    }));
    handler = new LabReportHandler(
      new JobHandlerRegistry(),
      prisma,
      { forUser: () => ({ respondStructured }) } as unknown as AiService,
      intakes,
    );
    purge = new HealthDocumentPurgeHandler(new JobHandlerRegistry(), prisma, objects, { healthDocumentPurge: jest.fn() } as never);
    duplicates = new LabReportDuplicatesService(prisma);

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    const intakeRows = await client.photoIntake.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
    const docs = await client.healthDocument.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
    await client.job.deleteMany({
      where: {
        OR: [
          { subjectType: 'photo_intake', subjectId: { in: intakeRows.map((r) => r.id) } },
          { subjectType: 'health_document', subjectId: { in: docs.map((d) => d.id) } },
        ],
      },
    });
    await client.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await client.storageObject.deleteMany({ where: { uploadedById: { in: createdUserIds } } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
    await cleanupTmpDir(baseDir);
    jest.restoreAllMocks();
  });

  it('a lab PDF yields the expected drafts, the unmatched analyte included, and the report date in the context', async () => {
    const userId = await makeUser('drafts');
    const { intakeId, object, healthDocumentId } = await importReport(userId, 'drafts');

    const intake = await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } });
    expect(intake.status).toBe('ready');
    expect(intake.context).toEqual({ collectionDate: '2026-09-15', labName: 'Acme Clinical Laboratories' });
    expect(intake.resultMeta).toMatchObject({ promptVersion: 1, unmatched: 1, converted: 1, itemsStored: 7 });

    const document = await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } });
    expect(document).toMatchObject({ kind: 'lab_report', mimeType: 'application/pdf', storageObjectId: object.id, retention: 'keep' });

    const drafts = await items(intakeId);
    expect(drafts).toHaveLength(7);
    for (const draft of drafts) {
      expect(draft).toMatchObject({ origin: 'ai', status: 'pending', kind: 'result', sourcePhotoIds: [object.id] });
    }
    expect(drafts.map((d) => (d.value as { analyteKey: string | null }).analyteKey)).toEqual([
      'total_cholesterol',
      'hdl_cholesterol',
      'ldl_cholesterol',
      'triglycerides',
      null,
      'fasting_glucose',
      'hba1c',
    ]);
    expect(drafts[4]).toMatchObject({ uncertain: true, value: { nameAsPrinted: 'Lipoprotein (a)', match: 'unmatched' } });
    expect(drafts[5].value).toMatchObject({ value: 97.2973, unit: 'mg/dL', originalValue: 5.4, originalUnit: 'mmol/L' });
    expect(await client.measurement.count({ where: { userId } })).toBe(0);
  });

  it('refuses apply while the unmatched row is unresolved, then saves one lab entry with range, flag and provenance', async () => {
    const userId = await makeUser('apply');
    const { intakeId, object, healthDocumentId } = await importReport(userId, 'apply');
    const unmatched = await byName(intakeId, 'Lipoprotein (a)');

    await intakes.acceptAll(userId, intakeId, PERMS);
    const refused = (await intakes.apply(userId, intakeId, PERMS).catch((error: unknown) => error)) as ConflictException;
    expect(refused).toBeInstanceOf(ConflictException);
    expect(refused.getResponse()).toMatchObject({ details: { reason: 'UNRESOLVED_ANALYTES', itemIds: [unmatched.id], count: 1 } });
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).status).toBe('ready');
    expect(await client.measurement.count({ where: { userId } })).toBe(0);

    // Edit LDL, reject the unmatched row.
    const ldl = await byName(intakeId, 'LDL Chol Calc');
    await intakes.updateItem(userId, intakeId, ldl.id, { value: { ...(ldl.value as object), value: 140 } }, PERMS);
    await intakes.updateItem(userId, intakeId, unmatched.id, { status: 'rejected' }, PERMS);

    const result = (await intakes.apply(userId, intakeId, PERMS)) as { entryId: string; measuredAtSource: string; documentDate: string };
    expect(result).toMatchObject({ measuredAtSource: 'collection_date', documentDate: '2026-09-15' });

    const rows = await client.measurement.findMany({ where: { userId }, orderBy: { metricKey: 'asc' } });
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row).toMatchObject({ entryId: result.entryId, origin: 'ai', method: 'lab', measuredAt: COLLECTED_AT, revision: 1 });
      expect(row.sourceRef).toMatchObject({
        kind: 'lab_report',
        intakeId,
        healthDocumentId,
        storageObjectIds: [object.id],
        collectionDate: '2026-09-15',
        labName: 'Acme Clinical Laboratories',
      });
    }

    const row = (key: string) => rows.find((r) => r.metricKey === key)!;
    expect(row('total_cholesterol')).toMatchObject({ value: 212, unit: 'mg/dL', referenceLow: null, referenceHigh: 200, referenceText: '<200', flag: 'high' });
    expect(row('total_cholesterol').sourceRef).toMatchObject({ userEdited: false, confidence: 'high', match: 'matched' });
    expect(row('total_cholesterol').sourceRef).not.toHaveProperty('originalAiValue');

    // The edited row keeps what the AI read.
    expect(row('ldl_cholesterol')).toMatchObject({ value: 140, referenceLow: 0, referenceHigh: 99, flag: 'high' });
    expect(row('ldl_cholesterol').sourceRef).toMatchObject({ userEdited: true, originalAiValue: 138, aiDraft: { value: 138 } });

    // Glucose printed in mmol/L: stored canonically, the printed unit kept.
    expect(row('fasting_glucose')).toMatchObject({ value: 97.2973, unit: 'mg/dL', referenceLow: 70.2703, referenceHigh: 99.0991 });
    expect(row('fasting_glucose').sourceRef).toMatchObject({ originalValue: 5.4, originalUnit: 'mmol/L', nameAsPrinted: 'Glucose' });

    const document = await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } });
    expect(document.documentDate).toEqual(new Date('2026-09-15T00:00:00.000Z'));

    // The results appear in the lab history, linked to a document that still has its file.
    const history = await measurements.list(userId, { category: 'lab', page: 1, pageSize: 20 } as never);
    expect(history.items).toHaveLength(6);
    expect(history.items.every((m) => m.fileDeleted === false && m.measuredAt === COLLECTED_AT.toISOString())).toBe(true);
  });

  it('an unmatched row mapped to a catalog key by the user is saved as user_mapped', async () => {
    const userId = await makeUser('mapped');
    const { intakeId } = await importReport(userId, 'mapped');
    const unmatched = await byName(intakeId, 'Lipoprotein (a)');

    const edited = await intakes.updateItem(
      userId,
      intakeId,
      unmatched.id,
      { value: { ...(unmatched.value as object), analyteKey: 'apob', value: 0.9, unit: 'g/L', referenceLow: null, referenceHigh: null } },
      PERMS,
    );
    expect(edited.value).toMatchObject({ analyteKey: 'apob', value: 90, unit: 'mg/dL', match: 'user_mapped', panel: 'lipids' });

    await intakes.acceptAll(userId, intakeId, PERMS);
    await intakes.apply(userId, intakeId, PERMS);

    const apob = await client.measurement.findFirstOrThrow({ where: { userId, metricKey: 'apob' } });
    expect(apob).toMatchObject({ value: 90, unit: 'mg/dL', origin: 'ai' });
    expect(apob.sourceRef).toMatchObject({ match: 'user_mapped', userEdited: true, nameAsPrinted: 'Lipoprotein (a)' });
    expect(await client.measurement.count({ where: { userId } })).toBe(7);
  });

  it('re-importing the same report shows the duplicate warning; the applied intake reports none against itself', async () => {
    const userId = await makeUser('dupes');
    const first = await importReport(userId, 'first');
    const ldl = await byName(first.intakeId, 'LDL Chol Calc');
    await intakes.updateItem(userId, first.intakeId, ldl.id, { value: { ...(ldl.value as object), value: 140 } }, PERMS);
    await intakes.updateItem(userId, first.intakeId, (await byName(first.intakeId, 'Lipoprotein (a)')).id, { status: 'rejected' }, PERMS);
    await intakes.acceptAll(userId, first.intakeId, PERMS);
    await intakes.apply(userId, first.intakeId, PERMS);

    expect((await duplicates.find(userId, first.intakeId)).duplicates).toEqual([]);

    const second = await importReport(userId, 'second');
    const warning = await duplicates.find(userId, second.intakeId);

    expect(warning).toMatchObject({ intakeId: second.intakeId, checkedDate: '2026-09-15', collectionDate: '2026-09-15' });
    // Every matched result equals a saved one, except LDL (saved as edited).
    expect(warning.duplicates.map((d) => d.analyteKey)).toEqual([
      'total_cholesterol',
      'hdl_cholesterol',
      'triglycerides',
      'fasting_glucose',
      'hba1c',
    ]);
    const glucose = warning.duplicates.find((d) => d.analyteKey === 'fasting_glucose')!;
    expect(glucose).toMatchObject({ value: 97.2973, unit: 'mg/dL' });
    expect(glucose.matches).toEqual([
      expect.objectContaining({ intakeId: first.intakeId, healthDocumentId: first.healthDocumentId, origin: 'ai' }),
    ]);

    // A warning only: nothing de-duplicates, and a rejected row is not reported.
    await intakes.updateItem(userId, second.intakeId, glucose.itemId, { status: 'rejected' }, PERMS);
    expect((await duplicates.find(userId, second.intakeId)).duplicates.map((d) => d.analyteKey)).not.toContain('fasting_glucose');

    // Another user's intake is a 404.
    const stranger = await makeUser('stranger');
    await expect(duplicates.find(stranger, second.intakeId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delete after processing: apply enqueues the purge, the job erases the file, provenance and documentDate stay', async () => {
    const userId = await makeUser('purge');
    const { intakeId, object, healthDocumentId } = await importReport(userId, 'purge', false);
    await intakes.updateItem(userId, intakeId, (await byName(intakeId, 'Lipoprotein (a)')).id, { status: 'rejected' }, PERMS);
    await intakes.acceptAll(userId, intakeId, PERMS);
    const result = (await intakes.apply(userId, intakeId, PERMS)) as { entryId: string };

    const [job] = await client.job.findMany({ where: { type: 'health.document.purge', subjectId: healthDocumentId } });
    expect(job).toMatchObject({ status: 'pending', payload: { healthDocumentId } });
    expect(await provider.exists(object.storageKey)).toBe(true);

    await purge.process(job);
    await client.job.update({ where: { id: job.id }, data: { status: 'succeeded', finishedAt: new Date() } });

    expect(await provider.exists(object.storageKey)).toBe(false);
    const document = await client.healthDocument.findUniqueOrThrow({ where: { id: healthDocumentId } });
    expect(document).toMatchObject({ storageObjectId: null, documentDate: new Date('2026-09-15T00:00:00.000Z') });
    expect(document.fileDeletedAt).toBeInstanceOf(Date);

    const history = await measurements.list(userId, { category: 'lab', page: 1, pageSize: 20 } as never);
    expect(history.items).toHaveLength(6);
    expect(history.items.every((m) => m.entryId === result.entryId && m.fileDeleted === true)).toBe(true);
  });
});
