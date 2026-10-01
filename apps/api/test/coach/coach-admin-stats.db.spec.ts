// =============================================================================
// Real-Postgres test: coach admin stats (E7.11, #251; E7.13, #253)
// =============================================================================
//
// What only a real server can prove: `CoachAdminStatsService` runs a Prisma
// `groupBy` over `coach_messages` and ONE raw-SQL KPI row (weekly actives as a
// UNION of completed workouts and user chat messages, chat sessions as
// distinct user-days, photo-cadence adherence through `make_interval`, and the
// `user_settings.value->'coach'` JSONB path for enabled / opted-out). A mocked
// client cannot prove any of that SQL parses, groups or counts correctly.
//
// The range is pinned to 2020 (a fixed `now`), so rows other suites leave
// behind cannot fall into it. The deployment-wide counts that have no date
// (`enabled`, `optedOut`, photo cadence) are asserted as exact values on the
// assumption that this database holds no other coach-enabled users; every
// suite that seeds users cleans up after itself.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { CoachAdminStatsService } from '../../src/coach/admin/coach-admin-stats.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('coach-admin-stats.db.spec');

// Monday 2020-06-15 12:00 UTC: the default 7-day range is 06-09 .. 06-15.
const NOW = new Date('2020-06-15T12:00:00.000Z');
const at = (iso: string) => new Date(`${iso}Z`);

