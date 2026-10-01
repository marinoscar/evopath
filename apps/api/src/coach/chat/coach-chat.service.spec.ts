import { threeDayPlanInput } from '../../../test/fixtures/training/signals/three-day-plan.fixture';
import { AiError } from '../../ai/core/ai-error';
import type { AiInputItem, AiOutputItem, AiResponse, AiResponseRequest } from '../../ai/core/types/responses.types';
import type { AiCallOptions, AiRequest, AiToolLoopRequest } from '../../ai/runtime/ai-runtime.types';
import { runToolLoop } from '../../ai/runtime/ai-tool-loop';
import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import { aggregateSignals } from '../../programs/signals/aggregate-signals';
import { SAFETY_STOP_GUIDANCE } from '../../training-agents/guardrails/safety-keywords';
import { containsProfanity } from '../guard/coach-content-guard';
import { COACH_PAUSE_INVALID } from './coach-chat-errors';
import { COACH_ADJUST_PATH } from './coach-chat-prompt';
import { COACH_DISTRESS_REPLY } from './coach-chat-safety';
import { COACH_CHAT_FALLBACK_REPLY, CoachChatService, StepChannel, chunkText, type CoachChatEvent } from './coach-chat.service';

// =============================================================================
// CoachChatService (E7.7) with a mocked AiService over the REAL tool loop
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';

// Canaries in every never-send source the turn could touch.
const CANARY = {
  email: 'canary-email@never-send.test',
  name: 'Canary McNeverSend',
  checkInNote: 'CANARY-CHECKIN-NOTE',
  workoutNote: 'CANARY-WORKOUT-NOTE',
  photoStorageId: '9c0ffee0-0000-4000-8000-00000000c0de',
  audioStorageId: '9c0ffee0-0000-4000-8000-00000000a0d1',
  dob: '1990-05-05',
};

type Script = Array<Partial<AiResponse> & { output?: AiOutputItem[] }>;

function call(name: string, args: unknown = {}, callId = `call_${name}`): AiOutputItem {
  return { type: 'function_call', callId, name, arguments: JSON.stringify(args) };
}

function setup(opts: { coach?: Record<string, unknown>; policy?: Record<string, unknown>; history?: unknown[] } = {}) {
  const requests: AiResponseRequest[] = [];
  let script: Script = [];
  let idSeq = 0;

  const prisma = {
    coachMessage: {
      create: jest.fn(async ({ data }: any) => ({ id: `msg-${++idSeq}`, createdAt: data.createdAt ?? new Date() })),
      findMany: jest.fn().mockResolvedValue(opts.history ?? []),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    coachState: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), upsert: jest.fn().mockResolvedValue({}) },
    workout: {
      findMany: jest.fn().mockResolvedValue([
        { name: 'Upper A', date: new Date('2026-09-30T00:00:00Z'), durationSeconds: 3600, notes: CANARY.workoutNote, exercises: [] },
      ]),
    },
  };

  const respond = async (req: AiRequest, _opts: AiCallOptions): Promise<AiResponse> => {
    requests.push(req as AiResponseRequest);
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    const output = next.output ?? [{ type: 'message', text: next.outputText ?? '' }];
    const outputText = output.filter((o) => o.type === 'message').map((o: any) => o.text).join('');
    return {
      id: `resp_${requests.length}`,
      provider: 'openai',
      model: 'fake-chat-model',
      output,
      outputText,
      usage: {},
      finishReason: output.some((o) => o.type === 'function_call') ? 'tool_calls' : 'stop',
    };
  };

  const runTools = jest.fn((req: AiToolLoopRequest, callOpts: AiCallOptions = {}) =>
    runToolLoop(respond, req, { userId: USER, signal: callOpts.signal }),
  );
  const ai = { forUser: jest.fn(() => ({ runTools })) };
  const features = {
    resolve: jest.fn().mockResolvedValue({ state: 'ready', model: { provider: 'openai', modelId: 'fake-chat-model' } }),
  };
  const userSettings = { getSettings: jest.fn().mockResolvedValue({ coach: { enabled: true, ...(opts.coach ?? {}) } }) };
  const systemSettings = {
    getCoachPolicy: jest.fn().mockResolvedValue({ ...DEFAULT_SYSTEM_SETTINGS.coach, ...(opts.policy ?? {}) }),
  };
  const healthProfile = { get: jest.fn().mockResolvedValue({ dateOfBirth: CANARY.dob }) };
  const checkIns = {
    today: jest.fn().mockResolvedValue('2026-10-01'),
    list: jest.fn().mockResolvedValue({
      items: [{ date: '2026-10-01', energy: 4, sleepQuality: 3, soreness: 2, stress: 1, note: CANARY.checkInNote, updatedAt: '' }],
    }),
  };
  const signals = { forUser: jest.fn().mockResolvedValue(aggregateSignals(threeDayPlanInput())) };
  const today = { today: jest.fn().mockResolvedValue({ kind: 'no_program', date: '2026-10-01' }) };
  const photos = {
    summarize: jest.fn().mockResolvedValue({
      count: 2,
      lastLocalDate: '2026-09-20',
      byPose: { front: 2, side: 0, back: 0, other: 0 },
      storageObjectId: CANARY.photoStorageId,
    }),
  };
  const metrics = { turn: jest.fn(), safetyHit: jest.fn(), toolCall: jest.fn(), error: jest.fn() };
  const appMetrics = { coachGuardRejection: jest.fn() };

  const service = new CoachChatService(
    prisma as never,
    ai as never,
    features as never,
    userSettings as never,
    systemSettings as never,
    healthProfile as never,
    checkIns as never,
    signals as never,
    today as never,
    photos as never,
    metrics as never,
    appMetrics as never,
  );

  return {
    service,
    prisma,
    runTools,
    requests,
    features,
    metrics,
    appMetrics,
    script: (next: Script) => {
      script = next;
    },
  };
}

