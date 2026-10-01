// =============================================================================
// Integration: "Read a value from a photo" (E2.6, #64) — full AppModule,
// mocked Prisma, the #432 AI harness (FakeAiProvider)
// =============================================================================
//
// The `body_metric_reading` intake kind and its `ai.health.body_metric_reading`
// job end to end over the real controllers, guards, pipes and filter:
//
//   create intake -> analyze (the job type queued) -> run the handler (a real
//   `AiService` call against the fake, photos as storage-object inputs) ->
//   drafts stored -> review (edit / add-missing validation) -> apply (one
//   measurement entry, provenance derived server-side);
//
// plus RBAC (the analyze gate), ownership (404 on a foreign intake), the kill
// switch and apply refusals. Real transaction rollback and the `source_ref`
// round trip are proved in `measurements-photo.db.spec.ts`.
// =============================================================================

import request from 'supertest';
import { z } from 'zod';

import { HARNESS_MODEL, HARNESS_OTHER_USER, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import type { IntakeKind } from '../../src/intake/intake-kind.interface';
import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { bodyMetricFixtureText, type BodyMetricFixture } from '../fixtures/body-metric/load';
import { plainPdf } from '../../src/intake/testing/pdf-bytes';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { mockPrismaTransaction } from '../mocks/prisma.mock';
import { type AiHttpTestApp, createAiHttpTestApp } from '../ai/ai-http.helper';

const INTAKE = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const ITEM_2 = '44444444-4444-4444-8444-444444444445';
const JOB = '66666666-6666-4666-8666-666666666666';
const VIEWER = '77777777-7777-4777-8777-777777777777';

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

function intakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTAKE,
    userId: HARNESS_USER,
    kind: 'body_metric_reading',
    status: 'draft',
    subjectType: null,
    subjectId: null,
    context: null,
    provider: null,
    modelId: null,
    jobId: null,
    errorCode: null,
    errorMessage: null,
    resultMeta: null,
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    updatedAt: new Date('2026-09-29T10:00:00.000Z'),
    completedAt: null,
    ...overrides,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM,
    intakeId: INTAKE,
    kind: 'reading',
    origin: 'ai',
    status: 'accepted',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
    sourcePhotoIds: [] as string[],
    userVerified: true,
    value: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
    originalAiValue: null,
    sortOrder: 0,
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    updatedAt: new Date('2026-09-29T10:00:00.000Z'),
    ...overrides,
  };
}

