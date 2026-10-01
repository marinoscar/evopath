import { NotFoundException } from '@nestjs/common';

import { CONVERSION_WINDOW_MS, conversionCandidateWhere } from './coach-conversion';
import { CoachMessagesService } from './coach-messages.service';

// =============================================================================
// Opened, feedback and conversion attribution (E7.5, #245)
// =============================================================================

const USER = '00000000-0000-4000-8000-000000000001';
const MESSAGE = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date('2026-10-01T10:00:00Z');

function setup(message: Record<string, unknown> | null = { id: MESSAGE, moment: 'missed_twice', openedAt: null }) {
  const prisma = {
    coachMessage: {
      findFirst: jest.fn(async () => message),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    coachState: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const metrics = { coachNudgeOpen: jest.fn(), coachFeedbackGiven: jest.fn(), coachNudgeConversion: jest.fn() };
  return { service: new CoachMessagesService(prisma as never, metrics as never), prisma, metrics };
}

describe('CoachMessagesService.markOpened', () => {
  it('sets openedAt once, resets consecutiveIgnored and clears silencedAt', async () => {
    const t = setup();
    await t.service.markOpened(USER, MESSAGE, NOW);
    expect(t.prisma.coachMessage.findFirst).toHaveBeenCalledWith({
      where: { id: MESSAGE, userId: USER, role: 'coach' },
      select: { id: true, moment: true, openedAt: true },
    });
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MESSAGE, userId: USER, openedAt: null },
      data: { openedAt: NOW },
    });
    expect(t.prisma.coachState.updateMany).toHaveBeenCalledWith({
      where: { userId: USER },
      data: { consecutiveIgnored: 0, silencedAt: null },
    });
    expect(t.metrics.coachNudgeOpen).toHaveBeenCalledWith('missed_twice');
  });

  it('keeps the first openedAt on a second call', async () => {
    const t = setup({ id: MESSAGE, moment: 'missed_twice', openedAt: new Date('2026-10-01T09:00:00Z') });
    await t.service.markOpened(USER, MESSAGE, NOW);
    expect(t.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
    expect(t.metrics.coachNudgeOpen).not.toHaveBeenCalled();
    expect(t.prisma.coachState.updateMany).toHaveBeenCalled();
  });

  it('answers 404 COACH_MESSAGE_NOT_FOUND for an unknown, foreign or malformed id', async () => {
    const t = setup(null);
    await expect(t.service.markOpened(USER, MESSAGE, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.service.markOpened(USER, 'not-a-uuid', NOW)).rejects.toMatchObject({
      response: { details: { code: 'COACH_MESSAGE_NOT_FOUND' } },
    });
    expect(t.prisma.coachState.updateMany).not.toHaveBeenCalled();
  });
});

describe('CoachMessagesService.setFeedback', () => {
  it.each(['up', 'down', null] as const)('stores %s on the caller\'s message', async (value) => {
    const t = setup();
    await t.service.setFeedback(USER, MESSAGE, value);
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({ where: { id: MESSAGE, userId: USER }, data: { feedback: value } });
    expect(t.metrics.coachFeedbackGiven).toHaveBeenCalledWith(value);
  });

  it('404s another user\'s message', async () => {
    const t = setup(null);
    await expect(t.service.setFeedback(USER, MESSAGE, 'up')).rejects.toBeInstanceOf(NotFoundException);
    expect(t.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
  });
});

describe('conversion attribution', () => {
  it('windows: 24h workout and check-in, 48h photo', () => {
    expect(CONVERSION_WINDOW_MS).toEqual({ workout: 86_400_000, photo: 172_800_000, check_in: 86_400_000 });
  });

  it('a workout converts the pushy moments only, delivered inside 24 hours', () => {
    expect(conversionCandidateWhere(USER, 'workout', NOW)).toEqual({
      userId: USER,
      role: 'coach',
      convertedAt: null,
      deliveredAt: { gte: new Date('2026-09-30T10:00:00Z'), lte: NOW },
      moment: { in: ['missed_twice', 'streak_at_risk', 'missed_session', 'fresh_start', 'win_back'] },
    });
  });

  it('a photo converts a photo prompt inside 48 hours; a check-in a low-readiness message inside 24', () => {
    expect(conversionCandidateWhere(USER, 'photo', NOW)).toMatchObject({
      moment: 'photo_prompt',
      deliveredAt: { gte: new Date('2026-09-29T10:00:00Z') },
    });
    expect(conversionCandidateWhere(USER, 'check_in', NOW)).toMatchObject({
      data: { path: ['lowReadiness'], equals: true },
      deliveredAt: { gte: new Date('2026-09-30T10:00:00Z') },
    });
  });

  it('stamps convertedAt on the latest candidate and counts it', async () => {
    const t = setup({ id: MESSAGE, moment: 'missed_twice' });
    await expect(t.service.recordConversion(USER, 'workout', NOW)).resolves.toBe(MESSAGE);
    expect(t.prisma.coachMessage.findFirst).toHaveBeenCalledWith({
      where: conversionCandidateWhere(USER, 'workout', NOW),
      orderBy: { deliveredAt: 'desc' },
      select: { id: true, moment: true },
    });
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({ where: { id: MESSAGE, convertedAt: null }, data: { convertedAt: NOW } });
    expect(t.metrics.coachNudgeConversion).toHaveBeenCalledWith('missed_twice', 'workout');
  });

  it('sets nothing when no message qualifies (outside the window, or a celebration)', async () => {
    const t = setup(null);
    await expect(t.service.recordConversion(USER, 'workout', NOW)).resolves.toBeNull();
    expect(t.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
    expect(t.metrics.coachNudgeConversion).not.toHaveBeenCalled();
  });
});
