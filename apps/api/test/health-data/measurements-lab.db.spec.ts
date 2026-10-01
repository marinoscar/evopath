// =============================================================================
// Real-Postgres test: lab results on `measurements` (H3, #187)
// =============================================================================
//
// What only a real server can prove: that the nullable `reference_low`,
// `reference_high`, `reference_text` and `flag` columns exist with the types
// the API relies on, that a lab panel written through `MeasurementsService`
// reads back with its range and flag, that an edit supersedes the rows and
// the new revision keeps range and flag, that `category=lab` lists it while
// the default list and `latest` never show it, and that a body entry still
// stores null context.
//
// Every user is created by this suite with a run-unique email and deleted in
// `afterAll`, so it neither sees nor disturbs other data.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import {
  createMeasurementEntrySchema,
  listMeasurementsQuerySchema,
  updateMeasurementEntrySchema,
} from '../../src/measurements/dto/measurement.dto';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('measurements-lab.db.spec');

const create = (body: unknown) => createMeasurementEntrySchema.parse(body);
const patch = (body: unknown) => updateMeasurementEntrySchema.parse(body);
const listQuery = (query: Record<string, string>) => listMeasurementsQuerySchema.parse(query);

describeWithDb('measurements: lab results (real Postgres)', () => {
  let client: PrismaClient;
  let service: MeasurementsService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `measure-lab-${label}-${run}@example.com` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  beforeAll(() => {
    client = createDbClient();
    service = new MeasurementsService(client as unknown as PrismaService);
  });

  afterAll(async () => {
    await client.auditEvent.deleteMany({
      where: { targetType: 'measurement_entry', actorUserId: { in: createdUserIds } },
    });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
  });

  it('has the four nullable reference columns', async () => {
    const columns = await client.$queryRaw<
      Array<{ column_name: string; data_type: string; is_nullable: string }>
    >`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'measurements'
        AND column_name IN ('reference_low', 'reference_high', 'reference_text', 'flag')
      ORDER BY column_name`;

    expect(columns).toEqual([
      { column_name: 'flag', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'reference_high', data_type: 'double precision', is_nullable: 'YES' },
      { column_name: 'reference_low', data_type: 'double precision', is_nullable: 'YES' },
      { column_name: 'reference_text', data_type: 'text', is_nullable: 'YES' },
    ]);
  });

  it('creates a lab panel with range and flag, reads it back, and an edit keeps both', async () => {
    const userId = await makeUser('panel');

    const created = await service.createEntry(
      userId,
      create({
        measuredAt: '2026-09-01T08:00:00.000Z',
        readings: [
          {
            metricKey: 'ldl_cholesterol',
            value: 3.36,
            unit: 'mmol/L',
            method: 'lab',
            referenceLow: 0,
            referenceHigh: 2.59,
            flag: 'high',
          },
          { metricKey: 'hdl_cholesterol', value: 55, method: 'lab', referenceText: '>40', flag: 'normal' },
          { metricKey: 'triglycerides', value: 1.2, unit: 'mmol/L', method: 'lab' },
        ],
      }),
    );

    expect(created.items).toHaveLength(3);
    const stored = await client.measurement.findMany({
      where: { userId, entryId: created.entryId },
      orderBy: { metricKey: 'asc' },
    });
    expect(stored.map((row) => row.metricKey)).toEqual(['hdl_cholesterol', 'ldl_cholesterol', 'triglycerides']);
    const [hdl, ldl, tg] = stored;
    expect(ldl).toMatchObject({ unit: 'mg/dL', method: 'lab', origin: 'manual', referenceLow: 0, flag: 'high' });
    expect(ldl.value).toBeCloseTo(129.93, 2);
    expect(ldl.referenceHigh).toBeCloseTo(100.15, 2);
    expect(hdl).toMatchObject({ referenceLow: null, referenceHigh: null, referenceText: '>40', flag: 'normal' });
    expect(tg).toMatchObject({ referenceLow: null, referenceHigh: null, referenceText: null, flag: null });

    // Listed on request only.
    const labList = await service.list(userId, listQuery({ category: 'lab' }));
    expect(labList.total).toBe(3);
    expect(labList.items.find((item) => item.metricKey === 'ldl_cholesterol')).toMatchObject({
      flag: 'high',
      referenceLow: 0,
    });
    expect((await service.list(userId, listQuery({}))).total).toBe(0);
    expect((await service.list(userId, listQuery({ metricKey: 'hdl_cholesterol' }))).items[0]).toMatchObject({
      referenceText: '>40',
    });
    const latest = await service.latest(userId);
    expect(latest.items.map((item) => item.metricKey)).not.toContain('ldl_cholesterol');

    // Edit only the LDL value: a new revision of every row; range and flag kept.
    const edited = await service.updateEntry(
      userId,
      created.entryId,
      patch({ readings: [{ metricKey: 'ldl_cholesterol', value: 128 }] }),
    );
    const editedLdl = edited.items.find((item) => item.metricKey === 'ldl_cholesterol')!;
    expect(editedLdl).toMatchObject({ value: 128, revision: 2, edited: true, flag: 'high', referenceLow: 0 });
    expect(editedLdl.referenceHigh).toBeCloseTo(100.15, 2);
    expect(edited.items.find((item) => item.metricKey === 'hdl_cholesterol')).toMatchObject({
      revision: 2,
      referenceText: '>40',
      flag: 'normal',
    });

    const history = await client.measurement.findMany({
      where: { userId, metricKey: 'ldl_cholesterol' },
      orderBy: { revision: 'asc' },
    });
    expect(history.map((row) => [row.revision, row.supersededAt !== null, row.flag])).toEqual([
      [1, true, 'high'],
      [2, false, 'high'],
    ]);
    expect(history[1].supersedesId).toBe(history[0].id);

    // Changing the flag and clearing the text writes revision 3.
    const changed = await service.updateEntry(
      userId,
      created.entryId,
      patch({ readings: [{ metricKey: 'hdl_cholesterol', value: 55, flag: 'low', referenceText: null }] }),
    );
    expect(changed.items.find((item) => item.metricKey === 'hdl_cholesterol')).toMatchObject({
      revision: 3,
      flag: 'low',
      referenceText: null,
    });
    expect(changed.items.find((item) => item.metricKey === 'ldl_cholesterol')).toMatchObject({
      revision: 3,
      flag: 'high',
    });
  });

  it('stores null context on a body entry', async () => {
    const userId = await makeUser('body');

    const created = await service.createEntry(userId, create({ readings: [{ metricKey: 'weight', value: 80 }] }));

    const row = await client.measurement.findFirstOrThrow({ where: { userId, entryId: created.entryId } });
    expect(row).toMatchObject({ referenceLow: null, referenceHigh: null, referenceText: null, flag: null });
    expect(created.items[0]).toMatchObject({ referenceLow: null, flag: null });
  });
});
