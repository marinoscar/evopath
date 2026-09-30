import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import { z } from 'zod';

import type { IntakeKind } from './intake-kind.interface';
import { IntakeKindRegistry } from './intake-kind.registry';
import { stubFeatureResolver } from '../ai/testing/feature-resolver.stub';
import { IntakeService } from './intake.service';
import { StorageObjectReferences } from './storage-object-references';

// =============================================================================
// IntakeService — the provenance and state invariants, over a mocked Prisma
// =============================================================================
//
// A TEST-ONLY stub kind (`test_stub`) stands in for a real consumer: it has a
// strict value schema, one item kind, a small photo cap and an `apply` that
// records what it was given. Real-row semantics (cascades, the unique photo
// link, concurrent writers, rollback) are proven in
// `test/intake/intakes.db.spec.ts`.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const INTAKE = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const OBJECT = '55555555-5555-4555-8555-555555555555';

const valueSchema = z.object({ name: z.string().min(1).max(100), count: z.number().int().min(0).optional() }).strict();
type StubValue = z.infer<typeof valueSchema>;

function stubKind(overrides: Partial<IntakeKind<unknown, StubValue>> = {}): IntakeKind<unknown, StubValue> {
  return {
    kind: 'test_stub',
    contextSchema: z.object({ label: z.string().max(20) }).strict().optional(),
    valueSchema,
    analyzeJobType: 'test.intake.analyze',
    aiFeature: 'gym_scan',
    maxPhotos: 3,
    itemKinds: ['thing'],
    normalizeValue: (value) => ({ ...value, name: value.name.trim() }),
    apply: jest.fn(async ({ accepted }) => ({ applied: accepted.length })),
    ...overrides,
  };
}

function intakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTAKE,
    userId: USER,
    kind: 'test_stub',
    status: 'ready',
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
    kind: 'thing',
    origin: 'ai',
    status: 'pending',
    confidence: 'low',
    uncertain: false,
    uncertaintyNote: null,
    sourcePhotoIds: [OBJECT],
    userVerified: false,
    value: { name: 'Leg press' },
    originalAiValue: null,
    sortOrder: 0,
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    updatedAt: new Date('2026-09-29T10:00:00.000Z'),
    ...overrides,
  };
}

