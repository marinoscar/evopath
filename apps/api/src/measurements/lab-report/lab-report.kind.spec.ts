import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, type DraftItem, type PhotoIntake } from '@prisma/client';

import { createMockPrismaService, type MockPrismaService } from '../../../test/mocks/prisma.mock';
import { IntakeKindRegistry } from '../../intake/intake-kind.registry';
import type { PrismaService } from '../../prisma/prisma.service';
import { MeasurementsService } from '../measurements.service';
import { withRecomputedUserEdited, healthDocumentIdOf } from '../photo/photo-source-ref';
import { LabReportIntakeKind } from './lab-report.kind';
import { labReportValueSchema, type LabReportContext, type LabReportValue } from './lab-report.value';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const INTAKE_ID = '33333333-3333-4333-8333-333333333333';
const DOC_OBJECT = '55555555-5555-4555-8555-555555555555';
const DOC_ID = '66666666-6666-4666-8666-666666666666';

let seq = 0;

const glucose = (overrides: Partial<LabReportValue> = {}): LabReportValue =>
  labReportValueSchema.parse({
    analyteKey: 'fasting_glucose',
    nameAsPrinted: 'Glucose',
    value: 97.2973,
    unit: 'mg/dL',
    originalValue: 5.4,
    originalUnit: 'mmol/L',
    referenceLow: 70.2703,
    referenceHigh: 99.0991,
    referenceText: '3.9-5.5',
    panel: 'glycemic',
    match: 'matched',
    ...overrides,
  });

