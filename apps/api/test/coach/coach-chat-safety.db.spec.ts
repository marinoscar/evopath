// =============================================================================
// Real-Postgres test: chat safety history, chat retry, delivery claim
// =============================================================================
//
// What only a real server can prove:
//   - the JSONB path filter on `coach_messages.data.safety` finds a blocked
//     turn inside the 24-hour lookback (and not one outside it), so the next
//     turn runs in the supportive register and sends neither blocked row;
//   - `retryOf` reuses the stored user row: one user row, one reply after it;
//   - `coach.message.deliver` claims `deliveredAt` with a guarded update, so
//     two CONCURRENT runs over one message send exactly once, and a
//     delivery-time suppression merges `data.suppressed` into the stored JSON.
//
// The model, settings and notifications are stubbed; the rows are real.
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { AiToolLoopRequest } from '../../src/ai/runtime/ai-runtime.types';
import { COACH_CHAT_SAFETY_LOOKBACK_MS } from '../../src/coach/chat/coach-chat-prompt';
import { COACH_DISTRESS_REPLY } from '../../src/coach/chat/coach-chat-safety';
import { CoachChatService, type CoachChatEvent } from '../../src/coach/chat/coach-chat.service';
import { CoachMessageDeliverHandler } from '../../src/coach/nudges/handlers/coach-message-deliver.handler';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('coach-chat-safety.db.spec');

const SARGE_L3_UNLOCKED = {
  enabled: true,
  personaId: 'drill_sergeant',
  intensity: 3,
  profanity: true,
  adultConfirmedAt: '2026-01-01T00:00:00.000Z',
};

