// =============================================================================
// Real-Postgres test: the coach sweep (E7.4)
// =============================================================================
//
// What only a real server can prove: the sweep's JSONB path filter
// (`user_settings.value.coach.enabled = true`) and the active-account filter
// pick exactly the right users; `CoachState` is created lazily and its
// bookkeeping lands in the right columns (the local `@db.Date` day); a second
// pass for the same user collapses onto the pending `ai.coach.nudge` job
// through the queue's real active-dedup index; and `recordNudgeSent`
// increments on the same local day and restarts at 1 on a new one.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { Job, PrismaClient } from '@prisma/client';

import { CoachMomentEnqueuer } from '../../src/coach/planning/coach-moment-enqueuer';
import { CoachPlannerService } from '../../src/coach/planning/coach-planner.service';
import { CoachPlanningMetrics } from '../../src/coach/planning/coach-planning.metrics';
import { ProgressPhotoSummaryService } from '../../src/progress-photos/progress-photo-summary.service';
import { CoachStateService } from '../../src/coach/planning/coach-state.service';
import { CoachSweepHandler } from '../../src/coach/planning/handlers/coach-sweep.handler';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { PlanSignals } from '../../src/programs/signals/plan-signals.contract';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('coach-sweep.db.spec');

// Wednesday 2026-09-30 12:00 UTC.
const NOW = new Date('2026-09-30T12:00:00.000Z');

function missedTwice(asOf: string): PlanSignals {
  return {
    range: { from: asOf, to: asOf },
    asOf,
    programId: null,
    planVersion: null,
    weeksInRange: 1,
    truncated: false,
    planChangedOn: null,
    adherence: {
      weeks: [],
      totals: { planned: 2, completed: 0, partialSessions: 0, missed: 2, extra: 0, adherencePct: 0 },
      missedStreak: 2,
      completedStreak: 0,
    },
    frequency: { avgPerWeek: null, perWeek: [] },
    sessions: [],
    volume: [],
    performance: [],
    effort: { avgRpe: null, setsAtRpe9Plus: 0, rpeTrend: 'insufficient' },
    pain: [],
    readiness: { days: 0, avg: null, lowDays: 0, lowStreak: 0 },
    body: { weightKg: { latest: null, changePerWeek: null, points: 0 }, bodyFatPct: null },
  };
}

