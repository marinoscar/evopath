import { CoachMessageDeliverHandler } from './coach-message-deliver.handler';

// =============================================================================
// coach.message.deliver (E7.5, #245): notifyNow outside any transaction, the
// inbox id and deliveredAt stamped, CoachState counted, idempotent on retry.
// =============================================================================

const USER = '00000000-0000-4000-8000-000000000001';
const MESSAGE = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date('2026-10-01T10:00:00Z');

interface GateOptions {
  aiEnabled?: boolean;
  systemEnabled?: boolean;
  isActive?: boolean;
  coachEnabled?: boolean;
  pausedUntil?: Date | null;
  noSettingsRow?: boolean;
  /** The system `coach.allowAudio` (default true). */
  allowAudio?: boolean;
  /** The user's `coach.audio.enabled` (default false, as stored settings default). */
  audioEnabled?: boolean;
}

function setup(message: Record<string, unknown> | null = {}, stampedCount = 1, gate: GateOptions = {}) {
  const calls: string[] = [];
  const row =
    message === null
      ? null
      : {
          id: MESSAGE,
          userId: USER,
          role: 'coach',
          kind: 'nudge',
          moment: 'missed_twice',
          title: 'Back to it today',
          pushTitle: 'Your coach checked in',
          pushBody: 'Ready for a short session today?',
          audioStatus: 'none',
          deliveredAt: null,
          user: { healthProfile: { timeZone: 'Europe/Madrid' } },
          ...message,
        };
  const prisma = {
    coachMessage: {
      findUnique: jest.fn(async () => row),
      updateMany: jest.fn(async ({ data }: any) => {
        if ('deliveredAt' in data) {
          calls.push(data.deliveredAt === null ? 'release' : 'stamp');
          return { count: data.deliveredAt === null ? 1 : stampedCount };
        }
        if ('notificationId' in data) {
          calls.push('inbox');
          return { count: 1 };
        }
        calls.push('suppress');
        return { count: stampedCount };
      }),
    },
    userSettings: {
      findUnique: jest.fn(async () =>
        gate.noSettingsRow
          ? null
          : {
              value: { coach: { enabled: gate.coachEnabled ?? true, audio: { enabled: gate.audioEnabled ?? false } } },
              user: { isActive: gate.isActive ?? true },
            },
      ),
    },
    coachState: { findUnique: jest.fn(async () => ({ pausedUntil: gate.pausedUntil ?? null })) },
    $transaction: jest.fn(),
  };
  const aiConfig = { isEnabled: jest.fn(async () => gate.aiEnabled ?? true) };
  const systemSettings = {
    getCoachPolicy: jest.fn(async () => ({ enabled: gate.systemEnabled ?? true, allowAudio: gate.allowAudio ?? true })),
  };
  const notifications = {
    notifyNow: jest.fn(async () => {
      calls.push('notify');
      return { rateLimited: false, retryAfterMs: null, notificationId: 'inbox-1' };
    }),
  };
  const coachState = {
    recordNudgeSent: jest.fn(async () => {
      calls.push('count');
    }),
  };
  const registry = { register: jest.fn() };
  const metrics = { coachNudgeDelivered: jest.fn(), coachNudgeSuppression: jest.fn() };
  const handler = new CoachMessageDeliverHandler(
    registry as never,
    prisma as never,
    notifications as never,
    coachState as never,
    aiConfig as never,
    systemSettings as never,
    metrics as never,
  );
  return { handler, prisma, notifications, coachState, registry, metrics, calls };
}

