import request from 'supertest';

import { HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { COACH_DISTRESS_REPLY } from '../../src/coach/chat/coach-chat-safety';
import { compactSignals } from '../../src/programs/signals/compact-signals';
import type { PlanSignals } from '../../src/programs/signals/plan-signals.contract';
import { TrainingSignalsService } from '../../src/programs/signals/signals.service';
import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { ALL_KEYS, createAiHttpTestApp, parseSse, type AiHttpTestApp } from '../ai/ai-http.helper';
import { ADULT_DOB, useDateOfBirth, useSystemCoachPolicy } from './coach-test.helper';

// =============================================================================
// POST /api/coach/chat/stream over HTTP (E7.7, #247)
// =============================================================================
//
// The real controller, guards, `CoachChatService`, tool loop and AI facade,
// over the harness's fake provider: SSE framing, persistence, tools, safety,
// validation, the kill switch, RBAC and `ai.limits`.
// =============================================================================

const PATH = '/api/coach/chat/stream';

function signalsFor(today: string): PlanSignals {
  return {
    range: { from: today, to: today },
    asOf: today,
    programId: '00000000-0000-4000-8000-0000000000aa',
    planVersion: 1,
    weeksInRange: 1,
    truncated: false,
    planChangedOn: null,
    adherence: {
      weeks: [],
      totals: { planned: 3, completed: 2, partialSessions: 0, missed: 1, extra: 0, adherencePct: 67 },
      missedStreak: 0,
      completedStreak: 2,
    },
    frequency: { avgPerWeek: 2, perWeek: [] },
    sessions: [],
    volume: [],
    performance: [],
    effort: { avgRpe: null, setsAtRpe9Plus: 0, rpeTrend: 'insufficient' },
    pain: [],
    readiness: { days: 0, avg: null, lowDays: 0, lowStreak: 0 },
    body: { weightKg: { latest: null, changePerWeek: null, points: 0 }, bodyFatPct: null },
  } as unknown as PlanSignals;
}

describe('POST /api/coach/chat/stream (E7.7)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let seq = 0;

  beforeAll(async () => {
    t = await createAiHttpTestApp({}, { harnessFeatureResolver: true });
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    useSystemCoachPolicy(t.context);
    useDateOfBirth(t.context, ADULT_DOB);

    const prisma = t.context.prismaMock as any;
    prisma.userSettings.findUnique.mockResolvedValue({ userId: HARNESS_USER, value: { coach: { enabled: true } }, version: 1 });
    prisma.coachMessage.findMany.mockResolvedValue([]);
    prisma.coachMessage.create.mockImplementation(async ({ data }: any) => ({
      id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      createdAt: data.createdAt ?? new Date(),
    }));
    prisma.coachState.updateMany.mockResolvedValue({ count: 0 });
    prisma.coachState.upsert.mockResolvedValue({});
    prisma.progressPhoto.groupBy.mockResolvedValue([]);

    jest
      .spyOn(t.context.app.get(TrainingSignalsService), 'forUser')
      .mockImplementation(async () => signalsFor(new Date().toISOString().slice(0, 10)));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const server = () => t.context.app.getHttpServer();
  const post = (user: TestUser, body: object) =>
    request(server()).post(PATH).set(authHeader(user.accessToken)).set('Accept', 'text/event-stream').send(body);
  const creates = () => (t.context.prismaMock as any).coachMessage.create.mock.calls.map((c: any[]) => c[0].data);

  it('streams unbuffered SSE frames ending with done; both turns are persisted as kind chat', async () => {
    t.script([{ outputText: 'Good question. Keep showing up.' }]);

    const res = await post(alice, { text: 'How am I doing?' }).expect(200);

    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['x-accel-buffering']).toBe('no');
    const frames = parseSse(res.text).filter((f) => f.event);
    for (const frame of frames) expect(frame.data.type).toBe(frame.event);
    expect(frames[frames.length - 1].event).toBe('done');
    expect(frames.filter((f) => f.event === 'delta').map((f) => f.data.text).join('')).toBe('Good question. Keep showing up.');

    const [user, coach] = creates();
    expect(user).toMatchObject({ userId: HARNESS_USER, role: 'user', kind: 'chat', body: 'How am I doing?' });
    expect(coach).toMatchObject({ userId: HARNESS_USER, role: 'coach', kind: 'chat', personaId: 'coach', provider: 'openai' });
    expect(frames[frames.length - 1].data.messageId).toBe('00000000-0000-4000-8000-000000000002');

    // The key never leaves.
    for (const key of ALL_KEYS) expect(res.text).not.toContain(key);
  });

  it('get_training_signals carries the numbers GET /api/training/signals serves', async () => {
    t.script([
      { output: [{ type: 'function_call', callId: 'c1', name: 'get_training_signals', arguments: '{}' }] },
      { outputText: '2 of 3 sessions done.' },
    ]);

    const res = await post(alice, { text: 'How am I doing?' }).expect(200);
    const frames = parseSse(res.text).filter((f) => f.event);
    expect(frames[0]).toMatchObject({ event: 'tool', data: { name: 'get_training_signals', status: 'ok' } });
    expect(frames.filter((f) => f.event === 'delta').map((f) => f.data.text).join('')).toBe('2 of 3 sessions done.');

    const route = await request(server()).get('/api/training/signals').set(authHeader(alice.accessToken)).expect(200);
    const second = t.harness.fake.calls.filter((c) => c.method === 'responses.create')[1].request as any;
    const output = JSON.parse(second.input.find((i: any) => i.type === 'function_call_output').output);
    expect(output.adherence.totals).toEqual(route.body.data.adherence.totals);
    expect(output.adherence.totals).toEqual(compactSignals(route.body.data).adherence.totals);
    expect(JSON.stringify(output)).not.toContain('00000000-0000-4000-8000-0000000000aa');
  });

  it('pause_coach: 3 days sets pausedUntil; done carries it', async () => {
    t.script([
      { output: [{ type: 'function_call', callId: 'c1', name: 'pause_coach', arguments: JSON.stringify({ days: 3, reason: 'sick' }) }] },
      { outputText: 'Paused. Rest up.' },
    ]);

    const before = Date.now();
    const res = await post(alice, { text: "I'm sick for 3 days" }).expect(200);
    const done = parseSse(res.text).find((f) => f.event === 'done')!;
    const until = new Date(done.data.pausedUntil).getTime();
    expect(until - before).toBeGreaterThan(3 * 86_400_000 - 5_000);
    expect(until - before).toBeLessThan(3 * 86_400_000 + 5_000);
    const prisma = t.context.prismaMock as any;
    expect(prisma.coachState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: HARNESS_USER }, update: { pausedUntil: expect.any(Date) } }),
    );
  });

  it('a distress message gets the safety frame and the fixed reply with no provider call', async () => {
    const res = await post(alice, { text: 'I keep thinking about suicide' }).expect(200);
    const frames = parseSse(res.text).filter((f) => f.event);

    expect(frames[0]).toMatchObject({ event: 'safety', data: { level: 'blocked', screen: 'distress' } });
    expect(frames.filter((f) => f.event === 'delta').map((f) => f.data.text).join('')).toBe(COACH_DISTRESS_REPLY);
    expect(frames[frames.length - 1].event).toBe('done');
    expect(t.harness.fake.calls.filter((c) => c.method.startsWith('responses'))).toHaveLength(0);
  });

  it('2,001 characters is a validation 400 with no provider call and nothing stored', async () => {
    const res = await post(alice, { text: 'a'.repeat(2001) }).expect(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(t.harness.fake.calls).toHaveLength(0);
    expect(creates()).toHaveLength(0);

    await post(alice, { text: '   ' }).expect(400);
    await post(alice, { text: 'hi', extra: true }).expect(400);
  });

  it('ai.limits: 429 as JSON before streaming, with no message stored', async () => {
    t.harness.setPolicy({ limits: { perUser: { requestsPerMinute: 1 } } });
    t.script([{ outputText: 'First.' }, { outputText: 'Second.' }]);

    await post(alice, { text: 'one' }).expect(200);
    const before = creates().length;

    const res = await post(alice, { text: 'two' }).expect(429);
    expect(res.body).toMatchObject({ details: { reason: 'AI_RATE_LIMITED' } });
    expect(res.headers['retry-after']).toBeDefined();
    expect(creates()).toHaveLength(before);
  });

  it('AI disabled: 403 AI_DISABLED from AiEnabledGuard', async () => {
    t.harness.setPolicy({ enabled: false });
    const res = await post(alice, { text: 'hi' }).expect(403);
    expect(res.body.details.reason).toBe('AI_DISABLED');
    expect(t.harness.fake.calls).toHaveLength(0);
  });

  it('the coach switched off for the deployment: 403 COACH_DISABLED', async () => {
    useSystemCoachPolicy(t.context, { enabled: false });
    const res = await post(alice, { text: 'hi' }).expect(403);
    expect(res.body.details.code).toBe('COACH_DISABLED');
  });

  it('401 without a token; 403 for a viewer without ai:use', async () => {
    await request(server()).post(PATH).send({ text: 'hi' }).expect(401);
    const viewer = await createMockViewerUser(t.context);
    await post(viewer, { text: 'hi' }).expect(403);
  });

  it('a provider failure after streaming began is an error frame, and no reply is stored', async () => {
    let n = 0;
    t.script(() => {
      n += 1;
      if (n === 1) return { output: [{ type: 'function_call', callId: 'c1', name: 'get_progress_photo_summary', arguments: '{}' }] };
      throw new Error('upstream exploded');
    });

    const res = await post(alice, { text: 'photos?' }).expect(200);
    const frames = parseSse(res.text).filter((f) => f.event);
    expect(frames[0].event).toBe('tool');
    expect(frames[frames.length - 1].event).toBe('error');
    expect(res.text).not.toContain('upstream exploded');
    expect(creates().filter((d: any) => d.role === 'coach')).toHaveLength(0);
  });
});
