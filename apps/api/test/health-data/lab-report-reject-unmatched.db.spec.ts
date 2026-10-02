// =============================================================================
// Real-Postgres test: reject every unmatched lab result (#311)
// =============================================================================
//
// What only real rows (and the real `FOR UPDATE` on `photo_intakes`) can prove,
// for `LabReportRejectUnmatchedService` behind
// `POST /api/measurements/lab-reports/:id/reject-unmatched`:
//   - on a report mixing matched, suggested, unmatched (pending, accepted,
//     user-edited) and already-rejected results, ONE call rejects exactly the
//     not-yet-rejected unmatched ones, changing only their `status`; every
//     other row is left exactly as it was;
//   - a second call rejects nothing (`items: []`);
//   - a rejected result restores with the item PATCH `{ status: 'pending' }`;
//   - the intake then applies with only the matched results;
//   - another user's intake is a 404 and an applied intake a 409, changing
//     nothing.
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

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { IntakeService } from '../../src/intake/intake.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { LabReportRejectUnmatchedService } from '../../src/measurements/lab-report/lab-report-reject-unmatched.service';
import { LabReportIntakeKind } from '../../src/measurements/lab-report/lab-report.kind';
import { labReportValueSchema, type LabReportValue } from '../../src/measurements/lab-report/lab-report.value';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('lab-report-reject-unmatched.db.spec');

const PERMS = ['intakes:read', 'intakes:write', 'health_data:read', 'health_data:write'];

describeWithDb('lab report reject unmatched (real Postgres)', () => {
  let client: PrismaClient;
  let intakes: IntakeService;
  let rejecting: LabReportRejectUnmatchedService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({ data: { email: `lab-reject-${label}-${run}@example.com` }, select: { id: true } });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function makeIntake(userId: string): Promise<string> {
    const intake = await intakes.create(userId, { kind: 'lab_report' }, PERMS);
    await client.photoIntake.update({ where: { id: intake.id }, data: { status: 'ready' } });
    return intake.id;
  }

  let sortOrder = 0;
  async function draft(
    intakeId: string,
    value: Partial<LabReportValue>,
    extra: { status?: string; originalAiValue?: object; userVerified?: boolean } = {},
  ) {
    sortOrder += 1;
    return client.draftItem.create({
      data: {
        intakeId,
        kind: 'result',
        origin: 'ai',
        status: extra.status ?? 'pending',
        confidence: 'high',
        userVerified: extra.userVerified ?? false,
        value: labReportValueSchema.parse(value) as object,
        ...(extra.originalAiValue ? { originalAiValue: extra.originalAiValue } : {}),
        sortOrder,
      },
    });
  }

  const unmatched = (overrides: Partial<LabReportValue> = {}): Partial<LabReportValue> => ({
    nameAsPrinted: 'Apolipoprotein A1',
    value: 1.4,
    unit: 'g/L',
    match: 'unmatched',
    collectionDate: '2026-01-14',
    ...overrides,
  });

  const row = (id: string) => client.draftItem.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const kinds = new IntakeKindRegistry();
    new LabReportIntakeKind(kinds, new MeasurementsService(prisma)).onModuleInit();
    intakes = new IntakeService(prisma, kinds, new JobsService(prisma), {} as never, {} as never, {} as never, {} as never);
    rejecting = new LabReportRejectUnmatchedService(prisma);
  });

  afterAll(async () => {
    await client.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
  });

  it('rejects only the not-yet-rejected unmatched results; restore and apply still work', async () => {
    const userId = await makeUser('mixed');
    const intakeId = await makeIntake(userId);

    const matched = await draft(intakeId, {
      nameAsPrinted: 'LDL Cholesterol',
      analyteKey: 'ldl_cholesterol',
      value: 2.4,
      unit: 'mmol/L',
      match: 'matched',
      collectionDate: '2026-01-14',
    });
    const suggested = await draft(intakeId, {
      nameAsPrinted: 'Chol/HDL',
      analyteKey: 'chol_hdl_ratio',
      value: 3.6,
      unit: 'ratio',
      match: 'suggested',
      collectionDate: '2026-01-14',
    });
    const pendingUnmatched = await draft(intakeId, unmatched());
    const acceptedUnmatched = await draft(intakeId, unmatched({ nameAsPrinted: 'Lp-PLA2', value: 180, unit: 'nmol/min/mL' }), {
      status: 'accepted',
      userVerified: true,
    });
    const editedUnmatched = await draft(intakeId, unmatched({ value: 1.5 }), {
      userVerified: true,
      originalAiValue: labReportValueSchema.parse(unmatched()) as object,
    });
    const alreadyRejected = await draft(intakeId, unmatched({ nameAsPrinted: 'Apolipoprotein B' }), { status: 'rejected' });

    const untouched = await Promise.all([matched, suggested, alreadyRejected].map((item) => row(item.id)));
    const targets = [pendingUnmatched, acceptedUnmatched, editedUnmatched];

    const answer = await rejecting.rejectUnmatched(userId, intakeId);

    expect(answer.items.map((item) => item.id)).toEqual(targets.map((t) => t.id));
    expect(answer.items.every((item) => item.status === 'rejected')).toBe(true);
    for (const target of targets) {
      const stored = await row(target.id);
      expect(stored.status).toBe('rejected');
      expect(stored.value).toEqual(target.value);
      expect(stored.userVerified).toBe(target.userVerified);
      expect(stored.originalAiValue).toEqual(target.originalAiValue);
    }
    for (const before of untouched) {
      expect(await row(before.id)).toEqual(before);
    }

    // Nothing left to reject.
    await expect(rejecting.rejectUnmatched(userId, intakeId)).resolves.toEqual({ items: [] });

    // Restore works as for any rejected result.
    const restored = await intakes.updateItem(userId, intakeId, pendingUnmatched.id, { status: 'pending' }, PERMS);
    expect(restored.status).toBe('pending');
    await intakes.updateItem(userId, intakeId, pendingUnmatched.id, { status: 'rejected' }, PERMS);

    // The report applies with only the matched results.
    await intakes.acceptAll(userId, intakeId, PERMS);
    await intakes.apply(userId, intakeId, PERMS);
    const saved = await client.measurement.findMany({ where: { userId } });
    expect(saved.map((m) => m.metricKey).sort()).toEqual(['chol_hdl_ratio', 'ldl_cholesterol']);

    // Applied: no more rejecting.
    const conflict = await rejecting.rejectUnmatched(userId, intakeId).catch((e) => e);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect(conflict.getResponse()).toMatchObject({ details: { reason: 'ALREADY_APPLIED' } });
  });

  it("404s on another user's intake, changing nothing", async () => {
    const owner = await makeUser('owner');
    const stranger = await makeUser('stranger');
    const intakeId = await makeIntake(owner);
    const item = await draft(intakeId, unmatched());

    await expect(rejecting.rejectUnmatched(stranger, intakeId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(rejecting.rejectUnmatched(owner, randomUUID())).rejects.toBeInstanceOf(NotFoundException);

    expect(await row(item.id)).toEqual(item);
  });

  it('409s on an applied intake, changing nothing', async () => {
    const userId = await makeUser('applied');
    const intakeId = await makeIntake(userId);
    const item = await draft(intakeId, unmatched());
    await client.photoIntake.update({ where: { id: intakeId }, data: { status: 'applied' } });

    const conflict = await rejecting.rejectUnmatched(userId, intakeId).catch((e) => e);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect(conflict.getResponse()).toMatchObject({ details: { reason: 'ALREADY_APPLIED' } });

    expect(await row(item.id)).toEqual(item);
  });
});