describe('CoachMessageDeliverHandler', () => {
  it('is server-only with a 3-minute / 3-attempt profile (room for a slow SMTP send)', () => {
    const t = setup();
    t.handler.onModuleInit();
    expect(t.registry.register).toHaveBeenCalledWith(t.handler);
    expect(t.handler.type).toBe('coach.message.deliver');
    expect(t.handler.profile).toEqual({ maxRuntimeMs: 180_000, maxAttempts: 3 });
    expect('nodeResultSchema' in t.handler).toBe(false);
    expect('persistNodeResult' in t.handler).toBe(false);
  });

  it('claims deliveredAt, notifies with the lock-screen pair, stores the inbox id, then counts the nudge', async () => {
    const t = setup();
    const outcome = await t.handler.deliver(MESSAGE, NOW);

    expect(outcome).toEqual({ status: 'delivered', eventKey: 'coach.nudge', notificationId: 'inbox-1' });
    expect(t.notifications.notifyNow).toHaveBeenCalledWith('coach.nudge', USER, {
      messageId: MESSAGE,
      pushTitle: 'Your coach checked in',
      pushBody: 'Ready for a short session today?',
      hasAudio: false,
    });
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MESSAGE, deliveredAt: null },
      data: { deliveredAt: NOW },
    });
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({ where: { id: MESSAGE }, data: { notificationId: 'inbox-1' } });
    expect(t.coachState.recordNudgeSent).toHaveBeenCalledWith(USER, NOW, 'Europe/Madrid');
    expect(t.calls).toEqual(['stamp', 'notify', 'inbox', 'count']);
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
    expect(t.metrics.coachNudgeDelivered).toHaveBeenCalledWith('missed_twice');
  });

  it.each([
    ['celebration', 'coach.celebration'],
    ['photo_prompt', 'coach.photo_prompt'],
    ['comeback', 'coach.nudge'],
    ['system', 'coach.nudge'],
  ])('raises the %s kind as %s', async (kind, eventKey) => {
    const t = setup({ kind });
    await t.handler.deliver(MESSAGE, NOW);
    expect(t.notifications.notifyNow).toHaveBeenCalledWith(eventKey, USER, expect.any(Object));
  });

  it('flags hasAudio when audio is available on demand (#259): user audio on AND system allowAudio; the body stays text', async () => {
    const t = setup({}, 1, { audioEnabled: true });
    await t.handler.deliver(MESSAGE, NOW);
    expect(t.notifications.notifyNow).toHaveBeenCalledWith(
      'coach.nudge',
      USER,
      expect.objectContaining({ hasAudio: true, pushBody: 'Ready for a short session today?', messageId: MESSAGE }),
    );
  });

  it.each([
    ['user audio off', { audioEnabled: false }],
    ['system allowAudio off', { audioEnabled: true, allowAudio: false }],
  ])('hasAudio false when %s', async (_label, gate) => {
    const t = setup({}, 1, gate);
    await t.handler.deliver(MESSAGE, NOW);
    expect(t.notifications.notifyNow).toHaveBeenCalledWith('coach.nudge', USER, expect.objectContaining({ hasAudio: false }));
  });

  it.each([['pending'], ['ready'], ['failed']])(
    'never touches audioStatus (%s): an on-demand request in flight is left alone and the text goes now',
    async (audioStatus) => {
      const t = setup({ audioStatus }, 1, { audioEnabled: true });
      await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toMatchObject({ status: 'delivered' });
      expect(t.calls).toEqual(['stamp', 'notify', 'inbox', 'count']);
      for (const [args] of t.prisma.coachMessage.updateMany.mock.calls as unknown as Array<[{ data: object }]>) {
        expect(args.data).not.toHaveProperty('audioStatus');
      }
      expect(t.notifications.notifyNow).toHaveBeenCalledWith('coach.nudge', USER, expect.objectContaining({ hasAudio: true }));
    },
  );

  it('is idempotent: an already delivered message is never sent again', async () => {
    const t = setup({ deliveredAt: new Date('2026-10-01T09:00:00Z') });
    await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toEqual({ status: 'skipped', reason: 'already_delivered' });
    expect(t.notifications.notifyNow).not.toHaveBeenCalled();
    expect(t.coachState.recordNudgeSent).not.toHaveBeenCalled();
  });

  it('never sends when a concurrent (or lease-lapsed) delivery claimed first (review finding)', async () => {
    const t = setup({}, 0);
    await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toEqual({ status: 'skipped', reason: 'already_delivered' });
    expect(t.notifications.notifyNow).not.toHaveBeenCalled();
    expect(t.coachState.recordNudgeSent).not.toHaveBeenCalled();
  });

  it('two overlapping runs over one row send exactly once (review finding)', async () => {
    const t = setup();
    // One shared row: the guarded claim lands for the first run only.
    const row: Record<string, unknown> = { deliveredAt: null };
    t.prisma.coachMessage.findUnique.mockImplementation(async () => ({
      id: MESSAGE,
      userId: USER,
      role: 'coach',
      kind: 'weekly_review',
      moment: 'weekly_review',
      title: 'Your week',
      pushTitle: 'Your week in review',
      pushBody: 'Coach has your weekly review.',
      audioStatus: 'none',
      deliveredAt: null, // both runs read before either claims
      user: { healthProfile: { timeZone: 'Europe/Madrid' } },
    }));
    t.prisma.coachMessage.updateMany.mockImplementation(async ({ where, data }: any) => {
      if ('deliveredAt' in data && where.deliveredAt === null) {
        if (row.deliveredAt) return { count: 0 };
        row.deliveredAt = data.deliveredAt;
        return { count: 1 };
      }
      return { count: 1 };
    });
    let release!: () => void;
    t.notifications.notifyNow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ rateLimited: false, retryAfterMs: null, notificationId: 'inbox-1' });
        }),
    );

    const first = t.handler.deliver(MESSAGE, NOW);
    await new Promise((r) => setImmediate(r));
    const second = await t.handler.deliver(MESSAGE, new Date(NOW.getTime() + 61_000));
    release();

    await expect(first).resolves.toMatchObject({ status: 'delivered' });
    expect(second).toEqual({ status: 'skipped', reason: 'already_delivered' });
    expect(t.notifications.notifyNow).toHaveBeenCalledTimes(1);
  });

  it('a notifyNow that throws releases the claim (guarded on its own stamp) and rethrows so the queue retries', async () => {
    const t = setup();
    t.notifications.notifyNow.mockRejectedValueOnce(new Error('smtp exploded'));
    await expect(t.handler.deliver(MESSAGE, NOW)).rejects.toThrow('smtp exploded');

    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MESSAGE, deliveredAt: NOW },
      data: { deliveredAt: null },
    });
    expect(t.calls).toEqual(['stamp', 'release']);
    expect(t.coachState.recordNudgeSent).not.toHaveBeenCalled();
    expect(t.metrics.coachNudgeDelivered).not.toHaveBeenCalled();

    // The retry sends.
    await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toMatchObject({ status: 'delivered' });
    expect(t.notifications.notifyNow).toHaveBeenCalledTimes(2);
  });

  it('skips a missing message or a user-authored row', async () => {
    await expect(setup(null).handler.deliver(MESSAGE, NOW)).resolves.toEqual({ status: 'skipped', reason: 'not_found' });
    const t = setup({ role: 'user' });
    await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toEqual({ status: 'skipped', reason: 'not_found' });
    expect(t.notifications.notifyNow).not.toHaveBeenCalled();
  });

  it('stores no notificationId when the browser channel did not deliver', async () => {
    const t = setup();
    t.notifications.notifyNow.mockResolvedValueOnce({ rateLimited: false, retryAfterMs: null } as never);
    await t.handler.deliver(MESSAGE, NOW);
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({ where: { id: MESSAGE, deliveredAt: null }, data: { deliveredAt: NOW } });
  });

  describe('re-checks state that changed after the nudge job (review finding)', () => {
    const LATER = new Date(NOW.getTime() + 86_400_000);

    it.each<[string, GateOptions, string]>([
      ['AI switched off', { aiEnabled: false }, 'coach_off'],
      ['the system coach switched off', { systemEnabled: false }, 'coach_off'],
      ['the account deactivated', { isActive: false }, 'coach_off'],
      ['the user turned the coach off', { coachEnabled: false }, 'coach_off'],
      ['no settings row', { noSettingsRow: true }, 'coach_off'],
      ['the user paused the coach', { pausedUntil: LATER }, 'paused'],
    ])('%s: no notification, data.suppressed recorded, counted', async (_label, gate, reason) => {
      const t = setup({ data: { momentKey: 'k1' } }, 1, gate);
      await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toEqual({ status: 'suppressed', reason });

      expect(t.notifications.notifyNow).not.toHaveBeenCalled();
      expect(t.coachState.recordNudgeSent).not.toHaveBeenCalled();
      expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledTimes(1);
      expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({
        where: { id: MESSAGE, deliveredAt: null },
        data: { data: { momentKey: 'k1', suppressed: { reason, at: NOW.toISOString() } } },
      });
      expect(t.metrics.coachNudgeSuppression).toHaveBeenCalledWith(reason, 'missed_twice');
    });

    it('a past pause does not suppress', async () => {
      const t = setup({}, 1, { pausedUntil: new Date(NOW.getTime() - 1000) });
      await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toMatchObject({ status: 'delivered' });
    });

    it('a weekly review obeys a pause (spec §2.10)', async () => {
      const t = setup({ kind: 'weekly_review', moment: 'weekly_review' }, 1, { pausedUntil: LATER });
      await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toEqual({ status: 'suppressed', reason: 'paused' });
      expect(t.notifications.notifyNow).not.toHaveBeenCalled();
    });

    it('a kickoff is not dropped by a pause (kickoffGate deferred it already), but obeys coach off', async () => {
      const paused = setup({ kind: 'kickoff', moment: 'kickoff' }, 1, { pausedUntil: LATER });
      await expect(paused.handler.deliver(MESSAGE, NOW)).resolves.toMatchObject({ status: 'delivered' });
      const off = setup({ kind: 'kickoff', moment: 'kickoff' }, 1, { coachEnabled: false });
      await expect(off.handler.deliver(MESSAGE, NOW)).resolves.toEqual({ status: 'suppressed', reason: 'coach_off' });
    });

    it('a suppressed message is never sent by a later run, even once the gate reopens', async () => {
      const t = setup({ data: { suppressed: { reason: 'paused', at: NOW.toISOString() } } });
      await expect(t.handler.deliver(MESSAGE, LATER)).resolves.toEqual({ status: 'skipped', reason: 'suppressed' });
      expect(t.notifications.notifyNow).not.toHaveBeenCalled();
      expect(t.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
    });

    it('a pending audio message suppressed at delivery is not sent and its audio is left alone', async () => {
      const t = setup({ audioStatus: 'pending' }, 1, { pausedUntil: LATER });
      await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toMatchObject({ status: 'suppressed' });
      expect(t.calls).toEqual(['suppress']);
    });
  });

  it('does not count a weekly review against the daily cap', async () => {
    const t = setup({ kind: 'weekly_review', moment: 'weekly_review' });
    await t.handler.deliver(MESSAGE, NOW);
    expect(t.notifications.notifyNow).toHaveBeenCalledWith('coach.weekly_review', USER, expect.any(Object));
    expect(t.coachState.recordNudgeSent).not.toHaveBeenCalled();
  });

  it('ignores a job with an invalid payload', async () => {
    const t = setup();
    await t.handler.process({ id: 'job-1', payload: { messageId: 'nope' } } as never);
    expect(t.prisma.coachMessage.findUnique).not.toHaveBeenCalled();
  });
});