async function drain(iterable: AsyncIterable<CoachChatEvent>): Promise<CoachChatEvent[]> {
  const out: CoachChatEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function text(events: CoachChatEvent[]): string {
  return events.filter((e): e is Extract<CoachChatEvent, { type: 'delta' }> => e.type === 'delta').map((e) => e.text).join('');
}

function created(prisma: ReturnType<typeof setup>['prisma'], role: string): any[] {
  return prisma.coachMessage.create.mock.calls.map((c: any[]) => c[0].data).filter((d: any) => d.role === role);
}

const SARGE_L3_UNLOCKED = {
  coach: { personaId: 'drill_sergeant', intensity: 3, profanity: true, adultConfirmedAt: '2026-01-01T00:00:00.000Z' },
  policy: { allowProfanePersonas: true },
};

describe('CoachChatService (E7.7)', () => {
  it('answers with tools: tool frames, the guarded reply as deltas, done with the stored id; both turns persisted', async () => {
    const t = setup();
    const signals = aggregateSignals(threeDayPlanInput());
    const done = signals.adherence.totals.completed;
    expect(typeof done).toBe('number');
    t.script([
      { output: [call('get_training_signals')] },
      { outputText: `You have done ${done} sessions. Keep going.` },
    ]);

    const events = await drain(await t.service.startTurn(USER, 'How am I doing?'));

    expect(events[0]).toEqual({ type: 'tool', name: 'get_training_signals', status: 'ok' });
    expect(text(events)).toBe(`You have done ${done} sessions. Keep going.`);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: 'done', fallback: false, pausedUntil: null, links: [] });

    const [user] = created(t.prisma, 'user');
    const [coach] = created(t.prisma, 'coach');
    expect(user).toMatchObject({ userId: USER, role: 'user', kind: 'chat', body: 'How am I doing?' });
    expect(coach).toMatchObject({
      userId: USER,
      role: 'coach',
      kind: 'chat',
      personaId: 'coach',
      intensity: 2,
      provider: 'openai',
      model: 'fake-chat-model',
      body: `You have done ${done} sessions. Keep going.`,
    });
    expect(coach.createdAt.getTime()).toBeGreaterThan(user.createdAt.getTime());
    expect((last as any).messageId).toBe('msg-2');
    expect((last as any).userMessageId).toBe('msg-1');
    expect(t.metrics.turn).toHaveBeenCalledWith('model');
    expect(t.metrics.toolCall).toHaveBeenCalledWith('get_training_signals', 'ok');
    // A chat message resets the ignored-nudge streak.
    expect(t.prisma.coachState.updateMany).toHaveBeenCalledWith({
      where: { userId: USER, consecutiveIgnored: { gt: 0 } },
      data: { consecutiveIgnored: 0 },
    });
  });

  it('runs with the coach.chat model and the tool list', async () => {
    const t = setup();
    t.script([{ outputText: 'Hello.' }]);
    await drain(await t.service.startTurn(USER, 'hi'));

    expect(t.features.resolve).toHaveBeenCalledWith(USER, 'coach.chat');
    const req = t.runTools.mock.calls[0][0];
    expect(req).toMatchObject({ provider: 'openai', model: 'fake-chat-model' });
    expect(req.tools.map((tool) => tool.tool.name)).toEqual([
      'get_training_signals',
      'get_today_plan',
      'get_recent_workouts',
      'get_check_ins',
      'get_progress_photo_summary',
      'get_last_weekly_review',
      'pause_coach',
    ]);
  });

  describe('pause_coach', () => {
    it('pauses for 3 days and reports pausedUntil on done and on the reply', async () => {
      const t = setup();
      t.script([{ output: [call('pause_coach', { days: 3, reason: 'sick' })] }, { outputText: 'Paused. Rest up.' }]);
      const before = Date.now();
      const events = await drain(await t.service.startTurn(USER, "I'm sick for 3 days, pause please"));

      const done = events.find((e) => e.type === 'done') as any;
      const until = new Date(done.pausedUntil).getTime();
      expect(until - before).toBeGreaterThanOrEqual(3 * 86_400_000 - 1000);
      expect(until - before).toBeLessThanOrEqual(3 * 86_400_000 + 5000);
      expect(t.prisma.coachState.upsert).toHaveBeenCalledTimes(1);
      expect(created(t.prisma, 'coach')[0].data).toMatchObject({ pausedUntil: done.pausedUntil });
    });

    it('refuses 15 days with COACH_PAUSE_INVALID to the model and pauses nothing', async () => {
      const t = setup();
      t.script([{ output: [call('pause_coach', { days: 15, reason: 'vacation' })] }, { outputText: 'I can pause up to 14 days.' }]);
      const events = await drain(await t.service.startTurn(USER, 'Pause for 15 days'));

      expect(t.prisma.coachState.upsert).not.toHaveBeenCalled();
      const second = t.requests[1];
      expect(JSON.stringify(second.input)).toContain(COACH_PAUSE_INVALID);
      expect((events.find((e) => e.type === 'done') as any).pausedUntil).toBeNull();
    });
  });

  describe('safety', () => {
    it('distress: no model call, persona dropped, the fixed reply, even for an unlocked Sarge L3', async () => {
      const t = setup(SARGE_L3_UNLOCKED);
      const events = await drain(await t.service.startTurn(USER, 'honestly I want to kill myself'));

      expect(t.runTools).not.toHaveBeenCalled();
      expect(t.features.resolve).not.toHaveBeenCalled();
      expect(events[0]).toEqual({ type: 'safety', level: 'blocked', screen: 'distress' });
      expect(text(events)).toBe(COACH_DISTRESS_REPLY);
      expect(containsProfanity(text(events))).toBe(false);
      expect(text(events)).toMatch(/professional/);
      expect(text(events)).not.toMatch(/\d/);
      const [coach] = created(t.prisma, 'coach');
      expect(coach).toMatchObject({ personaId: null, intensity: null, provider: 'static', body: COACH_DISTRESS_REPLY });
      expect(created(t.prisma, 'user')).toHaveLength(1);
      expect(t.metrics.safetyHit).toHaveBeenCalledWith('distress');
      expect(t.metrics.turn).toHaveBeenCalledWith('safety');
    });

    it('urgent symptom: no model call, SAFETY_STOP_GUIDANCE', async () => {
      const t = setup();
      const events = await drain(await t.service.startTurn(USER, 'I have chest pain when I run'));

      expect(t.runTools).not.toHaveBeenCalled();
      expect(events[0]).toEqual({ type: 'safety', level: 'blocked', screen: 'symptom' });
      expect(text(events)).toBe(SAFETY_STOP_GUIDANCE);
    });

    it('pain: the model runs in the supportive register; profanity is forced closed even for unlocked Sarge L3', async () => {
      const t = setup(SARGE_L3_UNLOCKED);
      t.script([{ outputText: 'Hell yes recruit, get your damn ass to the gym and push through it.' }]);
      const events = await drain(await t.service.startTurn(USER, 'my knee hurts after squats'));

      expect(events[0]).toEqual({ type: 'safety', level: 'conservative', screen: 'pain' });
      const instructions = t.requests[0].instructions ?? '';
      expect(instructions).toContain('REGISTER: SUPPORTIVE');
      expect(instructions).not.toContain('adult language is allowed');
      expect(instructions).not.toContain('Unhinged');
      // The profane reply fails the guard in the supportive register: the fallback stands in.
      expect(text(events)).toBe(COACH_CHAT_FALLBACK_REPLY);
      expect(containsProfanity(text(events))).toBe(false);
      const [coach] = created(t.prisma, 'coach');
      expect(coach.intensity).toBe(2);
      expect(coach.data).toMatchObject({ safety: 'pain', fallback: true });
      expect(coach.data.guard).toContain('profanity');
    });

    it('an unlocked Sarge L3 may swear outside the safety register', async () => {
      const t = setup(SARGE_L3_UNLOCKED);
      t.script([{ outputText: 'Damn right, recruit. Get to the bar.' }]);
      const events = await drain(await t.service.startTurn(USER, 'motivate me'));

      expect(t.requests[0].instructions).toContain('adult language is allowed');
      expect(text(events)).toBe('Damn right, recruit. Get to the bar.');
    });
  });

  describe('content guard', () => {
    it('replaces a reply with an invented number by the fallback line', async () => {
      const t = setup();
      t.script([{ outputText: 'You have trained 97 times this month.' }]);
      const events = await drain(await t.service.startTurn(USER, 'How am I doing?'));

      expect(text(events)).toBe(COACH_CHAT_FALLBACK_REPLY);
      expect((events.find((e) => e.type === 'done') as any).fallback).toBe(true);
      expect(t.appMetrics.coachGuardRejection).toHaveBeenCalledWith('invented_number');
      expect(t.metrics.turn).toHaveBeenCalledWith('fallback');
    });

    it('allows numbers the user wrote and numbers from tool results', async () => {
      const t = setup();
      t.script([{ output: [call('get_check_ins')] }, { outputText: 'Energy 4 today, and you said 3 days.' }]);
      const events = await drain(await t.service.startTurn(USER, 'I can train 3 days'));
      expect(text(events)).toBe('Energy 4 today, and you said 3 days.');
    });

    it('replaces an empty or over-long reply', async () => {
      const t = setup();
      t.script([{ outputText: 'word '.repeat(400) }]);
      expect(text(await drain(await t.service.startTurn(USER, 'hi')))).toBe(COACH_CHAT_FALLBACK_REPLY);
    });

    it('turns a plan-change link into a structured link', async () => {
      const t = setup();
      t.script([{ outputText: `A lighter day could help. Try [Adjust today's workout](${COACH_ADJUST_PATH}).` }]);
      const events = await drain(await t.service.startTurn(USER, 'Can you change my plan?'));
      expect((events.find((e) => e.type === 'done') as any).links).toEqual([{ label: "Adjust today's workout", href: '/train' }]);
    });
  });

  describe('history window', () => {
    it('sends the last 20 timeline messages, oldest first, then the new message', async () => {
      const history = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'coach' : 'user',
        kind: 'chat',
        title: '',
        body: `message ${19 - i}`,
      }));
      const t = setup({ history });
      t.script([{ outputText: 'Ok.' }]);
      await drain(await t.service.startTurn(USER, 'latest'));

      expect(t.prisma.coachMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER }, take: 20, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      );
      const input = t.requests[0].input as AiInputItem[];
      expect(input).toHaveLength(21);
      expect(JSON.stringify(input[0])).toContain('message 0');
      expect(JSON.stringify(input[19])).toContain('message 19');
      expect(JSON.stringify(input[20])).toContain('latest');
      // Only role, kind, title and body are read from history rows.
      expect(t.prisma.coachMessage.findMany.mock.calls[0][0].select).toEqual({ role: true, kind: true, title: true, body: true });
    });
  });

  it('never-send canary: no email, name, date of birth, notes or storage ids reach the model', async () => {
    const t = setup({
      history: [{ role: 'coach', kind: 'nudge', title: 'Hi', body: 'Your hour.', data: { audio: CANARY.audioStorageId } }],
    });
    t.script([
      {
        output: [
          call('get_training_signals', {}, 'c1'),
          call('get_today_plan', {}, 'c2'),
          call('get_recent_workouts', {}, 'c3'),
          call('get_check_ins', {}, 'c4'),
          call('get_progress_photo_summary', {}, 'c5'),
          call('get_last_weekly_review', {}, 'c6'),
        ],
      },
      { outputText: 'Ok.' },
    ]);
    await drain(await t.service.startTurn(USER, 'How am I doing?'));

    const sent = JSON.stringify(t.requests);
    for (const canary of Object.values(CANARY)) expect(sent).not.toContain(canary);
  });

  describe('failures', () => {
    it('a refused first call (ai.limits 429) rejects the first event and persists nothing', async () => {
      const t = setup();
      t.script([new AiError('AI_RATE_LIMITED', 'Rate limit reached') as never]);
      const iterator = (await t.service.startTurn(USER, 'hi'))[Symbol.asyncIterator]();

      await expect(iterator.next()).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });
      expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
      expect(t.metrics.error).toHaveBeenCalledWith('AI_RATE_LIMITED');
    });

    it('a failure after streaming began is an error frame and no reply is stored', async () => {
      const t = setup();
      t.script([{ output: [call('get_check_ins')] }, new AiError('AI_PROVIDER_UNAVAILABLE', 'Provider down') as never]);
      const events = await drain(await t.service.startTurn(USER, 'hi'));

      expect(events[0]).toMatchObject({ type: 'tool' });
      expect(events[events.length - 1]).toEqual({ type: 'error', code: 'AI_PROVIDER_UNAVAILABLE', message: 'Provider down' });
      expect(created(t.prisma, 'coach')).toHaveLength(0);
      expect(created(t.prisma, 'user')).toHaveLength(1);
    });

    it('a disconnect aborts the turn and discards the partial reply', async () => {
      const t = setup();
      const controller = new AbortController();
      t.script([{ output: [call('get_check_ins')] }, { outputText: 'never shown' }]);
      t.runTools.mockImplementationOnce(async (req: AiToolLoopRequest) => {
        req.onStep?.({ step: 1, response: {} as AiResponse, calls: [] });
        controller.abort();
        throw new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI request was cancelled.', { details: { aborted: true } });
      });

      const events = await drain(await t.service.startTurn(USER, 'hi', { signal: controller.signal }));
      expect(events.filter((e) => e.type === 'done' || e.type === 'delta')).toEqual([]);
      expect(created(t.prisma, 'coach')).toHaveLength(0);
      expect(t.metrics.error).toHaveBeenCalledWith('cancelled');
    });

    it('refuses when the deployment has the coach off (COACH_DISABLED), before anything', async () => {
      const t = setup({ policy: { enabled: false } });
      await expect(t.service.startTurn(USER, 'hi')).rejects.toMatchObject({
        response: { details: { code: 'COACH_DISABLED' } },
      });
      expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
    });

    it('refuses with 409 AI_FEATURE_UNAVAILABLE when coach.chat has no model', async () => {
      const t = setup();
      t.features.resolve.mockResolvedValue({ state: 'no_model', model: null, fix: null });
      await expect(t.service.startTurn(USER, 'hi')).rejects.toMatchObject({
        status: 409,
        response: { details: { reason: 'AI_FEATURE_UNAVAILABLE' } },
      });
      expect(t.runTools).not.toHaveBeenCalled();
    });
  });
});

describe('chunkText', () => {
  it('splits on word boundaries and concatenates back to the text exactly', () => {
    const value = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen.';
    const chunks = chunkText(value, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(value);
  });
});

describe('StepChannel', () => {
  it('yields pushed steps then ends; a failure rethrows', async () => {
    const channel = new StepChannel();
    const seen: number[] = [];
    const loop = (async () => {
      for await (const step of channel) seen.push(step.step);
    })();
    channel.push({ step: 1, response: {} as AiResponse, calls: [] });
    channel.push({ step: 2, response: {} as AiResponse, calls: [] });
    channel.end({ final: {} as AiResponse, steps: [], stopReason: 'completed' });
    await loop;
    expect(seen).toEqual([1, 2]);

    const failing = new StepChannel();
    failing.fail(new Error('boom'));
    await expect((async () => {
      for await (const _ of failing) void _;
    })()).rejects.toThrow('boom');
  });
});
