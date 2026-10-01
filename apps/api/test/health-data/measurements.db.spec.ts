// =============================================================================
// Real-Postgres test: the `measurements` table (E2.2, #50)
// =============================================================================
//
// What only a real server can prove: that measurements are deleted with their
// user (`ON DELETE CASCADE`, even when revisions reference each other), that
// `supersedes_id` is a real unique index, that two concurrent edits of one
// entry produce exactly one winner (the loser gets a 409), that edits and
// deletes are reflected by `latest`, `list` and `series` against real rows,
// that another user's entry is a 404, that `series` keeps the newest 1000 of
// 1200 points, and that the three indexes exist.
//
// Every user is created by this suite with a run-unique email and deleted in
// `afterAll` (with their audit rows), so it neither sees nor disturbs other
// data.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with
// `npm run test:db` against a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import {
  createMeasurementEntrySchema,
  updateMeasurementEntrySchema,
} from '../../src/measurements/dto/measurement.dto';
import { MeasurementsService } from '../../src/measurements/measurements.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('measurements.db.spec');

const create = (body: unknown) => createMeasurementEntrySchema.parse(body);
const patch = (body: unknown) => updateMeasurementEntrySchema.parse(body);

describeWithDb('measurements (real Postgres)', () => {
  let client: PrismaClient;
  let service: MeasurementsService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `measure-${label}-${run}@example.com` },
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

  it('creates the three indexes and the unique supersedes_id index', async () => {
    const rows = await client.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'measurements'`;
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));

    expect(byName['measurements_user_id_metric_key_measured_at_idx']).toMatch(
      /\(user_id, metric_key, measured_at DESC\)/,
    );
    expect(byName['measurements_user_id_entry_id_idx']).toMatch(/\(user_id, entry_id\)/);
    expect(byName['measurements_user_id_local_date_idx']).toMatch(/\(user_id, local_date\)/);
    expect(byName['measurements_supersedes_id_key']).toMatch(/UNIQUE INDEX .*\(supersedes_id\)/);
    // No partial ("active rows") index: the predicate lives in the queries.
    // The one partial index is the device-sync key (epic #276), on
    // `external_provider`, never on the active-row columns.
    const partial = Object.entries(byName).filter(([, def]) => / WHERE /i.test(def));
    expect(partial.map(([name]) => name)).toEqual(['measurements_provider_external_uniq_idx']);
    expect(partial[0][1]).toMatch(/\(user_id, external_provider, external_id\) WHERE \(external_provider IS NOT NULL\)/);
  });

  it('refuses a second row superseding the same row (unique supersedes_id)', async () => {
    const userId = await makeUser('unique');
    const { items } = await service.createEntry(userId, create({ readings: [{ metricKey: 'weight', value: 80 }] }));
    const base = {
      userId,
      entryId: items[0].entryId,
      metricKey: 'weight',
      value: 81,
      unit: 'kg',
      measuredAt: new Date(),
      revision: 2,
      supersedesId: items[0].id,
    };

    await client.measurement.create({ data: base });
    await expect(client.measurement.create({ data: base })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('edits by superseding: the original stays with supersededAt, reads see only the new value', async () => {
    const userId = await makeUser('edit');
    const created = await service.createEntry(
      userId,
      create({ notes: 'first', readings: [{ metricKey: 'weight', value: 80 }] }),
    );
    const originalId = created.items[0].id;

    const edited = await service.updateEntry(
      userId,
      created.entryId,
      patch({ readings: [{ metricKey: 'weight', value: 81 }] }),
    );

    expect(edited.items).toEqual([
      expect.objectContaining({ value: 81, revision: 2, edited: true, notes: 'first' }),
    ]);

    const original = await client.measurement.findUniqueOrThrow({ where: { id: originalId } });
    expect(original.value).toBe(80);
    expect(original.supersededAt).toBeInstanceOf(Date);
    expect(original.deletedAt).toBeNull();

    const list = await service.list(userId, { page: 1, pageSize: 20 });
    expect(list.items.map((i) => i.value)).toEqual([81]);
    expect(list.total).toBe(1);

    const series = await service.series(userId, {
      metricKey: 'weight',
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 60_000),
    });
    expect(series.points.map((p) => p.value)).toEqual([81]);

    // notes: null supersedes every row again and clears the notes.
    const cleared = await service.updateEntry(userId, created.entryId, patch({ notes: null }));
    expect(cleared.items).toEqual([expect.objectContaining({ value: 81, revision: 3, notes: null })]);
    expect(await client.measurement.count({ where: { entryId: created.entryId } })).toBe(3);
  });

  it('lets exactly one of two concurrent edits of one entry win; the other gets 409', async () => {
    const userId = await makeUser('race');
    const { entryId } = await service.createEntry(
      userId,
      create({
        readings: [
          { metricKey: 'bp_systolic', value: 128 },
          { metricKey: 'bp_diastolic', value: 84 },
        ],
      }),
    );

    const results = await Promise.allSettled([
      service.updateEntry(userId, entryId, patch({ readings: [{ metricKey: 'bp_systolic', value: 130 }] })),
      service.updateEntry(userId, entryId, patch({ readings: [{ metricKey: 'bp_systolic', value: 135 }] })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);

    const active = await client.measurement.findMany({
      where: { entryId, supersededAt: null, deletedAt: null },
    });
    expect(active).toHaveLength(2);
    expect(active.every((row) => row.revision === 2)).toBe(true);
  });

  it('reflects edits and deletes in latest', async () => {
    const userId = await makeUser('latest');
    const older = await service.createEntry(
      userId,
      create({ measuredAt: '2026-09-01T07:00:00Z', readings: [{ metricKey: 'weight', value: 80 }] }),
    );
    const newer = await service.createEntry(
      userId,
      create({ measuredAt: '2026-09-02T07:00:00Z', readings: [{ metricKey: 'weight', value: 82 }] }),
    );

    let latest = (await service.latest(userId)).items[0];
    expect(latest).toMatchObject({ metricKey: 'weight', latest: { value: 82 }, previous: { value: 80 } });

    await service.updateEntry(userId, newer.entryId, patch({ readings: [{ metricKey: 'weight', value: 83 }] }));
    latest = (await service.latest(userId)).items[0];
    expect(latest).toMatchObject({ latest: { value: 83, revision: 2 }, previous: { value: 80 } });

    await service.deleteEntry(userId, newer.entryId);
    latest = (await service.latest(userId)).items[0];
    expect(latest).toMatchObject({ latest: { value: 80, entryId: older.entryId }, previous: null });
  });

  it('soft-deletes, 404s a repeat, and audits the count without values', async () => {
    const userId = await makeUser('delete');
    const { entryId } = await service.createEntry(
      userId,
      create({
        notes: 'private note',
        readings: [
          { metricKey: 'bp_systolic', value: 128 },
          { metricKey: 'bp_diastolic', value: 84 },
        ],
      }),
    );

    await service.deleteEntry(userId, entryId);

    const rows = await client.measurement.findMany({ where: { entryId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.deletedAt instanceof Date)).toBe(true);

    await expect(service.deleteEntry(userId, entryId)).rejects.toBeInstanceOf(NotFoundException);

    const audits = await client.auditEvent.findMany({
      where: { targetType: 'measurement_entry', targetId: entryId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'measurement_entry:delete',
      actorUserId: userId,
      meta: { readingCount: 2 },
    });
    const serialized = JSON.stringify(audits[0].meta);
    expect(serialized).not.toContain('128');
    expect(serialized).not.toContain('private note');
  });

  it("never lets another user read, edit or delete an entry (404)", async () => {
    const owner = await makeUser('owner');
    const other = await makeUser('other');
    const { entryId } = await service.createEntry(owner, create({ readings: [{ metricKey: 'weight', value: 80 }] }));

    await expect(service.updateEntry(other, entryId, patch({ notes: null }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.deleteEntry(other, entryId)).rejects.toBeInstanceOf(NotFoundException);

    expect((await service.list(other, { page: 1, pageSize: 20 })).items).toEqual([]);
    expect((await service.latest(other)).items.every((i) => i.latest === null)).toBe(true);
    expect(
      (
        await service.series(other, {
          metricKey: 'weight',
          from: new Date(Date.now() - 86_400_000),
          to: new Date(Date.now() + 60_000),
        })
      ).points,
    ).toEqual([]);

    // The owner's row is untouched.
    expect((await service.list(owner, { page: 1, pageSize: 20 })).items).toHaveLength(1);
  });

  it('keeps the newest 1000 of 1200 series points, ascending', async () => {
    const userId = await makeUser('series');
    const start = Date.UTC(2026, 0, 1);
    await client.measurement.createMany({
      data: Array.from({ length: 1200 }, (_, i) => ({
        userId,
        entryId: randomUUID(),
        metricKey: 'resting_hr',
        value: 40 + (i % 100),
        unit: 'bpm',
        measuredAt: new Date(start + i * 3_600_000),
      })),
    });

    const series = await service.series(userId, {
      metricKey: 'resting_hr',
      from: new Date(start),
      to: new Date(start + 1300 * 3_600_000),
    });

    expect(series.truncated).toBe(true);
    expect(series.points).toHaveLength(1000);
    const times = series.points.map((p) => Date.parse(p.measuredAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[times.length - 1]).toBe(start + 1199 * 3_600_000);
    expect(times[0]).toBe(start + 200 * 3_600_000);
  });

  it('deletes every measurement, revisions included, with the user (cascade)', async () => {
    const userId = await makeUser('cascade');
    const { entryId } = await service.createEntry(userId, create({ readings: [{ metricKey: 'weight', value: 80 }] }));
    await service.updateEntry(userId, entryId, patch({ readings: [{ metricKey: 'weight', value: 81 }] }));
    await service.updateEntry(userId, entryId, patch({ readings: [{ metricKey: 'weight', value: 82 }] }));
    expect(await client.measurement.count({ where: { userId } })).toBe(3);

    await client.user.delete({ where: { id: userId } });
    createdUserIds.splice(createdUserIds.indexOf(userId), 1);

    expect(await client.measurement.count({ where: { userId } })).toBe(0);
  });
});
