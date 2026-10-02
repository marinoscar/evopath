// =============================================================================
// Real-Postgres test: coach chat "Start over" (#323)
// =============================================================================
//
// What only a real server can prove:
//   - `coach_states.chat_cleared_at` exists (the migration) and the upsert
//     creates the row when missing and moves the stamp on a second clear;
//   - the timeline's `createdAt > chatClearedAt` filter composes with the
//     keyset cursor on real timestamptz values, and no row is deleted;
//   - the chat turn sends only post-clear rows as history, while a blocked
//     safety turn from before the clear still keeps the register supportive
//     (the safety lookback ignores the clear on purpose).
//
// THIS IS A `*.db.spec.ts` FILE, skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { AiToolLoopRequest } from '../../src/ai/runtime/ai-runtime.types';
import { CoachChatService, type CoachChatEvent } from '../../src/coach/chat/coach-chat.service';
import { CoachTimelineService } from '../../src/coach/chat/coach-timeline.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('coach-chat-clear.db.spec');

async function drain(iterable: AsyncIterable<CoachChatEvent>): Promise<CoachChatEvent[]> {
  const out: CoachChatEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describeWithDb('coach chat start over (real Postgres)', () => {
  let client: PrismaClient;
  let timeline: CoachTimelineService;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `chat-clear-${label}-${run}@example.com`, isActive: true },
      select: { id: true },
    });
    userIds.push(user.id);
    await client.userSettings.create({ data: { userId: user.id, value: { coach: { enabled: true } } } });
    return user.id;
  }

  async function seed(userId: string, bodies: string[], startMs: number, data?: object, stepMs = 1000): Promise<void> {
    for (const [i, body] of bodies.entries()) {
      await client.coachMessage.create({
        data: {
          userId,
          role: i % 2 === 0 ? 'user' : 'coach',
          kind: 'chat',
          title: '',
          body,
          ...(data ? { data } : {}),
          createdAt: new Date(startMs + i * stepMs),
        },
      });
    }
  }

  function chatService() {
    const requests: AiToolLoopRequest[] = [];
    const runTools = jest.fn(async (req: AiToolLoopRequest) => {
      requests.push(req);
      return { final: { outputText: 'Ok.', provider: 'openai', model: 'fake-chat-model' }, steps: [], stopReason: 'completed' };
    });
    const service = new CoachChatService(
      client as unknown as PrismaService,
      { forUser: () => ({ runTools }) } as never,
      { resolve: async () => ({ state: 'ready', model: { provider: 'openai', modelId: 'fake-chat-model' } }) } as never,
      { getSettings: async () => ({ coach: { enabled: true } }) } as never,
      { getCoachPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, enabled: true }) } as never,
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
    timeline = new CoachTimelineService(client as unknown as PrismaService);
  });

  afterAll(async () => {
    if (!client) return;
    await client.coachMessage.deleteMany({ where: { userId: { in: userIds } } });
    await client.coachState.deleteMany({ where: { userId: { in: userIds } } });
    await client.userSettings.deleteMany({ where: { userId: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  it('the clear creates the state row, hides earlier rows from the timeline, deletes nothing, and pages after it', async () => {
    const userId = await makeUser('timeline');
    const base = Date.now() - 60 * 60_000;
    await seed(userId, ['old 0', 'old 1', 'old 2', 'old 3'], base);

    expect((await timeline.list(userId, { limit: 30 })).items).toHaveLength(4);
    expect(await client.coachState.findUnique({ where: { userId } })).toBeNull();

    await timeline.clear(userId);
    const state = await client.coachState.findUniqueOrThrow({ where: { userId } });
    expect(state.chatClearedAt).toBeInstanceOf(Date);
    expect(await timeline.list(userId, { limit: 30 })).toEqual({ items: [], nextCursor: null });

    // Five rows after the clear, paged two at a time, never reaching the old ones.
    await seed(userId, ['new 0', 'new 1', 'new 2', 'new 3', 'new 4'], state.chatClearedAt!.getTime() + 1, undefined, 1);
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      const page = await timeline.list(userId, { limit: 2, ...(before ? { before } : {}) });
      seen.push(...page.items.map((item) => item.body));
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    expect(seen).toEqual(['new 4', 'new 3', 'new 2', 'new 1', 'new 0']);
    expect(await client.coachMessage.count({ where: { userId } })).toBe(9);

    // Idempotent: a second clear moves the stamp forward and keeps one row.
    await new Promise((r) => setTimeout(r, 20));
    await timeline.clear(userId);
    const again = await client.coachState.findUniqueOrThrow({ where: { userId } });
    expect(again.chatClearedAt!.getTime()).toBeGreaterThan(state.chatClearedAt!.getTime());
    expect(await client.coachState.count({ where: { userId } })).toBe(1);
    expect((await timeline.list(userId, { limit: 30 })).items).toEqual([]);
  });

  it('a chat turn after the clear sends no earlier row, yet a pre-clear blocked turn keeps it supportive', async () => {
    const userId = await makeUser('history');
    const base = Date.now() - 2 * 60 * 60_000;
    await seed(userId, ['talked about deadlifts', 'deadlift reply'], base);
    await seed(userId, ['I want to kill myself', 'safety reply'], base + 10_000, { safety: 'distress' });

    await timeline.clear(userId);
    const { service, requests } = chatService();
    await drain(await service.startTurn(userId, 'new topic: sleep'));

    const sent = JSON.stringify(requests[0].input);
    expect(sent).not.toContain('deadlift');
    expect(sent).not.toContain('kill myself');
    expect(sent).toContain('new topic: sleep');
    expect(requests[0].instructions).toContain('REGISTER: SUPPORTIVE');
  });
});
