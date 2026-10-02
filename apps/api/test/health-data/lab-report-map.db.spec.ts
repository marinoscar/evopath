// =============================================================================
// Real-Postgres test: map once, apply to every same-named result (#307)
// =============================================================================
//
// What only real rows (and the real `FOR UPDATE` on `photo_intakes`) can prove,
// for `LabReportMapService` behind `POST /api/measurements/lab-reports/:id/map`:
//   - five unmatched "Chol/HDL Ratio" results on five collection dates (a
//     trend report read before the catalog knew the ratio) are all mapped by
//     ONE call: analyte, `ratio` unit, lipids panel, `match`, `userVerified`,
//     `originalAiValue` and `updatedAt` as the item PATCH would leave them;
//     their status is kept;
//   - a rejected twin, a twin the user mapped to a different analyte and a
//     differently named result are left exactly as they were;
//   - a twin whose unit the analyte refuses is skipped (and unchanged);
//   - the mapped results then apply as one entry per date;
//   - another user's intake is a 404, a key outside the lab catalog a 400,
//     an applied intake a 409.
//
// Drafts are inserted directly (the analyzer path is covered by
// `lab-report.db.spec.ts`). Every user is created with run-unique values and
// removed in `afterAll`.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with
// `npm run test:db` against a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { IntakeService } from '../../src/intake/intake.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { LabReportMapService } from '../../src/measurements/lab-report/lab-report-map.service';
import { LabReportIntakeKind } from '../../src/measurements/lab-report/lab-report.kind';
import { labReportValueSchema, type LabReportValue } from '../../src/measurements/lab-report/lab-report.value';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('lab-report-map.db.spec');

const PERMS = ['intakes:read', 'intakes:write', 'health_data:read', 'health_data:write'];
const DATES = ['2025-01-10', '2025-04-11', '2025-07-12', '2025-10-13', '2026-01-14'];

