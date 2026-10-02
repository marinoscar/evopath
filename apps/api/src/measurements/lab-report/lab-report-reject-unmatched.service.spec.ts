import { ConflictException, NotFoundException } from '@nestjs/common';
import { type DraftItem, type PhotoIntake } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import { LabReportRejectUnmatchedService } from './lab-report-reject-unmatched.service';
import { labReportValueSchema, type LabReportValue } from './lab-report.value';

// =============================================================================
// LabReportRejectUnmatchedService (#311): reject every unmatched result.
// Prisma is a hand-rolled fake (an in-memory item list behind `$transaction`).
// =============================================================================

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const INTAKE_ID = '33333333-3333-4333-8333-333333333333';

let seq = 0;

const result = (overrides: Partial<LabReportValue> = {}): LabReportValue =>
  labReportValueSchema.parse({ nameAsPrinted: 'Apolipoprotein A1', value: 1.4, unit: 'g/L', ...overrides });

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
      findMany: jest.fn(async ({ where }: any) =>
        [...store.values()]
          .filter((row) => (where.kind ? row.kind === where.kind : true))
          .filter((row) => (where.status?.not ? row.status !== where.status.not : true))
          .filter((row) => (where.id?.in ? where.id.in.includes(row.id) : true))
          .map((row) => ({ ...row })),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const id of where.id.in as string[]) {
          const row = store.get(id);
          if (!row || row.status === where.status.not) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
    },
  };
  const prisma = {
    photoIntake: { findFirst: jest.fn(async ({ where }: any) => (ownedBy(where) ? { id: intake.id } : null)) },
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };

  const service = new LabReportRejectUnmatchedService(prisma as unknown as PrismaService);
  return { service, store, tx };
}

describe('LabReportRejectUnmatchedService (#311)', () => {
  it('rejects only the not-yet-rejected unmatched results, status only, in review order', async () => {
    const unmatched = item(result());
    const editedUnmatched = item(result({ value: 1.5 }), { userVerified: true, originalAiValue: result() as never });
    const matched = item(result({ nameAsPrinted: 'LDL Cholesterol', analyteKey: 'ldl_cholesterol', unit: 'mmol/L', value: 2.4 }));
    const suggested = item(result({ analyteKey: 'chol_hdl_ratio', unit: 'ratio', value: 3.6, match: 'suggested' }));
    const already = item(result(), { status: 'rejected' });
    const accepted = item(result({ nameAsPrinted: 'Lp-PLA2' }), { status: 'accepted' });
    const { service, store, tx } = setup([unmatched, editedUnmatched, matched, suggested, already, accepted]);

    const answer = await service.rejectUnmatched(USER_ID, INTAKE_ID);

    expect(answer.items.map((i) => i.id)).toEqual([unmatched.id, editedUnmatched.id, accepted.id]);
    expect(answer.items.every((i) => i.status === 'rejected')).toBe(true);
    for (const rejected of [unmatched, editedUnmatched, accepted]) {
      const stored = store.get(rejected.id)!;
      expect(stored.status).toBe('rejected');
      expect(stored.value).toEqual(rejected.value);
      expect(stored.userVerified).toBe(rejected.userVerified);
      expect(stored.originalAiValue).toEqual(rejected.originalAiValue);
    }
    expect(store.get(matched.id)!.status).toBe('pending');
    expect(store.get(suggested.id)!.status).toBe('pending');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list and writes nothing when there is nothing to reject', async () => {
    const { service, tx } = setup([item(result(), { status: 'rejected' }), item(result({ analyteKey: 'ldl_cholesterol', unit: 'mmol/L' }))]);

    await expect(service.rejectUnmatched(USER_ID, INTAKE_ID)).resolves.toEqual({ items: [] });
    expect(tx.draftItem.updateMany).not.toHaveBeenCalled();
  });

  it("404s on another user's intake", async () => {
    const { service, tx } = setup([item(result())]);

    await expect(service.rejectUnmatched(OTHER_USER_ID, INTAKE_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.draftItem.updateMany).not.toHaveBeenCalled();
  });

  it('409s ALREADY_APPLIED on an applied intake', async () => {
    const { service, tx } = setup([item(result())], { status: 'applied' });

    const error = await service.rejectUnmatched(USER_ID, INTAKE_ID).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ details: { reason: 'ALREADY_APPLIED' } });
    expect(tx.draftItem.updateMany).not.toHaveBeenCalled();
  });
});
