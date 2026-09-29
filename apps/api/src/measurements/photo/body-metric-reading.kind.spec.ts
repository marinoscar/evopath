import { BadRequestException } from '@nestjs/common';
import { Prisma, type DraftItem, type PhotoIntake } from '@prisma/client';

import { createMockPrismaService, type MockPrismaService } from '../../../test/mocks/prisma.mock';
import { IntakeKindRegistry } from '../../intake/intake-kind.registry';
import type { PrismaService } from '../../prisma/prisma.service';
import { MeasurementsService } from '../measurements.service';
import { BodyMetricReadingIntakeKind } from './body-metric-reading.kind';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const INTAKE_ID = '33333333-3333-4333-8333-333333333333';
const PHOTO = '55555555-5555-4555-8555-555555555555';

let seq = 0;

function item(overrides: Partial<DraftItem> = {}): DraftItem {
  seq += 1;
  return {
    id: `44444444-4444-4444-8444-${String(seq).padStart(12, '0')}`,
    intakeId: INTAKE_ID,
    kind: 'reading',
    origin: 'ai',
    status: 'accepted',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
    sourcePhotoIds: [PHOTO],
    userVerified: true,
    value: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
    originalAiValue: null,
    sortOrder: seq,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as DraftItem;
}

const intake = { id: INTAKE_ID, userId: USER_ID, kind: 'body_metric_reading', status: 'ready' } as PhotoIntake;

function issuesOf(error: unknown): Array<{ path: string; message: string }> {
  return ((error as BadRequestException).getResponse() as any).details.issues;
}

describe('BodyMetricReadingIntakeKind (E2.6)', () => {
  let prisma: MockPrismaService;
  let kind: BodyMetricReadingIntakeKind;
  let registry: IntakeKindRegistry;

  beforeEach(() => {
    prisma = createMockPrismaService();
    (prisma.measurement.create as jest.Mock).mockImplementation(async ({ data }: any) => ({
      id: `row-${data.metricKey}`,
      revision: 1,
      localDate: null,
      ...data,
      sourceRef: data.sourceRef === Prisma.DbNull ? null : data.sourceRef,
    }));
    registry = new IntakeKindRegistry();
    kind = new BodyMetricReadingIntakeKind(registry, new MeasurementsService(prisma as unknown as PrismaService));
  });

  const apply = (accepted: DraftItem[], on: PhotoIntake = intake) =>
    kind.apply({ tx: prisma as unknown as Prisma.TransactionClient, userId: USER_ID, intake: on, context: undefined, accepted });

  const created = () => (prisma.measurement.create as jest.Mock).mock.calls.map(([arg]) => arg.data);

  it('registers itself, with the declared contract', () => {
    kind.onModuleInit();
    expect(registry.get('body_metric_reading')).toBe(kind);
    expect(kind.analyzeJobType).toBe('ai.health.body_metric_reading');
    expect(kind.maxPhotos).toBe(4);
    expect(kind.itemKinds).toEqual(['reading']);
    expect(kind.requiredPermissions).toEqual({ read: ['health_data:read'], write: ['health_data:write'] });
  });

  describe('contextSchema', () => {
    it('accepts no context or an empty one, refuses any key', () => {
      expect(kind.contextSchema.safeParse(undefined).success).toBe(true);
      expect(kind.contextSchema.safeParse({}).success).toBe(true);
      expect(kind.contextSchema.safeParse({ gymId: 'x' }).success).toBe(false);
    });
  });

  describe('valueSchema', () => {
    it.each([
      [{ metricKey: 'weight', value: 80, unit: 'kg' }, true],
      [{ metricKey: 'weight', value: 80, unit: 'kg', method: 'scale' }, true],
      [{ metricKey: 'energy', value: 3, unit: 'score' }, false],
      [{ metricKey: 'weight', value: '80', unit: 'kg' }, false],
      [{ metricKey: 'weight', value: 80 }, false],
      [{ metricKey: 'weight', value: 80, unit: '' }, false],
      [{ metricKey: 'weight', value: 80, unit: 'kg', origin: 'ai' }, false],
    ])('%j -> %s', (value, ok) => {
      expect(kind.valueSchema.safeParse(value).success).toBe(ok);
    });
  });

  describe('normalizeValue', () => {
    it('fixes the unit spelling for both sources', () => {
      expect(kind.normalizeValue({ metricKey: 'bp_systolic', value: 120, unit: 'mm hg' }, undefined, 'user')).toEqual({
        metricKey: 'bp_systolic',
        value: 120,
        unit: 'mmHg',
      });
      expect(kind.normalizeValue({ metricKey: 'weight', value: 80, unit: 'KG' }, undefined, 'analyzer').unit).toBe('kg');
    });

    it.each([
      [{ metricKey: 'weight', value: 80, unit: 'st' }, 'value.unit'],
      [{ metricKey: 'weight', value: 80, unit: 'kg', method: 'bp_cuff' }, 'value.method'],
      [{ metricKey: 'weight', value: 9999, unit: 'kg' }, 'value.value'],
      [{ metricKey: 'bp_diastolic', value: 10, unit: 'mmHg' }, 'value.value'],
    ] as const)('a user write of %j is a 400 naming %s, without echoing the value', (value, path) => {
      let error: unknown;
      try {
        kind.normalizeValue({ ...value }, undefined, 'user');
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(BadRequestException);
      expect(issuesOf(error).map((issue) => issue.path)).toEqual([path]);
      expect(JSON.stringify(issuesOf(error))).not.toContain('9999');
    });

    it('never throws for an analyzer write, so the doubtful AI item is kept', () => {
      expect(kind.normalizeValue({ metricKey: 'weight', value: 9999, unit: 'kg' }, undefined, 'analyzer')).toEqual({
        metricKey: 'weight',
        value: 9999,
        unit: 'kg',
      });
      expect(() => kind.normalizeValue({ metricKey: 'weight', value: 80, unit: 'st' }, undefined, 'analyzer')).not.toThrow();
    });
  });

  describe('apply', () => {
    it('writes ONE entry, converted to canonical units, measured now, with AI provenance', async () => {
      const weight = item();
      const before = Date.now();

      const result = await apply([weight]);

      const [data] = created();
      expect(data).toMatchObject({
        userId: USER_ID,
        metricKey: 'weight',
        value: 94.5286,
        unit: 'kg',
        method: 'scale',
        origin: 'ai',
        notes: null,
        sourceRef: {
          kind: 'photo_intake',
          intakeId: INTAKE_ID,
          draftItemId: weight.id,
          storageObjectIds: [PHOTO],
          aiDraft: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
          confidence: 'high',
          userEdited: false,
        },
      });
      expect(data.measuredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(result).toEqual({ entryId: expect.any(String), items: [expect.objectContaining({ origin: 'ai' })] });
      expect(result.items[0].entryId).toBe(result.entryId);
    });

    it('an edited AI item: aiDraft is the original AI value and userEdited is true', async () => {
      const edited = item({
        value: { metricKey: 'weight', value: 207.4, unit: 'lb', method: 'scale' },
        originalAiValue: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
      });

      await apply([edited]);

      expect(created()[0]).toMatchObject({
        value: 94.0751,
        sourceRef: { aiDraft: { value: 208.4 }, userEdited: true },
      });
    });

    it('an AI item edited and changed back (same canonical reading) is not userEdited', async () => {
      await apply([
        item({
          value: { metricKey: 'weight', value: 94.5286, unit: 'kg' },
          originalAiValue: { metricKey: 'weight', value: 208.4, unit: 'lb' },
        }),
      ]);

      expect(created()[0].sourceRef).toMatchObject({ userEdited: false });
    });

    it('a user item added in the review is manual, linked to the intake only', async () => {
      await apply([
        item({ origin: 'user', confidence: null, sourcePhotoIds: [], value: { metricKey: 'body_fat_pct', value: 22, unit: '%' } }),
      ]);

      expect(created()[0]).toMatchObject({
        metricKey: 'body_fat_pct',
        method: 'unspecified',
        origin: 'manual',
        sourceRef: { kind: 'photo_intake', intakeId: INTAKE_ID },
      });
      expect(Object.keys(created()[0].sourceRef)).toEqual(['kind', 'intakeId']);
    });

    it('a blood-pressure cuff: systolic and diastolic in one entry', async () => {
      await apply([
        item({ value: { metricKey: 'bp_systolic', value: 128, unit: 'mmHg', method: 'bp_cuff' } }),
        item({ value: { metricKey: 'bp_diastolic', value: 82, unit: 'mmHg', method: 'bp_cuff' } }),
      ]);

      expect(created().map((d) => [d.metricKey, d.value])).toEqual([
        ['bp_systolic', 128],
        ['bp_diastolic', 82],
      ]);
      expect(new Set(created().map((d) => d.entryId)).size).toBe(1);
    });

    it('refuses systolic without diastolic: "Enter both blood pressure numbers"', async () => {
      await expect(apply([item({ value: { metricKey: 'bp_systolic', value: 128, unit: 'mmHg' } })])).rejects.toMatchObject({
        message: 'Enter both blood pressure numbers',
      });
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('refuses systolic not above diastolic', async () => {
      const error = await apply([
        item({ value: { metricKey: 'bp_systolic', value: 80, unit: 'mmHg' } }),
        item({ value: { metricKey: 'bp_diastolic', value: 90, unit: 'mmHg' } }),
      ]).catch((caught) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(issuesOf(error)).toEqual([{ path: 'items', message: expect.stringContaining('must be higher') }]);
    });

    it('refuses the same metric accepted twice, naming the second item', async () => {
      const second = item({ value: { metricKey: 'weight', value: 209, unit: 'lb' } });
      const error = await apply([item(), second]).catch((caught) => caught);

      expect(issuesOf(error)).toEqual([
        { path: `items.${second.id}.value.metricKey`, message: 'Weight is accepted more than once; reject one of them' },
      ]);
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('refuses an out-of-range AI reading until it is edited or rejected, naming the field', async () => {
      const wild = item({ confidence: 'low', uncertain: true, value: { metricKey: 'weight', value: 9999, unit: 'kg' } });
      const error = await apply([wild]).catch((caught) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(issuesOf(error)).toEqual([
        { path: `items.${wild.id}.value.value`, message: expect.stringContaining('outside the allowed range') },
      ]);
      expect(JSON.stringify(issuesOf(error))).not.toContain('9999');
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('refuses a unit the metric does not allow and a malformed stored value', async () => {
      const badUnit = item({ value: { metricKey: 'weight', value: 14, unit: 'st' } });
      const malformed = item({ value: { nope: true } as never });
      const error = await apply([badUnit, malformed]).catch((caught) => caught);

      expect(issuesOf(error).map((issue) => issue.path)).toEqual([
        `items.${badUnit.id}.value.unit`,
        `items.${malformed.id}.value`,
      ]);
    });

    it('nothing accepted (everything rejected) writes nothing and answers a null entry', async () => {
      await expect(apply([])).resolves.toEqual({ entryId: null, items: [] });
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });

    it('refuses an intake of another kind', async () => {
      const error = await apply([item()], { ...intake, kind: 'gym_equipment' }).catch((caught) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error.getResponse() as any).details.reason).toBe('WRONG_INTAKE_KIND');
      expect(prisma.measurement.create).not.toHaveBeenCalled();
    });
  });
});
