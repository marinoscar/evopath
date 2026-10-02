// =============================================================================
// Real-Postgres test: the review's issues route lists what apply refuses (#317)
// =============================================================================
//
// What only real rows can prove, for `LabReportIssuesService` behind
// `GET /api/measurements/lab-reports/:id/issues`:
//   - on a report mixing a clean result, an unmatched one, a unit the analyte
//     does not allow, a result with no number, an analyte twice on one date
//     and a rejected (ignored) broken result, the route lists exactly the
//     not-rejected results apply would refuse, in review order, with codes;
//   - after accepting everything, apply's 409 `UNRESOLVED_ANALYTES` names
//     exactly the route's `UNMATCHED` results;
//   - once those are rejected, apply's 400 `details.issues` are exactly the
//     route's issues (same item, field and message), and nothing is saved;
//   - once everything the route lists is fixed or rejected, the route is
//     empty and apply succeeds;
//   - another user's intake is a 404.
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
import { LabReportIssuesService } from '../../src/measurements/lab-report/lab-report-issues.service';
import { LabReportIntakeKind } from '../../src/measurements/lab-report/lab-report.kind';
import { labReportValueSchema, type LabReportValue } from '../../src/measurements/lab-report/lab-report.value';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('lab-report-issues.db.spec');

const PERMS = ['intakes:read', 'intakes:write', 'health_data:read', 'health_data:write'];

describeWithDb('lab report issues route (real Postgres)', () => {
  let client: PrismaClient;
  let intakes: IntakeService;
  let issuesService: LabReportIssuesService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `lab-issues-${label}-${run}@example.com` }, select: { id: true } });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function makeIntake(userId: string): Promise<string> {
    const intake = await intakes.create(userId, { kind: 'lab_report' }, PERMS);
    await client.photoIntake.update({
      where: { id: intake.id },
      data: { status: 'ready', context: { collectionDate: '2026-01-14' } },
    });
    return intake.id;
  }

  let sortOrder = 0;
  async function draft(intakeId: string, value: Partial<LabReportValue>, status = 'pending') {
    sortOrder += 1;
    return client.draftItem.create({
      data: {
        intakeId,
        kind: 'result',
        origin: 'ai',
        status,
        confidence: 'high',
        value: labReportValueSchema.parse(value) as object,
        sortOrder,
      },
    });
  }

  const ldl = (overrides: Partial<LabReportValue> = {}): Partial<LabReportValue> => ({
    nameAsPrinted: 'LDL Cholesterol',
    analyteKey: 'ldl_cholesterol',
    value: 2.4,
    unit: 'mmol/L',
    match: 'matched',
    ...overrides,
  });

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const kinds = new IntakeKindRegistry();
    new LabReportIntakeKind(kinds, new MeasurementsService(prisma)).onModuleInit();
    intakes = new IntakeService(prisma, kinds, new JobsService(prisma), {} as never, {} as never, {} as never, {} as never);
    issuesService = new LabReportIssuesService(prisma);
  });

  afterAll(async () => {
    await client.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
  });

  it('lists exactly what apply refuses, before and after the unmatched results are rejected', async () => {
    const userId = await makeUser('mixed');
    const intakeId = await makeIntake(userId);

    const clean = await draft(intakeId, ldl());
    const unmatched = await draft(intakeId, { nameAsPrinted: 'BUN/Creatinine Ratio', value: 17.3, match: 'unmatched' });
    const badUnit = await draft(intakeId, ldl({ nameAsPrinted: 'HDL', analyteKey: 'hdl_cholesterol', unit: 'furlongs' }), 'accepted');
    const noValue = await draft(intakeId, ldl({ nameAsPrinted: 'Triglycerides', analyteKey: 'triglycerides', value: null, valueText: 'see note' }));
    const glucoseA = await draft(intakeId, { nameAsPrinted: 'Glucose', analyteKey: 'fasting_glucose', value: 92, unit: 'mg/dL' });
    // No own date: joins the report date 2026-01-14, so it repeats glucose on that date.
    const glucoseB = await draft(intakeId, { nameAsPrinted: 'Glucose', analyteKey: 'fasting_glucose', value: 95, unit: 'mg/dL', collectionDate: '2026-01-14' });
    await draft(intakeId, ldl({ unit: 'furlongs' }), 'rejected');

    const before = await issuesService.find(userId, intakeId);
    expect(before.items.map(({ itemId, issues }) => [itemId, issues.map((i) => i.code)])).toEqual([
      [unmatched.id, ['UNMATCHED']],
      [badUnit.id, ['UNIT_NOT_ALLOWED']],
      [noValue.id, ['NO_VALUE']],
      [glucoseA.id, ['DUPLICATE_ON_DATE']],
      [glucoseB.id, ['DUPLICATE_ON_DATE']],
    ]);
    expect(before.items.find((i) => i.itemId === clean.id)).toBeUndefined();
    expect(JSON.stringify(before)).not.toMatch(/17\.3|"92"|"95"/);

    // Accept everything: apply refuses the unmatched result first, naming exactly the route's UNMATCHED items.
    await intakes.acceptAll(userId, intakeId, PERMS);
    const conflict: any = await intakes.apply(userId, intakeId, PERMS).catch((e: any) => e);
    expect(conflict).toBeInstanceOf(ConflictException);
    const routeUnmatched = before.items.filter((i) => i.issues.some((x) => x.code === 'UNMATCHED')).map((i) => i.itemId);
    expect(conflict.getResponse().details.itemIds).toEqual(routeUnmatched);

    // Reject it: apply's 400 issues are exactly the route's.
    await intakes.updateItem(userId, intakeId, unmatched.id, { status: 'rejected' }, PERMS);
    const after = await issuesService.find(userId, intakeId);
    const refused: any = await intakes.apply(userId, intakeId, PERMS).catch((e: any) => e);
    expect(refused).toBeInstanceOf(BadRequestException);

    const fromApply = (refused.getResponse().details.issues as Array<{ path: string; message: string }>)
      .map(({ path, message }) => {
        const [, itemId, , field] = path.split('.');
        return `${itemId}|${field ?? null}|${message}`;
      })
      .sort();
    const fromRoute = after.items
      .flatMap(({ itemId, issues }) => issues.map((issue) => `${itemId}|${issue.field}|${issue.message}`))
      .sort();
    expect(fromRoute).toEqual(fromApply);
    expect(after.items.map((i) => i.itemId)).not.toContain(unmatched.id);
    expect(await client.measurement.count({ where: { userId } })).toBe(0);

    // Fix or reject everything the route lists: it is empty and apply succeeds.
    for (const id of [badUnit.id, noValue.id, glucoseB.id]) {
      await intakes.updateItem(userId, intakeId, id, { status: 'rejected' }, PERMS);
    }
    await expect(issuesService.find(userId, intakeId)).resolves.toEqual({ items: [] });
    await intakes.apply(userId, intakeId, PERMS);
    const saved = await client.measurement.findMany({ where: { userId } });
    expect(saved.map((m) => m.metricKey).sort()).toEqual(['fasting_glucose', 'ldl_cholesterol']);
  });

  it("404s on another user's intake or an unknown id", async () => {
    const owner = await makeUser('owner');
    const stranger = await makeUser('stranger');
    const intakeId = await makeIntake(owner);
    await draft(intakeId, { nameAsPrinted: 'Mystery', value: 1 });

    await expect(issuesService.find(stranger, intakeId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(issuesService.find(owner, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    await expect(issuesService.find(owner, intakeId)).resolves.toMatchObject({ items: [{ issues: [{ code: 'UNMATCHED' }] }] });
  });
});