describeWithDb('lab report map once (real Postgres)', () => {
  let client: PrismaClient;
  let intakes: IntakeService;
  let mapping: LabReportMapService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `lab-map-${label}-${run}@example.com` }, select: { id: true } });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function makeIntake(userId: string): Promise<string> {
    const intake = await intakes.create(userId, { kind: 'lab_report' }, PERMS);
    await client.photoIntake.update({ where: { id: intake.id }, data: { status: 'ready' } });
    return intake.id;
  }

  let sortOrder = 0;
  async function draft(intakeId: string, value: Partial<LabReportValue>, extra: { status?: string; originalAiValue?: object } = {}) {
    sortOrder += 1;
    return client.draftItem.create({
      data: {
        intakeId,
        kind: 'result',
        origin: 'ai',
        status: extra.status ?? 'pending',
        confidence: 'high',
        value: labReportValueSchema.parse(value) as object,
        ...(extra.originalAiValue ? { originalAiValue: extra.originalAiValue } : {}),
        sortOrder,
      },
    });
  }

  const ratio = (overrides: Partial<LabReportValue> = {}): Partial<LabReportValue> => ({
    nameAsPrinted: 'Chol/HDL Ratio',
    value: 3.6,
    unit: null,
    match: 'unmatched',
    ...overrides,
  });

  const row = (id: string) => client.draftItem.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const kinds = new IntakeKindRegistry();
    new LabReportIntakeKind(kinds, new MeasurementsService(prisma)).onModuleInit();
    intakes = new IntakeService(prisma, kinds, new JobsService(prisma), {} as never, {} as never, {} as never, {} as never);
    mapping = new LabReportMapService(prisma, intakes);
  });

  afterAll(async () => {
    await client.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
  });

  it('maps five same-named results across dates in one call, leaving rejected, user-mapped and other names alone', async () => {
    const userId = await makeUser('trend');
    const intakeId = await makeIntake(userId);

    const twins = [];
    for (const [i, collectionDate] of DATES.entries()) {
      twins.push(
        await draft(intakeId, ratio({ collectionDate, value: 3.1 + i / 10, nameAsPrinted: i === 1 ? 'CHOL/HDL RATIO' : 'Chol/HDL Ratio' }), {
          status: i === 4 ? 'accepted' : 'pending',
        }),
      );
    }
    const rejected = await draft(intakeId, ratio({ collectionDate: '2024-12-01' }), { status: 'rejected' });
    const userMapped = await draft(
      intakeId,
      ratio({ collectionDate: '2024-11-01', analyteKey: 'ldl_hdl_ratio', unit: 'ratio', match: 'user_mapped' }),
      { originalAiValue: ratio({ collectionDate: '2024-11-01' }) },
    );
    const otherName = await draft(intakeId, ratio({ nameAsPrinted: 'LDL/HDL Ratio', collectionDate: DATES[0] }));
    const badUnit = await draft(intakeId, ratio({ unit: 'mg/dL', collectionDate: '2024-10-01' }));
    const untouched = await Promise.all([rejected, userMapped, otherName, badUnit].map((item) => row(item.id)));

    const answer = await mapping.map(userId, intakeId, { itemId: twins[2].id, analyteKey: 'chol_hdl_ratio' });

    expect(answer.items.map((item) => item.id).sort()).toEqual(twins.map((t) => t.id).sort());
    expect(answer.skipped).toEqual([{ itemId: badUnit.id, message: expect.stringContaining('unit must be one of ratio') }]);

    for (const [i, twin] of twins.entries()) {
      const stored = await row(twin.id);
      expect(stored.value).toMatchObject({
        analyteKey: 'chol_hdl_ratio',
        unit: 'ratio',
        panel: 'lipids',
        match: 'matched',
        collectionDate: DATES[i],
        value: 3.1 + i / 10,
      });
      expect(stored).toMatchObject({ status: twin.status, userVerified: true });
      expect(stored.originalAiValue).toEqual(twin.value);
      expect(stored.updatedAt.getTime()).toBeGreaterThan(twin.updatedAt.getTime());
    }
    for (const before of untouched) {
      expect(await row(before.id)).toEqual(before);
    }

    // The mapped twins now apply, one entry per date (the bad-unit twin is rejected, the other name too).
    await intakes.updateItem(userId, intakeId, badUnit.id, { status: 'rejected' }, PERMS);
    await intakes.updateItem(userId, intakeId, otherName.id, { status: 'rejected' }, PERMS);
    await intakes.updateItem(userId, intakeId, userMapped.id, { status: 'rejected' }, PERMS);
    await intakes.acceptAll(userId, intakeId, PERMS);
    const applied = (await intakes.apply(userId, intakeId, PERMS)) as { entries: Array<{ collectionDate: string }> };
    expect(applied.entries.map((e) => e.collectionDate).sort()).toEqual([...DATES].sort());
    const saved = await client.measurement.findMany({ where: { userId } });
    expect(saved).toHaveLength(5);
    expect(saved.every((m) => m.metricKey === 'chol_hdl_ratio' && m.unit === 'ratio')).toBe(true);

    // Applied: no more mapping.
    const conflict = await mapping.map(userId, intakeId, { itemId: twins[0].id, analyteKey: 'chol_hdl_ratio' }).catch((e) => e);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect(conflict.getResponse()).toMatchObject({ details: { reason: 'ALREADY_APPLIED' } });
  });

  it("404s on another user's intake and 400s on a key outside the lab catalog, changing nothing", async () => {
    const owner = await makeUser('owner');
    const stranger = await makeUser('stranger');
    const intakeId = await makeIntake(owner);
    const item = await draft(intakeId, ratio());

    await expect(mapping.map(stranger, intakeId, { itemId: item.id, analyteKey: 'chol_hdl_ratio' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(mapping.map(owner, intakeId, { itemId: randomUUID(), analyteKey: 'chol_hdl_ratio' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(mapping.map(owner, intakeId, { itemId: item.id, analyteKey: 'weight' })).rejects.toBeInstanceOf(BadRequestException);

    expect(await row(item.id)).toEqual(item);
  });
});
