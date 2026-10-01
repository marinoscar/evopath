// =============================================================================
// Real-Postgres test: global angle rewards (E7.11, #251; E7.13, #253)
// =============================================================================
//
// What only a real server can prove: `AngleStatsService` runs ONE grouped raw
// SQL aggregate over `coach_messages`, reading `data->'eligibleAngles'`,
// `data->>'register'` and `data->>'lowReadiness'` out of the JSONB column, with
// a `moment IN (...)` list built by `Prisma.join`, a 90-day window and a 48 h
// maturity cut. The folding into mu+ / mu- is pure (and unit-tested); this
// suite proves the SQL feeds it the right rows and the right JSON.
//
// `now` is pinned to 2021-03-01 12:00 UTC so rows other suites leave behind
// (all dated near their own run) cannot fall into the window.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { AngleStatsService } from '../../src/coach/learning/angle-stats.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('coach-angle-stats.db.spec');

const NOW = new Date('2021-03-01T12:00:00.000Z');
const at = (iso: string) => new Date(`${iso}Z`);

describeWithDb('angle stats (real Postgres)', () => {
  let client: PrismaClient;
  let service: AngleStatsService;
  let userId: string;
  const run = randomUUID().slice(0, 8);

  async function msg(
    deliveredAt: Date | null,
    over: { moment?: string | null; angle?: string | null; converted?: boolean; data?: Record<string, unknown> | null; role?: string } = {},
  ): Promise<void> {
    await client.coachMessage.create({
      data: {
        userId,
        role: over.role ?? 'coach',
        kind: 'nudge',
        moment: over.moment === undefined ? 'missed_twice' : over.moment,
        angle: over.angle === undefined ? null : over.angle,
        body: 'x',
        deliveredAt,
        convertedAt: over.converted ? deliveredAt : null,
        ...(over.data ? { data: over.data as never } : {}),
      },
    });
  }

  beforeAll(async () => {
    client = createDbClient();
    service = new AngleStatsService(client as unknown as PrismaService);
    userId = (await client.user.create({ data: { email: `angles-${run}@example.com` }, select: { id: true } })).id;

    const pair = { eligibleAngles: ['identity', 'humor'] };
    // identity: 2 sends (1 converted), recorded eligible set {identity, humor}.
    await msg(at('2021-01-10T10:00:00'), { angle: 'identity', converted: true, data: pair });
    await msg(at('2021-01-11T10:00:00'), { angle: 'identity', data: pair });
    // humor: converted, same eligible set.
    await msg(at('2021-01-12T10:00:00'), { moment: 'win_back', angle: 'humor', converted: true, data: pair });
    // Older message with no recorded set but a supportive register: eligible = identity + future_self.
    await msg(at('2021-01-13T10:00:00'), { moment: 'fresh_start', angle: 'challenge', data: { register: 'supportive' } });
    // Older message with no set and no register: every angle was eligible. photo_prompt has a target by moment.
    await msg(at('2021-01-14T10:00:00'), { moment: 'photo_prompt', angle: 'data', converted: true });
    // No target by moment, but sent under low readiness (included through data->>'lowReadiness').
    await msg(at('2021-01-15T10:00:00'), {
      moment: 'celebration', angle: 'humor', data: { lowReadiness: true, eligibleAngles: ['humor', 'data'] },
    });
    // A recorded set may carry a name that is not an angle: ignored, not an error.
    await msg(at('2021-01-16T10:00:00'), { angle: 'humor', data: { eligibleAngles: ['humor', 'bogus', 'challenge'] } });
    // Window start is inclusive (2020-12-01 12:00).
    await msg(at('2020-12-01T12:00:00'), { angle: 'challenge', converted: true, data: { eligibleAngles: ['challenge'] } });

    // ---- never counted
    await msg(at('2021-01-17T10:00:00'), { moment: 'celebration', angle: 'humor', data: { eligibleAngles: ['humor', 'data'] } }); // no target
    await msg(at('2021-01-17T11:00:00'), { moment: 'celebration', angle: 'data', data: { lowReadiness: false } }); // lowReadiness false
    await msg(at('2021-02-28T10:00:00'), { angle: 'identity', converted: true }); // still inside the 48 h maturity window
    await msg(at('2021-02-27T12:00:00'), { angle: 'identity', converted: true }); // exactly at the maturity edge (exclusive)
    await msg(at('2020-11-30T10:00:00'), { angle: 'identity', converted: true }); // older than 90 days
    await msg(at('2021-01-18T10:00:00'), { angle: null }); // no angle
    await msg(null, { angle: 'identity' }); // never delivered
    await msg(at('2021-01-19T10:00:00'), { angle: 'identity', role: 'user' }); // not a coach message
  });

  afterAll(async () => {
    if (!client) return;
    if (userId) await client.user.deleteMany({ where: { id: userId } });
    await client.$disconnect();
  });

  it('counts sends and conversions per angle, and eligible-but-not-sent from the recorded set, the register, or every angle', async () => {
    const rewards = await service.rewards(NOW);

    expect(rewards).toEqual({
      identity: { sent: 2, sentConverted: 1, notSent: 3, notSentConverted: 2 },
      humor: { sent: 3, sentConverted: 1, notSent: 3, notSentConverted: 2 },
      challenge: { sent: 2, sentConverted: 1, notSent: 2, notSentConverted: 1 },
      data: { sent: 1, sentConverted: 1, notSent: 1, notSentConverted: 0 },
      future_self: { sent: 0, sentConverted: 0, notSent: 2, notSentConverted: 1 },
      loss_aversion: { sent: 0, sentConverted: 0, notSent: 1, notSentConverted: 1 },
      social_proof_self: { sent: 0, sentConverted: 0, notSent: 1, notSentConverted: 1 },
    });
  });

  it('excludes messages inside the 48 h maturity window until it has passed', async () => {
    const before = await service.rewards(NOW);
    const later = await new AngleStatsService(client as unknown as PrismaService).rewards(new Date(NOW.getTime() + 3 * 24 * 3_600_000));

    // The 02-28 and 02-27 12:00 identity sends are now mature (and 12-01 12:00 has aged out of the window).
    expect(before.identity?.sent).toBe(2);
    expect(later.identity?.sent).toBe(4);
    expect(later.challenge?.sent).toBe(1);
  });

  it('answers an empty set (cold start) when nothing is in the window', async () => {
    const far = await new AngleStatsService(client as unknown as PrismaService).rewards(new Date('2030-01-01T00:00:00.000Z'));
    expect(far).toEqual({});
  });
});
