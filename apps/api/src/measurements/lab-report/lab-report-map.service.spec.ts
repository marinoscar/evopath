import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, type DraftItem, type PhotoIntake } from '@prisma/client';

import { IntakeKindRegistry } from '../../intake/intake-kind.registry';
import { IntakeService } from '../../intake/intake.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MeasurementsService } from '../measurements.service';
import { mapLabResultSchema } from './dto/lab-report-map.dto';
import { LabReportMapService } from './lab-report-map.service';
import { LabReportIntakeKind } from './lab-report.kind';
import { labReportValueSchema, type LabReportValue } from './lab-report.value';

// =============================================================================
// LabReportMapService (#307): map once, apply to every same-named result.
// Prisma is a hand-rolled fake (an in-memory item list behind `$transaction`);
// validation is the REAL item-PATCH path (`IntakeService.validateUserValue`
// over the real `lab_report` kind).
// =============================================================================

const USER_ID = '11111111-1111-4111-8111-111111111111';
const INTAKE_ID = '33333333-3333-4333-8333-333333333333';

let seq = 0;

const result = (overrides: Partial<LabReportValue> = {}): LabReportValue =>
  labReportValueSchema.parse({ nameAsPrinted: 'Chol/HDL Ratio', value: 3.6, unit: null, ...overrides });

function item(value: unknown, overrides: Partial<DraftItem> = {}): DraftItem {
  seq += 1;
  return {
    id: `44444444-4444-4444-8444-${String(seq).padStart(12, '0')}`,
    intakeId: INTAKE_ID,
    kind: 'result',
    origin: 'ai',
    status: 'pending',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
    sourcePhotoIds: [],
    userVerified: false,
    value,
    originalAiValue: null,
    sortOrder: seq,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as DraftItem;
}

function setup(rows: DraftItem[], intakeOverrides: Partial<PhotoIntake> = {}) {
  const intake = { id: INTAKE_ID, userId: USER_ID, kind: 'lab_report', status: 'ready', context: null, ...intakeOverrides } as PhotoIntake;
  const store = new Map(rows.map((row) => [row.id, { ...row }]));

  const ownedBy = (where: { id: string; userId: string; kind: string }) =>
    where.id === intake.id && where.userId === intake.userId && where.kind === intake.kind ? intake : null;

  const tx = {
    $queryRaw: jest.fn(async () => [{ id: INTAKE_ID }]),
    photoIntake: { findFirst: jest.fn(async ({ where }: any) => ownedBy(where)) },
    draftItem: {
      findMany: jest.fn(async () => [...store.values()].filter((row) => row.kind === 'result')),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = store.get(where.id);
        if (!row || row.originalAiValue !== null) return { count: 0 };
        row.originalAiValue = data.originalAiValue;
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.get(where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      }),
    },
  };
  const prisma = {
    photoIntake: { findFirst: jest.fn(async ({ where }: any) => (ownedBy(where) ? { id: intake.id } : null)) },
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };

  const kinds = new IntakeKindRegistry();
  new LabReportIntakeKind(kinds, {} as MeasurementsService).onModuleInit();
  const intakes = new IntakeService(prisma as never, kinds, {} as never, {} as never, {} as never, {} as never, {} as never);
  const service = new LabReportMapService(prisma as unknown as PrismaService, intakes);

  return { service, store, tx, prisma };
}

const valueOf = (row: { value: unknown }) => row.value as LabReportValue;

