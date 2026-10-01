// =============================================================================
// Real-Postgres test: the biomarker summary and revision history (H5, #189)
// =============================================================================
//
// What only a real server can prove: that the window-function query in
// `BiomarkersService.summary` parses and runs on PostgreSQL 16, picks the
// latest and previous ACTIVE result per analyte (superseded revisions and
// soft-deleted entries are neither ranked nor counted), breaks a `measuredAt`
// tie by insertion time, never reads another user's rows, lists only
// analytes with a value, and honours `panel` and `outOfRange`. Plus the
// revision chain `MeasurementsService.revisions` returns from real rows.
//
// Every user is created by this suite with a run-unique email and deleted in
// `afterAll`, so it neither sees nor disturbs other data.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { biomarkerSummaryQuerySchema } from '../../src/measurements/biomarkers/dto/biomarker-summary.dto';
import { BiomarkersService } from '../../src/measurements/biomarkers/biomarkers.service';
import {
  createMeasurementEntrySchema,
  updateMeasurementEntrySchema,
} from '../../src/measurements/dto/measurement.dto';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('biomarkers-summary.db.spec');

const create = (body: unknown) => createMeasurementEntrySchema.parse(body);
const patch = (body: unknown) => updateMeasurementEntrySchema.parse(body);
const summaryQuery = (query: Record<string, string> = {}) => biomarkerSummaryQuerySchema.parse(query);