describeWithDb('coach admin stats (real Postgres)', () => {
  let client: PrismaClient;
  let service: CoachAdminStatsService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const objectIds: string[] = [];
  let a: string;
  let b: string;
  let c: string;
  let d: string;

  async function makeUser(label: string, coach: Record<string, unknown> | null, isActive = true): Promise<string> {
    const user = await client.user.create({ data: { email: `cstats-${label}-${run}@example.com`, isActive }, select: { id: true } });
    userIds.push(user.id);
    await client.userSettings.create({ data: { userId: user.id, value: (coach ? { coach } : {}) as never } });
    return user.id;
  }

  async function photo(userId: string, createdAt: Date): Promise<void> {
    const object = await client.storageObject.create({
      data: { name: 'p.jpg', size: 1, mimeType: 'image/jpeg', storageKey: `cstats/${run}/${randomUUID()}` },
      select: { id: true },
    });
    objectIds.push(object.id);
    await client.progressPhoto.create({
      data: { userId, storageObjectId: object.id, localDate: new Date(createdAt.toISOString().slice(0, 10)), createdAt },
    });
  }

  async function coachMessage(
    userId: string,
    deliveredAt: Date | null,
    over: Partial<{
      kind: string;
      role: string;
      moment: string | null;
      angle: string | null;
      personaId: string | null;
      openedAt: Date | null;
      convertedAt: Date | null;
      feedback: string | null;
      createdAt: Date;
    }> = {},
  ): Promise<void> {
    await client.coachMessage.create({
      data: {
        userId,
        role: over.role ?? 'coach',
        kind: over.kind ?? 'nudge',
        moment: over.moment ?? null,
        angle: over.angle ?? null,
        personaId: over.personaId ?? null,
        body: 'x',
        deliveredAt,
        openedAt: over.openedAt ?? null,
        convertedAt: over.convertedAt ?? null,
        feedback: over.feedback ?? null,
        createdAt: over.createdAt ?? deliveredAt ?? at('2020-06-10T00:00:00'),
      },
    });
  }

  async function workout(userId: string, status: 'completed' | 'in_progress', endedAt: Date): Promise<void> {
    await client.workout.create({
      data: {
        userId,
        name: 'w',
        date: new Date(endedAt.toISOString().slice(0, 10)),
        status,
        startedAt: new Date(endedAt.getTime() - 3_600_000),
        endedAt: status === 'completed' ? endedAt : null,
      },
    });
  }

  let baseline: { enabled: number; optedOut: number };

  beforeAll(async () => {
    client = createDbClient();
    service = new CoachAdminStatsService(client as unknown as PrismaService);
    const before = await service.stats({ days: 1 }, NOW);
    baseline = { enabled: before.kpis.enabled, optedOut: before.kpis.optedOut };

    // ---- funnel + activity users (no coach settings key: not counted as enabled / opted out)
    a = await makeUser('a', null);
    b = await makeUser('b', null);
    c = await makeUser('c', null);
    d = await makeUser('d', null);

    await coachMessage(a, at('2020-06-10T10:00:00'), {
      moment: 'missed_twice', angle: 'streak', personaId: 'stoic',
      openedAt: at('2020-06-10T11:00:00'), convertedAt: at('2020-06-10T12:00:00'), feedback: 'up',
    });
    await coachMessage(b, at('2020-06-10T23:59:59'), {
      moment: 'missed_twice', angle: 'data', personaId: 'stoic', openedAt: at('2020-06-11T01:00:00'), feedback: 'down',
    });
    // No target by moment alone, but converted (a low-readiness check-in): counts as convertible.
    await coachMessage(c, at('2020-06-14T08:00:00'), {
      moment: 'celebration', angle: 'data', personaId: 'hype', convertedAt: at('2020-06-14T09:00:00'),
    });
    // Range start is inclusive; no angle, no persona.
    await coachMessage(d, at('2020-06-09T00:00:00'), { moment: 'photo_prompt' });
    // Never counted: a chat reply, an undelivered row, just before the range, exactly at the exclusive end.
    await coachMessage(a, at('2020-06-11T10:00:00'), { kind: 'chat', moment: null, angle: 'data', personaId: 'stoic' });
    await coachMessage(a, null, { moment: 'missed_twice', angle: 'data', personaId: 'stoic' });
    await coachMessage(a, at('2020-06-08T23:59:59'), { moment: 'missed_twice', angle: 'streak', personaId: 'stoic' });
    await coachMessage(a, at('2020-06-16T00:00:00'), { moment: 'missed_twice', angle: 'streak', personaId: 'stoic' });

    // ---- weekly actives: A (chat AND workout, counted once), B (chat), C (workout)
    await coachMessage(a, null, { role: 'user', kind: 'chat', createdAt: at('2020-06-10T08:00:00') });
    await coachMessage(a, null, { role: 'user', kind: 'chat', createdAt: at('2020-06-10T09:00:00') });
    await coachMessage(a, null, { role: 'user', kind: 'chat', createdAt: at('2020-06-11T09:00:00') });
    await coachMessage(b, null, { role: 'user', kind: 'chat', createdAt: at('2020-06-12T09:00:00') });
    await workout(a, 'completed', at('2020-06-13T10:00:00'));
    await workout(c, 'completed', at('2020-06-14T10:00:00'));
    // D: a workout before the 7-day window, an unfinished one, and a chat 10 days back.
    await workout(d, 'completed', at('2020-06-08T10:00:00'));
    await workout(d, 'in_progress', at('2020-06-13T10:00:00'));
    await coachMessage(d, null, { role: 'user', kind: 'chat', createdAt: at('2020-06-05T09:00:00') });

    // ---- coach settings: photo cadence adherence, enabled, opted out
    const u1 = await makeUser('u1', { enabled: true, photoCadence: 'weekly' });
    const u2 = await makeUser('u2', { enabled: true }); // default biweekly (14 d)
    const u3 = await makeUser('u3', { enabled: true, photoCadence: 'monthly' });
    const u4 = await makeUser('u4', { enabled: true, photoCadence: 'weekly' });
    await makeUser('u5', { enabled: false, photoCadence: 'weekly' });
    await makeUser('u6', { enabled: true, photoCadence: 'weekly' }, false); // inactive: ignored
    await makeUser('u7', null); // no coach key: ignored
    await makeUser('u8', { enabled: true, photoCadence: 'daily' }); // unknown cadence: enabled, never "due"
    await photo(u1, at('2020-06-12T10:00:00')); // inside 7 d of 06-16
    await photo(u2, at('2020-06-03T10:00:00')); // inside 14 d
    await photo(u3, at('2020-05-01T10:00:00')); // outside 28 d
    await photo(u4, at('2020-06-08T10:00:00')); // just outside 7 d
  });

  afterAll(async () => {
    if (!client) return;
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.storageObject.deleteMany({ where: { id: { in: objectIds } } });
    await client.$disconnect();
  });

  it('rolls the delivered coach messages up into exact totals, rates and breakdowns', async () => {
    const stats = await service.stats({ days: 7 }, NOW);

    expect(stats.range).toEqual({ from: '2020-06-09', to: '2020-06-15', days: 7 });
    expect(stats.totals).toEqual({
      sent: 4, opened: 2, convertible: 4, converted: 2, up: 1, down: 1, openRate: 0.5, convertRate: 0.5,
    });
    expect(stats.byAngle.map((r) => [r.key, r.sent])).toEqual([['data', 2], ['none', 1], ['streak', 1]]);
    expect(stats.byAngle.find((r) => r.key === 'data')).toMatchObject({ sent: 2, opened: 1, converted: 1, convertible: 2, down: 1 });
    expect(stats.byPersona.map((r) => [r.key, r.sent])).toEqual([['stoic', 2], ['hype', 1], ['none', 1]]);
    expect(stats.byMoment.map((r) => [r.key, r.sent])).toEqual([['missed_twice', 2], ['celebration', 1], ['photo_prompt', 1]]);
    expect(stats.byMoment.find((r) => r.key === 'missed_twice')).toMatchObject({ opened: 2, converted: 1, convertible: 2, up: 1, down: 1 });
    expect(stats.byMoment.find((r) => r.key === 'celebration')).toMatchObject({ convertible: 1, converted: 1, convertRate: 1 });
    expect(stats.byMoment.find((r) => r.key === 'photo_prompt')).toMatchObject({ opened: 0, convertible: 1, converted: 0, convertRate: 0 });
  });

  it('counts weekly actives as workouts UNION chat, and chat sessions as distinct user-days', async () => {
    const { kpis } = await service.stats({ days: 7 }, NOW);
    // A (chat + workout, once), B (chat), C (workout). D's workout is before the window, its other one unfinished, its chat 10 days old.
    expect(kpis.weeklyActiveUsers).toBe(3);
    // (A, 06-10) x2 collapse to one; (A, 06-11); (B, 06-12).
    expect(kpis.chatSessionsPerWau).toBe(1);
    expect(kpis.nudgeOpenRate).toBe(0.5);
    expect(kpis.conversionRate).toBe(0.5);
    expect(kpis.weeklyAdherencePct).toBeNull();
  });

  it('reads photo cadence adherence, enabled and opted-out from the coach JSONB path', async () => {
    const { kpis } = await service.stats({ days: 7 }, NOW);
    // Due: u1 (7 d), u2 (14 d default), u3 (28 d), u4 (7 d). On cadence: u1, u2.
    expect(kpis.photoCadenceAdherencePct).toBe(50);
    expect(kpis.enabled - baseline.enabled).toBe(5); // u1..u4 and u8; not the inactive u6
    expect(kpis.optedOut - baseline.optedOut).toBe(1); // u5
    expect(kpis.optOutRate).toBe(Math.round((kpis.optedOut / (kpis.optedOut + kpis.enabled)) * 10_000) / 10_000);
  });

  it('a one-day range keeps only that day (both bounds inclusive of the day) and clips the active window to it', async () => {
    const stats = await service.stats({ from: '2020-06-10', to: '2020-06-10' }, NOW);
    expect(stats.range.days).toBe(1);
    expect(stats.totals).toMatchObject({ sent: 2, opened: 2, converted: 1, up: 1, down: 1 });
    expect(stats.byMoment).toHaveLength(1);
    // Only A's chat on 06-10 falls in [06-10, 06-11).
    expect(stats.kpis.weeklyActiveUsers).toBe(1);
    expect(stats.kpis.chatSessionsPerWau).toBe(1);
  });

  it('a long range widens the funnel but keeps the active window at the last 7 days', async () => {
    const stats = await service.stats({}, NOW); // the default range is 30 days
    expect(stats.range).toEqual({ from: '2020-05-17', to: '2020-06-15', days: 30 });
    // The 06-08 23:59:59 message joins; the undelivered, chat and 06-16 rows never do.
    expect(stats.totals.sent).toBe(5);
    expect(stats.kpis.weeklyActiveUsers).toBe(3);
  });

  it('an empty range answers zeros and null rates, not an error', async () => {
    const stats = await service.stats({ from: '2019-01-01', to: '2019-01-07' }, NOW);
    expect(stats.totals).toEqual({ sent: 0, opened: 0, convertible: 0, converted: 0, up: 0, down: 0, openRate: null, convertRate: null });
    expect(stats.byAngle).toEqual([]);
    expect(stats.kpis.weeklyActiveUsers).toBe(0);
    expect(stats.kpis.chatSessionsPerWau).toBeNull();
  });
});