async function drain(iterable: AsyncIterable<CoachChatEvent>): Promise<CoachChatEvent[]> {
  const out: CoachChatEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describeWithDb('coach chat safety, retry and delivery claim (real Postgres)', () => {
  let client: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `chat-safety-${label}-${run}@example.com`, isActive: true },
      select: { id: true },
    });
    userIds.push(user.id);
    await client.userSettings.create({ data: { userId: user.id, value: { coach: { enabled: true } } } });
    return user.id;
  }

  function chatService(replies: Array<string | Error>) {
    const requests: AiToolLoopRequest[] = [];
    const runTools = jest.fn(async (req: AiToolLoopRequest) => {
      requests.push(req);
      const next = replies.shift();
      if (next instanceof Error) {
        req.onStep?.({ step: 1, response: {} as never, calls: [{ name: 'get_check_ins', status: 'ok' } as never] });
        throw next;
      }
      return {
        final: { outputText: next ?? 'Ok.', provider: 'openai', model: 'fake-chat-model' },
        steps: [],
        stopReason: 'completed',
      };
    });
    const service = new CoachChatService(
      client as unknown as PrismaService,
      { forUser: () => ({ runTools }) } as never,
      { resolve: async () => ({ state: 'ready', model: { provider: 'openai', modelId: 'fake-chat-model' } }) } as never,
      { getSettings: async () => ({ coach: SARGE_L3_UNLOCKED }) } as never,
      { getCoachPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, enabled: true, allowProfanePersonas: true }) } as never,
      { get: async () => ({ dateOfBirth: '1990-05-05' }) } as never,
      { today: async () => '2026-10-01' } as never,
      {} as never,
      {} as never,
      {} as never,
      { turn: jest.fn(), safetyHit: jest.fn(), toolCall: jest.fn(), error: jest.fn() } as never,
      { coachGuardRejection: jest.fn() } as never,
    );
    return { service, requests };
  }

  beforeAll(() => {
    client = createDbClient();
  });

  afterAll(async () => {
    if (!client) return;
    await client.coachMessage.deleteMany({ where: { userId: { in: userIds } } });
    await client.coachState.deleteMany({ where: { userId: { in: userIds } } });
    await client.userSettings.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  it('a blocked turn is tagged, never sent again, and keeps the next turn supportive', async () => {
    const userId = await makeUser('blocked');
    const { service, requests } = chatService(['One calm step at a time.']);

    await drain(await service.startTurn(userId, 'honestly I want to kill myself'));
    const stored = await client.coachMessage.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    expect(stored.map((r) => [r.role, r.data])).toEqual([
      ['user', { safety: 'distress' }],
      ['coach', { safety: 'distress' }],
    ]);

    await drain(await service.startTurn(userId, 'motivate me'));
    const sent = JSON.stringify(requests[0].input);
    expect(sent).not.toContain('kill myself');
    expect(sent).not.toContain(COACH_DISTRESS_REPLY.slice(0, 40));
    expect(requests[0].instructions).toContain('REGISTER: SUPPORTIVE');
    expect(requests[0].instructions).not.toContain('adult language is allowed');
  });

  it('a blocked turn outside the lookback no longer forces the register', async () => {
    const userId = await makeUser('old');
    const old = new Date(Date.now() - COACH_CHAT_SAFETY_LOOKBACK_MS - 60_000);
    await client.coachMessage.create({
      data: { userId, role: 'user', kind: 'chat', title: '', body: 'I want to kill myself', data: { safety: 'distress' }, createdAt: old },
    });
    await client.coachMessage.create({
      data: {
        userId,
        role: 'coach',
        kind: 'chat',
        title: '',
        body: COACH_DISTRESS_REPLY,
        data: { safety: 'distress' },
        createdAt: new Date(old.getTime() + 1),
      },
    });
    const { service, requests } = chatService(['Damn right, recruit.']);

    await drain(await service.startTurn(userId, 'motivate me'));
    expect(requests[0].instructions).toContain('adult language is allowed');
    expect(JSON.stringify(requests[0].input)).not.toContain('kill myself');
  });

  it('retryOf reuses the stored user row and answers it', async () => {
    const userId = await makeUser('retry');
    const { service, requests } = chatService([new Error('provider down'), 'Here now.']);

    const failed = await drain(await service.startTurn(userId, 'How am I doing?'));
    const error = failed.at(-1) as Extract<CoachChatEvent, { type: 'error' }>;
    expect(error.type).toBe('error');
    expect(error.userMessageId).toEqual(expect.any(String));

    const retried = await drain(await service.startTurn(userId, 'How am I doing?', { retryOf: error.userMessageId! }));
    expect(retried.at(-1)).toMatchObject({ type: 'done', userMessageId: error.userMessageId });

    const rows = await client.coachMessage.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.role)).toEqual(['user', 'coach']);
    expect(rows[0].id).toBe(error.userMessageId);
    // The retried row is not also sent as history.
    expect(JSON.stringify(requests[1].input).split('How am I doing?').length - 1).toBe(1);

    await expect(service.startTurn(userId, 'How am I doing?', { retryOf: error.userMessageId! })).rejects.toMatchObject({
      status: 400,
      response: { details: { reason: 'COACH_RETRY_INVALID' } },
    });
  });

  function deliverer() {
    const notifyNow = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { rateLimited: false, retryAfterMs: null, notificationId: null };
    });
    const handler = new CoachMessageDeliverHandler(
      { register: jest.fn() } as never,
      client as unknown as PrismaService,
      { notifyNow } as never,
      { recordNudgeSent: jest.fn() } as never,
      { markFailed: jest.fn() } as never,
      { isEnabled: async () => true } as never,
      { getCoachPolicy: async () => ({ enabled: true }) } as never,
      { coachNudgeDelivered: jest.fn(), coachNudgeSuppression: jest.fn() } as never,
    );
    return { handler, notifyNow };
  }

  async function nudgeRow(userId: string): Promise<string> {
    const row = await client.coachMessage.create({
      data: {
        userId,
        role: 'coach',
        kind: 'nudge',
        moment: 'missed_twice',
        title: 'Back to it',
        body: 'A short session today?',
        pushTitle: 'Your coach checked in',
        pushBody: 'Ready?',
        data: { momentKey: `k-${run}` },
      },
      select: { id: true },
    });
    return row.id;
  }

  it('two concurrent deliveries of one message send exactly once', async () => {
    const userId = await makeUser('deliver');
    const messageId = await nudgeRow(userId);
    const { handler, notifyNow } = deliverer();

    const outcomes = await Promise.all([handler.deliver(messageId, new Date()), handler.deliver(messageId, new Date())]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['delivered', 'skipped']);
    expect(notifyNow).toHaveBeenCalledTimes(1);
    const row = await client.coachMessage.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.deliveredAt).not.toBeNull();
  });

  it('a pause set after the nudge suppresses delivery for good and merges data.suppressed', async () => {
    const userId = await makeUser('paused');
    const messageId = await nudgeRow(userId);
    await client.coachState.create({ data: { userId, pausedUntil: new Date(Date.now() + 86_400_000) } });
    const { handler, notifyNow } = deliverer();

    await expect(handler.deliver(messageId, new Date())).resolves.toEqual({ status: 'suppressed', reason: 'paused' });
    const row = await client.coachMessage.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.deliveredAt).toBeNull();
    expect(row.data).toMatchObject({ momentKey: `k-${run}`, suppressed: { reason: 'paused' } });

    await client.coachState.update({ where: { userId }, data: { pausedUntil: null } });
    await expect(handler.deliver(messageId, new Date())).resolves.toEqual({ status: 'skipped', reason: 'suppressed' });
    expect(notifyNow).not.toHaveBeenCalled();
  });
});
