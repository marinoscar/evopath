// =============================================================================
// Real-Postgres test: the activation-metrics aggregate (#212)
// =============================================================================
//
// What only a real server can prove: the SQL itself — the cohort and
// eligibility cutoffs, the exactly-7-days activation boundary, the
// percentile_cont median, and the per-step EXISTS counts.
//
// ISOLATION: the suite shares a database with others, and the query counts
// EVERY user in the window. So it passes a fixed `now` decades in the future
// (the service's second argument) and backdates its own users around it;
// nothing any other suite created can fall inside that window.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { OnboardingMetricsService } from '../../src/onboarding/onboarding-metrics.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('onboarding-metrics.db.spec');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describeWithDb('onboarding activation metrics (real Postgres)', () => {
  let client: PrismaClient;
  let service: OnboardingMetricsService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  // Two distinct "now"s so the populated and empty scenarios cannot interfere.
  const NOW = new Date('2090-06-15T12:00:00.000Z');
  const EMPTY_NOW = new Date('2190-06-15T12:00:00.000Z');

  const ago = (ms: number, from: Date = NOW) => new Date(from.getTime() - ms);

  async function makeUser(label: string, createdAt: Date): Promise<{ id: string; createdAt: Date }> {
    const u = await client.user.create({
      data: { email: `onb-${label}-${run}@example.com`, createdAt },
      select: { id: true },
    });
    userIds.push(u.id);
    return { id: u.id, createdAt };
  }

  const workout = (
    userId: string,
    data: { status?: string; startedAt: Date; endedAt?: Date | null },
  ) =>
    client.workout.create({
      data: {
        userId,
        name: 'W',
        date: data.startedAt,
        status: data.status ?? 'completed',
        startedAt: data.startedAt,
        endedAt: data.endedAt === undefined ? data.startedAt : data.endedAt,
      },
    });

  /** A completed workout ending `offsetMs` after the user's sign-up. */
  const completedAfter = (u: { id: string; createdAt: Date }, offsetMs: number) =>
    workout(u.id, { startedAt: new Date(u.createdAt.getTime() + offsetMs - HOUR), endedAt: new Date(u.createdAt.getTime() + offsetMs) });

  beforeAll(() => {
    client = createDbClient();
    service = new OnboardingMetricsService(client as never);
  });

  afterAll(async () => {
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  it('computes cohort, eligibility, activation boundary, median and steps', async () => {
    // Outside the 30-day window: must not count at all.
    const old = await makeUser('old', ago(31 * DAY));
    await completedAfter(old, HOUR);
    await client.gym.create({ data: { userId: old.id, name: 'Old gym' } });

    // Eligible (created >= 7 days ago), activated: first workout after 2h.
    const a = await makeUser('a', ago(20 * DAY));
    await completedAfter(a, 2 * HOUR);
    await client.healthProfile.create({ data: { userId: a.id } });
    await client.gym.create({ data: { userId: a.id, name: 'A gym' } });
    // A later workout must not move the FIRST-workout time.
    await completedAfter(a, 3 * DAY);

    // Eligible, activated at EXACTLY 7 days (inclusive boundary): 168h.
    const b = await makeUser('b', ago(10 * DAY));
    await completedAfter(b, 7 * DAY);
    await client.program.create({ data: { userId: b.id, name: 'P', goal: 'general' } });
    // E7.12: with a program, `ai_plan` is "Meet your coach", done once the coach settings were saved.
    await client.userSettings.create({ data: { userId: b.id, value: { coach: { personaId: 'coach' } } } });

    // Eligible, one second past 7 days: has a workout but NOT activated.
    const c = await makeUser('c', ago(10 * DAY));
    await completedAfter(c, 7 * DAY + 1000);

    // Eligible, only an in-progress and a no-end workout: not activated, no first_workout.
    const d = await makeUser('d', ago(9 * DAY));
    await workout(d.id, { status: 'in_progress', startedAt: ago(9 * DAY - HOUR), endedAt: null });
    await client.gym.create({ data: { userId: d.id, name: 'D gym' } });
    // A program but no saved coach settings: "Meet your coach" is still todo.
    await client.program.create({ data: { userId: d.id, name: 'P', goal: 'general' } });
    await client.userSettings.create({ data: { userId: d.id, value: { onboarding: { goal: 'general' } } } });

    // Eligible exactly at the 7-day edge of eligibility (created_at == now - 7d), no workout.
    const e = await makeUser('e', ago(7 * DAY));

    // NOT eligible (created 3 days ago), but in the cohort with a quick workout: counts
    // toward cohort, steps and median, not toward eligible/activated.
    const f = await makeUser('f', ago(3 * DAY));
    await completedAfter(f, 30 * 60 * 1000); // 0.5h
    await client.healthProfile.create({ data: { userId: f.id } });

    // Cohort of 6 + ... count: a,b,c,d,e,f = 6
    const out = await service.metrics(30, NOW);

    expect(out.windowDays).toBe(30);
    expect(out.activationWindowDays).toBe(7);
    expect(out.cohortSize).toBe(6);
    expect(out.eligible).toBe(5); // a b c d e
    expect(out.activated).toBe(2); // a and b (exactly 7d is inside)
    expect(out.activationRate).toBeCloseTo(2 / 5, 10);

    // First-workout hours: a=2, b=168, c=168.0003, f=0.5 -> median of [0.5, 2, 168, 168.0002..]
    // = (2 + 168) / 2 = 85 .
    expect(out.medianHoursToFirstWorkout).toBe(85);

    const steps = Object.fromEntries(out.steps.map((s) => [s.id, s]));
    expect(steps.health_profile).toEqual({ id: 'health_profile', completed: 2, rate: 2 / 6 });
    expect(steps.gym).toEqual({ id: 'gym', completed: 2, rate: 2 / 6 });
    expect(steps.first_workout).toEqual({ id: 'first_workout', completed: 4, rate: 4 / 6 });
    expect(steps.ai_plan).toEqual({ id: 'ai_plan', completed: 1, rate: 1 / 6 });

    // With the system coach switched off, `ai_plan` is the plain "a program exists" rule again (b and d).
    const coachOff = new OnboardingMetricsService(client as never, {
      getCoachPolicy: async () => ({ enabled: false }),
    } as never);
    const offSteps = Object.fromEntries((await coachOff.metrics(30, NOW)).steps.map((s) => [s.id, s]));
    expect(offSteps.ai_plan).toEqual({ id: 'ai_plan', completed: 2, rate: 2 / 6 });
  });

  it('narrows the cohort with a smaller window', async () => {
    // From the previous scenario's data: only users created within 5 days of NOW (f).
    const out = await service.metrics(5, NOW);

    expect(out.cohortSize).toBe(1);
    expect(out.eligible).toBe(0);
    expect(out.activated).toBe(0);
    expect(out.activationRate).toBeNull();
    expect(out.medianHoursToFirstWorkout).toBe(0.5);
    expect(out.steps.find((s) => s.id === 'first_workout')).toEqual({
      id: 'first_workout',
      completed: 1,
      rate: 1,
    });
  });

  it('rounds the median to one decimal', async () => {
    const n = new Date('2110-06-15T12:00:00.000Z');
    const x = await makeUser('m1', ago(10 * DAY, n));
    const y = await makeUser('m2', ago(10 * DAY, n));
    await completedAfter(x, 1 * HOUR);
    await completedAfter(y, 2 * HOUR + 10 * 60 * 1000); // 2h10m = 2.1666h; median (1 + 2.1666)/2 = 1.5833

    const out = await service.metrics(30, n);

    expect(out.cohortSize).toBe(2);
    expect(out.medianHoursToFirstWorkout).toBe(1.6);
  });

  it('returns zeros and nulls for an empty cohort', async () => {
    const out = await service.metrics(30, EMPTY_NOW);

    expect(out).toEqual({
      windowDays: 30,
      activationWindowDays: 7,
      cohortSize: 0,
      eligible: 0,
      activated: 0,
      activationRate: null,
      medianHoursToFirstWorkout: null,
      steps: [
        { id: 'health_profile', completed: 0, rate: null },
        { id: 'gym', completed: 0, rate: null },
        { id: 'first_workout', completed: 0, rate: null },
        { id: 'ai_plan', completed: 0, rate: null },
      ],
    });
  });
});