describe('LabReportMapService (#307)', () => {
  it('maps the clicked result and every same-named result across dates, keeping their status', async () => {
    const dates = ['2025-01-10', '2025-04-11', '2025-07-12', '2025-10-13', '2026-01-14'];
    const rows = dates.map((collectionDate, i) =>
      item(result({ collectionDate, nameAsPrinted: i === 3 ? 'CHOL / HDL  ratio' : 'Chol/HDL Ratio' }), {
        status: i === 4 ? 'accepted' : 'pending',
      }),
    );
    const { service, store, tx } = setup(rows);

    const answer = await service.map(USER_ID, INTAKE_ID, { itemId: rows[2].id, analyteKey: 'chol_hdl_ratio' });

    expect(answer.skipped).toEqual([]);
    expect(answer.items.map((i) => i.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(answer.items.map((i) => i.id)).toEqual(rows.map((r) => r.id)); // review order
    for (const row of rows) {
      const stored = store.get(row.id)!;
      expect(valueOf(stored)).toMatchObject({ analyteKey: 'chol_hdl_ratio', unit: 'ratio', panel: 'lipids', match: 'matched', value: 3.6 });
      expect(stored).toMatchObject({ userVerified: true, status: row.status });
      expect(stored.originalAiValue).toEqual(row.value);
    }
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('leaves rejected, user-mapped-elsewhere and differently named items untouched', async () => {
    const clicked = item(result());
    const rejected = item(result(), { status: 'rejected' });
    const elsewhere = item(result({ analyteKey: 'ldl_hdl_ratio', unit: 'ratio', match: 'user_mapped' }), {
      originalAiValue: result() as unknown as Prisma.JsonValue,
    });
    const userAdded = item(result({ analyteKey: 'tg_hdl_ratio', unit: 'ratio' }), { origin: 'user', confidence: null });
    const other = item(result({ nameAsPrinted: 'LDL/HDL Ratio' }));
    // An AI suggestion of another key, never touched by the user, IS remapped.
    const suggested = item(result({ analyteKey: 'ldl_hdl_ratio', unit: 'ratio', match: 'suggested' }));
    const { service, store } = setup([clicked, rejected, elsewhere, userAdded, other, suggested]);

    const answer = await service.map(USER_ID, INTAKE_ID, { itemId: clicked.id, analyteKey: 'chol_hdl_ratio' });

    expect(answer.items.map((i) => i.id)).toEqual([clicked.id, suggested.id]);
    for (const untouched of [rejected, elsewhere, userAdded, other]) {
      expect(store.get(untouched.id)!.value).toEqual(untouched.value);
      expect(store.get(untouched.id)!.userVerified).toBe(false);
    }
    expect(valueOf(store.get(suggested.id)!)).toMatchObject({ analyteKey: 'chol_hdl_ratio', match: 'matched' });
  });

  it('maps a rejected clicked item itself, and a same-named item already user-mapped to the SAME key', async () => {
    const clicked = item(result(), { status: 'rejected' });
    const same = item(result({ analyteKey: 'chol_hdl_ratio', unit: 'ratio' }), { origin: 'user', confidence: null });
    const { service } = setup([clicked, same]);

    const answer = await service.map(USER_ID, INTAKE_ID, { itemId: clicked.id, analyteKey: 'chol_hdl_ratio' });

    expect(answer.items.map((i) => [i.id, i.status])).toEqual([
      [clicked.id, 'rejected'],
      [same.id, 'pending'],
    ]);
  });

  it('skips a same-named result the PATCH would refuse, with the rule, never the value', async () => {
    const clicked = item(result());
    const badUnit = item(result({ unit: 'mg/dL', value: 4.25 }));
    const outOfBounds = item(result({ value: 999 }));
    const { service, store } = setup([clicked, badUnit, outOfBounds]);

    const answer = await service.map(USER_ID, INTAKE_ID, { itemId: clicked.id, analyteKey: 'chol_hdl_ratio' });

    expect(answer.items.map((i) => i.id)).toEqual([clicked.id]);
    expect(answer.skipped).toEqual([
      { itemId: badUnit.id, message: expect.stringContaining('unit must be one of ratio') },
      { itemId: outOfBounds.id, message: expect.stringContaining('outside the allowed range') },
    ]);
    expect(JSON.stringify(answer.skipped)).not.toMatch(/4\.25|999/);
    expect(store.get(badUnit.id)!.value).toEqual(badUnit.value);
    expect(store.get(badUnit.id)!.userVerified).toBe(false);
  });

  it('answers the 400 the PATCH would when the CLICKED item is refused, writing nothing', async () => {
    const clicked = item(result({ unit: 'mg/dL' }));
    const twin = item(result());
    const { service, tx } = setup([clicked, twin]);

    await expect(service.map(USER_ID, INTAKE_ID, { itemId: clicked.id, analyteKey: 'chol_hdl_ratio' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.draftItem.update).not.toHaveBeenCalled();
  });

  it('refuses a key outside the lab catalog with a 400, at the body and in the service', async () => {
    const clicked = item(result());
    expect(mapLabResultSchema.safeParse({ itemId: clicked.id, analyteKey: 'weight' }).success).toBe(false);
    expect(mapLabResultSchema.safeParse({ itemId: clicked.id, analyteKey: 'chol_hdl_ratio' }).success).toBe(true);
    expect(mapLabResultSchema.safeParse({ itemId: 'nope', analyteKey: 'chol_hdl_ratio' }).success).toBe(false);
    expect(mapLabResultSchema.safeParse({ itemId: clicked.id, analyteKey: 'chol_hdl_ratio', extra: 1 }).success).toBe(false);

    const { service } = setup([clicked]);
    await expect(service.map(USER_ID, INTAKE_ID, { itemId: clicked.id, analyteKey: 'not_a_lab' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s for another user, an unknown intake or an item of another intake; 409 once applied', async () => {
    const clicked = item(result());
    const { service } = setup([clicked]);
    const OTHER = '99999999-9999-4999-8999-999999999999';

    await expect(service.map(OTHER, INTAKE_ID, { itemId: clicked.id, analyteKey: 'chol_hdl_ratio' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.map(USER_ID, OTHER, { itemId: clicked.id, analyteKey: 'chol_hdl_ratio' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.map(USER_ID, INTAKE_ID, { itemId: OTHER, analyteKey: 'chol_hdl_ratio' })).rejects.toBeInstanceOf(NotFoundException);

    const applied = setup([item(result())], { status: 'applied' });
    const error = await applied.service
      .map(USER_ID, INTAKE_ID, { itemId: [...applied.store.keys()][0], analyteKey: 'chol_hdl_ratio' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ details: { reason: 'ALREADY_APPLIED' } });
  });

  it('maps only the clicked item when it has no printed name', async () => {
    const clicked = item(labReportValueSchema.parse({ value: 3.6 }), { origin: 'user', confidence: null });
    const other = item(labReportValueSchema.parse({ value: 3.1 }), { origin: 'user', confidence: null });
    const { service } = setup([clicked, other]);

    const answer = await service.map(USER_ID, INTAKE_ID, { itemId: clicked.id, analyteKey: 'chol_hdl_ratio' });
    expect(answer.items.map((i) => i.id)).toEqual([clicked.id]);
    expect(answer.items[0].value).toMatchObject({ nameAsPrinted: 'Cholesterol/HDL ratio', unit: 'ratio' });
  });

  describe('unit (re-read every same-named result printed with the same unit)', () => {
    // The model read "mg/dL" where the report printed mmol/L; mg/dL is canonical, so nothing was converted.
    const misread = (n: number, overrides: Partial<LabReportValue> = {}) =>
      labReportValueSchema.parse({
        analyteKey: 'fasting_glucose',
        nameAsPrinted: 'Glucose',
        value: n,
        unit: 'mg/dL',
        originalValue: n,
        originalUnit: 'mg/dL',
        referenceLow: 3.9,
        referenceHigh: 5.5,
        panel: 'glycemic',
        match: 'matched',
        ...overrides,
      });

    it('re-reads the clicked result and its misread twins in the new unit, leaving re-numbered and differently printed ones', async () => {
      const twins = [5.4, 5.6, 5.1].map((n) => item(misread(n)));
      const renumbered = item(misread(99, { originalValue: 5.3 }), { originalAiValue: misread(5.3) as unknown as Prisma.JsonValue });
      const printedRight = item(misread(100.9, { originalValue: 5.6, originalUnit: 'mmol/L' }));
      const otherAnalyte = item(misread(5.4, { analyteKey: 'hba1c', unit: '%', originalUnit: 'mg/dL', match: 'user_mapped' }));
      const { service, store } = setup([...twins, renumbered, printedRight, otherAnalyte]);

      const answer = await service.map(USER_ID, INTAKE_ID, { itemId: twins[1].id, unit: 'mmol/L' });

      expect(answer.items.map((i) => i.id)).toEqual(twins.map((t) => t.id));
      expect(answer.skipped).toEqual([]);
      for (const [i, n] of [5.4, 5.6, 5.1].entries()) {
        const stored = valueOf(store.get(twins[i].id)!);
        expect(stored).toMatchObject({ unit: 'mg/dL', originalValue: n, originalUnit: 'mg/dL' });
        expect(stored.value!).toBeCloseTo(n / 0.0555, 2);
        expect(stored.referenceLow!).toBeCloseTo(3.9 / 0.0555, 2);
      }
      for (const untouched of [renumbered, printedRight, otherAnalyte]) {
        expect(store.get(untouched.id)!.value).toEqual(untouched.value);
      }
    });

    it('is a no-op for a clicked result that already reads in the unit, still listing it', async () => {
      const clicked = item(misread(5.4, { value: 5.4 / 0.0555 }), { originalAiValue: misread(5.4) as unknown as Prisma.JsonValue });
      // Its value as stored by the PATCH (canonical, rounded).
      const patched = { ...valueOf(clicked), value: Math.round((5.4 / 0.0555) * 1e4) / 1e4 };
      clicked.value = patched as unknown as Prisma.JsonValue;
      const twin = item(misread(5.6));
      const { service, tx } = setup([clicked, twin]);

      const answer = await service.map(USER_ID, INTAKE_ID, { itemId: clicked.id, unit: 'mmol/L' });

      expect(answer.items.map((i) => [i.id, i.userVerified])).toEqual([
        [clicked.id, false],
        [twin.id, true],
      ]);
      expect(tx.draftItem.update).toHaveBeenCalledTimes(1);
    });

    it('maps then re-reads in one call, and skips a twin the new unit puts out of bounds', async () => {
      const unmatched = (n: number) => labReportValueSchema.parse({ nameAsPrinted: 'Glu', value: n, unit: 'mg/dL', originalValue: n, originalUnit: 'mg/dL' });
      const clicked = item(unmatched(5.4));
      const huge = item(unmatched(150));
      const { service, store } = setup([clicked, huge]);

      const answer = await service.map(USER_ID, INTAKE_ID, { itemId: clicked.id, analyteKey: 'fasting_glucose', unit: 'mmol/L' });

      expect(answer.items.map((i) => i.id)).toEqual([clicked.id]);
      expect(answer.skipped).toEqual([{ itemId: huge.id, message: expect.stringContaining('outside the allowed range') }]);
      expect(valueOf(store.get(clicked.id)!)).toMatchObject({ analyteKey: 'fasting_glucose', unit: 'mg/dL', match: 'matched' });
      expect(store.get(huge.id)!.value).toEqual(huge.value);
    });

    it('answers the 400 when the clicked result cannot take the unit', async () => {
      const clicked = item(misread(5.4));
      const { service } = setup([clicked]);
      await expect(service.map(USER_ID, INTAKE_ID, { itemId: clicked.id, unit: 'furlongs' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires an analyteKey or a unit in the body', () => {
      const itemId = '44444444-4444-4444-8444-000000000001';
      expect(mapLabResultSchema.safeParse({ itemId }).success).toBe(false);
      expect(mapLabResultSchema.safeParse({ itemId, unit: 'mmol/L' }).success).toBe(true);
      expect(mapLabResultSchema.safeParse({ itemId, unit: '  ' }).success).toBe(false);
    });
  });
});