function item(value: unknown, overrides: Partial<DraftItem> = {}): DraftItem {
  seq += 1;
  return {
    id: `44444444-4444-4444-8444-${String(seq).padStart(12, '0')}`,
    intakeId: INTAKE_ID,
    kind: 'result',
    origin: 'ai',
    status: 'accepted',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
    sourcePhotoIds: [DOC_OBJECT],
    userVerified: true,
    value,
    originalAiValue: null,
    sortOrder: seq,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as DraftItem;
}

const intake = { id: INTAKE_ID, userId: USER_ID, kind: 'lab_report', status: 'ready' } as PhotoIntake;
const DOCS = [{ id: DOC_ID, storageObjectId: DOC_OBJECT }];

describe('LabReportIntakeKind (H4, #188)', () => {
  let prisma: MockPrismaService;
  let kind: LabReportIntakeKind;
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
    (prisma.healthDocument.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.healthDocument.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    registry = new IntakeKindRegistry();
    kind = new LabReportIntakeKind(registry, new MeasurementsService(prisma as unknown as PrismaService));
  });

  const apply = (accepted: DraftItem[], context: LabReportContext = { collectionDate: '2026-09-15', labName: 'Acme' }) =>
    kind.apply({
      tx: prisma as unknown as Prisma.TransactionClient,
      userId: USER_ID,
      intake,
      context,
      accepted,
      healthDocuments: DOCS,
    });

  const created = () => (prisma.measurement.create as jest.Mock).mock.calls.map(([arg]) => arg.data);

  it('registers itself with the declared contract', () => {
    kind.onModuleInit();
    expect(registry.get('lab_report')).toBe(kind);
    expect(kind).toMatchObject({
      analyzeJobType: 'ai.health.lab_report',
      aiFeature: 'lab_report',
      maxPhotos: 10,
      itemKinds: ['result'],
      acceptedInputs: ['image', 'pdf'],
      healthDocumentKind: 'lab_report',
      requiredPermissions: { read: ['health_data:read'], write: ['health_data:write'] },
    });
  });

  describe('normalizeValue', () => {
    it('analyzer: converts leniently and never throws', () => {
      const raw = glucose({ value: 5.4, unit: 'mmol/L', referenceLow: 3.9, referenceHigh: 5.5 });
      expect(kind.normalizeValue(raw, undefined, 'analyzer')).toMatchObject({ value: 97.2973, unit: 'mg/dL' });
      expect(kind.normalizeValue(glucose({ unit: 'furlongs' }), undefined, 'analyzer').unit).toBe('furlongs');
    });

    it('user: maps an unmatched result to a catalog key, recomputes match and converts', () => {
      const mapped = kind.normalizeValue(
        labReportValueSchema.parse({ analyteKey: 'apob', nameAsPrinted: 'Lipoprotein (a)', value: 0.9, unit: 'g/L', match: 'unmatched' }),
        undefined,
        'user',
      );
      expect(mapped).toMatchObject({ analyteKey: 'apob', value: 90, unit: 'mg/dL', originalValue: 0.9, originalUnit: 'g/L', match: 'user_mapped', panel: 'lipids' });

      expect(kind.normalizeValue(glucose({ match: 'suggested' }), undefined, 'user').match).toBe('matched');
      expect(kind.normalizeValue(glucose({ analyteKey: null }), undefined, 'user').match).toBe('unmatched');
    });

    it('user: fills a missing unit and name, refuses a unit, a bound or a range with a 400 naming the field', () => {
      expect(
        kind.normalizeValue(labReportValueSchema.parse({ analyteKey: 'hba1c', value: 5.6 }), undefined, 'user'),
      ).toMatchObject({ unit: '%', nameAsPrinted: 'HbA1c', match: 'matched' });

      const refused = (value: LabReportValue) => {
        try {
          kind.normalizeValue(value, undefined, 'user');
        } catch (error) {
          expect(error).toBeInstanceOf(BadRequestException);
          return ((error as BadRequestException).getResponse() as any).details.issues.map((i: any) => i.path);
        }
        throw new Error('expected a refusal');
      };
      expect(refused(glucose({ unit: 'furlongs' }))).toEqual(['value.unit']);
      expect(refused(glucose({ value: 99999 }))).toEqual(['value.value']);
      expect(refused(glucose({ referenceLow: 100, referenceHigh: 70 }))).toEqual(['value.referenceLow']);
    });
  });

  describe('apply', () => {
    it('refuses with 409 UNRESOLVED_ANALYTES listing every unmatched accepted item, writing nothing', async () => {
      const a = item(labReportValueSchema.parse({ nameAsPrinted: 'Lipoprotein (a)', value: 32, unit: 'nmol/L' }));
      const b = item(labReportValueSchema.parse({ nameAsPrinted: 'Chol/HDL ratio', value: 4.4 }));

      const error = await apply([item(glucose()), a, b]).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        details: { reason: 'UNRESOLVED_ANALYTES', itemIds: [a.id, b.id], count: 2 },
      });
      expect(created()).toEqual([]);
    });

    it('writes one lab entry at the collection date with range, flag, method lab and lab_report provenance', async () => {
      const ldl = item(
        labReportValueSchema.parse({
          analyteKey: 'ldl_cholesterol',
          nameAsPrinted: 'LDL Chol Calc',
          value: 138,
          unit: 'mg/dL',
          originalValue: 138,
          originalUnit: 'mg/dL',
          referenceLow: 0,
          referenceHigh: 99,
          referenceText: '0-99',
          flag: 'high',
          panel: 'lipids',
          match: 'matched',
        }),
      );
      const sugar = item(glucose());

      const result = await apply([ldl, sugar]);

      const rows = created();
      expect(new Set(rows.map((r) => r.entryId)).size).toBe(1);
      expect(rows[0]).toMatchObject({
        userId: USER_ID,
        metricKey: 'ldl_cholesterol',
        value: 138,
        unit: 'mg/dL',
        method: 'lab',
        origin: 'ai',
        referenceLow: 0,
        referenceHigh: 99,
        referenceText: '0-99',
        flag: 'high',
        measuredAt: new Date('2026-09-15T12:00:00.000Z'),
      });
      expect(rows[0].sourceRef).toEqual({
        kind: 'lab_report',
        intakeId: INTAKE_ID,
        draftItemId: ldl.id,
        storageObjectIds: [DOC_OBJECT],
        healthDocumentId: DOC_ID,
        aiDraft: ldl.value,
        confidence: 'high',
        userEdited: false,
        nameAsPrinted: 'LDL Chol Calc',
        originalValue: 138,
        originalUnit: 'mg/dL',
        match: 'matched',
        collectionDate: '2026-09-15',
        labName: 'Acme',
      });
      // Glucose read in mmol/L is stored canonically; the printed unit stays in the provenance.
      expect(rows[1]).toMatchObject({ metricKey: 'fasting_glucose', value: 97.2973, unit: 'mg/dL' });
      expect(rows[1].sourceRef).toMatchObject({ originalValue: 5.4, originalUnit: 'mmol/L' });

      expect(prisma.healthDocument.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [DOC_ID] }, userId: USER_ID },
        data: { documentDate: new Date('2026-09-15T00:00:00.000Z'), version: { increment: 1 } },
      });
      expect(result).toMatchObject({ measuredAtSource: 'collection_date', documentDate: '2026-09-15' });
      expect(result.items).toHaveLength(2);
    });

    it('an edited AI result sets userEdited and keeps originalAiValue; a user-added one is manual', async () => {
      const edited = item(glucose({ value: 90 }), { originalAiValue: glucose() as never });
      const added = item(labReportValueSchema.parse({ analyteKey: 'hba1c', nameAsPrinted: 'HbA1c', value: 5.6, unit: '%', match: 'matched' }), {
        origin: 'user',
        confidence: null,
        sourcePhotoIds: [],
      });

      await apply([edited, added]);

      const [aiRow, userRow] = created();
      expect(aiRow).toMatchObject({ value: 90, origin: 'ai' });
      expect(aiRow.sourceRef).toMatchObject({ userEdited: true, originalAiValue: 97.2973, aiDraft: { value: 97.2973 } });
      expect(userRow).toMatchObject({ origin: 'manual' });
      expect(userRow.sourceRef).toEqual({
        kind: 'lab_report',
        intakeId: INTAKE_ID,
        healthDocumentId: DOC_ID,
        userAdded: true,
        collectionDate: '2026-09-15',
        labName: 'Acme',
      });
    });

    it('without a collection date, dates the results now and flags it; no document date', async () => {
      const before = Date.now();
      const result = await apply([item(glucose())], {});

      expect(created()[0].measuredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(created()[0].sourceRef).toMatchObject({ collectionDate: null });
      expect(result).toMatchObject({ measuredAtSource: 'apply_time', documentDate: null });
      expect(prisma.healthDocument.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a result without a number, a repeated analyte and more than 40 results, all at once', async () => {
      const noNumber = item(glucose({ value: null, valueText: 'see note' }));
      const twice = item(glucose());
      const error = await apply([noNumber, twice]).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      const issues = error.getResponse().details.issues;
      // The repeated analyte is reported on each of its results (#317).
      expect(issues.map((i: any) => i.path)).toEqual([
        `items.${noNumber.id}.value.value`,
        `items.${noNumber.id}.value.analyteKey`,
        `items.${twice.id}.value.analyteKey`,
      ]);
      expect(JSON.stringify(issues)).not.toContain('97.2973');

      const many = Array.from({ length: 151 }, () => item(glucose()));
      const tooMany = await apply(many).catch((e) => e);
      expect(JSON.stringify(tooMany.getResponse())).toContain('at most 150 results');
    });

    it('answers an empty result when every item was rejected', async () => {
      await expect(apply([])).resolves.toEqual({
        entryId: null,
        entryIds: [],
        entries: [],
        items: [],
        measuredAtSource: null,
        documentDate: null,
      });
    });

    describe('multi-date reports (#305)', () => {
      const albumin = (date: string | null, value = 4.4) =>
        labReportValueSchema.parse({
          analyteKey: 'albumin',
          nameAsPrinted: 'Albumin Lvl',
          value,
          unit: 'g/dL',
          panel: 'cmp',
          match: 'matched',
          collectionDate: date,
        });

      it('writes one entry per effective date, newest first, each dated with its own date', async () => {
        const old = item(albumin('2023-04-06', 4.2));
        const newest = item(albumin('2025-11-19', 4.6));
        const reportDated = item(glucose()); // no own date: the report date 2026-09-15
        const sugarOld = item(glucose({ collectionDate: '2023-04-06' }));

        const result = await apply([old, newest, reportDated, sugarOld]);

        const rows = created();
        expect(new Set(rows.map((r) => r.entryId)).size).toBe(3);
        const byItem = (id: string) => rows.find((r) => r.sourceRef.draftItemId === id);
        expect(byItem(old.id)).toMatchObject({ measuredAt: new Date('2023-04-06T12:00:00.000Z'), value: 4.2 });
        expect(byItem(old.id).sourceRef).toMatchObject({ collectionDate: '2023-04-06', labName: 'Acme' });
        expect(byItem(sugarOld.id).entryId).toBe(byItem(old.id).entryId);
        expect(byItem(newest.id)).toMatchObject({ measuredAt: new Date('2025-11-19T12:00:00.000Z') });
        expect(byItem(reportDated.id)).toMatchObject({ measuredAt: new Date('2026-09-15T12:00:00.000Z') });
        expect(byItem(reportDated.id).sourceRef).toMatchObject({ collectionDate: '2026-09-15' });

        expect(result.entries.map((e) => e.collectionDate)).toEqual(['2026-09-15', '2025-11-19', '2023-04-06']);
        expect(result.entries.map((e) => e.items.length)).toEqual([1, 1, 2]);
        expect(result.entryIds).toEqual(result.entries.map((e) => e.entryId));
        expect(result.entryId).toBe(result.entries[0].entryId);
        expect(result.items).toHaveLength(4);
        expect(result).toMatchObject({ measuredAtSource: 'collection_date', documentDate: '2026-09-15' });
        expect(prisma.healthDocument.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.healthDocument.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { documentDate: new Date('2026-09-15T00:00:00.000Z'), version: { increment: 1 } } }),
        );
      });

      it('saves undated results at apply time in their own entry, last, as mixed; the document gets the newest date', async () => {
        const before = Date.now();
        const result = await apply([item(albumin(null)), item(albumin('2024-05-02')), item(albumin('2025-11-19'))], { labName: null });

        expect(result.entries.map((e) => e.collectionDate)).toEqual(['2025-11-19', '2024-05-02', null]);
        const undated = created().find((r) => r.entryId === result.entries[2].entryId);
        expect(undated.measuredAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(undated.sourceRef).toMatchObject({ collectionDate: null });
        expect(result).toMatchObject({ measuredAtSource: 'mixed', documentDate: '2025-11-19' });
      });

      it('allows the same analyte on different dates, refuses it twice on one date naming the date', async () => {
        await expect(apply([item(albumin('2025-11-19')), item(albumin('2024-05-02'))])).resolves.toMatchObject({
          entryIds: [expect.any(String), expect.any(String)],
        });

        const first = item(albumin('2025-11-19'));
        const twice = item(albumin('2025-11-19', 4.5));
        const error = await apply([first, twice, item(albumin('2024-05-02'))]).catch((e) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.getResponse().details.issues).toEqual(
          [first, twice].map(({ id }) => ({
            path: `items.${id}.value.analyteKey`,
            message: 'Albumin appears more than once on 2025-11-19; reject one of them or change its date',
          })),
        );

        // An item without its own date joins the report-date group.
        const sameAsReport = item(glucose({ collectionDate: '2026-09-15' }));
        const clash = await apply([item(glucose()), sameAsReport]).catch((e) => e);
        expect(clash.getResponse().details.issues[1]).toMatchObject({ path: `items.${sameAsReport.id}.value.analyteKey` });
        expect(created()).toHaveLength(2); // only the first, valid apply wrote
      });

      it('applies the 150-result cap per date, naming the date', async () => {
        const keys = ['total_cholesterol', 'ldl_cholesterol', 'hdl_cholesterol', 'triglycerides'];
        const pad = (n: number) => String(n).padStart(2, '0');
        const dates = Array.from({ length: 40 }, (_, i) => `2025-${pad((i % 12) + 1)}-${pad(Math.floor(i / 12) + 1)}`);
        // 160 results over 40 dates (4 per date): allowed, though more than 150 in total.
        const spread = dates.flatMap((date) =>
          keys.map((key) => item(labReportValueSchema.parse({ analyteKey: key, value: 100, unit: 'mg/dL', collectionDate: date }))),
        );
        await expect(apply(spread)).resolves.toMatchObject({ items: expect.any(Array) });
        expect(created()).toHaveLength(160);

        const crowded = Array.from({ length: 151 }, () =>
          item(labReportValueSchema.parse({ analyteKey: 'albumin', value: 4, unit: 'g/dL', collectionDate: '2025-11-19' })),
        );
        const error = await apply(crowded).catch((e) => e);
        const messages = error.getResponse().details.issues.map((i: any) => i.message);
        expect(messages).toContain(
          'One collection date saves at most 150 results; 151 are listed on 2025-11-19, reject 1 of them',
        );
      });
    });
  });

  describe('provenance helpers', () => {
    it('healthDocumentIdOf reads lab_report refs; a later edit recomputes userEdited', () => {
      const ref = { kind: 'lab_report', healthDocumentId: DOC_ID, aiDraft: glucose(), userEdited: false };
      expect(healthDocumentIdOf(ref)).toBe(DOC_ID);

      const changed = withRecomputedUserEdited(ref, { metricKey: 'fasting_glucose', value: 100, unit: 'mg/dL' }) as any;
      expect(changed).toMatchObject({ userEdited: true, originalAiValue: 97.2973 });

      const back = withRecomputedUserEdited(changed, { metricKey: 'fasting_glucose', value: 97.2973, unit: 'mg/dL' }) as any;
      expect(back.userEdited).toBe(false);
      expect('originalAiValue' in back).toBe(false);
    });
  });
});