function reasonOf(error: unknown): string | undefined {
  const response = (error as { getResponse?: () => unknown }).getResponse?.() as { details?: { reason?: string } };
  return response?.details?.reason;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('IntakeService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let registry: IntakeKindRegistry;
  let jobs: { enqueueWithin: jest.Mock };
  let usableModels: { assertUsable: jest.Mock };
  let objects: { delete: jest.Mock };
  let features: ReturnType<typeof stubFeatureResolver>;
  let service: IntakeService;
  let references: StorageObjectReferences;
  let kind: IntakeKind<unknown, StubValue>;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    registry = new IntakeKindRegistry();
    kind = stubKind();
    registry.register(kind);
    jobs = { enqueueWithin: jest.fn(async () => ({ id: '66666666-6666-4666-8666-666666666666' })) };
    usableModels = { assertUsable: jest.fn(async () => ({})) };
    objects = { delete: jest.fn(async () => undefined) };
    features = stubFeatureResolver({ provider: 'openai', modelId: 'vision-1' });
    references = new StorageObjectReferences();
    service = new IntakeService(
      prisma as never,
      registry,
      jobs as never,
      usableModels as never,
      objects as never,
      features as never,
      references,
    );
  });

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  describe('create', () => {
    it('refuses an unregistered kind with 400 UNKNOWN_INTAKE_KIND', async () => {
      const error = await caught(service.create(USER, { kind: 'nope' }));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(reasonOf(error)).toBe('UNKNOWN_INTAKE_KIND');
      expect(prisma.photoIntake.create).not.toHaveBeenCalled();
    });

    it("validates context with the kind's schema and names the field under details.issues", async () => {
      const error = (await caught(service.create(USER, { kind: 'test_stub', context: { label: 5 } }))) as BadRequestException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error.getResponse() as any).details.issues[0].path).toBe('context.label');
    });

    it("runs the kind's assertContext and stops on its refusal", async () => {
      registry.register(
        stubKind({
          assertContext: async () => {
            throw new NotFoundException('Gym not found');
          },
        }),
      );

      await expect(service.create(USER, { kind: 'test_stub', context: { label: 'x' } })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.photoIntake.create).not.toHaveBeenCalled();
    });

    it('creates a draft intake owned by the caller', async () => {
      prisma.photoIntake.create.mockResolvedValue({ ...intakeRow({ status: 'draft' }), photos: [], items: [] } as never);

      const view = await service.create(USER, { kind: 'test_stub', context: { label: 'x' } });

      expect(prisma.photoIntake.create.mock.calls[0][0].data).toMatchObject({
        userId: USER,
        kind: 'test_stub',
        status: 'draft',
        context: { label: 'x' },
      });
      expect(view).toMatchObject({ id: INTAKE, status: 'draft', photos: [], items: [] });
    });

    it("takes the subject from the kind's subjectOf over what the client sent", async () => {
      registry.register(
        stubKind({ subjectOf: (context: any) => ({ subjectType: 'gym', subjectId: `gym-of-${context.label}` }) }),
      );
      prisma.photoIntake.create.mockResolvedValue({ ...intakeRow({ status: 'draft' }), photos: [], items: [] } as never);

      await service.create(USER, {
        kind: 'test_stub',
        context: { label: 'x' },
        subjectType: 'other',
        subjectId: '99999999-9999-4999-8999-999999999999',
      });

      expect(prisma.photoIntake.create.mock.calls[0][0].data).toMatchObject({
        subjectType: 'gym',
        subjectId: 'gym-of-x',
      });
    });

    it('keeps the client-sent subject for a kind without subjectOf', async () => {
      prisma.photoIntake.create.mockResolvedValue({ ...intakeRow({ status: 'draft' }), photos: [], items: [] } as never);

      await service.create(USER, { kind: 'test_stub', subjectType: 'gym', subjectId: '99999999-9999-4999-8999-999999999999' });

      expect(prisma.photoIntake.create.mock.calls[0][0].data).toMatchObject({
        subjectType: 'gym',
        subjectId: '99999999-9999-4999-8999-999999999999',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Ownership
  // ---------------------------------------------------------------------------

  describe('ownership', () => {
    beforeEach(() => {
      prisma.photoIntake.findFirst.mockResolvedValue(null);
    });

    it.each([
      ['get', (s: IntakeService) => s.get(USER, INTAKE)],
      ['discard', (s: IntakeService) => s.discard(USER, INTAKE)],
      ['attachPhoto', (s: IntakeService) => s.attachPhoto(USER, INTAKE, OBJECT)],
      ['detachPhoto', (s: IntakeService) => s.detachPhoto(USER, INTAKE, OBJECT)],
      ['analyze', (s: IntakeService) => s.analyze(USER, INTAKE, { provider: 'openai', modelId: 'm' })],
      ['addItem', (s: IntakeService) => s.addItem(USER, INTAKE, { kind: 'thing', value: { name: 'x' } })],
      ['updateItem', (s: IntakeService) => s.updateItem(USER, INTAKE, ITEM, { status: 'accepted' })],
      ['deleteItem', (s: IntakeService) => s.deleteItem(USER, INTAKE, ITEM)],
      ['acceptAll', (s: IntakeService) => s.acceptAll(USER, INTAKE)],
      ['apply', (s: IntakeService) => s.apply(USER, INTAKE)],
    ])('%s answers 404 for an intake the caller does not own, filtering by userId', async (_name, call) => {
      await expect(call(service)).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.photoIntake.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: INTAKE, userId: USER }) }),
      );
    });

    it('list filters by the caller and the given statuses, newest first', async () => {
      prisma.photoIntake.findMany.mockResolvedValue([]);

      await service.list(USER, { status: ['draft', 'ready'], limit: 20 });

      expect(prisma.photoIntake.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER, status: { in: ['draft', 'ready'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------------

  describe('attachPhoto', () => {
    const readyImage = {
      id: OBJECT,
      name: 'machine.jpg',
      status: 'ready',
      mimeType: 'image/jpeg',
      size: BigInt(1024),
      uploadedById: USER,
    };

    beforeEach(() => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status: 'draft' }) as never);
      prisma.photoIntakePhoto.count.mockResolvedValue(0);
      prisma.photoIntakePhoto.aggregate.mockResolvedValue({ _max: { sortOrder: null } } as never);
    });

    it("answers 404 for another user's object", async () => {
      prisma.storageObject.findUnique.mockResolvedValue({ ...readyImage, uploadedById: 'someone-else' } as never);

      await expect(service.attachPhoto(USER, INTAKE, OBJECT)).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['a non-ready object', { status: 'processing' }, 'OBJECT_NOT_READY'],
      ['a non-image object', { mimeType: 'application/pdf' }, 'UNSUPPORTED_MEDIA_TYPE'],
      ['a 21 MiB object', { size: BigInt(21 * 1024 * 1024) }, 'OBJECT_TOO_LARGE'],
    ])('refuses %s with 400', async (_label, override, reason) => {
      prisma.storageObject.findUnique.mockResolvedValue({ ...readyImage, ...override } as never);

      const error = await caught(service.attachPhoto(USER, INTAKE, OBJECT));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(reasonOf(error)).toBe(reason);
      expect(prisma.photoIntakePhoto.create).not.toHaveBeenCalled();
    });

    it("refuses the photo past the kind's cap with 400 TOO_MANY_PHOTOS", async () => {
      prisma.storageObject.findUnique.mockResolvedValue(readyImage as never);
      prisma.photoIntakePhoto.count.mockResolvedValue(3);

      const error = await caught(service.attachPhoto(USER, INTAKE, OBJECT));

      expect(reasonOf(error)).toBe('TOO_MANY_PHOTOS');
    });

    it('maps the unique (intakeId, storageObjectId) violation to 409 DUPLICATE_PHOTO', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(readyImage as never);
      prisma.photoIntakePhoto.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' }),
      );

      const error = await caught(service.attachPhoto(USER, INTAKE, OBJECT));

      expect(error).toBeInstanceOf(ConflictException);
      expect(reasonOf(error)).toBe('DUPLICATE_PHOTO');
    });

    it.each(['scanning', 'applied'])('refuses to attach while the intake is %s (409)', async (status) => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status }) as never);

      await expect(service.attachPhoto(USER, INTAKE, OBJECT)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('detachPhoto and discard', () => {
    it('keeps an object another consumer still references (e.g. a gym photo), on detach and on discard', async () => {
      const isReferenced = jest.fn(async (id: string) => id === OBJECT);
      references.register({ name: 'test_consumer', isReferenced });
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
      prisma.photoIntakePhoto.deleteMany.mockResolvedValue({ count: 1 });
      prisma.photoIntakePhoto.count.mockResolvedValue(0);
      prisma.photoIntakePhoto.findMany.mockResolvedValue([
        { storageObjectId: OBJECT },
        { storageObjectId: 'other-object' },
      ] as never);
      prisma.photoIntake.deleteMany.mockResolvedValue({ count: 1 });

      await service.detachPhoto(USER, INTAKE, OBJECT);
      expect(objects.delete).not.toHaveBeenCalled();

      await service.discard(USER, INTAKE);
      expect(isReferenced).toHaveBeenCalledWith(OBJECT);
      expect(objects.delete).toHaveBeenCalledTimes(1);
      expect(objects.delete).toHaveBeenCalledWith('other-object', USER);
    });

    it('keeps the object when a reference checker fails (the safe side of best effort)', async () => {
      references.register({
        name: 'broken',
        isReferenced: async () => {
          throw new Error('db down');
        },
      });
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
      prisma.photoIntakePhoto.deleteMany.mockResolvedValue({ count: 1 });
      prisma.photoIntakePhoto.count.mockResolvedValue(0);

      await service.detachPhoto(USER, INTAKE, OBJECT);

      expect(objects.delete).not.toHaveBeenCalled();
    });

    it('deletes the storage object once no intake links it', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
      prisma.photoIntakePhoto.deleteMany.mockResolvedValue({ count: 1 });
      prisma.photoIntakePhoto.count.mockResolvedValue(0);

      await service.detachPhoto(USER, INTAKE, OBJECT);

      expect(objects.delete).toHaveBeenCalledWith(OBJECT, USER);
    });

    it('keeps a storage object another intake still links', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
      prisma.photoIntakePhoto.deleteMany.mockResolvedValue({ count: 1 });
      prisma.photoIntakePhoto.count.mockResolvedValue(1);

      await service.detachPhoto(USER, INTAKE, OBJECT);

      expect(objects.delete).not.toHaveBeenCalled();
    });

    it('a failing storage delete is best effort: discard still succeeds', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
      prisma.photoIntakePhoto.findMany.mockResolvedValue([{ storageObjectId: OBJECT }] as never);
      prisma.photoIntake.deleteMany.mockResolvedValue({ count: 1 });
      prisma.photoIntakePhoto.count.mockResolvedValue(0);
      objects.delete.mockRejectedValue(new Error('provider down'));

      await expect(service.discard(USER, INTAKE)).resolves.toBeUndefined();
      expect(objects.delete).toHaveBeenCalledWith(OBJECT, USER);
    });

    it('refuses to discard an applied intake with 409 ALREADY_APPLIED', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status: 'applied' }) as never);

      const error = await caught(service.discard(USER, INTAKE));

      expect(reasonOf(error)).toBe('ALREADY_APPLIED');
      expect(prisma.photoIntake.deleteMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Analyze
  // ---------------------------------------------------------------------------

  describe('analyze', () => {
    beforeEach(() => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status: 'draft' }) as never);
      prisma.photoIntakePhoto.count.mockResolvedValue(2);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
    });

    it("resolves the kind's feature model, re-checks it for vision and structured output, then flips to scanning and enqueues the kind's job in one transaction", async () => {
      const started = await service.analyze(USER, INTAKE, {});

      expect(features.resolve).toHaveBeenCalledWith(USER, 'gym_scan');
      expect(usableModels.assertUsable).toHaveBeenCalledWith(USER, 'openai', 'vision-1', [
        'vision_input',
        'structured_output',
      ]);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.photoIntake.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: INTAKE, userId: USER },
        data: { status: 'scanning', provider: 'openai', modelId: 'vision-1' },
      });
      expect(jobs.enqueueWithin).toHaveBeenCalledWith(prisma, {
        type: 'test.intake.analyze',
        reason: 'upload',
        subjectType: 'photo_intake',
        subjectId: INTAKE,
        payload: { intakeId: INTAKE },
      });
      expect(prisma.photoIntake.update).toHaveBeenCalledWith({
        where: { id: INTAKE },
        data: { jobId: '66666666-6666-4666-8666-666666666666' },
      });
      expect(started).toEqual({ intakeId: INTAKE, jobId: '66666666-6666-4666-8666-666666666666' });
    });

    it('refuses a model the gate refuses, and queues nothing', async () => {
      usableModels.assertUsable.mockRejectedValue(new Error('AI_CAPABILITY_UNSUPPORTED'));

      await expect(service.analyze(USER, INTAKE, {})).rejects.toThrow(
        'AI_CAPABILITY_UNSUPPORTED',
      );
      expect(jobs.enqueueWithin).not.toHaveBeenCalled();
    });

    it('refuses an intake without photos with 400 NO_PHOTOS', async () => {
      prisma.photoIntakePhoto.count.mockResolvedValue(0);

      expect(reasonOf(await caught(service.analyze(USER, INTAKE, {})))).toBe(
        'NO_PHOTOS',
      );
    });

    it('refuses a manual-only kind with 400 MANUAL_ONLY_KIND', async () => {
      registry.register(stubKind({ analyzeJobType: null }));

      expect(reasonOf(await caught(service.analyze(USER, INTAKE, {})))).toBe(
        'MANUAL_ONLY_KIND',
      );
    });

    it.each([
      ['scanning', 'INTAKE_SCANNING'],
      ['applied', 'ALREADY_APPLIED'],
    ])('answers 409 while %s', async (status, reason) => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status }) as never);

      const error = await caught(service.analyze(USER, INTAKE, {}));

      expect(error).toBeInstanceOf(ConflictException);
      expect(reasonOf(error)).toBe(reason);
      expect(usableModels.assertUsable).not.toHaveBeenCalled();
    });

    it('a concurrent analyze that won the status flip makes this one 409, with nothing queued', async () => {
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 0 });
      prisma.photoIntake.findFirst
        .mockResolvedValueOnce(intakeRow({ status: 'draft' }) as never)
        .mockResolvedValueOnce({ status: 'scanning' } as never);

      const error = await caught(service.analyze(USER, INTAKE, {}));

      expect(reasonOf(error)).toBe('INTAKE_SCANNING');
      expect(jobs.enqueueWithin).not.toHaveBeenCalled();
    });
  
    it('accepts a client model equal to the resolved one', async () => {
      await service.analyze(USER, INTAKE, { provider: 'openai', modelId: 'vision-1' });

      expect(prisma.photoIntake.updateMany.mock.calls[0][0]).toMatchObject({ data: { provider: 'openai', modelId: 'vision-1' } });
    });

    it('refuses a different client model with 409 AI_MODEL_ASSIGNMENT_LOCKED naming the resolved one, queueing nothing (#173)', async () => {
      const error = await caught(service.analyze(USER, INTAKE, { provider: 'openai', modelId: 'other' }));

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        details: { reason: 'AI_MODEL_ASSIGNMENT_LOCKED', featureId: 'gym_scan', provider: 'openai', modelId: 'vision-1' },
      });
      expect(usableModels.assertUsable).not.toHaveBeenCalled();
      expect(jobs.enqueueWithin).not.toHaveBeenCalled();
    });

    it('refuses a blocked feature with 409 AI_FEATURE_UNAVAILABLE naming the state (#173)', async () => {
      features.resolve.mockResolvedValueOnce(
        (await stubFeatureResolver(null, 'no_key').resolve(USER, 'gym_scan')) as never,
      );

      const error = await caught(service.analyze(USER, INTAKE, {}));

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        details: { reason: 'AI_FEATURE_UNAVAILABLE', featureId: 'gym_scan', state: 'no_key' },
      });
      expect(jobs.enqueueWithin).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Items — provenance
  // ---------------------------------------------------------------------------

  describe('addItem', () => {
    beforeEach(() => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
      prisma.draftItem.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } } as never);
      prisma.draftItem.create.mockImplementation((async (args: any) => itemRow(args.data)) as never);
    });

    it('stores a user item as accepted, verified, without confidence, value normalized', async () => {
      const view = await service.addItem(USER, INTAKE, { kind: 'thing', value: { name: '  Bench  ' } });

      expect(prisma.draftItem.create.mock.calls[0][0].data).toMatchObject({
        origin: 'user',
        status: 'accepted',
        confidence: null,
        userVerified: true,
        value: { name: 'Bench' },
        sortOrder: 5,
      });
      expect(view).toMatchObject({ origin: 'user', confidence: null, userVerified: true, originalAiValue: null });
    });

    it("tells the kind's normalizeValue the write came from a user", async () => {
      const normalizeValue = jest.fn((value: StubValue) => value);
      registry.register(stubKind({ normalizeValue }));

      await service.addItem(USER, INTAKE, { kind: 'thing', value: { name: 'Bench' } });

      expect(normalizeValue).toHaveBeenCalledWith({ name: 'Bench' }, undefined, 'user');
    });

    it("refuses a value the kind's schema rejects, naming the field", async () => {
      const error = (await caught(
        service.addItem(USER, INTAKE, { kind: 'thing', value: { name: '' } }),
      )) as BadRequestException;

      expect((error.getResponse() as any).details.issues[0].path).toBe('value.name');
      expect(prisma.draftItem.create).not.toHaveBeenCalled();
    });

    it("refuses an item kind the intake kind does not declare", async () => {
      await expect(service.addItem(USER, INTAKE, { kind: 'other', value: { name: 'x' } })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('updateItem', () => {
    beforeEach(() => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
      prisma.draftItem.update.mockImplementation((async (args: any) => itemRow(args.data)) as never);
    });

    it('the first value edit of an AI item copies the previous value into originalAiValue, write-once, and sets userVerified', async () => {
      prisma.draftItem.findFirst.mockResolvedValue(itemRow() as never);

      await service.updateItem(USER, INTAKE, ITEM, { value: { name: 'Seated leg press' } });

      expect(prisma.draftItem.updateMany).toHaveBeenCalledWith({
        where: { id: ITEM, intakeId: INTAKE, originalAiValue: { equals: Prisma.DbNull } },
        data: { originalAiValue: { name: 'Leg press' } },
      });
      expect(prisma.draftItem.update.mock.calls[0][0].data).toEqual({
        value: { name: 'Seated leg press' },
        userVerified: true,
      });
    });

    it('never touches originalAiValue in the main update, so a later edit cannot overwrite it', async () => {
      prisma.draftItem.findFirst.mockResolvedValue(
        itemRow({ value: { name: 'Second' }, originalAiValue: { name: 'Leg press' }, userVerified: true }) as never,
      );

      await service.updateItem(USER, INTAKE, ITEM, { value: { name: 'Third' } });

      // The conditional write only matches while original_ai_value IS NULL;
      // the unconditional update never names the column.
      expect(prisma.draftItem.updateMany.mock.calls[0][0].where).toMatchObject({
        originalAiValue: { equals: Prisma.DbNull },
      });
      expect(prisma.draftItem.update.mock.calls[0][0].data).not.toHaveProperty('originalAiValue');
    });

    it('a user item edit never writes originalAiValue', async () => {
      prisma.draftItem.findFirst.mockResolvedValue(
        itemRow({ origin: 'user', status: 'accepted', confidence: null, userVerified: true }) as never,
      );

      await service.updateItem(USER, INTAKE, ITEM, { value: { name: 'Mine' } });

      expect(prisma.draftItem.updateMany).not.toHaveBeenCalled();
    });

    it('accepting sets userVerified; rejecting keeps the row and does not verify; pending restores', async () => {
      prisma.draftItem.findFirst.mockResolvedValue(itemRow() as never);

      await service.updateItem(USER, INTAKE, ITEM, { status: 'accepted' });
      await service.updateItem(USER, INTAKE, ITEM, { status: 'rejected' });
      await service.updateItem(USER, INTAKE, ITEM, { status: 'pending' });

      const updates = prisma.draftItem.update.mock.calls.map((call) => call[0].data);
      expect(updates).toEqual([
        { status: 'accepted', userVerified: true },
        { status: 'rejected' },
        { status: 'pending' },
      ]);
      expect(prisma.draftItem.delete).not.toHaveBeenCalled();
      expect(prisma.draftItem.deleteMany).not.toHaveBeenCalled();
    });

    it('answers 404 for an item of another intake', async () => {
      prisma.draftItem.findFirst.mockResolvedValue(null);

      await expect(service.updateItem(USER, INTAKE, ITEM, { status: 'accepted' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses edits once applied with 409 ALREADY_APPLIED', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status: 'applied' }) as never);

      expect(reasonOf(await caught(service.updateItem(USER, INTAKE, ITEM, { status: 'accepted' })))).toBe(
        'ALREADY_APPLIED',
      );
    });
  });

  describe('deleteItem', () => {
    beforeEach(() => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
    });

    it('refuses an AI item with 409 USE_REJECT', async () => {
      prisma.draftItem.findFirst.mockResolvedValue(itemRow() as never);

      const error = await caught(service.deleteItem(USER, INTAKE, ITEM));

      expect(error).toBeInstanceOf(ConflictException);
      expect(reasonOf(error)).toBe('USE_REJECT');
      expect(prisma.draftItem.deleteMany).not.toHaveBeenCalled();
    });

    it('hard-deletes a user item', async () => {
      prisma.draftItem.findFirst.mockResolvedValue(itemRow({ origin: 'user' }) as never);

      await service.deleteItem(USER, INTAKE, ITEM);

      expect(prisma.draftItem.deleteMany).toHaveBeenCalledWith({ where: { id: ITEM, intakeId: INTAKE, origin: 'user' } });
    });
  });

  describe('acceptAll', () => {
    it('accepts and verifies only the pending items and returns them', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
      prisma.draftItem.findMany
        .mockResolvedValueOnce([{ id: ITEM }] as never)
        .mockResolvedValueOnce([itemRow({ status: 'accepted', userVerified: true })] as never);

      const items = await service.acceptAll(USER, INTAKE);

      expect(prisma.draftItem.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [ITEM] }, intakeId: INTAKE, status: 'pending' },
        data: { status: 'accepted', userVerified: true },
      });
      expect(items).toEqual([expect.objectContaining({ id: ITEM, status: 'accepted', userVerified: true })]);
    });
  });

  // ---------------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------------

  describe('apply', () => {
    beforeEach(() => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
    });

    it('refuses while items are pending with 400 PENDING_ITEMS and the count', async () => {
      prisma.draftItem.count.mockResolvedValue(2);

      const error = (await caught(service.apply(USER, INTAKE))) as BadRequestException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error.getResponse() as any).details).toEqual({ reason: 'PENDING_ITEMS', count: 2 });
      expect(kind.apply).not.toHaveBeenCalled();
    });

    it("runs the kind's apply inside the transaction with only the accepted items, then answers its result", async () => {
      prisma.draftItem.count.mockResolvedValue(0);
      const accepted = [itemRow({ status: 'accepted', userVerified: true })];
      prisma.draftItem.findMany.mockResolvedValue(accepted as never);

      const result = await service.apply(USER, INTAKE);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.draftItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { intakeId: INTAKE, status: 'accepted' } }),
      );
      expect(prisma.photoIntake.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: INTAKE, userId: USER, status: 'ready' },
        data: { status: 'applied' },
      });
      expect(kind.apply).toHaveBeenCalledWith(
        expect.objectContaining({ tx: prisma, userId: USER, accepted, intake: expect.objectContaining({ id: INTAKE }) }),
      );
      expect(result).toEqual({ applied: 1 });
    });

    it('a second apply answers 409 ALREADY_APPLIED and calls nothing', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status: 'applied' }) as never);

      const error = await caught(service.apply(USER, INTAKE));

      expect(reasonOf(error)).toBe('ALREADY_APPLIED');
      expect(kind.apply).not.toHaveBeenCalled();
      expect(prisma.photoIntake.updateMany).not.toHaveBeenCalled();
    });

    it('applies a draft intake too (the manual path needs no scan)', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status: 'draft' }) as never);
      prisma.draftItem.count.mockResolvedValue(0);
      prisma.draftItem.findMany.mockResolvedValue([] as never);

      await expect(service.apply(USER, INTAKE)).resolves.toEqual({ applied: 0 });
    });

    it('refuses while scanning with 409 INTAKE_SCANNING', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status: 'scanning' }) as never);

      expect(reasonOf(await caught(service.apply(USER, INTAKE)))).toBe('INTAKE_SCANNING');
    });
  });

  // ---------------------------------------------------------------------------
  // For analyzer jobs
  // ---------------------------------------------------------------------------

  describe('replaceAiDrafts (a stub analyzer)', () => {
    beforeEach(() => {
      prisma.photoIntake.findUnique.mockResolvedValue(intakeRow({ status: 'scanning' }) as never);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      prisma.draftItem.deleteMany.mockResolvedValue({ count: 2 });
      prisma.draftItem.aggregate.mockResolvedValue({ _max: { sortOrder: 6 } } as never);
    });

    it('deletes ONLY untouched AI drafts, appends the new ones after the survivors, and moves to ready', async () => {
      const result = await service.replaceAiDrafts(INTAKE, [
        { kind: 'thing', value: { name: 'Cable row' }, confidence: 'high' },
        { kind: 'thing', value: { name: ' Mystery ' }, confidence: 'low', uncertain: true, uncertaintyNote: 'Blurry' },
      ]);

      expect(prisma.draftItem.deleteMany).toHaveBeenCalledWith({
        where: { intakeId: INTAKE, origin: 'ai', status: 'pending', userVerified: false },
      });
      expect(prisma.photoIntake.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: INTAKE, status: 'scanning' },
        data: { status: 'ready' },
      });

      const rows = (prisma.draftItem.createMany.mock.calls[0][0] as any).data;
      expect(rows).toEqual([
        expect.objectContaining({ origin: 'ai', status: 'pending', userVerified: false, confidence: 'high', sortOrder: 7 }),
        // Low confidence and uncertain: stored like any other, never dropped.
        expect.objectContaining({
          confidence: 'low',
          uncertain: true,
          uncertaintyNote: 'Blurry',
          value: { name: 'Mystery' },
          sortOrder: 8,
        }),
      ]);
      expect(result).toEqual({ inserted: 2, removed: 2, invalid: [] });
    });

    it("tells the kind's normalizeValue the write came from the analyzer", async () => {
      const normalizeValue = jest.fn((value: StubValue) => value);
      registry.register(stubKind({ normalizeValue }));

      await service.replaceAiDrafts(INTAKE, [{ kind: 'thing', value: { name: 'Row' }, confidence: 'high' }]);

      expect(normalizeValue).toHaveBeenCalledWith({ name: 'Row' }, undefined, 'analyzer');
    });

    it('stores what passes validation and records what did not in resultMeta, by index and issue only', async () => {
      const result = await service.replaceAiDrafts(
        INTAKE,
        [
          { kind: 'thing', value: { name: 'Good' }, confidence: 'medium' },
          { kind: 'thing', value: { name: 'secret-looking value', extra: true }, confidence: 'high' },
          { kind: 'thing', value: { name: 'Bad confidence' }, confidence: 'certain' as never },
        ],
        { resultMeta: { promptVersion: 'v1' } },
      );

      expect(result.inserted).toBe(1);
      expect(result.invalid.map((i) => i.index)).toEqual([1, 2]);

      const meta = (prisma.photoIntake.updateMany.mock.calls[0][0] as any).data.resultMeta;
      expect(meta).toMatchObject({ promptVersion: 'v1', itemsReturned: 3, itemsStored: 1 });
      expect(meta.invalidItems).toHaveLength(2);
      expect(JSON.stringify(meta)).not.toContain('secret-looking value');
    });

    it('refuses with 409 NOT_SCANNING when the intake left scanning, writing no items', async () => {
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 0 });
      prisma.photoIntake.findUnique
        .mockResolvedValueOnce(intakeRow({ status: 'scanning' }) as never)
        .mockResolvedValueOnce({ status: 'ready' } as never);

      expect(reasonOf(await caught(service.replaceAiDrafts(INTAKE, [])))).toBe('NOT_SCANNING');
      expect(prisma.draftItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.draftItem.createMany).not.toHaveBeenCalled();
    });

    it('answers 404 when the intake was discarded mid-scan', async () => {
      prisma.photoIntake.findUnique.mockResolvedValue(null);

      await expect(service.replaceAiDrafts(INTAKE, [])).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('failIntake', () => {
    it('marks a scanning intake failed with a bounded code and message', async () => {
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.failIntake(INTAKE, 'AI_PROVIDER_ERROR', 'x'.repeat(900))).resolves.toBe(true);

      const args = prisma.photoIntake.updateMany.mock.calls[0][0] as any;
      expect(args.where).toEqual({ id: INTAKE, status: 'scanning' });
      expect(args.data).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_ERROR' });
      expect(args.data.errorMessage).toHaveLength(500);
    });

    it('answers false and changes nothing for an intake that is not scanning', async () => {
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.failIntake(INTAKE, 'X', 'y')).resolves.toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // A kind's own requiredPermissions
  // ---------------------------------------------------------------------------

  describe("a kind's requiredPermissions", () => {
    const INTAKES = ['intakes:read', 'intakes:write'];
    const reasonOf = (error: unknown) => ((error as ForbiddenException).getResponse() as any).details;

    beforeEach(() => {
      registry.register(stubKind({ requiredPermissions: { read: ['health_data:read'], write: ['health_data:write'] } }));
      prisma.photoIntake.create.mockResolvedValue({ ...intakeRow(), photos: [], items: [] } as never);
    });

    it('create is a 403 naming the missing permission, before anything is written', async () => {
      const error = await caught(service.create(USER, { kind: 'test_stub' }, INTAKES));

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).message).toBe('Missing permissions: health_data:write');
      expect(reasonOf(error)).toEqual({
        reason: 'MISSING_KIND_PERMISSIONS',
        kind: 'test_stub',
        permissions: ['health_data:write'],
      });
      expect(prisma.photoIntake.create).not.toHaveBeenCalled();
    });

    it('create succeeds with the permission', async () => {
      await service.create(USER, { kind: 'test_stub' }, [...INTAKES, 'health_data:write']);
      expect(prisma.photoIntake.create).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the caller\'s permissions are unknown', async () => {
      await expect(service.create(USER, { kind: 'test_stub' })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('apply is a 403 before the status flip or the kind runs', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status: 'ready' }) as never);
      prisma.draftItem.count.mockResolvedValue(0);
      const apply = jest.fn();
      registry.register(stubKind({ apply, requiredPermissions: { write: ['health_data:write'] } }));

      await expect(service.apply(USER, INTAKE, INTAKES)).rejects.toBeInstanceOf(ForbiddenException);

      expect(prisma.photoIntake.updateMany).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    });

    it('an owned intake of the kind: write routes need `write`, get needs `read`', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue({ ...intakeRow({ status: 'ready' }), photos: [], items: [] } as never);

      await expect(service.acceptAll(USER, INTAKE, [...INTAKES, 'health_data:read'])).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.get(USER, INTAKE, [...INTAKES, 'health_data:write'])).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.get(USER, INTAKE, [...INTAKES, 'health_data:read'])).resolves.toMatchObject({ id: INTAKE });
    });

    it('another user\'s intake is still a 404, not a 403', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(null);
      await expect(service.discard(USER, INTAKE, INTAKES)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list leaves out the kinds the caller may not read, and naming one is a 403', async () => {
      prisma.photoIntake.findMany.mockResolvedValue([]);
      registry.register({ ...stubKind(), kind: 'open_kind' });

      await service.list(USER, { limit: 20 }, INTAKES);
      expect(prisma.photoIntake.findMany.mock.calls[0][0]!.where).toEqual({
        userId: USER,
        kind: { notIn: ['test_stub'] },
      });

      await expect(service.list(USER, { kind: 'test_stub', limit: 20 }, INTAKES)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await service.list(USER, { kind: 'open_kind', limit: 20 }, INTAKES);
      expect(prisma.photoIntake.findMany.mock.calls[1][0]!.where).toEqual({ userId: USER, kind: 'open_kind' });
    });

    it('a kind without requiredPermissions is unaffected, even with unknown permissions', async () => {
      registry.register(stubKind());
      prisma.photoIntake.findMany.mockResolvedValue([]);

      await service.create(USER, { kind: 'test_stub' });
      await service.list(USER, { limit: 20 });

      expect(prisma.photoIntake.create).toHaveBeenCalledTimes(1);
      expect(prisma.photoIntake.findMany.mock.calls[0][0]!.where).toEqual({ userId: USER });
    });
  });

  // ---------------------------------------------------------------------------
  // File retention and health documents (H1, #185)
  // ---------------------------------------------------------------------------

  describe('retainFiles and health documents', () => {
    const DOC = '77777777-7777-4777-8777-777777777777';
    const DOC_2 = '77777777-7777-4777-8777-777777777778';
    const readyImage = {
      id: OBJECT,
      name: 'scale.jpg',
      status: 'ready',
      mimeType: 'image/jpeg',
      size: BigInt(2048),
      uploadedById: USER,
    };

    beforeEach(() => {
      registry.register(stubKind({ kind: 'health_stub', healthDocumentKind: 'body_metric' }));
    });

    it('create stores retention keep by default and delete_after_processing for retainFiles: false', async () => {
      prisma.photoIntake.create.mockResolvedValue({ ...intakeRow({ retention: 'keep' }), photos: [], items: [] } as never);

      const view = await service.create(USER, { kind: 'test_stub' });
      await service.create(USER, { kind: 'test_stub', retainFiles: true });
      await service.create(USER, { kind: 'test_stub', retainFiles: false });

      expect(prisma.photoIntake.create.mock.calls.map(([args]) => args.data.retention)).toEqual([
        'keep',
        'keep',
        'delete_after_processing',
      ]);
      expect(view).toMatchObject({ retention: 'keep', retainFiles: true });
    });

    it('the view reports delete_after_processing as retainFiles: false and each photo its document', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue({
        ...intakeRow({ kind: 'health_stub', retention: 'delete_after_processing' }),
        photos: [{ id: 'p1', storageObjectId: OBJECT, sortOrder: 0, storageObject: { name: 'scale.jpg' } }],
        items: [],
        healthDocuments: [{ id: DOC, storageObjectId: OBJECT, retention: 'delete_after_processing' }],
      } as never);

      const view = await service.get(USER, INTAKE);

      expect(view).toMatchObject({ retention: 'delete_after_processing', retainFiles: false });
      expect(view.photos[0]).toMatchObject({ healthDocumentId: DOC, retention: 'delete_after_processing' });
    });

    describe('attachPhoto', () => {
      beforeEach(() => {
        prisma.storageObject.findUnique.mockResolvedValue(readyImage as never);
        prisma.photoIntakePhoto.count.mockResolvedValue(0);
        prisma.photoIntakePhoto.aggregate.mockResolvedValue({ _max: { sortOrder: null } } as never);
        prisma.photoIntakePhoto.create.mockResolvedValue({
          id: 'p1',
          intakeId: INTAKE,
          storageObjectId: OBJECT,
          sortOrder: 0,
          storageObject: { name: 'scale.jpg' },
        } as never);
        prisma.healthDocument.create.mockImplementation((async (args: { data: Record<string, unknown> }) => ({
          id: DOC,
          storageObjectId: args.data.storageObjectId,
          retention: args.data.retention,
        })) as never);
      });

      it("a health kind writes one document from the object's metadata, with the intake's retention", async () => {
        prisma.photoIntake.findFirst.mockResolvedValue(
          intakeRow({ kind: 'health_stub', status: 'draft', retention: 'delete_after_processing' }) as never,
        );

        const view = await service.attachPhoto(USER, INTAKE, OBJECT);

        expect(prisma.healthDocument.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: {
              userId: USER,
              kind: 'body_metric',
              storageObjectId: OBJECT,
              originalName: 'scale.jpg',
              mimeType: 'image/jpeg',
              sizeBytes: BigInt(2048),
              retention: 'delete_after_processing',
              intakeId: INTAKE,
            },
          }),
        );
        expect(view).toMatchObject({ healthDocumentId: DOC, retention: 'delete_after_processing' });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      });

      it('retainFiles on the attach overrides the intake choice for that file', async () => {
        prisma.photoIntake.findFirst.mockResolvedValue(
          intakeRow({ kind: 'health_stub', status: 'draft', retention: 'keep' }) as never,
        );

        await service.attachPhoto(USER, INTAKE, OBJECT, undefined, { retainFiles: false });

        expect(prisma.healthDocument.create.mock.calls[0][0].data.retention).toBe('delete_after_processing');
      });

      it('a kind without healthDocumentKind writes no document', async () => {
        prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ status: 'draft' }) as never);

        const view = await service.attachPhoto(USER, INTAKE, OBJECT, undefined, { retainFiles: false });

        expect(prisma.healthDocument.create).not.toHaveBeenCalled();
        expect(view).toMatchObject({ healthDocumentId: null, retention: null });
      });
    });

    it('detach removes the file\'s document with the link, before the object cleanup', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ kind: 'health_stub' }) as never);
      prisma.photoIntakePhoto.deleteMany.mockResolvedValue({ count: 1 });
      prisma.healthDocument.deleteMany.mockResolvedValue({ count: 1 });
      prisma.photoIntakePhoto.count.mockResolvedValue(0);

      await service.detachPhoto(USER, INTAKE, OBJECT);

      expect(prisma.healthDocument.deleteMany).toHaveBeenCalledWith({
        where: { intakeId: INTAKE, userId: USER, storageObjectId: OBJECT, fileDeletedAt: null },
      });
      expect(prisma.healthDocument.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        objects.delete.mock.invocationCallOrder[0],
      );
    });

    it('discard enqueues one purge per delete_after_processing document, in the delete transaction', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ kind: 'health_stub' }) as never);
      prisma.photoIntakePhoto.findMany.mockResolvedValue([] as never);
      prisma.healthDocument.findMany.mockResolvedValue([{ id: DOC }, { id: DOC_2 }] as never);
      prisma.photoIntake.deleteMany.mockResolvedValue({ count: 1 });

      await service.discard(USER, INTAKE);

      expect(prisma.healthDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { intakeId: INTAKE, userId: USER, retention: 'delete_after_processing', fileDeletedAt: null },
        }),
      );
      // Read before the delete, which sets their intake_id to NULL.
      expect(prisma.healthDocument.findMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.photoIntake.deleteMany.mock.invocationCallOrder[0],
      );
      expect(jobs.enqueueWithin.mock.calls.map(([, input]) => input)).toEqual([
        expect.objectContaining({
          type: 'health.document.purge',
          subjectType: 'health_document',
          subjectId: DOC,
          payload: { healthDocumentId: DOC },
        }),
        expect.objectContaining({ subjectId: DOC_2, payload: { healthDocumentId: DOC_2 } }),
      ]);
    });

    it('a discard that loses to a concurrent apply enqueues nothing', async () => {
      prisma.photoIntake.findFirst
        .mockResolvedValueOnce(intakeRow({ kind: 'health_stub' }) as never)
        .mockResolvedValue(intakeRow({ kind: 'health_stub', status: 'applied' }) as never);
      prisma.photoIntakePhoto.findMany.mockResolvedValue([] as never);
      prisma.healthDocument.findMany.mockResolvedValue([{ id: DOC }] as never);
      prisma.photoIntake.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.discard(USER, INTAKE)).rejects.toBeInstanceOf(ConflictException);
      expect(jobs.enqueueWithin).not.toHaveBeenCalled();
    });

    it('apply hands the kind its documents and enqueues the purges after its writes', async () => {
      const healthKind = stubKind({ kind: 'health_stub', healthDocumentKind: 'body_metric' });
      registry.register(healthKind);
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ kind: 'health_stub' }) as never);
      prisma.draftItem.count.mockResolvedValue(0);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      prisma.draftItem.findMany.mockResolvedValue([] as never);
      prisma.healthDocument.findMany
        .mockResolvedValueOnce([{ id: DOC, storageObjectId: OBJECT }] as never)
        .mockResolvedValueOnce([{ id: DOC }] as never);

      await service.apply(USER, INTAKE);

      expect(healthKind.apply).toHaveBeenCalledWith(
        expect.objectContaining({ healthDocuments: [{ id: DOC, storageObjectId: OBJECT }] }),
      );
      expect(jobs.enqueueWithin).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ type: 'health.document.purge', subjectId: DOC }),
      );
      expect((healthKind.apply as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        jobs.enqueueWithin.mock.invocationCallOrder[0],
      );
    });

    it('apply of a kind without healthDocumentKind reads no documents and enqueues nothing', async () => {
      prisma.photoIntake.findFirst.mockResolvedValue(intakeRow() as never);
      prisma.draftItem.count.mockResolvedValue(0);
      prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      prisma.draftItem.findMany.mockResolvedValue([] as never);

      await service.apply(USER, INTAKE);

      expect(prisma.healthDocument.findMany).not.toHaveBeenCalled();
      expect(jobs.enqueueWithin).not.toHaveBeenCalled();
      expect(kind.apply).toHaveBeenCalledWith(expect.objectContaining({ healthDocuments: [] }));
    });

    describe('updateContext with retainFiles', () => {
      beforeEach(() => {
        prisma.photoIntake.findFirst.mockResolvedValue({
          ...intakeRow({ kind: 'health_stub', context: { label: 'kept' } }),
          photos: [],
          items: [],
          healthDocuments: [],
        } as never);
        prisma.photoIntake.updateMany.mockResolvedValue({ count: 1 });
      });

      it('a body with only retainFiles changes the retention of the intake and its documents, not the context', async () => {
        await service.updateContext(USER, INTAKE, { retainFiles: false });

        const data = prisma.photoIntake.updateMany.mock.calls[0][0].data;
        expect(data).toEqual({ retention: 'delete_after_processing' });
        expect(prisma.healthDocument.updateMany).toHaveBeenCalledWith({
          where: { intakeId: INTAKE, userId: USER, fileDeletedAt: null },
          data: { retention: 'delete_after_processing' },
        });
      });

      it('a body without retainFiles replaces the context as before and leaves retention alone', async () => {
        await service.updateContext(USER, INTAKE, { context: { label: 'new' } });

        const data = prisma.photoIntake.updateMany.mock.calls[0][0].data;
        expect(data).toEqual({ context: { label: 'new' } });
        expect(prisma.healthDocument.updateMany).not.toHaveBeenCalled();
      });

      it('once applied, a retention change is refused 409 ALREADY_APPLIED', async () => {
        prisma.photoIntake.findFirst.mockResolvedValue(intakeRow({ kind: 'health_stub', status: 'applied' }) as never);

        const error = await caught(service.updateContext(USER, INTAKE, { retainFiles: false }));

        expect(reasonOf(error)).toBe('ALREADY_APPLIED');
        expect(prisma.healthDocument.updateMany).not.toHaveBeenCalled();
      });
    });
  });
});