describe('Read a value from a photo over HTTP (E2.6)', () => {
  let t: AiHttpTestApp;
  let prisma: any;
  let contributor: string;
  let viewer: string;

  beforeAll(async () => {
    t = await createAiHttpTestApp({}, { harnessUsableModels: true });
    prisma = t.context.prismaMock;
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    mockPrismaTransaction();
    contributor = (await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' })).accessToken;
    viewer = (await createMockTestUser(t.context, { id: VIEWER, roleName: 'viewer' })).accessToken;
    prisma.photoIntake.findFirst.mockResolvedValue(null);
    prisma.healthDocument.findMany.mockResolvedValue([]);
    prisma.measurement.create.mockImplementation(async ({ data }: any) => ({
      id: `m-${data.metricKey}`,
      revision: 1,
      localDate: null,
      ...data,
    }));
  });

  const call = (method: HttpMethod, path: string, token: string, body: object = {}) =>
    request(t.context.app.getHttpServer())[method](path).set(authHeader(token)).send(body);

  /** `findFirst` honouring the owner filter over one stored row. */
  function storeIntake(row: ReturnType<typeof intakeRow>): void {
    prisma.photoIntake.findFirst.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      if (where.id !== undefined && where.id !== row.id) return null;
      if (where.userId !== undefined && where.userId !== row.userId) return null;
      return args?.select ? { status: row.status } : row;
    });
  }

  /** Runs the registered handler over a `scanning` intake holding `photoIds`, the fake answering `fixture`. */
  async function runHandler(fixture: BodyMetricFixture, photoIds: string[], mimeType = 'image/jpeg') {
    const scanning = {
      ...intakeRow({ status: 'scanning', provider: 'openai', modelId: HARNESS_MODEL, jobId: JOB }),
      photos: photoIds.map((storageObjectId) => ({ storageObjectId, storageObject: { mimeType } })),
    };
    prisma.photoIntake.findUnique.mockResolvedValue(scanning);
    prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
    prisma.draftItem.deleteMany.mockResolvedValue({ count: 0 });
    prisma.draftItem.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    prisma.draftItem.createMany.mockResolvedValue({ count: 1 });
    t.script([{ outputText: bodyMetricFixtureText(fixture) }]);

    const handler = t.context.app.get(JobHandlerRegistry).get('ai.health.body_metric_reading');
    expect(handler).toBeDefined();
    await handler!.process({ id: JOB, payload: { intakeId: INTAKE } } as never);
  }

  const addPhoto = () => t.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'image/jpeg' }).id;

  // ---------------------------------------------------------------------------

  describe('create and analyze', () => {
    it('creates a body_metric_reading intake with no context', async () => {
      prisma.photoIntake.create.mockResolvedValue({ ...intakeRow(), photos: [], items: [] });

      const res = await call('post', '/api/intakes', contributor, { kind: 'body_metric_reading' }).expect(201);

      expect(res.body.data).toMatchObject({ kind: 'body_metric_reading', status: 'draft' });
      expect(prisma.photoIntake.create.mock.calls[0][0].data).toMatchObject({ kind: 'body_metric_reading' });
    });

    it('refuses a context key (the kind takes none)', async () => {
      const res = await call('post', '/api/intakes', contributor, {
        kind: 'body_metric_reading',
        context: { gymId: INTAKE },
      }).expect(400);

      expect(prisma.photoIntake.create).not.toHaveBeenCalled();
      expect(res.body.details.issues[0].path).toMatch(/^context/);
    });

    it('refuses a fifth photo (maxPhotos 4)', async () => {
      storeIntake(intakeRow());
      prisma.storageObject.findUnique.mockResolvedValue({
        id: INTAKE,
        name: 'scale.jpg',
        status: 'ready',
        mimeType: 'image/jpeg',
        size: BigInt(1024),
        uploadedById: HARNESS_USER,
      });
      prisma.photoIntakePhoto.count.mockResolvedValue(4);

      const res = await call('post', `/api/intakes/${INTAKE}/photos`, contributor, {
        storageObjectId: '55555555-5555-4555-8555-555555555555',
      }).expect(400);

      expect(res.body.details).toMatchObject({ reason: 'TOO_MANY_PHOTOS', maxPhotos: 4 });
    });

    it('analyze queues an ai.health.body_metric_reading job for the intake', async () => {
      storeIntake(intakeRow());
      prisma.photoIntakePhoto.count.mockResolvedValue(1);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      prisma.job.create.mockImplementation(async (args: any) => ({ id: JOB, status: 'pending', ...args.data }));

      await call('post', `/api/intakes/${INTAKE}/analyze`, contributor, { provider: 'openai', modelId: HARNESS_MODEL }).expect(
        202,
      );

      expect(prisma.job.create.mock.calls[0][0].data).toMatchObject({
        type: 'ai.health.body_metric_reading',
        subjectType: 'photo_intake',
        subjectId: INTAKE,
        payload: { intakeId: INTAKE },
      });
    });

    it('analyze is refused for a viewer (no ai:use) and while AI is off', async () => {
      storeIntake(intakeRow());

      const denied = await call('post', `/api/intakes/${INTAKE}/analyze`, viewer, { provider: 'openai', modelId: HARNESS_MODEL });
      expect(denied.status).toBe(403);
      expect(denied.body.message).toContain('ai:use');

      t.harness.setPolicy({ enabled: false });
      const off = await call('post', `/api/intakes/${INTAKE}/analyze`, contributor, {
        provider: 'openai',
        modelId: HARNESS_MODEL,
      }).expect(403);
      expect(off.body.details.reason).toBe('AI_DISABLED');
      expect(prisma.job.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------

  describe('PDFs (H2, #186)', () => {
    const PHOTO_ROW = '99999999-9999-4999-8999-999999999999';

    /** A stored object in the harness storage, and its row as the mocked Prisma returns it. */
    function storePdf(bytes: Buffer, overrides: Record<string, unknown> = {}) {
      const stored = t.harness.storage.addObject({
        uploadedById: HARNESS_USER,
        mimeType: 'application/pdf',
        name: 'scale-report.pdf',
        bytes,
      });
      const row = {
        id: stored.id,
        name: stored.name,
        status: 'ready',
        mimeType: 'application/pdf',
        size: stored.size,
        storageKey: stored.storageKey,
        uploadedById: HARNESS_USER,
        ...overrides,
      };
      prisma.storageObject.findUnique.mockResolvedValue(row);
      return row;
    }

    const attach = (storageObjectId: string) =>
      call('post', `/api/intakes/${INTAKE}/photos`, contributor, { storageObjectId });

    beforeEach(() => {
      storeIntake(intakeRow());
      prisma.photoIntakePhoto.count.mockResolvedValue(0);
      prisma.photoIntakePhoto.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      prisma.photoIntakePhoto.create.mockImplementation(async ({ data }: any) => ({
        id: PHOTO_ROW,
        createdAt: new Date(),
        storageObject: { name: 'scale-report.pdf' },
        ...data,
      }));
      prisma.healthDocument.create.mockImplementation(async ({ data }: any) => ({
        id: 'doc-1',
        storageObjectId: data.storageObjectId,
        retention: data.retention,
      }));
    });

    it('attaches a PDF to body_metric_reading; its health document records application/pdf', async () => {
      const row = storePdf(plainPdf(2));

      const res = await attach(row.id).expect(201);

      expect(res.body.data).toMatchObject({ storageObjectId: row.id, healthDocumentId: 'doc-1', retention: 'keep' });
      expect(prisma.healthDocument.create.mock.calls[0][0].data).toMatchObject({
        kind: 'body_metric',
        mimeType: 'application/pdf',
        storageObjectId: row.id,
      });
    });

    it.each([
      ['a PDF over the 20-page cap', () => plainPdf(21), {}, 'TOO_MANY_PAGES'],
      ['a text file renamed to .pdf', () => Buffer.from('these are not the bytes of a PDF'), {}, 'UNSUPPORTED_MEDIA_TYPE'],
      ['a PDF over 50 MiB', () => plainPdf(1), { size: BigInt(51 * 1024 * 1024) }, 'OBJECT_TOO_LARGE'],
      ['a PDF with no readable page', () => Buffer.from('%PDF-1.7\n%%EOF\n'), {}, 'PDF_UNREADABLE'],
    ])('refuses %s with 400, before any provider call and with nothing stored', async (_label, bytes, overrides, reason) => {
      const row = storePdf(bytes(), overrides);

      const res = await attach(row.id).expect(400);

      expect(res.body.details.reason).toBe(reason);
      expect(prisma.photoIntakePhoto.create).not.toHaveBeenCalled();
      expect(prisma.healthDocument.create).not.toHaveBeenCalled();
      expect(t.harness.fake.calls).toEqual([]);
    });

    describe('analyze', () => {
      let pdf: ReturnType<typeof storePdf>;

      beforeEach(() => {
        pdf = storePdf(plainPdf(3));
        prisma.photoIntakePhoto.count.mockResolvedValue(1);
        prisma.photoIntakePhoto.findMany.mockResolvedValue([
          { storageObjectId: pdf.id, storageObject: { mimeType: pdf.mimeType, size: pdf.size, storageKey: pdf.storageKey } },
        ]);
        prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
        prisma.job.create.mockImplementation(async (args: any) => ({ id: JOB, status: 'pending', ...args.data }));
      });

      it('queues the job for a model with file input', async () => {
        await call('post', `/api/intakes/${INTAKE}/analyze`, contributor, {}).expect(202);

        expect(prisma.job.create).toHaveBeenCalledTimes(1);
      });

      it('a model without file_input: the typed, user-readable 400, no job and no provider request', async () => {
        const findUnique = t.harness.prisma.aiModel.findUnique as jest.Mock;
        const original = findUnique.getMockImplementation()!;
        findUnique.mockImplementation(async (args: any) => {
          const row = await original(args);
          return row && row.capabilities
            ? {
                ...row,
                capabilities: {
                  ...row.capabilities,
                  capabilities: row.capabilities.capabilities.filter((c: string) => c !== 'file_input'),
                  inputModalities: ['text', 'image'],
                },
              }
            : row;
        });

        try {
          const res = await call('post', `/api/intakes/${INTAKE}/analyze`, contributor, {}).expect(400);

          expect(res.body.message).toBe("Your AI model can't read PDFs; choose a model with file input or upload an image.");
          expect(res.body.details).toMatchObject({
            reason: 'AI_CAPABILITY_UNSUPPORTED',
            capability: 'file_input',
            inputKind: 'pdf',
          });
          expect(prisma.photoIntake.updateMany).not.toHaveBeenCalled();
          expect(prisma.job.create).not.toHaveBeenCalled();
          expect(t.harness.fake.calls).toEqual([]);
        } finally {
          findUnique.mockImplementation(original);
        }
      });
    });

    it('the job sends the PDF to the fake provider as one file input and stores the drafts', async () => {
      const stored = t.harness.storage.addObject({
        uploadedById: HARNESS_USER,
        mimeType: 'application/pdf',
        name: 'scale-report.pdf',
        bytes: plainPdf(2),
      });

      await runHandler('smart-scale-report', [stored.id], 'application/pdf');

      expect(t.harness.fake.calls).toHaveLength(1);
      const [fakeCall] = t.harness.fake.calls;
      expect(fakeCall.storageInputs?.map((input) => [input.storageObjectId, input.modality])).toEqual([[stored.id, 'file']]);
      const content = (fakeCall.request?.input as any)[0].content;
      expect(content).toContainEqual({ type: 'file', storageObjectId: stored.id });
      expect(content).toContainEqual({ type: 'text', text: 'Photo 1 (PDF document):' });

      const { data } = prisma.draftItem.createMany.mock.calls[0][0];
      expect(data.map((item: any) => [item.value.metricKey, item.value.value, item.sourcePhotoIds])).toEqual([
        ['weight', 82.3, [stored.id]],
        ['body_fat_pct', 21.4, [stored.id]],
      ]);

      // The presigned URL the provider was handed never lands in a stored row.
      const url = fakeCall.storageInputs?.[0].url;
      const writes = JSON.stringify([prisma.draftItem.createMany.mock.calls, prisma.photoIntake.updateMany.mock.calls]);
      if (url) expect(writes).not.toContain(url);
    });
  });

  // ---------------------------------------------------------------------------

  describe('the job against the fake provider', () => {
    it('scale photo: one pending AI draft, photos sent as storage inputs, nothing written to measurements', async () => {
      const photo = addPhoto();

      await runHandler('scale-display', [photo]);

      expect(t.harness.fake.calls).toHaveLength(1);
      const [fakeCall] = t.harness.fake.calls;
      expect(fakeCall.request?.structuredOutput?.name).toBe('body_metric_reading');
      expect(fakeCall.storageInputs?.map((input) => [input.storageObjectId, input.modality])).toEqual([[photo, 'image']]);

      const { data } = prisma.draftItem.createMany.mock.calls[0][0];
      expect(data).toEqual([
        expect.objectContaining({
          intakeId: INTAKE,
          kind: 'reading',
          origin: 'ai',
          status: 'pending',
          confidence: 'high',
          uncertain: false,
          userVerified: false,
          sourcePhotoIds: [photo],
          value: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
        }),
      ]);
      expect(prisma.photoIntake.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INTAKE, status: 'scanning' },
          data: expect.objectContaining({ status: 'ready', resultMeta: expect.objectContaining({ promptVersion: 2 }) }),
        }),
      );
      expect(prisma.measurement.create).not.toHaveBeenCalled();

      // The presigned URL the provider was handed never lands in a stored row.
      const url = fakeCall.storageInputs?.[0].url;
      expect(url).toBeTruthy();
      const writes = JSON.stringify([
        prisma.draftItem.createMany.mock.calls,
        prisma.photoIntake.updateMany.mock.calls,
      ]);
      expect(writes).not.toContain(url);
    });

    it('cuff photo: systolic, diastolic and an uncertain pulse', async () => {
      await runHandler('bp-cuff', [addPhoto()]);

      const { data } = prisma.draftItem.createMany.mock.calls[0][0];
      expect(data.map((d: any) => [d.value.metricKey, d.uncertain])).toEqual([
        ['bp_systolic', false],
        ['bp_diastolic', false],
        ['resting_hr', true],
      ]);
      expect(data[2].uncertaintyNote).toBe('Pulse from a blood-pressure cuff may not be a resting rate');
    });

    it('out-of-range reading: kept, low confidence, uncertain, with the range note', async () => {
      await runHandler('out-of-range', [addPhoto()]);

      const { data } = prisma.draftItem.createMany.mock.calls[0][0];
      expect(data).toEqual([
        expect.objectContaining({
          confidence: 'low',
          uncertain: true,
          uncertaintyNote: 'Outside the usual range for weight',
          value: { metricKey: 'weight', value: 9999, unit: 'kg', method: 'scale' },
        }),
      ]);
    });

    it('unreadable photo: no items, resultMeta.unreadable', async () => {
      await runHandler('unreadable', [addPhoto()]);

      expect(prisma.draftItem.createMany).not.toHaveBeenCalled();
      expect(prisma.photoIntake.updateMany.mock.calls[0][0].data.resultMeta).toMatchObject({ unreadable: true });
    });

    it('kill switch: zero provider calls, intake failed with AI_DISABLED', async () => {
      t.harness.setPolicy({ enabled: false });

      await runHandler('scale-display', [addPhoto()]);

      expect(t.harness.fake.calls).toEqual([]);
      expect(prisma.draftItem.createMany).not.toHaveBeenCalled();
      expect(prisma.photoIntake.updateMany).toHaveBeenCalledWith({
        where: { id: INTAKE, status: 'scanning' },
        data: expect.objectContaining({ status: 'failed', errorCode: 'AI_DISABLED' }),
      });
    });

    it('a model answer that does not fit the schema fails the intake with AI_STRUCTURED_OUTPUT_INVALID', async () => {
      const photo = addPhoto();
      const handler = t.context.app.get(JobHandlerRegistry).get('ai.health.body_metric_reading')!;
      prisma.photoIntake.findUnique.mockResolvedValue({
        ...intakeRow({ status: 'scanning', provider: 'openai', modelId: HARNESS_MODEL }),
        photos: [{ storageObjectId: photo }],
      });
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      t.script([{ outputText: '{"readable": true}' }]);

      await expect(handler.process({ id: JOB, payload: { intakeId: INTAKE } } as never)).resolves.toBeUndefined();

      expect(prisma.photoIntake.updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'failed',
        errorCode: 'AI_STRUCTURED_OUTPUT_INVALID',
      });
    });
  });

  // ---------------------------------------------------------------------------

  describe('review', () => {
    beforeEach(() => storeIntake(intakeRow({ status: 'ready' })));

    it('editing an AI item to an out-of-range value is a 400 naming value.value; nothing is stored', async () => {
      prisma.draftItem.findFirst.mockResolvedValue(itemRow({ status: 'pending', userVerified: false }));

      const res = await call('patch', `/api/intakes/${INTAKE}/items/${ITEM}`, contributor, {
        value: { metricKey: 'weight', value: 9999, unit: 'kg' },
      }).expect(400);

      expect(res.body.details.issues).toEqual([{ path: 'value.value', message: expect.any(String) }]);
      expect(JSON.stringify(res.body)).not.toContain('9999');
      expect(prisma.draftItem.update).not.toHaveBeenCalled();
    });

    it('"Add missing item" with a unit the metric does not allow is a 400 naming value.unit', async () => {
      const res = await call('post', `/api/intakes/${INTAKE}/items`, contributor, {
        kind: 'reading',
        value: { metricKey: 'resting_hr', value: 60, unit: 'kg' },
      }).expect(400);

      expect(res.body.details.issues).toEqual([{ path: 'value.unit', message: expect.any(String) }]);
      expect(prisma.draftItem.create).not.toHaveBeenCalled();
    });

    it('"Add missing item" stores a user item with the unit spelling fixed', async () => {
      prisma.draftItem.aggregate.mockResolvedValue({ _max: { sortOrder: 2 } });
      prisma.draftItem.create.mockImplementation(async ({ data }: any) => itemRow({ ...data, id: ITEM_2 }));

      const res = await call('post', `/api/intakes/${INTAKE}/items`, contributor, {
        kind: 'reading',
        value: { metricKey: 'bp_systolic', value: 128, unit: 'MMHG' },
      }).expect(201);

      expect(res.body.data).toMatchObject({
        origin: 'user',
        status: 'accepted',
        value: { metricKey: 'bp_systolic', value: 128, unit: 'mmHg' },
      });
    });

    it('refuses a wrong item kind', async () => {
      await call('post', `/api/intakes/${INTAKE}/items`, contributor, {
        kind: 'equipment',
        value: { metricKey: 'weight', value: 80, unit: 'kg' },
      }).expect(400);
    });
  });

  // ---------------------------------------------------------------------------

  describe('apply', () => {
    const apply = (token = contributor) => call('post', `/api/intakes/${INTAKE}/apply`, token);

    function ready(accepted: ReturnType<typeof itemRow>[]) {
      storeIntake(intakeRow({ status: 'ready' }));
      prisma.draftItem.count.mockResolvedValue(0);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      prisma.draftItem.findMany.mockResolvedValue(accepted);
    }

    const created = () => prisma.measurement.create.mock.calls.map(([arg]: any) => arg.data);

    it('saves one entry with server-derived provenance: edited AI, unedited AI and a hand-added item', async () => {
      const photo = '55555555-5555-4555-8555-555555555555';
      const document = '77777777-7777-4777-8777-777777777777';
      // The intake's health documents (H1): read for provenance, then for the
      // file states of the new rows (kept: not deleted), then for the purge
      // (none: every file is kept).
      prisma.healthDocument.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.id) return [{ id: document, fileDeletedAt: null }];
        if (args?.where?.retention) return [];
        return [{ id: document, storageObjectId: photo }];
      });
      ready([
        itemRow({
          sourcePhotoIds: [photo],
          value: { metricKey: 'weight', value: 207.4, unit: 'lb', method: 'scale' },
          originalAiValue: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
        }),
        itemRow({ id: ITEM_2, sourcePhotoIds: [photo], value: { metricKey: 'body_fat_pct', value: 22.5, unit: '%' } }),
        itemRow({
          id: '44444444-4444-4444-8444-444444444446',
          origin: 'user',
          confidence: null,
          value: { metricKey: 'waist_circumference', value: 34, unit: 'in' },
        }),
      ]);

      const res = await apply().expect(200);

      expect(res.body.data).toEqual({
        entryId: expect.any(String),
        items: [
          expect.objectContaining({ metricKey: 'weight', value: 94.0751, unit: 'kg', origin: 'ai' }),
          expect.objectContaining({ metricKey: 'body_fat_pct', value: 22.5, origin: 'ai' }),
          expect.objectContaining({ metricKey: 'waist_circumference', value: 86.36, unit: 'cm', origin: 'manual' }),
        ],
      });
      const [weight, fat, waist] = created();
      expect(weight.sourceRef).toEqual({
        kind: 'photo_intake',
        intakeId: INTAKE,
        draftItemId: ITEM,
        storageObjectIds: [photo],
        aiDraft: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
        confidence: 'high',
        userEdited: true,
        healthDocumentId: document,
      });
      expect(fat.sourceRef).toMatchObject({ draftItemId: ITEM_2, userEdited: false, aiDraft: { value: 22.5 } });
      expect(waist.sourceRef).toEqual({ kind: 'photo_intake', intakeId: INTAKE, healthDocumentId: document });
      expect(res.body.data.items.map((item: any) => item.fileDeleted)).toEqual([false, false, false]);
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it('systolic without diastolic: 400 "Enter both blood pressure numbers", nothing written', async () => {
      ready([itemRow({ value: { metricKey: 'bp_systolic', value: 128, unit: 'mmHg' } })]);

      const res = await apply().expect(400);

      expect(res.body.message).toBe('Enter both blood pressure numbers');
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('an unresolved out-of-range AI reading: 400 naming the item field', async () => {
      ready([itemRow({ confidence: 'low', uncertain: true, value: { metricKey: 'weight', value: 9999, unit: 'kg' } })]);

      const res = await apply().expect(400);

      expect(res.body.details.issues).toEqual([{ path: `items.${ITEM}.value.value`, message: expect.any(String) }]);
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('the same metric accepted twice: 400 asking to reject one', async () => {
      ready([itemRow(), itemRow({ id: ITEM_2, value: { metricKey: 'weight', value: 209, unit: 'lb' } })]);

      const res = await apply().expect(400);

      expect(res.body.message).toContain('more than once');
    });

    it("another user's intake is a 404", async () => {
      storeIntake(intakeRow({ userId: HARNESS_OTHER_USER, status: 'ready' }));

      await apply().expect(404);
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('a second apply is 409 ALREADY_APPLIED and writes nothing', async () => {
      storeIntake(intakeRow({ status: 'applied' }));

      const res = await apply().expect(409);

      expect(res.body.details.reason).toBe('ALREADY_APPLIED');
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('every item rejected: 200 with a null entry, nothing written', async () => {
      ready([]);

      const res = await apply().expect(200);

      expect(res.body.data).toEqual({ entryId: null, items: [] });
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------

  describe('health permissions (the kind requires health_data:* on top of intakes:*)', () => {
    const NO_HEALTH = '12121212-1212-4121-8121-121212121212';
    let noHealth: string;

    const stubKind: IntakeKind = {
      kind: 'test_other_kind',
      contextSchema: z.undefined(),
      valueSchema: z.object({ name: z.string() }).strict(),
      analyzeJobType: null,
      apply: async ({ accepted }) => ({ applied: accepted.length }),
    };

    beforeAll(() => {
      t.context.app.get(IntakeKindRegistry).register(stubKind);
    });

    beforeEach(async () => {
      noHealth = (await createMockTestUser(t.context, { id: NO_HEALTH, roleName: 'contributor' })).accessToken;
      // Same contributor, minus every `health_data:*` permission, through the
      // real resolution path (JWT strategy -> user row -> role permissions).
      const resolve = prisma.user.findUnique.getMockImplementation();
      prisma.user.findUnique.mockImplementation(async (args: any) => {
        const user = await resolve(args);
        if (user?.id !== NO_HEALTH) return user;
        return {
          ...user,
          userRoles: user.userRoles.map((userRole: any) => ({
            ...userRole,
            role: {
              ...userRole.role,
              rolePermissions: userRole.role.rolePermissions.filter(
                (rp: any) => !rp.permission.name.startsWith('health_data:'),
              ),
            },
          })),
        };
      });
    });

    const expectKindDenied = (res: request.Response, permission: string) => {
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(`Missing permissions: ${permission}`);
      expect(res.body.details).toMatchObject({
        reason: 'MISSING_KIND_PERMISSIONS',
        kind: 'body_metric_reading',
        permissions: [permission],
      });
    };

    it('the caller still holds intakes:write (so the refusal is the kind, not the route)', async () => {
      prisma.photoIntake.create.mockResolvedValue({ ...intakeRow({ kind: 'test_other_kind' }), photos: [], items: [] });
      await call('post', '/api/intakes', noHealth, { kind: 'test_other_kind' }).expect(201);
    });

    it('create is 403 without health_data:write, and nothing is stored', async () => {
      const res = await call('post', '/api/intakes', noHealth, { kind: 'body_metric_reading' });

      expectKindDenied(res, 'health_data:write');
      expect(prisma.photoIntake.create).not.toHaveBeenCalled();
    });

    it('apply is 403 without health_data:write, before any write', async () => {
      storeIntake(intakeRow({ userId: NO_HEALTH, status: 'ready' }));
      prisma.draftItem.findMany.mockResolvedValue([itemRow()]);

      const res = await call('post', `/api/intakes/${INTAKE}/apply`, noHealth);

      expectKindDenied(res, 'health_data:write');
      expect(prisma.photoIntake.updateMany).not.toHaveBeenCalled();
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('item edits and analyze are 403 too', async () => {
      storeIntake(intakeRow({ userId: NO_HEALTH, status: 'ready' }));
      prisma.draftItem.findFirst.mockResolvedValue(itemRow());

      expectKindDenied(
        await call('patch', `/api/intakes/${INTAKE}/items/${ITEM}`, noHealth, { status: 'accepted' }),
        'health_data:write',
      );
      expectKindDenied(
        await call('post', `/api/intakes/${INTAKE}/analyze`, noHealth, { provider: 'openai', modelId: HARNESS_MODEL }),
        'health_data:write',
      );
      expect(prisma.draftItem.update).not.toHaveBeenCalled();
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it('reading one is 403 without health_data:read; the list hides the kind, and naming it is 403', async () => {
      storeIntake(intakeRow({ userId: NO_HEALTH, status: 'ready' }));
      prisma.photoIntake.findFirst.mockImplementation(async () => ({ ...intakeRow({ userId: NO_HEALTH }), photos: [], items: [] }));

      expectKindDenied(await call('get', `/api/intakes/${INTAKE}`, noHealth), 'health_data:read');

      prisma.photoIntake.findMany.mockResolvedValue([]);
      await call('get', '/api/intakes', noHealth).expect(200);
      expect(prisma.photoIntake.findMany.mock.calls.at(-1)[0].where).toMatchObject({
        userId: NO_HEALTH,
        kind: { notIn: ['body_metric_reading'] },
      });

      expectKindDenied(await call('get', '/api/intakes?kind=body_metric_reading', noHealth), 'health_data:read');
    });

    it('other kinds are unaffected: create and apply work without health_data:*', async () => {
      storeIntake(intakeRow({ userId: NO_HEALTH, kind: 'test_other_kind', status: 'ready' }));
      prisma.draftItem.count.mockResolvedValue(0);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      prisma.draftItem.findMany.mockResolvedValue([]);

      const res = await call('post', `/api/intakes/${INTAKE}/apply`, noHealth).expect(200);

      expect(res.body.data).toEqual({ applied: 0 });
    });

    it('a contributor (who holds health_data:*) is not affected', async () => {
      prisma.photoIntake.create.mockResolvedValue({ ...intakeRow(), photos: [], items: [] });
      await call('post', '/api/intakes', contributor, { kind: 'body_metric_reading' }).expect(201);
    });
  });

  it('POST /api/measurements still refuses client-supplied provenance', async () => {
    await call('post', '/api/measurements', contributor, {
      readings: [{ metricKey: 'weight', value: 80 }],
      origin: 'ai',
      sourceRef: { kind: 'photo_intake' },
    }).expect(400);
  });
});
