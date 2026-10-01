import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import type { PrismaService } from '../prisma/prisma.service';
import { createMeasurementEntrySchema, updateMeasurementEntrySchema } from './dto/measurement.dto';
import {
  MEASUREMENT_ENTRY_AUDIT_TARGET,
  MEASUREMENT_ENTRY_DELETE_AUDIT_ACTION,
  MeasurementsService,
} from './measurements.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVE_PREDICATE = { supersededAt: null, deletedAt: null };
const CREATED_AT = new Date('2026-09-29T10:00:00.000Z');

let seq = 0;

function row(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    userId: USER_ID,
    entryId: ENTRY_ID,
    metricKey: 'weight',
    value: 80,
    unit: 'kg',
    measuredAt: new Date('2026-09-28T07:00:00.000Z'),
    localDate: null,
    method: 'scale',
    origin: 'manual',
    notes: 'morning',
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    flag: null,
    sourceRef: null,
    revision: 1,
    supersedesId: null,
    supersededAt: null,
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/** `create` echoes its data back as a stored row. */
function echoCreate(prisma: MockPrismaService) {
  (prisma.measurement.create as jest.Mock).mockImplementation(async ({ data }: any) =>
    row({ ...data, sourceRef: data.sourceRef === Prisma.DbNull ? null : data.sourceRef }),
  );
}

describe('MeasurementsService', () => {
  let service: MeasurementsService;
  let prisma: MockPrismaService;

  beforeEach(() => {
    prisma = createMockPrismaService();
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prisma));
    service = new MeasurementsService(prisma as unknown as PrismaService);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createEntry', () => {
    it('writes every reading under one new entryId and one measuredAt, origin manual', async () => {
      echoCreate(prisma);
      const input = createMeasurementEntrySchema.parse({
        readings: [
          { metricKey: 'weight', value: 208.4, unit: 'lb' },
          { metricKey: 'bp_systolic', value: 128, method: 'bp_cuff' },
          { metricKey: 'bp_diastolic', value: 84, method: 'bp_cuff' },
        ],
      });

      const result = await service.createEntry(USER_ID, input);

      expect(result.entryId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.items).toHaveLength(3);
      const calls = (prisma.measurement.create as jest.Mock).mock.calls.map(([arg]) => arg.data);
      expect(new Set(calls.map((d) => d.entryId))).toEqual(new Set([result.entryId]));
      expect(new Set(calls.map((d) => d.measuredAt.getTime())).size).toBe(1);
      expect(calls[0]).toMatchObject({
        userId: USER_ID,
        metricKey: 'weight',
        value: 94.5286,
        unit: 'kg',
        method: 'unspecified',
        origin: 'manual',
        notes: null,
      });
      expect(calls[1]).toMatchObject({ method: 'bp_cuff', unit: 'mmHg' });
      expect(result.items[0]).toMatchObject({
        value: 94.5286,
        unit: 'kg',
        origin: 'manual',
        method: 'unspecified',
        revision: 1,
        edited: false,
        sourceRef: null,
      });
    });

    it('runs inside one transaction', async () => {
      echoCreate(prisma);
      await service.createEntry(
        USER_ID,
        createMeasurementEntrySchema.parse({ readings: [{ metricKey: 'weight', value: 80 }] }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('lets server code set origin and sourceRef through the transaction-aware create', async () => {
      echoCreate(prisma);
      const sourceRef = { kind: 'storage_object', storageObjectId: 'obj-1' };

      const result = await service.createEntryInTransaction(
        prisma as unknown as Prisma.TransactionClient,
        USER_ID,
        createMeasurementEntrySchema.parse({ readings: [{ metricKey: 'weight', value: 80 }] }),
        { origin: 'ai', sourceRef },
      );

      expect(result.items[0]).toMatchObject({ origin: 'ai', sourceRef });
    });

    it('takes one provenance per reading, in reading order (photo intake, E2.6)', async () => {
      echoCreate(prisma);
      const ai = { kind: 'photo_intake', intakeId: 'i-1', draftItemId: 'd-1' };
      const manual = { kind: 'photo_intake', intakeId: 'i-1' };

      const result = await service.createEntryInTransaction(
        prisma as unknown as Prisma.TransactionClient,
        USER_ID,
        createMeasurementEntrySchema.parse({
          readings: [
            { metricKey: 'weight', value: 80 },
            { metricKey: 'body_fat_pct', value: 20 },
          ],
        }),
        [
          { origin: 'ai', sourceRef: ai },
          { origin: 'manual', sourceRef: manual },
        ],
      );

      expect(result.items.map((item) => [item.metricKey, item.origin, item.sourceRef])).toEqual([
        ['weight', 'ai', ai],
        ['body_fat_pct', 'manual', manual],
      ]);
    });

    it('refuses a provenance list that does not match the readings', async () => {
      await expect(
        service.createEntryInTransaction(
          prisma as unknown as Prisma.TransactionClient,
          USER_ID,
          createMeasurementEntrySchema.parse({ readings: [{ metricKey: 'weight', value: 80 }] }),
          [],
        ),
      ).rejects.toThrow('one provenance per reading');
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });
  });

  describe('updateEntry on a photo-read row (E2.6)', () => {
    // The AI read 208.4 lb (94.5286 kg canonical) and the user saved it unedited.
    const aiDraft = { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' };
    const sourceRef = {
      kind: 'photo_intake',
      intakeId: 'i-1',
      draftItemId: 'd-1',
      storageObjectIds: ['obj-1'],
      aiDraft,
      confidence: 'high',
      userEdited: false,
    };

    async function patch(existing: ReturnType<typeof row>, body: Record<string, unknown>) {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([existing]);
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      echoCreate(prisma);
      return service.updateEntry(USER_ID, ENTRY_ID, updateMeasurementEntrySchema.parse(body));
    }

    it('keeps origin ai and flips userEdited to true when the value changes', async () => {
      const result = await patch(row({ value: 94.5286, origin: 'ai', sourceRef }), {
        readings: [{ metricKey: 'weight', value: 95 }],
      });

      expect(result.items[0]).toMatchObject({
        origin: 'ai',
        sourceRef: { ...sourceRef, userEdited: true },
      });
    });

    it('flips userEdited back to false when the value is edited back to the AI reading, in any unit', async () => {
      const edited = row({ value: 95, origin: 'ai', sourceRef: { ...sourceRef, userEdited: true } });

      const inPounds = await patch(edited, { readings: [{ metricKey: 'weight', value: 208.4, unit: 'lb' }] });
      expect(inPounds.items[0].sourceRef).toEqual({ ...sourceRef, userEdited: false });

      const inKg = await patch(edited, { readings: [{ metricKey: 'weight', value: 94.5286 }] });
      expect(inKg.items[0].sourceRef).toEqual({ ...sourceRef, userEdited: false });
    });

    it('leaves sourceRef untouched when the edit does not change the reading (notes only)', async () => {
      const result = await patch(row({ value: 95, origin: 'ai', sourceRef: { ...sourceRef, userEdited: true } }), {
        notes: 'after run',
      });

      expect(result.items[0].sourceRef).toEqual({ ...sourceRef, userEdited: true });
    });

    it('leaves a manual row and its sourceRef alone', async () => {
      const manualRef = { kind: 'photo_intake', intakeId: 'i-1' };
      const result = await patch(row({ value: 80, origin: 'manual', sourceRef: manualRef }), {
        readings: [{ metricKey: 'weight', value: 81 }],
      });

      expect(result.items[0]).toMatchObject({ origin: 'manual', sourceRef: manualRef });
    });
  });

  describe('updateEntry', () => {
    it('supersedes every active row, copying unmentioned readings forward', async () => {
      const weight = row({ metricKey: 'weight', value: 80, method: 'scale' });
      const fat = row({ metricKey: 'body_fat_pct', value: 20, unit: '%', method: 'smart_scale' });
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([fat, weight]);
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      echoCreate(prisma);

      const result = await service.updateEntry(
        USER_ID,
        ENTRY_ID,
        updateMeasurementEntrySchema.parse({ readings: [{ metricKey: 'weight', value: 81 }] }),
      );

      expect(prisma.measurement.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ userId: USER_ID, entryId: ENTRY_ID, ...ACTIVE_PREDICATE }),
      });
      expect(prisma.measurement.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [weight.id, fat.id] }, ...ACTIVE_PREDICATE },
        data: { supersededAt: expect.any(Date) },
      });

      const created = (prisma.measurement.create as jest.Mock).mock.calls.map(([arg]) => arg.data);
      expect(created).toEqual([
        expect.objectContaining({
          metricKey: 'weight',
          value: 81,
          method: 'scale',
          revision: 2,
          supersedesId: weight.id,
          entryId: ENTRY_ID,
          notes: 'morning',
          origin: 'manual',
        }),
        expect.objectContaining({
          metricKey: 'body_fat_pct',
          value: 20,
          method: 'smart_scale',
          revision: 2,
          supersedesId: fat.id,
        }),
      ]);
      expect(result.items.map((item) => [item.metricKey, item.revision, item.edited])).toEqual([
        ['weight', 2, true],
        ['body_fat_pct', 2, true],
      ]);
    });

    it('clears notes on every row with notes: null', async () => {
      const a = row({ metricKey: 'bp_systolic', value: 128, unit: 'mmHg' });
      const b = row({ metricKey: 'bp_diastolic', value: 84, unit: 'mmHg' });
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([a, b]);
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      echoCreate(prisma);

      const result = await service.updateEntry(
        USER_ID,
        ENTRY_ID,
        updateMeasurementEntrySchema.parse({ notes: null }),
      );

      expect(result.items.map((item) => item.notes)).toEqual([null, null]);
      expect(result.items.map((item) => item.value)).toEqual([128, 84]);
    });

    it('moves measuredAt on every row', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([row()]);
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      echoCreate(prisma);

      await service.updateEntry(
        USER_ID,
        ENTRY_ID,
        updateMeasurementEntrySchema.parse({ measuredAt: '2026-09-27T06:00:00Z' }),
      );

      expect((prisma.measurement.create as jest.Mock).mock.calls[0][0].data.measuredAt).toEqual(
        new Date('2026-09-27T06:00:00Z'),
      );
    });

    it('404s when the caller has no active row in the entry', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([]);

      await expect(
        service.updateEntry(USER_ID, ENTRY_ID, updateMeasurementEntrySchema.parse({ notes: null })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    });

    it('400s when a reading names a metric the entry does not hold', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([row()]);

      const error = await service
        .updateEntry(
          USER_ID,
          ENTRY_ID,
          updateMeasurementEntrySchema.parse({ readings: [{ metricKey: 'resting_hr', value: 60 }] }),
        )
        .catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse().details.issues[0].path).toBe('readings.0.metricKey');
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    });

    it('checks the blood-pressure rule on the merged entry', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([
        row({ metricKey: 'bp_systolic', value: 128, unit: 'mmHg' }),
        row({ metricKey: 'bp_diastolic', value: 84, unit: 'mmHg' }),
      ]);

      await expect(
        service.updateEntry(
          USER_ID,
          ENTRY_ID,
          updateMeasurementEntrySchema.parse({ readings: [{ metricKey: 'bp_systolic', value: 80 }] }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    });

    it('409s when fewer rows were stamped than read (a concurrent edit or delete)', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([row(), row({ metricKey: 'body_fat_pct' })]);
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await expect(
        service.updateEntry(USER_ID, ENTRY_ID, updateMeasurementEntrySchema.parse({ notes: null })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('maps a unique violation on supersedes_id to 409', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([row()]);
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.measurement.create as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['supersedes_id'] },
        }),
      );

      await expect(
        service.updateEntry(USER_ID, ENTRY_ID, updateMeasurementEntrySchema.parse({ notes: null })),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('lab results (H3, #187)', () => {
    function labRow(overrides: Record<string, unknown> = {}) {
      return row({
        metricKey: 'ldl_cholesterol',
        value: 130,
        unit: 'mg/dL',
        method: 'lab',
        notes: null,
        referenceLow: 0,
        referenceHigh: 99,
        referenceText: '<100',
        flag: 'high',
        ...overrides,
      });
    }

    it('creates a panel under one entryId with canonical ranges and flags', async () => {
      echoCreate(prisma);
      const input = createMeasurementEntrySchema.parse({
        readings: [
          {
            metricKey: 'ldl_cholesterol',
            value: 3.36,
            unit: 'mmol/L',
            method: 'lab',
            referenceLow: 0,
            referenceHigh: 2.59,
            referenceText: '<2.59',
            flag: 'high',
          },
          { metricKey: 'hdl_cholesterol', value: 55, method: 'lab', flag: 'normal' },
          { metricKey: 'fasting_glucose', value: 5.55, unit: 'mmol/L' },
        ],
      });

      const result = await service.createEntry(USER_ID, input);

      const calls = (prisma.measurement.create as jest.Mock).mock.calls.map(([arg]) => arg.data);
      expect(new Set(calls.map((d) => d.entryId)).size).toBe(1);
      expect(calls[0]).toMatchObject({
        metricKey: 'ldl_cholesterol',
        unit: 'mg/dL',
        method: 'lab',
        referenceLow: 0,
        referenceText: '<2.59',
        flag: 'high',
      });
      expect(calls[0].value).toBeCloseTo(129.93, 2);
      expect(calls[0].referenceHigh).toBeCloseTo(100.15, 2);
      expect(calls[1]).toMatchObject({ referenceLow: null, referenceHigh: null, referenceText: null, flag: 'normal' });
      expect(calls[2]).toMatchObject({ method: 'unspecified', flag: null });
      expect(Math.round(calls[2].value)).toBe(100);
      expect(result.items[0]).toMatchObject({ referenceText: '<2.59', flag: 'high', unit: 'mg/dL' });
    });

    it('keeps range and flag when an edit changes only the value', async () => {
      const ldl = labRow();
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([ldl]);
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      echoCreate(prisma);

      const result = await service.updateEntry(
        USER_ID,
        ENTRY_ID,
        updateMeasurementEntrySchema.parse({ readings: [{ metricKey: 'ldl_cholesterol', value: 128 }] }),
      );

      const [created] = (prisma.measurement.create as jest.Mock).mock.calls.map(([arg]) => arg.data);
      expect(created).toMatchObject({
        value: 128,
        referenceLow: 0,
        referenceHigh: 99,
        referenceText: '<100',
        flag: 'high',
        method: 'lab',
        revision: 2,
        supersedesId: ldl.id,
      });
      expect(result.items[0]).toMatchObject({ flag: 'high', referenceHigh: 99, edited: true });
    });

    it('keeps range and flag on a notes-only edit, and changes or clears them when sent', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([labRow()]);
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      echoCreate(prisma);

      await service.updateEntry(USER_ID, ENTRY_ID, updateMeasurementEntrySchema.parse({ notes: 'fasted' }));
      await service.updateEntry(
        USER_ID,
        ENTRY_ID,
        updateMeasurementEntrySchema.parse({
          readings: [{ metricKey: 'ldl_cholesterol', value: 130, flag: 'normal', referenceText: null, referenceLow: null }],
        }),
      );

      const [notesOnly, changed] = (prisma.measurement.create as jest.Mock).mock.calls.map(([arg]) => arg.data);
      expect(notesOnly).toMatchObject({ notes: 'fasted', referenceLow: 0, referenceHigh: 99, referenceText: '<100', flag: 'high' });
      expect(changed).toMatchObject({ referenceLow: null, referenceHigh: 99, referenceText: null, flag: 'normal' });
    });

    it('checks low <= high on the merged reading', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([labRow()]);

      const error = await service
        .updateEntry(
          USER_ID,
          ENTRY_ID,
          updateMeasurementEntrySchema.parse({ readings: [{ metricKey: 'ldl_cholesterol', value: 130, referenceLow: 120 }] }),
        )
        .catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({
        details: {
          issues: [
            { path: 'readings.0.referenceLow', message: 'referenceLow must not be higher than referenceHigh' },
          ],
        },
      });
      expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
    });

    it('list: lists lab rows only on request', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([labRow()]);
      (prisma.measurement.count as jest.Mock).mockResolvedValue(1);

      const result = await service.list(USER_ID, { category: 'lab', page: 1, pageSize: 20 });

      const where = (prisma.measurement.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.metricKey.in).toContain('ldl_cholesterol');
      expect(where.metricKey.in).not.toContain('weight');
      expect(result.items[0]).toMatchObject({ referenceLow: 0, referenceHigh: 99, referenceText: '<100', flag: 'high' });

      await service.list(USER_ID, { metricKey: 'tsh', page: 1, pageSize: 20 });
      expect((prisma.measurement.findMany as jest.Mock).mock.calls[1][0].where.metricKey).toBe('tsh');

      await service.list(USER_ID, { category: 'body', metricKey: 'tsh', page: 1, pageSize: 20 });
      expect((prisma.measurement.findMany as jest.Mock).mock.calls[2][0].where.metricKey).toEqual({ in: [] });
    });
  });

  describe('deleteEntry', () => {
    it('soft-deletes the active rows and audits the reading count only', async () => {
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.deleteEntry(USER_ID, ENTRY_ID);

      expect(prisma.measurement.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, entryId: ENTRY_ID, ...ACTIVE_PREDICATE },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: USER_ID,
          action: MEASUREMENT_ENTRY_DELETE_AUDIT_ACTION,
          targetType: MEASUREMENT_ENTRY_AUDIT_TARGET,
          targetId: ENTRY_ID,
          meta: { readingCount: 2 },
        },
      });
    });

    it('404s when nothing was active, and audits nothing', async () => {
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.deleteEntry(USER_ID, ENTRY_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('succeeds when the audit write fails', async () => {
      (prisma.measurement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.auditEvent.create as jest.Mock).mockRejectedValue(new Error('audit down'));

      await expect(service.deleteEntry(USER_ID, ENTRY_ID)).resolves.toBeUndefined();
    });
  });

  describe('reads carry the owner and active predicate', () => {
    it('list: body/vital only, newest first, flat pagination', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([row()]);
      (prisma.measurement.count as jest.Mock).mockResolvedValue(41);

      const result = await service.list(USER_ID, { page: 2, pageSize: 20 });

      expect(prisma.measurement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: USER_ID,
            ...ACTIVE_PREDICATE,
            metricKey: {
              in: ['weight', 'body_fat_pct', 'waist_circumference', 'bp_systolic', 'bp_diastolic', 'resting_hr'],
            },
          }),
          orderBy: [{ measuredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          skip: 20,
          take: 20,
        }),
      );
      expect(prisma.measurement.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ userId: USER_ID, ...ACTIVE_PREDICATE }),
      });
      expect(result).toMatchObject({ total: 41, page: 2, pageSize: 20, totalPages: 3 });
      expect(result.items).toHaveLength(1);
    });

    it('list: applies metricKey and the date range', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.measurement.count as jest.Mock).mockResolvedValue(0);
      const from = new Date('2026-01-01T00:00:00Z');
      const to = new Date('2026-02-01T00:00:00Z');

      await service.list(USER_ID, { metricKey: 'weight', from, to, page: 1, pageSize: 20 });

      expect(prisma.measurement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            metricKey: 'weight',
            measuredAt: { gte: from, lte: to },
            ...ACTIVE_PREDICATE,
          }),
        }),
      );
    });

    it('latest: six metrics in registry order, two rows each', async () => {
      (prisma.measurement.findMany as jest.Mock).mockImplementation(async ({ where }: any) =>
        where.metricKey === 'weight'
          ? [row({ value: 81 }), row({ value: 80 })]
          : where.metricKey === 'resting_hr'
            ? [row({ metricKey: 'resting_hr', value: 58, unit: 'bpm' })]
            : [],
      );

      const result = await service.latest(USER_ID);

      expect(result.items.map((item) => item.metricKey)).toEqual([
        'weight',
        'body_fat_pct',
        'waist_circumference',
        'bp_systolic',
        'bp_diastolic',
        'resting_hr',
      ]);
      expect(result.items[0].latest?.value).toBe(81);
      expect(result.items[0].previous?.value).toBe(80);
      expect(result.items[1]).toEqual({ metricKey: 'body_fat_pct', latest: null, previous: null });
      expect(result.items[5]).toMatchObject({ latest: { value: 58 }, previous: null });

      for (const [arg] of (prisma.measurement.findMany as jest.Mock).mock.calls) {
        expect(arg).toMatchObject({
          where: { userId: USER_ID, ...ACTIVE_PREDICATE },
          take: 2,
          orderBy: [{ measuredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        });
      }
    });

    it('series: ascending, capped at 1000 keeping the newest, truncated flag', async () => {
      const base = Date.UTC(2026, 0, 1);
      // 1001 rows newest first, as the query returns them.
      const rows = Array.from({ length: 1001 }, (_, i) =>
        row({ measuredAt: new Date(base + (1000 - i) * 60_000), value: 1000 - i }),
      );
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue(rows);
      const from = new Date(base);
      const to = new Date(base + 2000 * 60_000);

      const result = await service.series(USER_ID, { metricKey: 'weight', from, to });

      expect(prisma.measurement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: USER_ID,
            metricKey: 'weight',
            measuredAt: { gte: from, lte: to },
            ...ACTIVE_PREDICATE,
          }),
          take: 1001,
        }),
      );
      expect(result.truncated).toBe(true);
      expect(result.unit).toBe('kg');
      expect(result.points).toHaveLength(1000);
      expect(result.points[0].value).toBe(1);
      expect(result.points[999].value).toBe(1000);
    });

    it('series: not truncated at or under the cap', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([row({ value: 2 }), row({ value: 1 })]);

      const result = await service.series(USER_ID, {
        metricKey: 'weight',
        from: new Date(0),
        to: new Date(),
      });

      expect(result.truncated).toBe(false);
      expect(result.points.map((p) => p.value)).toEqual([1, 2]);
    });

    it('series: lab points carry their own range and flag; body points keep their shape (H5)', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValueOnce([
        row({ metricKey: 'ldl_cholesterol', value: 130, referenceLow: null, referenceHigh: 129, flag: 'high' }),
        row({ metricKey: 'ldl_cholesterol', value: 95, referenceLow: 0, referenceHigh: 99, referenceText: '<100', flag: 'normal' }),
      ]);

      const lab = await service.series(USER_ID, { metricKey: 'ldl_cholesterol', from: new Date(0), to: new Date() });

      expect(prisma.measurement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ referenceLow: true, referenceHigh: true, referenceText: true, flag: true }),
        }),
      );
      expect(lab.unit).toBe('mg/dL');
      expect(lab.points.map(({ value, referenceLow, referenceHigh, referenceText, flag }) => ({
        value, referenceLow, referenceHigh, referenceText, flag,
      }))).toEqual([
        { value: 95, referenceLow: 0, referenceHigh: 99, referenceText: '<100', flag: 'normal' },
        { value: 130, referenceLow: null, referenceHigh: 129, referenceText: null, flag: 'high' },
      ]);

      (prisma.measurement.findMany as jest.Mock).mockResolvedValueOnce([row({ value: 80 })]);
      const body = await service.series(USER_ID, { metricKey: 'weight', from: new Date(0), to: new Date() });

      expect(Object.keys(body.points[0]).sort()).toEqual(['id', 'measuredAt', 'method', 'origin', 'value']);
    });
  });

  describe('revisions (H5, #189)', () => {
    const MEASUREMENT_ID = '44444444-4444-4444-8444-444444444444';

    it('finds the reading owner-scoped, then lists its whole chain newest first', async () => {
      const superseded = new Date('2026-09-29T09:00:00.000Z');
      (prisma.measurement.findFirst as jest.Mock).mockResolvedValue({ entryId: ENTRY_ID, metricKey: 'ldl_cholesterol' });
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([
        row({ metricKey: 'ldl_cholesterol', value: 128, revision: 2, flag: 'normal' }),
        row({ metricKey: 'ldl_cholesterol', value: 130, revision: 1, flag: 'high', supersededAt: superseded }),
      ]);

      const result = await service.revisions(USER_ID, MEASUREMENT_ID);

      expect(prisma.measurement.findFirst).toHaveBeenCalledWith({
        where: { id: MEASUREMENT_ID, userId: USER_ID },
        select: { entryId: true, metricKey: true },
      });
      expect(prisma.measurement.findMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, entryId: ENTRY_ID, metricKey: 'ldl_cholesterol' },
        orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
      });
      expect(result.items.map(({ value, revision, edited, flag, supersededAt, createdAt }) => ({
        value, revision, edited, flag, supersededAt, createdAt,
      }))).toEqual([
        { value: 128, revision: 2, edited: true, flag: 'normal', supersededAt: null, createdAt: CREATED_AT.toISOString() },
        { value: 130, revision: 1, edited: false, flag: 'high', supersededAt: superseded.toISOString(), createdAt: CREATED_AT.toISOString() },
      ]);
    });

    it('404s for a foreign or unknown id', async () => {
      (prisma.measurement.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.revisions(USER_ID, MEASUREMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    });

    it('404s when the reading was deleted', async () => {
      (prisma.measurement.findFirst as jest.Mock).mockResolvedValue({ entryId: ENTRY_ID, metricKey: 'weight' });
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([
        row({ revision: 2, deletedAt: new Date() }),
        row({ revision: 1, supersededAt: new Date() }),
      ]);

      await expect(service.revisions(USER_ID, MEASUREMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('fileDeleted (H1, #185)', () => {
    const KEPT = '77777777-7777-4777-8777-777777777771';
    const ERASED = '77777777-7777-4777-8777-777777777772';
    const GONE = '77777777-7777-4777-8777-777777777773';
    const ref = (healthDocumentId?: string) => ({
      kind: 'photo_intake',
      intakeId: '33333333-3333-4333-8333-333333333333',
      ...(healthDocumentId ? { healthDocumentId } : {}),
    });

    it('list: one owner-scoped document lookup for the page; kept false, erased or missing true, none null', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([
        row({ origin: 'ai', sourceRef: ref(KEPT) }),
        row({ origin: 'ai', sourceRef: ref(ERASED) }),
        row({ origin: 'manual', sourceRef: ref(ERASED) }),
        row({ origin: 'ai', sourceRef: ref(GONE) }),
        row({ origin: 'manual', sourceRef: ref() }),
        row(),
      ]);
      (prisma.measurement.count as jest.Mock).mockResolvedValue(6);
      (prisma.healthDocument.findMany as jest.Mock).mockResolvedValue([
        { id: KEPT, fileDeletedAt: null },
        { id: ERASED, fileDeletedAt: new Date() },
      ]);

      const result = await service.list(USER_ID, { page: 1, pageSize: 20 });

      expect(prisma.healthDocument.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.healthDocument.findMany).toHaveBeenCalledWith({
        where: { id: { in: [KEPT, ERASED, GONE] }, userId: USER_ID },
        select: { id: true, fileDeletedAt: true },
      });
      expect(result.items.map((item) => item.fileDeleted)).toEqual([false, true, true, true, null, null]);
    });

    it('list: no lookup at all when no row names a document', async () => {
      (prisma.measurement.findMany as jest.Mock).mockResolvedValue([row(), row({ sourceRef: ref() })]);
      (prisma.measurement.count as jest.Mock).mockResolvedValue(2);

      const result = await service.list(USER_ID, { page: 1, pageSize: 20 });

      expect(prisma.healthDocument.findMany).not.toHaveBeenCalled();
      expect(result.items.map((item) => item.fileDeleted)).toEqual([null, null]);
    });

    it('latest: one lookup across every metric', async () => {
      (prisma.measurement.findMany as jest.Mock).mockImplementation(async ({ where }: any) =>
        where.metricKey === 'weight' ? [row({ sourceRef: ref(ERASED) })] : [],
      );
      (prisma.healthDocument.findMany as jest.Mock).mockResolvedValue([{ id: ERASED, fileDeletedAt: new Date() }]);

      const result = await service.latest(USER_ID);

      expect(prisma.healthDocument.findMany).toHaveBeenCalledTimes(1);
      expect(result.items.find((item) => item.metricKey === 'weight')!.latest!.fileDeleted).toBe(true);
    });
  });
});
