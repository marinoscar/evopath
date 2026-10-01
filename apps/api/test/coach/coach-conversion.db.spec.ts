// =============================================================================
// Real-Postgres test: coach conversion attribution (E7.5, #245; E7.13, #253)
// =============================================================================
//
// What only a real server can prove: `conversionCandidateWhere` combines a
// delivery-window range (`delivered_at >= at - window AND <= at`), a `moment IN`
// list and, for the check-in target, a Prisma JSON-path filter
// (`data #> '{lowReadiness}' = true`). `CoachMessagesService.recordConversion`
// then picks the LATEST candidate and flips it with a guarded `convertedAt IS
// NULL` update. The nudge job's idempotency lookup uses the same kind of JSON
// path filter on `data.momentKey`; its exact `where` is exercised here too.
//
// Each test seeds its own user, so rows never leak between cases.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { CoachMessagesService } from '../../src/coach/nudges/coach-messages.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('coach-conversion.db.spec');

const AT = new Date('2026-09-30T12:00:00.000Z');
const HOUR = 3_600_000;
const before = (hours: number, extraMs = 0) => new Date(AT.getTime() - hours * HOUR - extraMs);

describeWithDb('coach conversion (real Postgres)', () => {
  let client: PrismaClient;
  let service: CoachMessagesService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(): Promise<string> {
    const user = await client.user.create({ data: { email: `conv-${userIds.length}-${run}@example.com` }, select: { id: true } });
    userIds.push(user.id);
    return user.id;
  }

  async function msg(
    userId: string,
    deliveredAt: Date | null,
    over: { moment?: string; role?: string; data?: unknown; converted?: boolean } = {},
  ): Promise<string> {
    const row = await client.coachMessage.create({
      data: {
        userId,
        role: over.role ?? 'coach',
        kind: 'nudge',
        moment: over.moment ?? 'missed_twice',
        body: 'x',
        deliveredAt,
        convertedAt: over.converted ? deliveredAt : null,
        ...(over.data !== undefined ? { data: over.data as never } : {}),
      },
      select: { id: true },
    });
    return row.id;
  }

  const convertedAt = async (id: string) => (await client.coachMessage.findUniqueOrThrow({ where: { id }, select: { convertedAt: true } })).convertedAt;

  beforeAll(() => {
    client = createDbClient();
    service = new CoachMessagesService(client as unknown as PrismaService);
  });

  afterAll(async () => {
    if (!client) return;
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  describe('workout target (24 h, the workout moments)', () => {
    it.each(['missed_twice', 'streak_at_risk', 'missed_session', 'fresh_start', 'win_back'])('converts a delivered %s message', async (moment) => {
      const user = await makeUser();
      const id = await msg(user, before(2), { moment });
      await expect(service.recordConversion(user, 'workout', AT)).resolves.toBe(id);
      expect(await convertedAt(id)).toEqual(AT);
    });

    it('window edges: exactly 24 h old converts, 24 h and 1 ms old does not; a message delivered after the workout does not', async () => {
      const edge = await makeUser();
      const edgeId = await msg(edge, before(24));
      await expect(service.recordConversion(edge, 'workout', AT)).resolves.toBe(edgeId);

      const stale = await makeUser();
      const staleId = await msg(stale, before(24, 1));
      await expect(service.recordConversion(stale, 'workout', AT)).resolves.toBeNull();
      expect(await convertedAt(staleId)).toBeNull();

      const future = await makeUser();
      await msg(future, new Date(AT.getTime() + 1));
      await expect(service.recordConversion(future, 'workout', AT)).resolves.toBeNull();
    });

    it('ignores other moments, user messages, undelivered rows and other users', async () => {
      const user = await makeUser();
      const other = await makeUser();
      await msg(user, before(1), { moment: 'celebration' });
      await msg(user, before(1), { moment: 'photo_prompt' });
      await msg(user, before(1), { role: 'user' });
      await msg(user, null);
      await msg(other, before(1));
      await expect(service.recordConversion(user, 'workout', AT)).resolves.toBeNull();
    });

    it('converts the LATEST candidate, skips one already converted, and each message converts once', async () => {
      const user = await makeUser();
      const older = await msg(user, before(10));
      const newer = await msg(user, before(3));
      const done = await msg(user, before(1), { converted: true });

      await expect(service.recordConversion(user, 'workout', AT)).resolves.toBe(newer);
      await expect(service.recordConversion(user, 'workout', AT)).resolves.toBe(older);
      await expect(service.recordConversion(user, 'workout', AT)).resolves.toBeNull();
      expect(await convertedAt(done)).toEqual(before(1));
    });
  });

  describe('photo target (48 h, photo_prompt)', () => {
    it('converts a photo prompt up to 48 h old and nothing older', async () => {
      const ok = await makeUser();
      const okId = await msg(ok, before(48), { moment: 'photo_prompt' });
      await expect(service.recordConversion(ok, 'photo', AT)).resolves.toBe(okId);

      const stale = await makeUser();
      await msg(stale, before(48, 1), { moment: 'photo_prompt' });
      await expect(service.recordConversion(stale, 'photo', AT)).resolves.toBeNull();
    });

    it('a photo converts only photo prompts, and a workout never converts one', async () => {
      const user = await makeUser();
      await msg(user, before(1)); // missed_twice
      const prompt = await msg(user, before(30), { moment: 'photo_prompt' });
      await expect(service.recordConversion(user, 'photo', AT)).resolves.toBe(prompt);

      const another = await makeUser();
      await msg(another, before(1), { moment: 'photo_prompt' });
      await expect(service.recordConversion(another, 'workout', AT)).resolves.toBeNull();
    });
  });

  describe('check-in target (24 h, data.lowReadiness = true, the JSON-path filter)', () => {
    it('converts a message flagged lowReadiness whatever its moment', async () => {
      const user = await makeUser();
      const id = await msg(user, before(5), { moment: 'celebration', data: { lowReadiness: true, momentKey: 'k' } });
      await expect(service.recordConversion(user, 'check_in', AT)).resolves.toBe(id);
      expect(await convertedAt(id)).toEqual(AT);
    });

    it('ignores false, the string "true", a missing key, null data and an unrelated key', async () => {
      const user = await makeUser();
      await msg(user, before(1), { data: { lowReadiness: false } });
      await msg(user, before(1), { data: { lowReadiness: 'true' } });
      await msg(user, before(1), { data: { other: true } });
      await msg(user, before(1));
      await expect(service.recordConversion(user, 'check_in', AT)).resolves.toBeNull();
    });

    it('applies the 24 h window and the owner filter', async () => {
      const user = await makeUser();
      const other = await makeUser();
      await msg(user, before(24, 1), { data: { lowReadiness: true } });
      await msg(other, before(1), { data: { lowReadiness: true } });
      await expect(service.recordConversion(user, 'check_in', AT)).resolves.toBeNull();

      const edge = await msg(user, before(24), { data: { lowReadiness: true } });
      await expect(service.recordConversion(user, 'check_in', AT)).resolves.toBe(edge);
    });

    it('a workout does not convert a lowReadiness-only celebration', async () => {
      const user = await makeUser();
      await msg(user, before(1), { moment: 'celebration', data: { lowReadiness: true } });
      await expect(service.recordConversion(user, 'workout', AT)).resolves.toBeNull();
    });
  });

  describe('nudge idempotency lookup (data.momentKey)', () => {
    // The exact filter `CoachNudgeHandler` runs before it writes a message.
    const lookup = (userId: string, momentKey: string) =>
      client.coachMessage.findFirst({
        where: { userId, role: 'coach', data: { path: ['momentKey'], equals: momentKey } },
        select: { id: true, deliveredAt: true, audioStatus: true, createdAt: true },
      });

    it('finds the message with that exact momentKey for that user only', async () => {
      const user = await makeUser();
      const other = await makeUser();
      const id = await msg(user, null, { data: { momentKey: 'missed_twice:2026-09-30', eligibleAngles: ['humor'] } });
      await msg(user, before(1), { data: { momentKey: 'missed_twice:2026-09-29' } });
      await msg(other, before(1), { data: { momentKey: 'missed_twice:2026-09-30' } });
      await msg(user, before(1), { role: 'user', data: { momentKey: 'role:2026-09-30' } });

      expect((await lookup(user, 'missed_twice:2026-09-30'))?.id).toBe(id);
      expect(await lookup(user, 'missed_twice:2026-09-28')).toBeNull();
      expect(await lookup(user, 'missed_twice:2026-09')).toBeNull(); // a prefix is not a match
      expect(await lookup(user, 'role:2026-09-30')).toBeNull(); // user-role rows are never coach messages
      expect((await lookup(other, 'missed_twice:2026-09-30'))?.id).not.toBe(id);
    });

    it('does not match a row whose data has no momentKey or is null', async () => {
      const user = await makeUser();
      await msg(user, before(1), { data: { register: 'supportive' } });
      await msg(user, before(1));
      expect(await lookup(user, 'anything')).toBeNull();
    });
  });
});