describeWithDb('biomarker summary (real Postgres)', () => {
  let client: PrismaClient;
  let measurements: MeasurementsService;
  let biomarkers: BiomarkersService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `biomarkers-${label}-${run}@example.com` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function lab(userId: string, measuredAt: string, readings: unknown[]) {
    return measurements.createEntry(userId, create({ measuredAt, readings }));
  }

  beforeAll(() => {
    client = createDbClient();
    measurements = new MeasurementsService(client as unknown as PrismaService);
    biomarkers = new BiomarkersService(client as unknown as PrismaService);
  });

  afterAll(async () => {
    await client.auditEvent.deleteMany({
      where: { targetType: 'measurement_entry', actorUserId: { in: createdUserIds } },
    });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
  });

  it('returns latest, previous, delta and count from active rows only, owner-scoped', async () => {
    const userId = await makeUser('owner');
    const otherId = await makeUser('other');

    // LDL: three reports; the middle one is edited (its first revision is
    // superseded) and a newer fourth report is deleted.
    await lab(userId, '2026-01-10T08:00:00.000Z', [
      { metricKey: 'ldl_cholesterol', value: 150, referenceHigh: 129, flag: 'high' },
      { metricKey: 'hdl_cholesterol', value: 45, flag: 'normal' },
    ]);
    const middle = await lab(userId, '2026-04-10T08:00:00.000Z', [
      { metricKey: 'ldl_cholesterol', value: 999, referenceHigh: 129, flag: 'critical' },
    ]);
    await measurements.updateEntry(
      userId,
      middle.entryId,
      patch({ readings: [{ metricKey: 'ldl_cholesterol', value: 140, flag: 'high' }] }),
    );
    const latestLdl = await lab(userId, '2026-07-10T08:00:00.000Z', [
      { metricKey: 'ldl_cholesterol', value: 3.1, unit: 'mmol/L', referenceLow: 0, referenceHigh: 2.59, flag: 'high' },
    ]);
    const deleted = await lab(userId, '2026-09-10T08:00:00.000Z', [
      { metricKey: 'ldl_cholesterol', value: 60, flag: 'normal' },
      { metricKey: 'tsh', value: 2, flag: 'normal' },
    ]);
    await measurements.deleteEntry(userId, deleted.entryId);

    // HbA1c: one result. Two TSH results deleted above and none active.
    await lab(userId, '2026-07-10T08:00:00.000Z', [
      { metricKey: 'hba1c', value: 5.4, referenceText: '<5.7', flag: 'normal' },
    ]);

    // A body reading and another user's lab rows must never appear.
    await measurements.createEntry(userId, create({ readings: [{ metricKey: 'weight', value: 80 }] }));
    await lab(otherId, '2026-08-01T08:00:00.000Z', [
      { metricKey: 'ldl_cholesterol', value: 70, flag: 'normal' },
      { metricKey: 'ferritin', value: 10, flag: 'low' },
    ]);

    const { items } = await biomarkers.summary(userId, summaryQuery());

    expect(items.map((item) => item.analyteKey)).toEqual(['ldl_cholesterol', 'hdl_cholesterol', 'hba1c']);

    const [ldl, hdl, hba1c] = items;
    expect(ldl).toMatchObject({ label: 'LDL cholesterol', panel: 'lipids', unit: 'mg/dL', count: 3 });
    expect(ldl.latest).toMatchObject({
      measurementId: latestLdl.items[0].id,
      measuredAt: '2026-07-10T08:00:00.000Z',
      flag: 'high',
      referenceLow: 0,
      referenceText: null,
    });
    expect(ldl.latest.value).toBeCloseTo(119.88, 2);
    expect(ldl.latest.referenceHigh).toBeCloseTo(100.15, 2);
    expect(ldl.previous).toMatchObject({ value: 140, flag: 'high', measuredAt: '2026-04-10T08:00:00.000Z' });
    expect(ldl.delta).toBeCloseTo(ldl.latest.value - 140, 4);

    expect(hdl).toMatchObject({ count: 1, previous: null, delta: null });
    expect(hdl.latest).toMatchObject({ value: 45, flag: 'normal' });
    expect(hba1c).toMatchObject({ panel: 'glycemic', unit: '%', count: 1 });
    expect(hba1c.latest).toMatchObject({ value: 5.4, referenceText: '<5.7' });

    // Filters.
    expect((await biomarkers.summary(userId, summaryQuery({ panel: 'glycemic' }))).items.map((i) => i.analyteKey)).toEqual(['hba1c']);
    expect((await biomarkers.summary(userId, summaryQuery({ panel: 'thyroid' }))).items).toEqual([]);
    expect((await biomarkers.summary(userId, summaryQuery({ outOfRange: 'true' }))).items.map((i) => i.analyteKey)).toEqual(['ldl_cholesterol']);
    expect(
      (await biomarkers.summary(userId, summaryQuery({ panel: 'lipids', outOfRange: 'true' }))).items.map((i) => i.analyteKey),
    ).toEqual(['ldl_cholesterol']);

    // The other user sees only their own.
    expect((await biomarkers.summary(otherId, summaryQuery())).items.map((i) => [i.analyteKey, i.count])).toEqual([
      ['ldl_cholesterol', 1],
      ['ferritin', 1],
    ]);
  });

  it('breaks a measuredAt tie by insertion time', async () => {
    const userId = await makeUser('tie');
    await lab(userId, '2026-05-01T08:00:00.000Z', [{ metricKey: 'ferritin', value: 40 }]);
    const second = await lab(userId, '2026-05-01T08:00:00.000Z', [{ metricKey: 'ferritin', value: 55 }]);

    const [ferritin] = (await biomarkers.summary(userId, summaryQuery())).items;

    expect(ferritin.latest.measurementId).toBe(second.items[0].id);
    expect(ferritin).toMatchObject({ count: 2, delta: 15 });
  });

  it('returns no items for a user without lab results', async () => {
    const userId = await makeUser('empty');
    await measurements.createEntry(userId, create({ readings: [{ metricKey: 'weight', value: 80 }] }));

    expect(await biomarkers.summary(userId, summaryQuery())).toEqual({ items: [] });
  });

  it('returns the revision chain from any revision id; 404 when foreign or deleted', async () => {
    const userId = await makeUser('revisions');
    const otherId = await makeUser('revisions-other');
    const first = await lab(userId, '2026-02-01T08:00:00.000Z', [
      { metricKey: 'tsh', value: 2.1, flag: 'normal' },
      { metricKey: 'free_t4', value: 1.2 },
    ]);
    await measurements.updateEntry(userId, first.entryId, patch({ readings: [{ metricKey: 'tsh', value: 2.4 }] }));
    const third = await measurements.updateEntry(
      userId,
      first.entryId,
      patch({ readings: [{ metricKey: 'tsh', value: 5.2, flag: 'high' }] }),
    );
    const currentTsh = third.items.find((item) => item.metricKey === 'tsh')!;

    const fromCurrent = await measurements.revisions(userId, currentTsh.id);
    expect(fromCurrent.items.map((item) => [item.metricKey, item.revision, item.value, item.flag])).toEqual([
      ['tsh', 3, 5.2, 'high'],
      ['tsh', 2, 2.4, 'normal'],
      ['tsh', 1, 2.1, 'normal'],
    ]);
    expect(fromCurrent.items[0].supersededAt).toBeNull();
    expect(fromCurrent.items[1].supersededAt).not.toBeNull();

    // Any revision's id gives the same chain.
    const tshV1 = first.items.find((item) => item.metricKey === 'tsh')!;
    expect((await measurements.revisions(userId, tshV1.id)).items.map((item) => item.id)).toEqual(
      fromCurrent.items.map((item) => item.id),
    );

    await expect(measurements.revisions(otherId, currentTsh.id)).rejects.toBeInstanceOf(NotFoundException);

    await measurements.deleteEntry(userId, first.entryId);
    await expect(measurements.revisions(userId, tshV1.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
