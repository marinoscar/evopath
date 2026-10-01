import { CoachMessageDeliverHandler } from './coach-message-deliver.handler';

// =============================================================================
// coach.message.deliver (E7.5, #245): notifyNow outside any transaction, the
// inbox id and deliveredAt stamped, CoachState counted, idempotent on retry.
// =============================================================================

const USER = '00000000-0000-4000-8000-000000000001';
const MESSAGE = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date('2026-10-01T10:00:00Z');

function setup(message: Record<string, unknown> | null = {}, stampedCount = 1) {
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
      updateMany: jest.fn(async () => {
        calls.push('stamp');
        return { count: stampedCount };
      }),
    },
    $transaction: jest.fn(),
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
  const metrics = { coachNudgeDelivered: jest.fn() };
  const handler = new CoachMessageDeliverHandler(
    registry as never,
    prisma as never,
    notifications as never,
    coachState as never,
    metrics as never,
  );
  return { handler, prisma, notifications, coachState, registry, metrics, calls };
}

describe('CoachMessageDeliverHandler', () => {
  it('is server-only with a 1-minute / 3-attempt profile', () => {
    const t = setup();
    t.handler.onModuleInit();
    expect(t.registry.register).toHaveBeenCalledWith(t.handler);
    expect(t.handler.type).toBe('coach.message.deliver');
    expect(t.handler.profile).toEqual({ maxRuntimeMs: 60_000, maxAttempts: 3 });
    expect('nodeResultSchema' in t.handler).toBe(false);
    expect('persistNodeResult' in t.handler).toBe(false);
  });

  it('notifies with the lock-screen pair, then stamps deliveredAt and the inbox id, then counts the nudge', async () => {
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
      data: { deliveredAt: NOW, notificationId: 'inbox-1' },
    });
    expect(t.coachState.recordNudgeSent).toHaveBeenCalledWith(USER, NOW, 'Europe/Madrid');
    expect(t.calls).toEqual(['notify', 'stamp', 'count']);
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

  it('flags hasAudio when the audio is ready (E7.6 seam)', async () => {
    const t = setup({ audioStatus: 'ready' });
    await t.handler.deliver(MESSAGE, NOW);
    expect(t.notifications.notifyNow).toHaveBeenCalledWith('coach.nudge', USER, expect.objectContaining({ hasAudio: true }));
  });

  it('is idempotent: an already delivered message is never sent again', async () => {
    const t = setup({ deliveredAt: new Date('2026-10-01T09:00:00Z') });
    await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toEqual({ status: 'skipped', reason: 'already_delivered' });
    expect(t.notifications.notifyNow).not.toHaveBeenCalled();
    expect(t.coachState.recordNudgeSent).not.toHaveBeenCalled();
  });

  it('does not count twice when a concurrent delivery stamped first', async () => {
    const t = setup({}, 0);
    await expect(t.handler.deliver(MESSAGE, NOW)).resolves.toEqual({ status: 'skipped', reason: 'already_delivered' });
    expect(t.coachState.recordNudgeSent).not.toHaveBeenCalled();
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
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({ where: { id: MESSAGE, deliveredAt: null }, data: { deliveredAt: NOW } });
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
