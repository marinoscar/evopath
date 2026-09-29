// =============================================================================
// Real-Postgres test: daily check-ins on the `measurements` table (E2.4, #56)
// =============================================================================
//
// What only a real server can prove: that repeated saves of one day leave
// exactly one active row per (user, day, key) with correct revisions and
// supersession links; that an identical save writes nothing; that two
// concurrent saves of the same day — both the first save and an edit —
// produce exactly one winner (the loser gets a 409) and never two active
// check-ins; that `localDate` filtering against real `date` columns follows the
// profile time zone; that delete is soft, 404s on repeat and audits counts
// only; and that another user's day is invisible.
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

import { CheckInsService } from '../../src/check-ins/check-ins.service';
import { putCheckInSchema } from '../../src/check-ins/dto/check-in.dto';
import { addDays, localDateInZone } from '../../src/check-ins/local-date';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('check-ins.db.spec');

const body = (input: unknown) => putCheckInSchema.parse(input);
const WELLNESS_KEYS = ['energy', 'sleep_quality', 'muscle_soreness', 'stress'];

describeWithDb('check-ins (real Postgres)', () => {
  let client: PrismaClient;
  let service: CheckInsService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string, timeZone?: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `checkin-${label}-${run}@example.com` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    if (timeZone) {
      await client.healthProfile.create({ data: { userId: user.id, timeZone } });
    }
    return user.id;
  }

  const activeRows = (userId: string) =>
    client.measurement.findMany({
      where: { userId, supersededAt: null, deletedAt: null, metricKey: { in: WELLNESS_KEYS } },
    });

  beforeAll(() => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    service = new CheckInsService(prisma, new HealthProfileService(prisma));
  });

  afterAll(async () => {
    await client.auditEvent.deleteMany({
      where: { targetType: 'check_in', actorUserId: { in: createdUserIds } },
    });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
  });

  it('creates four rows with one entryId, localDate, self_report, revision 1', async () => {
    const userId = await makeUser('create');
    const today = localDateInZone(new Date(), null);

    const saved = await service.put(
      userId,
      today,
      body({ energy: 4, sleepQuality: 3, soreness: 2, stress: 3, note: 'Big presentation' }),
    );

    expect(saved).toMatchObject({
      date: today,
      energy: 4,
      sleepQuality: 3,
      soreness: 2,
      stress: 3,
      note: 'Big presentation',
    });
    await expect(service.getToday(userId)).resolves.toEqual({ date: today, checkIn: saved });

    const rows = await activeRows(userId);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.entryId)).size).toBe(1);
    for (const r of rows) {
      expect(r.localDate?.toISOString().slice(0, 10)).toBe(today);
      expect(r).toMatchObject({ method: 'self_report', origin: 'manual', unit: 'score', revision: 1 });
    }
  });

  it('keeps one active row per (user, day, key) across repeated saves', async () => {
    const userId = await makeUser('replace');
    const today = localDateInZone(new Date(), null);

    await service.put(userId, today, body({ energy: 4, sleepQuality: 3, soreness: 2, stress: 3 }));
    const second = await service.put(userId, today, body({ energy: 5 }));

    expect(second).toMatchObject({ energy: 5, sleepQuality: null, soreness: null, stress: null, note: null });

    let active = await activeRows(userId);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ metricKey: 'energy', value: 5, revision: 2 });

    const all = await client.measurement.findMany({ where: { userId } });
    expect(all).toHaveLength(5);
    const firstEnergy = all.find((r) => r.metricKey === 'energy' && r.revision === 1)!;
    expect(firstEnergy.supersededAt).toBeInstanceOf(Date);
    expect(active[0].supersedesId).toBe(firstEnergy.id);
    expect(active[0].entryId).toBe(firstEnergy.entryId);
    expect(all.filter((r) => r.deletedAt !== null).map((r) => r.metricKey).sort()).toEqual([
      'muscle_soreness',
      'sleep_quality',
      'stress',
    ]);

    // Re-adding a removed key joins the same entry at the next revision.
    await service.put(userId, today, body({ energy: 5, stress: 1 }));
    active = await activeRows(userId);
    expect(active.map((r) => [r.metricKey, r.revision]).sort()).toEqual([
      ['energy', 3],
      ['stress', 3],
    ]);
    expect(new Set(active.map((r) => r.entryId)).size).toBe(1);
  });

  it('writes nothing when the submission equals the stored day', async () => {
    const userId = await makeUser('noop');
    const today = localDateInZone(new Date(), null);
    const first = await service.put(userId, today, body({ energy: 2, note: 'tired' }));

    const again = await service.put(userId, today, body({ energy: 2, note: '  tired ' }));

    expect(again).toEqual(first);
    expect(await client.measurement.count({ where: { userId } })).toBe(1);
  });

  it('never leaves two active check-ins for a day after concurrent FIRST saves (loser gets 409)', async () => {
    // Two first saves both read "nothing" and both insert; the SERIALIZABLE
    // transaction aborts one of them. Scheduling decides whether the two
    // actually overlap, so the race is repeated and the invariant checked
    // every time: exactly one active entry, and every failure is a 409.
    const today = localDateInZone(new Date(), null);
    let conflicts = 0;

    for (let round = 0; round < 10; round += 1) {
      const userId = await makeUser(`race-first-${round}`);

      const results = await Promise.allSettled([
        service.put(userId, today, body({ energy: 1, stress: 1 })),
        service.put(userId, today, body({ energy: 5, stress: 5 })),
      ]);

      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(rejected.length).toBeLessThanOrEqual(1);
      for (const failure of rejected) {
        expect(failure.reason).toBeInstanceOf(ConflictException);
      }
      conflicts += rejected.length;

      const active = await activeRows(userId);
      expect(active).toHaveLength(2);
      expect(new Set(active.map((r) => r.entryId)).size).toBe(1);
      expect(new Set(active.map((r) => r.value)).size).toBe(1);
      // Both succeeded only if they ran one after the other: then the second
      // superseded the first.
      expect(active.every((r) => r.revision === (rejected.length === 1 ? 1 : 2))).toBe(true);
    }

    // The race is real: in practice nearly every round overlaps and one side
    // is refused. At least one refusal proves the conflict path is exercised.
    expect(conflicts).toBeGreaterThan(0);
  });

  it('lets exactly one of two concurrent edits of a day win; the other gets 409', async () => {
    const userId = await makeUser('race-edit');
    const today = localDateInZone(new Date(), null);
    await service.put(userId, today, body({ energy: 3, sleepQuality: 3 }));

    const results = await Promise.allSettled([
      service.put(userId, today, body({ energy: 1, sleepQuality: 1 })),
      service.put(userId, today, body({ energy: 5, sleepQuality: 5 })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);

    const active = await activeRows(userId);
    expect(active).toHaveLength(2);
    expect(active.every((r) => r.revision === 2)).toBe(true);
  });

  it('follows the profile time zone for today, the window and list', async () => {
    // UTC+14: at most instants this is a different calendar day from UTC, and
    // never earlier than it.
    const userId = await makeUser('zone', 'Pacific/Kiritimati');
    const today = localDateInZone(new Date(), 'Pacific/Kiritimati');

    await expect(service.getToday(userId)).resolves.toEqual({ date: today, checkIn: null });

    await service.put(userId, today, body({ energy: 4 }));
    await service.put(userId, addDays(today, -3), body({ energy: 2 }));
    await service.put(userId, addDays(today, -7), body({ energy: 1 }));
    await expect(service.put(userId, addDays(today, 1), body({ energy: 3 }))).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.put(userId, addDays(today, -8), body({ energy: 3 }))).rejects.toMatchObject({
      status: 400,
    });

    expect((await service.getToday(userId)).checkIn).toMatchObject({ date: today, energy: 4 });
    expect((await service.list(userId, 30)).items.map((i) => [i.date, i.energy])).toEqual([
      [today, 4],
      [addDays(today, -3), 2],
      [addDays(today, -7), 1],
    ]);
    expect((await service.list(userId, 4)).items.map((i) => i.date)).toEqual([today, addDays(today, -3)]);
    expect((await service.list(userId, 1)).items.map((i) => i.date)).toEqual([today]);
    await expect(service.getForDate(userId, addDays(today, -3))).resolves.toMatchObject({ energy: 2 });

    // A time-zone change keeps stored days; "today" simply follows the new zone.
    await client.healthProfile.update({ where: { userId }, data: { timeZone: 'Pacific/Pago_Pago' } });
    const pagoToday = localDateInZone(new Date(), 'Pacific/Pago_Pago');
    expect((await service.getToday(userId)).date).toBe(pagoToday);
    await expect(service.getForDate(userId, today)).resolves.toMatchObject({ energy: 4 });
  });

  it('soft-deletes, 404s a repeat, and audits the count without values', async () => {
    const userId = await makeUser('delete');
    const today = localDateInZone(new Date(), null);
    await service.put(userId, today, body({ energy: 4, stress: 3, note: 'private note' }));

    await service.remove(userId, today);

    expect((await service.getToday(userId)).checkIn).toBeNull();
    const rows = await client.measurement.findMany({ where: { userId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.deletedAt instanceof Date)).toBe(true);

    await expect(service.remove(userId, today)).rejects.toBeInstanceOf(NotFoundException);

    const audits = await client.auditEvent.findMany({ where: { targetType: 'check_in', actorUserId: userId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'check_in:delete', targetId: today, meta: { scoreCount: 2 } });
    expect(JSON.stringify(audits[0].meta)).not.toContain('private note');

    // A new save after a delete starts a fresh entry.
    const again = await service.put(userId, today, body({ energy: 1 }));
    expect(again.energy).toBe(1);
    expect((await activeRows(userId))[0].revision).toBe(1);
  });

  it("never lets another user read, write over or delete a user's day", async () => {
    const owner = await makeUser('owner');
    const other = await makeUser('other');
    const today = localDateInZone(new Date(), null);
    await service.put(owner, today, body({ energy: 4 }));

    expect((await service.getToday(other)).checkIn).toBeNull();
    expect((await service.list(other, 30)).items).toEqual([]);
    await expect(service.remove(other, today)).rejects.toBeInstanceOf(NotFoundException);

    // The other user's save creates their own day and leaves the owner's alone.
    await service.put(other, today, body({ energy: 1 }));
    expect((await service.getToday(owner)).checkIn).toMatchObject({ energy: 4 });
    expect(await activeRows(owner)).toHaveLength(1);
  });
});