describeWithDb('coach sweep (real Postgres)', () => {
  let client: PrismaClient;
  let handler: CoachSweepHandler;
  let planner: CoachPlannerService;
  let stateService: CoachStateService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let enabledUser: string;
  let disabledUser: string;
  let inactiveUser: string;

  async function makeUser(label: string, coach: { enabled: boolean } | null, isActive = true): Promise<string> {
    const user = await client.user.create({
      data: { email: `coach-${label}-${run}@example.com`, isActive },
      select: { id: true },
    });
    userIds.push(user.id);
    await client.userSettings.create({ data: { userId: user.id, value: coach ? { coach } : {} } });
    return user.id;
  }

  beforeAll(async () => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const registry = new JobHandlerRegistry();
    // A stand-in for E7.5's handler, so the enqueuer queues rather than counting handler_missing.
    registry.register({ type: 'ai.coach.nudge', process: async () => undefined } as never);
    const jobs = new JobsService(prisma);
    const metrics = new CoachPlanningMetrics();
    const signals = { forUser: jest.fn(async () => missedTwice('2026-09-30')) };
    planner = new CoachPlannerService(
      prisma,
      signals as never,
      new CoachMomentEnqueuer(jobs, registry, metrics),
      metrics,
      new ProgressPhotoSummaryService(prisma),
    );
    const systemSettings = {
      getCoachPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, enabled: true }),
      getNotificationsPolicy: async () => ({ browserEnabled: true, disabledEvents: [] }),
    };
    handler = new CoachSweepHandler(
      registry,
      prisma,
      jobs,
      { isEnabled: async () => true } as never,
      systemSettings as never,
      planner,
      metrics,
    );
    stateService = new CoachStateService(prisma, signals as never, {} as never, {} as never, {} as never);

    enabledUser = await makeUser('on', { enabled: true });
    disabledUser = await makeUser('off', { enabled: false });
    inactiveUser = await makeUser('inactive', { enabled: true }, false);
    await makeUser('none', null);
  });

  afterAll(async () => {
    if (!client) return;
    await client.job.deleteMany({ where: { subjectId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  async function activeNudges(userId: string): Promise<Job[]> {
    return client.job.findMany({ where: { type: 'ai.coach.nudge', subjectId: userId, status: { in: ['pending', 'running'] } } });
  }

  it('pages only active users whose coach is enabled (the JSONB path filter)', async () => {
    const plannedFor: string[] = [];
    const spy = jest.spyOn(planner, 'planUser').mockImplementation(async (userId) => {
      plannedFor.push(userId);
      return { queued: null, weeklyReviewQueued: false, suppressed: 0 };
    });

    await handler.sweep('db-job', null, NOW);
    spy.mockRestore();

    expect(plannedFor).toContain(enabledUser);
    expect(plannedFor).not.toContain(disabledUser);
    expect(plannedFor).not.toContain(inactiveUser);
  });

  it('creates CoachState lazily with the local day and lastSweepAt, and queues one nudge job', async () => {
    await planner.planUser(enabledUser, {
      now: NOW,
      trigger: 'sweep',
      timeZone: 'Asia/Kolkata',
      settingsValue: { coach: { enabled: true } },
      aiEnabled: true,
      system: { ...DEFAULT_SYSTEM_SETTINGS.coach, enabled: true },
      notificationPolicy: { browserEnabled: true, disabledEvents: [] },
    });

    const state = await client.coachState.findUnique({ where: { userId: enabledUser } });
    expect(state).toMatchObject({ nudgesToday: 0, consecutiveIgnored: 0, silencedAt: null, lastSweepAt: NOW });
    // 12:00 UTC is 17:30 in Kolkata, still 2026-09-30.
    expect(state?.nudgeDayLocal?.toISOString().slice(0, 10)).toBe('2026-09-30');

    const jobs = await activeNudges(enabledUser);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ subjectType: 'user', subjectId: enabledUser });
    expect(jobs[0].payload).toMatchObject({ userId: enabledUser, moment: 'missed_twice', momentKey: 'missed_twice:2026-09-30' });
  });

  it('a second pass collapses onto the pending nudge through the real active-dedup index', async () => {
    const before = await activeNudges(enabledUser);
    await planner.planUser(enabledUser, {
      now: new Date(NOW.getTime() + 3_600_000),
      trigger: 'sweep',
      timeZone: 'UTC',
      settingsValue: { coach: { enabled: true } },
      aiEnabled: true,
      system: { ...DEFAULT_SYSTEM_SETTINGS.coach, enabled: true },
      notificationPolicy: { browserEnabled: true, disabledEvents: [] },
    });
    const after = await activeNudges(enabledUser);
    expect(after.map((j) => j.id)).toEqual(before.map((j) => j.id));
  });

  it('recordNudgeSent counts per local day', async () => {
    const at = new Date('2026-09-30T20:00:00.000Z');
    await stateService.recordNudgeSent(enabledUser, at, 'UTC');
    await stateService.recordNudgeSent(enabledUser, new Date(at.getTime() + 60_000), 'UTC');
    let state = await client.coachState.findUnique({ where: { userId: enabledUser } });
    expect(state?.nudgesToday).toBe(2);

    // 20:00 UTC on the 30th is already 01:30 on the 1st in Kolkata: a new local day.
    await stateService.recordNudgeSent(enabledUser, at, 'Asia/Kolkata');
    state = await client.coachState.findUnique({ where: { userId: enabledUser } });
    expect(state?.nudgesToday).toBe(1);
    expect(state?.nudgeDayLocal?.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(state?.lastNudgeAt).toEqual(at);
  });
});
