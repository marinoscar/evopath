import { randomUUID } from 'node:crypto';

import { EVALUATION_SWEEP } from '../evaluation.constants';
import { APPROVAL_EXPIRED_CODE, TrainingEvaluationSweepHandler } from './training-evaluation-sweep.handler';

// Wednesday 2026-09-30 12:10 UTC: no weekly review is due for a plan whose
// last one was this week, and it is not the 06:00 missed-sessions hour in UTC.
const NOW = new Date('2026-09-30T12:10:00.000Z');
const THIS_SUNDAY_REVIEW = new Date('2026-09-27T18:05:00.000Z');

type Program = {
  id: string;
  userId: string;
  startDate: Date | null;
  lastEvaluatedAt: Date | null;
  lastWeeklyEvaluationAt: Date | null;
  evaluationRequestedAt: Date | null;
  user: { healthProfile: { timeZone: string | null } | null };
};

function program(overrides: Partial<Program> = {}): Program {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    startDate: new Date('2026-09-07T00:00:00.000Z'),
    lastEvaluatedAt: new Date('2026-09-29T10:00:00.000Z'),
    lastWeeklyEvaluationAt: THIS_SUNDAY_REVIEW,
    evaluationRequestedAt: null,
    user: { healthProfile: { timeZone: 'UTC' } },
    ...overrides,
  };
}

