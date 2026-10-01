import { BanditAnglePicker } from './bandit-angle-picker';
import { ANGLE_USER_HISTORY_DAYS } from './learning.constants';
import type { AngleRewards } from './pick-angle';
import type { AnglePickInput } from '../nudges/angle-picker';

// E7.11 (#251): the bandit behind COACH_ANGLE_PICKER, with a mocked Prisma.

const NOW = new Date('2026-10-01T12:00:00Z');
const USER = '00000000-0000-4000-8000-000000000001';
const DAY_MS = 86_400_000;

const INPUT: AnglePickInput = { userId: USER, moment: 'missed_twice', personaId: 'coach', supportive: false, hasWhy: true };

function setup(opts: { history?: unknown[]; rewards?: AngleRewards | Error; rng?: () => number } = {}) {
  const prisma = { coachMessage: { findMany: jest.fn(async () => opts.history ?? []) } };
  const stats = {
    rewards: jest.fn(async () => {
      if (opts.rewards instanceof Error) throw opts.rewards;
      return opts.rewards ?? {};
    }),
  };
  const metrics = { coachAnglePicked: jest.fn() };
  const picker = new BanditAnglePicker(prisma as never, stats as never, metrics as never, opts.rng ?? (() => 0), () => NOW);
  return { picker, prisma, stats, metrics };
}

describe('BanditAnglePicker', () => {
  it('reads only the user\'s own recent angle history (indexed on user_id, created_at)', async () => {
    const t = setup();
    await t.picker.pick(INPUT);
    expect(t.prisma.coachMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: USER,
          role: 'coach',
          angle: { not: null },
          createdAt: { gte: new Date(NOW.getTime() - ANGLE_USER_HISTORY_DAYS * DAY_MS) },
        },
        select: { angle: true, deliveredAt: true, createdAt: true },
      }),
    );
  });

  it('cold start with rng 0 picks the first eligible angle and counts it', async () => {
    const t = setup({ rng: () => 0 });
    await expect(t.picker.pick(INPUT)).resolves.toBe('loss_aversion');
    expect(t.metrics.coachAnglePicked).toHaveBeenCalledWith('loss_aversion');
  });

  it('the novelty penalty steers away from the angle the user just got', async () => {
    const counts = { loss_aversion: 0, identity: 0 };
    let seed = 0;
    const rng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const t = setup({
      rng,
      history: [{ angle: 'loss_aversion', deliveredAt: new Date(NOW.getTime() - 1000), createdAt: NOW }],
    });
    for (let i = 0; i < 2000; i += 1) {
      const a = await t.picker.pick({ ...INPUT, hasWhy: false });
      if (a === 'loss_aversion' || a === 'identity') counts[a] += 1;
    }
    expect(counts.loss_aversion).toBeLessThan(counts.identity);
  });

  it('honours the supportive register', async () => {
    const t = setup({ rng: () => 0.99 });
    const angle = await t.picker.pick({ ...INPUT, supportive: true });
    expect(['identity', 'future_self']).toContain(angle);
  });

  it('falls back to the default angle when the learning loop fails', async () => {
    const t = setup();
    t.prisma.coachMessage.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(t.picker.pick(INPUT)).resolves.toBe('future_self');
    await expect(t.picker.pick({ ...INPUT, hasWhy: false, personaId: 'analyst' })).resolves.not.toBeNull();
  });

  it('ignores history rows with an unknown angle', async () => {
    const t = setup({ history: [{ angle: 'retired', deliveredAt: NOW, createdAt: NOW }], rng: () => 0 });
    await expect(t.picker.pick(INPUT)).resolves.toBe('loss_aversion');
  });
});
