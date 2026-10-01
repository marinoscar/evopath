// =============================================================================
// Real-Postgres test: the weekly review (E7.10, #250)
// =============================================================================
//
// What only a real server can prove:
//   - the JSONB path filter on `coach_messages.data.isoWeek` finds the week's
//     review (the redelivery branch);
//   - the streak and `lastWeeklyReviewWeek` land in `coach_states` in the same
//     transaction as the message, and the guarded update makes a second run
//     (sequential or CONCURRENT) a no-op: exactly one message, one delivery job;
//   - a DST-change week (Europe/Madrid, 2026-W43 ends on the night clocks go
//     back) is reviewed on its local Sunday and keyed by its own ISO week.
//
// The signals, check-ins, photo count and the model are stubbed (their own
// suites prove them); the database, the transaction, the job queue and its
// active-dedup index are real.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { CoachContentGuard } from '../../src/coach/guard/coach-content-guard.service';
import { CoachWeeklyReviewHandler } from '../../src/coach/review/handlers/coach-weekly-review.handler';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { GOOD_REVIEW, ISO_WEEK, NOW, nextWeekSignals, weekSignals } from './coach-weekly-review.fixtures';

const { describeWithDb } = resolveDbSuite('coach-weekly-review.db.spec');

describeWithDb('coach weekly review (real Postgres)', () => {
  let client: PrismaClient;
  let handler: CoachWeeklyReviewHandler;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `review-${label}-${run}@example.com`, isActive: true },
      select: { id: true },
    });
    userIds.push(user.id);
    await client.userSettings.create({ data: { userId: user.id, value: { coach: { enabled: true } } } });
    await client.healthProfile.create({ data: { userId: user.id, timeZone: 'Europe/Madrid' } });
    return user.id;
  }

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const registry = new JobHandlerRegistry();
    const respondStructured = jest.fn(async () => ({ parsed: GOOD_REVIEW, usage: {} }));
    handler = new CoachWeeklyReviewHandler(
      registry,
      prisma,
      { forUser: () => ({ respondStructured }) } as never,
      { resolve: async () => ({ state: 'ready', model: { provider: 'openai', modelId: 'gpt-test' } }) } as never,
      { isEnabled: async () => true } as never,
      { getCoachPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, enabled: true }) } as never,
      {
        forUser: async (_userId: string, request: { from: string }) =>
          request.from === '2026-09-28' || request.from === '2026-10-19' ? weekSignals() : nextWeekSignals(),
      } as never,
      { list: async () => ({ items: [{ date: '2026-10-02' }] }) } as never,
      { countInRange: async () => 0 } as never,
      new CoachContentGuard(),
      new JobsService(prisma),
      { sent: jest.fn(), skipped: jest.fn(), fallback: jest.fn(), streak: jest.fn() } as never,
    );
  });

  afterAll(async () => {
    if (!client) return;
    const messageIds = (await client.coachMessage.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map(
      (m) => m.id,
    );
    await client.job.deleteMany({ where: { subjectId: { in: [...userIds, ...messageIds] } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  async function deliveryJobsFor(userId: string): Promise<number> {
    const ids = (await client.coachMessage.findMany({ where: { userId }, select: { id: true } })).map((m) => m.id);
    return client.job.count({ where: { type: 'coach.message.deliver', subjectId: { in: ids } } });
  }

  it('persists the review and the streak together, and a second run is a no-op', async () => {
    const userId = await makeUser('seq');
    await client.coachState.create({ data: { userId, weeklyStreak: 3, streakPassesLeft: 0 } });

    const first = await handler.run('job-1', { userId, isoWeek: ISO_WEEK }, NOW);
    expect(first).toMatchObject({ status: 'persisted', source: 'model' });

    const state = await client.coachState.findUniqueOrThrow({ where: { userId } });
    expect(state).toMatchObject({ weeklyStreak: 4, streakPassesLeft: 1, lastWeeklyReviewWeek: ISO_WEEK });

    const second = await handler.run('job-2', { userId, isoWeek: ISO_WEEK }, NOW);
    // The undelivered review is found through the JSONB path and only re-delivered.
    expect(second).toEqual({ status: 'redelivered', messageId: (first as { messageId: string }).messageId });

    const messages = await client.coachMessage.findMany({ where: { userId } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'weekly_review', moment: 'weekly_review', title: GOOD_REVIEW.headline });
    expect((messages[0].data as { isoWeek: string }).isoWeek).toBe(ISO_WEEK);
    expect(await deliveryJobsFor(userId)).toBe(1);
    expect((await client.coachState.findUniqueOrThrow({ where: { userId } })).weeklyStreak).toBe(4);
  });

  it('two concurrent runs for one week leave exactly one message and one streak increment', async () => {
    const userId = await makeUser('race');
    await client.coachState.create({ data: { userId, weeklyStreak: 1, streakPassesLeft: 0 } });

    const outcomes = await Promise.all([
      handler.run('job-a', { userId, isoWeek: ISO_WEEK }, NOW),
      handler.run('job-b', { userId, isoWeek: ISO_WEEK }, NOW),
    ]);
    expect(outcomes.filter((o) => o.status === 'persisted')).toHaveLength(1);

    expect(await client.coachMessage.count({ where: { userId } })).toBe(1);
    expect((await client.coachState.findUniqueOrThrow({ where: { userId } })).weeklyStreak).toBe(2);
    expect(await deliveryJobsFor(userId)).toBe(1);
  });

  it('creates CoachState lazily for a user who has none', async () => {
    const userId = await makeUser('lazy');
    await expect(handler.run('job-1', { userId, isoWeek: ISO_WEEK }, NOW)).resolves.toMatchObject({ status: 'persisted' });
    expect(await client.coachState.findUniqueOrThrow({ where: { userId } })).toMatchObject({
      weeklyStreak: 1,
      lastWeeklyReviewWeek: ISO_WEEK,
    });
  });

  it('a DST-change week (clocks go back on its Sunday) is reviewed on that local Sunday under its own key', async () => {
    const userId = await makeUser('dst');
    // Sunday 2026-10-25, 18:00 in Madrid is 17:00 UTC (CET, after the change).
    const sunday = new Date('2026-10-25T17:00:00Z');
    await expect(handler.run('job-1', { userId, isoWeek: '2026-W43' }, sunday)).resolves.toMatchObject({ status: 'persisted' });
    // Saturday 21:30 UTC is still Saturday (23:30 CEST) locally: the week has not ended.
    const userId2 = await makeUser('dst-early');
    await expect(
      handler.run('job-1', { userId: userId2, isoWeek: '2026-W43' }, new Date('2026-10-24T21:30:00Z')),
    ).resolves.toEqual({ status: 'skipped', reason: 'not_due' });
    const message = await client.coachMessage.findFirstOrThrow({ where: { userId } });
    expect((message.data as { stats: { weekStart: string; weekEnd: string } }).stats).toMatchObject({
      weekStart: '2026-10-19',
      weekEnd: '2026-10-25',
    });
  });
});
