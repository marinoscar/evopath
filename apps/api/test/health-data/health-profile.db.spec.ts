// =============================================================================
// Real-Postgres test: the `health_profiles` table (E2.1, #47)
// =============================================================================
//
// What only a real server can prove: that `user_id` is a real unique index
// (one profile per user), that a profile is deleted with its user
// (`ON DELETE CASCADE`), that a `date` column round-trips a leap-day birth
// date without a time-zone shift, and that the service's version-conditional
// write turns a concurrent first save into a 409 rather than a lost update.
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

import { ConflictException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

import type { HealthProfileInput } from '../../src/health-profile/dto/health-profile.dto';
import { HealthProfileService } from '../../src/health-profile/health-profile.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('health-profile.db.spec');

const INPUT: HealthProfileInput = {
  dateOfBirth: '2000-02-29',
  sexAtBirth: 'prefer_not_to_say',
  heightMm: 1778,
  unitSystem: 'imperial',
  timeZone: 'Pacific/Kiritimati',
  bio: 'db spec',
};

describeWithDb('health_profiles (real Postgres)', () => {
  let client: PrismaClient;
  let service: HealthProfileService;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `health-${label}-${run}@example.com` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  beforeAll(() => {
    client = createDbClient();
    service = new HealthProfileService(client as unknown as PrismaService);
  });

  afterAll(async () => {
    await client.auditEvent.deleteMany({
      where: { targetType: 'health_profile', targetId: { in: createdUserIds } },
    });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
  });

  it('enforces one profile per user (unique user_id)', async () => {
    const userId = await makeUser('unique');

    await client.healthProfile.create({ data: { userId } });

    await expect(client.healthProfile.create({ data: { userId } })).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(
      (await client.healthProfile.findMany({ where: { userId } })).length,
    ).toBe(1);
  });

  it('applies the column defaults (metric, version 1)', async () => {
    const userId = await makeUser('defaults');

    const row = await client.healthProfile.create({ data: { userId } });

    expect(row).toMatchObject({
      unitSystem: 'metric',
      version: 1,
      dateOfBirth: null,
      heightMm: null,
      timeZone: null,
      bio: null,
    });
  });

  it('deletes the profile when its user is deleted (cascade)', async () => {
    const userId = await makeUser('cascade');
    await client.healthProfile.create({ data: { userId, heightMm: 1800 } });

    await client.user.delete({ where: { id: userId } });
    createdUserIds.splice(createdUserIds.indexOf(userId), 1);

    expect(await client.healthProfile.findUnique({ where: { userId } })).toBeNull();
  });

  it('refuses a profile for a user that does not exist (foreign key)', async () => {
    await expect(
      client.healthProfile.create({ data: { userId: randomUUID() } }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('round-trips a leap-day birth date through the date column and versions each save', async () => {
    const userId = await makeUser('roundtrip');

    const first = await service.put(userId, INPUT);
    expect(first).toMatchObject({ dateOfBirth: '2000-02-29', version: 1 });

    const second = await service.put(userId, { ...INPUT, heightMm: 1800 }, 1);
    expect(second).toMatchObject({ heightMm: 1800, version: 2 });

    await expect(service.put(userId, INPUT, 1)).rejects.toBeInstanceOf(ConflictException);

    const read = await service.get(userId);
    expect(read).toMatchObject({ dateOfBirth: '2000-02-29', heightMm: 1800, version: 2 });
    await expect(service.getTimeZone(userId)).resolves.toBe('Pacific/Kiritimati');

    const audits = await client.auditEvent.findMany({
      where: { targetType: 'health_profile', targetId: userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.meta)).toEqual([
      { fields: ['dateOfBirth', 'sexAtBirth', 'heightMm', 'unitSystem', 'timeZone', 'bio'] },
      { fields: ['heightMm'] },
    ]);
  });

  it('lets exactly one of two concurrent first saves win', async () => {
    const userId = await makeUser('race');

    const results = await Promise.allSettled([
      service.put(userId, INPUT, 0),
      service.put(userId, { ...INPUT, heightMm: 1900 }, 0),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect((await service.get(userId)).version).toBe(1);
  });
});
