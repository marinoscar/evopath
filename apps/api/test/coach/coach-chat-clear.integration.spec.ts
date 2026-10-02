import request from 'supertest';

import { HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from '../ai/ai-http.helper';

// =============================================================================
// POST /api/coach/chat/clear (#323): "Start over", a soft clear
// =============================================================================
//
// The route stamps `CoachState.chatClearedAt` (upsert, 204, idempotent) and
// deletes nothing; `GET /api/coach/messages` then lists only rows created
// after the stamp. A stateful in-memory `coach_states` row and
// `coach_messages` table sit behind the Prisma mock, so the effect is proven
// end to end through the real controllers and services.
// =============================================================================

const CLEAR = '/api/coach/chat/clear';
const MESSAGES = '/api/coach/messages';
const T0 = Date.parse('2026-09-01T08:00:00.000Z');

interface Row {
  id: string;
  userId: string;
  role: string;
  kind: string;
  body: string;
  createdAt: Date;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function matches(row: Row, where: any): boolean {
  if (where.userId && row.userId !== where.userId) return false;
  if (where.id && row.id !== where.id) return false;
  if (where.createdAt?.gt && row.createdAt.getTime() <= where.createdAt.gt.getTime()) return false;
  if (where.OR) {
    return where.OR.some((clause: any) => {
      const t = row.createdAt.getTime();
      if (clause.createdAt?.lt) return t < clause.createdAt.lt.getTime();
      return t === clause.createdAt.getTime() && row.id < clause.id.lt;
    });
  }
  return true;
}

describe('POST /api/coach/chat/clear (#323)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let table: Row[];
  let state: { userId: string; chatClearedAt: Date | null } | null;

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    table = Array.from({ length: 6 }, (_, i) => ({
      id: uuid(100 + i),
      userId: HARNESS_USER,
      role: i % 2 === 0 ? 'user' : 'coach',
      kind: 'chat',
      body: `message ${i}`,
      createdAt: new Date(T0 + i * 60_000),
    }));
    state = null;

    const prisma = t.context.prismaMock as any;
    prisma.coachState.findUnique.mockImplementation(async ({ where }: any) =>
      state && state.userId === where.userId ? { chatClearedAt: state.chatClearedAt } : null,
    );
    prisma.coachState.upsert.mockImplementation(async ({ where, create, update }: any) => {
      state = state && state.userId === where.userId ? { ...state, ...update } : { ...create };
      return state;
    });
    prisma.coachMessage.findFirst.mockImplementation(async ({ where }: any) => {
      const row = table.find((r) => matches(r, where));
      return row ? { id: row.id, createdAt: row.createdAt } : null;
    });
    prisma.coachMessage.findMany.mockImplementation(async ({ where, take }: any) =>
      table
        .filter((r) => matches(r, where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, take)
        .map((r) => ({
          ...r,
          moment: null,
          personaId: null,
          intensity: null,
          title: '',
          audioStatus: 'none',
          audioStorageObjectId: null,
          feedback: null,
          openedAt: null,
          data: null,
        })),
    );
  });

  const server = () => t.context.app.getHttpServer();
  const clear = (user: TestUser = alice) => request(server()).post(CLEAR).set(authHeader(user.accessToken)).send();
  const list = () => request(server()).get(MESSAGES).set(authHeader(alice.accessToken));

  it('answers 204 with no body and stamps chatClearedAt for the caller only', async () => {
    const before = Date.now();
    const res = await clear().expect(204);
    expect(res.text).toBe('');

    const prisma = t.context.prismaMock as any;
    expect(prisma.coachState.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.coachState.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ userId: HARNESS_USER });
    expect(args.create).toEqual({ userId: HARNESS_USER, chatClearedAt: expect.any(Date) });
    expect(args.update).toEqual({ chatClearedAt: expect.any(Date) });
    expect(args.update.chatClearedAt.getTime()).toBeGreaterThanOrEqual(before);
    // A soft clear: nothing is deleted.
    expect(prisma.coachMessage.deleteMany).not.toHaveBeenCalled();
    expect(prisma.coachMessage.delete).not.toHaveBeenCalled();
  });

  it('is idempotent: a second clear is 204 again and only moves the instant forward', async () => {
    await clear().expect(204);
    const first = state!.chatClearedAt!.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await clear().expect(204);
    expect(state!.chatClearedAt!.getTime()).toBeGreaterThanOrEqual(first);
    expect((t.context.prismaMock as any).coachState.upsert).toHaveBeenCalledTimes(2);
  });

  it('the timeline then lists only messages created after the clear', async () => {
    expect((await list().expect(200)).body.data.items).toHaveLength(6);

    await clear().expect(204);
    expect((await list().expect(200)).body.data).toEqual({ items: [], nextCursor: null });

    // A new turn after the clear is listed; the earlier ones stay hidden.
    table.push({
      id: uuid(200),
      userId: HARNESS_USER,
      role: 'user',
      kind: 'chat',
      body: 'fresh start',
      createdAt: new Date(state!.chatClearedAt!.getTime() + 1),
    });
    const items = (await list().expect(200)).body.data.items as Array<{ body: string }>;
    expect(items.map((i) => i.body)).toEqual(['fresh start']);
    // Rows are kept.
    expect(table).toHaveLength(7);
  });

  it('a cursor from before the clear is still valid (the caller\'s own row) and pages into nothing', async () => {
    await clear().expect(204);
    const res = await request(server())
      .get(`${MESSAGES}?before=${uuid(103)}`)
      .set(authHeader(alice.accessToken))
      .expect(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('refuses an unauthenticated caller (401) and a caller without ai:use (403)', async () => {
    await request(server()).post(CLEAR).expect(401);
    const viewer = await createMockViewerUser(t.context);
    await clear(viewer).expect(403);
    expect((t.context.prismaMock as any).coachState.upsert).not.toHaveBeenCalled();
  });

  it('answers 403 AI_DISABLED while AI is off, and writes nothing', async () => {
    t.harness.setPolicy({ enabled: false });
    const res = await clear().expect(403);
    expect(res.body.details.reason).toBe('AI_DISABLED');
    expect((t.context.prismaMock as any).coachState.upsert).not.toHaveBeenCalled();
  });
});