function setup(opts: { aiEnabled?: boolean; programs?: Program[]; expired?: number; missedStreak?: number } = {}) {
  const programs = [...(opts.programs ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
  const awaiting = Array.from({ length: opts.expired ?? 0 }, () => ({ id: randomUUID(), status: 'awaiting_approval' }));
  const prisma = {
    program: {
      findMany: jest.fn(async (args: { where: { id?: { gt: string } }; take: number }) =>
        programs.filter((p) => !args.where.id || p.id > args.where.id.gt).slice(0, args.take),
      ),
    },
    programWeek: {
      findMany: jest.fn(async () => [
        { weekNumber: 1, blockId: 'a' },
        { weekNumber: 2, blockId: 'a' },
        { weekNumber: 3, blockId: 'a' },
        { weekNumber: 4, blockId: 'a' },
      ]),
    },
    trainingPlanRun: {
      findMany: jest.fn(async (args: { take: number }) => awaiting.slice(0, args.take).map((r) => ({ id: r.id }))),
      updateMany: jest.fn(async (args: { where: { id: string } }) => {
        const run = awaiting.find((r) => r.id === args.where.id && r.status === 'awaiting_approval');
        if (run) run.status = 'cancelled';
        return { count: run ? 1 : 0 };
      }),
    },
    programChangeLog: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const scheduler = {
    requestEvaluation: jest.fn(async (_userId: string, _trigger: string, _options: unknown) => ({
      status: 'created' as const,
      runId: randomUUID(),
      programId: 'p',
    })),
  };
  const signals = {
    forEvaluator: jest.fn(async () => ({ adherence: { missedStreak: opts.missedStreak ?? 0 } })),
  };
  const events = { emit: jest.fn(async () => undefined) };
  const handler = new TrainingEvaluationSweepHandler(
    { register: jest.fn() } as never,
    prisma as never,
    { isEnabled: jest.fn(async () => opts.aiEnabled ?? true) } as never,
    scheduler as never,
    signals as never,
    events as never,
  );
  return { handler, prisma, scheduler, signals, events, awaiting };
}

describe('TrainingEvaluationSweepHandler', () => {
  it('is a server-only housekeeping handler with a 10-minute, 3-attempt profile', () => {
    const { handler } = setup();
    expect(handler.type).toBe('training.evaluation.sweep');
    expect(handler.profile).toEqual({ maxRuntimeMs: 600_000, maxAttempts: 3 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
  });

  it('does nothing with AI off', async () => {
    const t = setup({ aiEnabled: false, programs: [program({ evaluationRequestedAt: NOW })], expired: 2 });

    const summary = await t.handler.sweep('job', NOW);

    expect(summary).toMatchObject({ aiEnabled: false, expiredProposals: 0, created: 0 });
    expect(t.prisma.program.findMany).not.toHaveBeenCalled();
    expect(t.prisma.trainingPlanRun.findMany).not.toHaveBeenCalled();
    expect(t.scheduler.requestEvaluation).not.toHaveBeenCalled();
  });

  it('expires proposals past their expiry: run cancelled, proposed entries expired, event appended', async () => {
    const t = setup({ expired: 2 });

    const summary = await t.handler.sweep('job', NOW);

    expect(summary.expiredProposals).toBe(2);
    expect(t.prisma.trainingPlanRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'awaiting_approval', expiresAt: { lt: NOW } } }),
    );
    expect(t.prisma.trainingPlanRun.updateMany).toHaveBeenCalledWith({
      where: { id: t.awaiting[0].id, status: 'awaiting_approval', expiresAt: { lt: NOW } },
      data: { status: 'cancelled', completedAt: NOW, stage: null, errorCode: APPROVAL_EXPIRED_CODE },
    });
    expect(t.prisma.programChangeLog.updateMany).toHaveBeenCalledWith({
      where: { runId: t.awaiting[0].id, status: 'proposed' },
      data: { status: 'expired', decidedAt: NOW },
    });
    expect(t.events.emit).toHaveBeenCalledWith(t.awaiting[1].id, 'run.cancelled', {});
  });

  it('routes each due plan to its trigger: weekly (deep in a block\'s last week), a deferred request, missed sessions', async () => {
    const weekly = program({ lastWeeklyEvaluationAt: null, startDate: new Date('2026-09-10T00:00:00.000Z') });
    const pending = program({ evaluationRequestedAt: new Date('2026-09-30T11:00:00.000Z') });
    const idle = program({ lastEvaluatedAt: null });
    const t = setup({ programs: [weekly, pending, idle] });

    await t.handler.sweep('job', NOW);

    const calls = t.scheduler.requestEvaluation.mock.calls.map(([userId, trigger, options]) => ({ userId, trigger, options }));
    // 2026-09-30 is day 20 of a plan started 09-10: week 3 of 4 in block a -> not deep.
    expect(calls).toContainEqual({ userId: weekly.userId, trigger: 'weekly', options: { deep: false, now: NOW } });
    expect(calls).toContainEqual({ userId: pending.userId, trigger: 'workout_finished', options: { now: NOW } });
    // 12:10 UTC is not the missed-sessions hour: `idle` is not even a candidate.
    expect(calls.map((c) => c.userId)).not.toContain(idle.userId);
  });

  it('marks a weekly review in the last week of a block deep', async () => {
    const weekly = program({ lastWeeklyEvaluationAt: null, startDate: new Date('2026-09-05T00:00:00.000Z') });
    const t = setup({ programs: [weekly] });

    await t.handler.sweep('job', NOW);

    expect(t.scheduler.requestEvaluation).toHaveBeenCalledWith(weekly.userId, 'weekly', { deep: true, now: NOW });
  });

  it('reads the signals only for missed-sessions candidates (local 06:00), and needs a streak of 2', async () => {
    const at6 = new Date('2026-09-30T06:10:00.000Z');
    const idle = program({ lastEvaluatedAt: new Date('2026-09-20T00:00:00.000Z') });
    const recent = program({ lastEvaluatedAt: new Date('2026-09-29T00:00:00.000Z') });

    const two = setup({ programs: [idle, recent], missedStreak: 2 });
    await two.handler.sweep('job', at6);
    expect(two.signals.forEvaluator).toHaveBeenCalledTimes(1);
    expect(two.signals.forEvaluator).toHaveBeenCalledWith(idle.userId, idle.id, at6);
    expect(two.scheduler.requestEvaluation).toHaveBeenCalledWith(idle.userId, 'missed_sessions', { now: at6 });

    const one = setup({ programs: [idle], missedStreak: 1 });
    const summary = await one.handler.sweep('job', at6);
    expect(one.scheduler.requestEvaluation).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ due: 1, considered: 1, skipped: 1, created: 0 });
  });

  it('pages through every active plan by id, 500 at a time', async () => {
    const plans = Array.from({ length: 1_203 }, () => program());
    const t = setup({ programs: plans });

    const summary = await t.handler.sweep('job', NOW);

    expect(t.prisma.program.findMany).toHaveBeenCalledTimes(3);
    const [first, second] = t.prisma.program.findMany.mock.calls.map(([args]) => args);
    expect(first).toMatchObject({ where: { status: 'active', autonomyPausedAt: null }, orderBy: { id: 'asc' }, take: 500 });
    expect(second.where.id?.gt).toBe([...plans].sort((a, b) => (a.id < b.id ? -1 : 1))[499].id);
    expect(summary).toMatchObject({ scanned: 1_203, due: 0, created: 0 });
  });

  it('serves at most 200 users a pass, oldest-evaluated first (never evaluated first)', async () => {
    const plans = Array.from({ length: 260 }, (_, i) =>
      program({
        evaluationRequestedAt: new Date('2026-09-30T11:00:00.000Z'),
        lastEvaluatedAt: i % 2 === 0 ? null : new Date(Date.UTC(2026, 8, 1) + i * 60_000),
      }),
    );
    const t = setup({ programs: plans });

    const summary = await t.handler.sweep('job', NOW);

    expect(summary).toMatchObject({ due: 260, considered: EVALUATION_SWEEP.maxUsers, created: EVALUATION_SWEEP.maxUsers });
    const served = new Set(t.scheduler.requestEvaluation.mock.calls.map(([userId]) => userId));
    const neverEvaluated = plans.filter((p) => p.lastEvaluatedAt === null);
    expect(neverEvaluated.every((p) => served.has(p.userId))).toBe(true);
    // Of the evaluated ones, the 70 oldest are served and the 60 newest wait for the next pass.
    const evaluated = plans.filter((p) => p.lastEvaluatedAt !== null).sort((a, b) => a.lastEvaluatedAt!.getTime() - b.lastEvaluatedAt!.getTime());
    expect(evaluated.slice(0, 70).every((p) => served.has(p.userId))).toBe(true);
    expect(evaluated.slice(70).some((p) => served.has(p.userId))).toBe(false);
  });

  it('stops at 500 runs a pass, counting expired proposals', async () => {
    const plans = Array.from({ length: 50 }, () => program({ evaluationRequestedAt: NOW }));
    const t = setup({ programs: plans, expired: 490 });

    const summary = await t.handler.sweep('job', NOW);

    expect(summary).toMatchObject({ expiredProposals: 490, created: 10 });
  });

  it('counts deferred and skipped outcomes, and one user\'s failure does not stop the pass', async () => {
    const plans = Array.from({ length: 4 }, () => program({ evaluationRequestedAt: NOW }));
    const t = setup({ programs: plans });
    t.scheduler.requestEvaluation
      .mockResolvedValueOnce({ status: 'deferred', reason: 'active_run' } as never)
      .mockResolvedValueOnce({ status: 'skipped', reason: 'automation_paused' } as never)
      .mockRejectedValueOnce(new Error('boom'));

    const summary = await t.handler.sweep('job', NOW);

    expect(summary).toMatchObject({ considered: 4, deferred: 1, skipped: 1, failed: 1, created: 1 });
  });
});
