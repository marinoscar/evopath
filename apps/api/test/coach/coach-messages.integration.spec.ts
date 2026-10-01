import request from 'supertest';

import { HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from '../ai/ai-http.helper';

// =============================================================================
// POST /api/coach/messages/:id/{opened,feedback} (E7.5, #245)
// =============================================================================
//
// Opened is idempotent and re-engages (consecutiveIgnored 0, silencedAt
// cleared); feedback stores up/down/null; both are caller-scoped (another
// user's id is the same 404 as an unknown one), kill-switched and need ai:use.
// =============================================================================

const MESSAGE = '00000000-0000-4000-8000-0000000000a1';
const OPENED = `/api/coach/messages/${MESSAGE}/opened`;
const FEEDBACK = `/api/coach/messages/${MESSAGE}/feedback`;

describe('coach message engagement routes (E7.5)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let stored: { id: string; userId: string; role: string; moment: string; openedAt: Date | null; feedback: string | null };

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    stored = { id: MESSAGE, userId: HARNESS_USER, role: 'coach', moment: 'missed_twice', openedAt: null, feedback: null };
    const prisma = t.context.prismaMock as any;
    prisma.coachMessage.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === stored.id && where.userId === stored.userId && where.role === stored.role
        ? { id: stored.id, moment: stored.moment, openedAt: stored.openedAt }
        : null,
    );
    prisma.coachMessage.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.id !== stored.id || where.userId !== stored.userId) return { count: 0 };
      if ('openedAt' in where && where.openedAt === null && stored.openedAt !== null) return { count: 0 };
      stored = { ...stored, ...data };
      return { count: 1 };
    });
    prisma.coachState.updateMany.mockResolvedValue({ count: 1 });
  });

  const server = () => t.context.app.getHttpServer();

  it('opened: 204, sets openedAt once and re-engages the coach on every call', async () => {
    await request(server()).post(OPENED).set(authHeader(alice.accessToken)).expect(204);
    const first = stored.openedAt;
    expect(first).toBeInstanceOf(Date);

    await request(server()).post(OPENED).set(authHeader(alice.accessToken)).expect(204);
    expect(stored.openedAt).toBe(first);

    const prisma = t.context.prismaMock as any;
    expect(prisma.coachMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.coachState.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.coachState.updateMany).toHaveBeenCalledWith({
      where: { userId: HARNESS_USER },
      data: { consecutiveIgnored: 0, silencedAt: null },
    });
  });

  it.each([['up'], ['down'], [null]])('feedback %s: 204 and stored', async (value) => {
    await request(server()).post(FEEDBACK).set(authHeader(alice.accessToken)).send({ feedback: value }).expect(204);
    expect(stored.feedback).toBe(value);
  });

  it('feedback: 400 for an unknown value or an extra key', async () => {
    await request(server()).post(FEEDBACK).set(authHeader(alice.accessToken)).send({ feedback: 'meh' }).expect(400);
    await request(server()).post(FEEDBACK).set(authHeader(alice.accessToken)).send({ feedback: 'up', extra: 1 }).expect(400);
    await request(server()).post(FEEDBACK).set(authHeader(alice.accessToken)).send({}).expect(400);
  });

  it("404 COACH_MESSAGE_NOT_FOUND for another user's message, an unknown id and a malformed id", async () => {
    stored = { ...stored, userId: '00000000-0000-4000-8000-0000000000b2' };

    const res = await request(server()).post(OPENED).set(authHeader(alice.accessToken)).expect(404);
    expect(res.body.details).toMatchObject({ code: 'COACH_MESSAGE_NOT_FOUND' });
    await request(server()).post(FEEDBACK).set(authHeader(alice.accessToken)).send({ feedback: 'up' }).expect(404);
    await request(server())
      .post('/api/coach/messages/00000000-0000-4000-8000-0000000000ff/opened')
      .set(authHeader(alice.accessToken))
      .expect(404);
    await request(server()).post('/api/coach/messages/not-a-uuid/opened').set(authHeader(alice.accessToken)).expect(404);

    const prisma = t.context.prismaMock as any;
    expect(prisma.coachMessage.updateMany).not.toHaveBeenCalled();
    expect(prisma.coachState.updateMany).not.toHaveBeenCalled();
  });

  it('403 AI_DISABLED while AI is off, before authentication', async () => {
    t.harness.setPolicy({ enabled: false });
    const res = await request(server()).post(OPENED).set(authHeader(alice.accessToken)).expect(403);
    expect(res.body.details).toMatchObject({ reason: 'AI_DISABLED' });
    await request(server()).post(FEEDBACK).send({ feedback: 'up' }).expect(403);
  });

  it('refuses a viewer (no ai:use) and an unauthenticated caller', async () => {
    const viewer = await createMockViewerUser(t.context);
    await request(server()).post(OPENED).set(authHeader(viewer.accessToken)).expect(403);
    await request(server()).post(OPENED).expect(401);
    expect((t.context.prismaMock as any).coachMessage.updateMany).not.toHaveBeenCalled();
  });
});
