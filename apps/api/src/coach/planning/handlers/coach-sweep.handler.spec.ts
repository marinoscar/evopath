import { CoachSweepHandler, COACH_SWEEP } from './coach-sweep.handler';

// E7.4: chunking by user cursor, per-user failure isolation (AC 14), the switches.

const SYSTEM = {
  enabled: true,
  allowProfanePersonas: false,
  allowAudio: true,
  maxNudgesPerDayCeiling: 4,
  audioRetentionDays: 30,
  autoSilenceAfterIgnored: 3,
  inactiveStopDays: 7,
};

function uid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function row(n: number, timeZone: string | null = 'Europe/Madrid') {
  return { userId: uid(n), value: { coach: { enabled: true } }, user: { healthProfile: timeZone ? { timeZone } : null } };
}

function setup(options: { ai?: boolean; coach?: boolean; pages?: ReturnType<typeof row>[][]; failFor?: string[] } = {}) {
  const pages = [...(options.pages ?? [[row(1), row(2), row(3)]])];
  const prisma = { userSettings: { findMany: jest.fn(async () => pages.shift() ?? []) } };
  const jobs = { enqueue: jest.fn(async () => ({ id: 'next-job' })) };
  const registry = { register: jest.fn() };
  const aiConfig = { isEnabled: jest.fn(async () => options.ai ?? true) };
  const systemSettings = {
    getCoachPolicy: jest.fn(async () => ({ ...SYSTEM, enabled: options.coach ?? true })),
    getNotificationsPolicy: jest.fn(async () => ({ browserEnabled: true, disabledEvents: [] })),
  };
  const planner = {
    planUser: jest.fn(async (userId: string) => {
      if (options.failFor?.includes(userId)) throw new Error('signals exploded with secret details');
      return { queued: 'missed_twice', weeklyReviewQueued: false, suppressed: 0 };
    }),
  };
  const metrics = { userError: jest.fn(), usersPlanned: jest.fn(), suppressed: jest.fn() };
  const handler = new CoachSweepHandler(
    registry as never,
    prisma as never,
    jobs as never,
    aiConfig as never,
    systemSettings as never,
    planner as never,
    metrics as never,
  );
  return { handler, prisma, jobs, planner, metrics, registry };
}

const NOW = new Date('2026-09-30T12:17:00Z');

describe('CoachSweepHandler', () => {
  it('declares the coach.sweep type, the 5-minute / 2-attempt profile and no node members (server-only)', () => {
    const { handler, registry } = setup();
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('coach.sweep');
    expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 2 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
  });

  it('pages coach-enabled active users by user id and plans each with its zone and settings', async () => {
    const t = setup();
    const summary = await t.handler.sweep('job-1', null, NOW);

    expect(t.prisma.userSettings.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { value: { path: ['coach', 'enabled'], equals: true }, user: { isActive: true } },
        orderBy: { userId: 'asc' },
        take: COACH_SWEEP.pageSize,
      }),
    );
    expect(t.planner.planUser).toHaveBeenCalledTimes(3);
    expect(t.planner.planUser).toHaveBeenCalledWith(
      uid(1),
      expect.objectContaining({ now: NOW, trigger: 'sweep', timeZone: 'Europe/Madrid', aiEnabled: true, settingsValue: { coach: { enabled: true } } }),
    );
    expect(summary).toEqual({ enabled: true, users: 3, queued: 3, failed: 0, continuedFrom: null });
    expect(t.metrics.usersPlanned).toHaveBeenCalledWith(3);
  });

  it('reads the next page after the last user of a full page', async () => {
    const full = Array.from({ length: COACH_SWEEP.pageSize }, (_, i) => row(i + 1));
    const t = setup({ pages: [full, [row(COACH_SWEEP.pageSize + 1, null)]] });

    const summary = await t.handler.sweep('job-1', null, NOW);

    expect(t.prisma.userSettings.findMany).toHaveBeenCalledTimes(2);
    const second = (t.prisma.userSettings.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>)[1][0];
    expect(second.where.userId).toEqual({ gt: uid(COACH_SWEEP.pageSize) });
    expect(summary.users).toBe(COACH_SWEEP.pageSize + 1);
    expect(t.planner.planUser).toHaveBeenLastCalledWith(uid(COACH_SWEEP.pageSize + 1), expect.objectContaining({ timeZone: null }));
  });

  it('starts after the payload cursor', async () => {
    const t = setup();
    await t.handler.process({ id: 'job-2', payload: { cursor: uid(9) } } as never);
    const first = (t.prisma.userSettings.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>)[0][0];
    expect(first.where.userId).toEqual({ gt: uid(9) });
  });

  it('isolates one user\'s failure: the others are planned, the error counted and logged by id only', async () => {
    const t = setup({ failFor: [uid(2)] });
    const warn = jest.spyOn((t.handler as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);

    const summary = await t.handler.sweep('job-1', null, NOW);

    expect(t.planner.planUser).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ users: 3, queued: 2, failed: 1 });
    expect(t.metrics.userError).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(uid(2)));
    expect(warn.mock.calls[0][0]).not.toContain('secret details');
  });

  it('propagates a page read failure so the queue retries', async () => {
    const t = setup();
    t.prisma.userSettings.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(t.handler.sweep('job-1', null, NOW)).rejects.toThrow('db down');
  });

  it.each([
    ['AI is off', { ai: false }],
    ['the coach is off', { coach: false }],
  ])('does nothing while %s', async (_label, options) => {
    const t = setup(options);
    const summary = await t.handler.sweep('job-1', null, NOW);
    expect(summary.enabled).toBe(false);
    expect(t.prisma.userSettings.findMany).not.toHaveBeenCalled();
    expect(t.planner.planUser).not.toHaveBeenCalled();
  });

  it('out of time, queues a continuation from the last finished user (skipDedup, housekeeping priority)', async () => {
    const t = setup();
    let elapsed = 0;
    // Each call to the clock advances past the budget once two users are done.
    const clock = () => elapsed;
    t.planner.planUser.mockImplementation(async () => {
      elapsed += COACH_SWEEP.timeBudgetMs / 2;
      return { queued: null, weeklyReviewQueued: false, suppressed: 0 } as never;
    });

    const summary = await t.handler.sweep('job-1', null, NOW, clock);

    expect(t.planner.planUser).toHaveBeenCalledTimes(2);
    expect(summary.continuedFrom).toBe(uid(2));
    expect(t.jobs.enqueue).toHaveBeenCalledWith({
      type: 'coach.sweep',
      reason: 'backfill',
      priority: 100,
      payload: { cursor: uid(2) },
      skipDedup: true,
    });
  });
});
