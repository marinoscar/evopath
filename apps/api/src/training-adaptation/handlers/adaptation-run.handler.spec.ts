import { randomUUID } from 'node:crypto';

import type { Job } from '@prisma/client';

import { AiError, type AiErrorCode } from '../../ai/core/ai-error';
import { AI_RUN_TERMINAL_CODES } from '../../ai/runtime/ai-response-run.handler';
import { createAiRuntimeHarness, HARNESS_MODEL, HARNESS_USER, HARNESS_USER_KEY } from '../../ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES, type FakeAiScriptedResponse } from '../../ai/testing/fake-ai-provider';
import { JOB_SETTLED_EVENT, type JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { SCRIPT_USAGE } from '../../training-agents/testing/agent-scripts';
import { ADAPTATION_REASONS, ADAPTATION_RUN_JOB_TYPE, ADAPTATION_SUBJECT_TYPE } from '../adaptation.constants';
import { AdaptationContextError } from '../context/adaptation-context.contract';
import {
  ACCEPT,
  DUMBBELL_30_ANSWER,
  REVISE_MAJOR,
  adaptationRequestFixture,
  modelExercise,
  onlyDumbbellsRequest,
  proposalAnswer,
} from '../testing/adaptation-fixtures';
import { type AdaptationRig, createAdaptationRig } from '../testing/adaptation-rig';
import { AdaptationRunHandler, adaptationRunPayloadSchema } from './adaptation-run.handler';

// =============================================================================
// AdaptationRunHandler: outcomes, on the real service, the real graph and the
// fake provider (no database)
// =============================================================================

type Script = (req: { metadata?: Record<string, string> }, ctx: { signal?: AbortSignal }) => FakeAiScriptedResponse | Promise<FakeAiScriptedResponse>;

const answer = (value: unknown): FakeAiScriptedResponse => ({ outputText: JSON.stringify(value), usage: SCRIPT_USAGE });
const agentOf = (req: { metadata?: Record<string, string> }) => req.metadata?.agent;

/** The scripted planner and critic answers, by role. */
const good: Script = (req) => answer(agentOf(req) === 'critic' ? ACCEPT : DUMBBELL_30_ANSWER);

describe('AdaptationRunHandler', () => {
  let script: Script;
  let h: ReturnType<typeof createAiRuntimeHarness>;
  let rig: AdaptationRig;

  const start = (body: Parameters<typeof adaptationRequestFixture>[0] = { minutes: 30 }) => rig.service.create(HARNESS_USER, adaptationRequestFixture(body));
  const row = (id: string) => rig.db.getAdaptation(id)!;
  const run = (runId: string) => rig.db.get(runId)!;
  const providerCalls = () => h.fake.calls.filter((c) => c.method !== 'listModels' && c.method !== 'verifyKey');
  const callsBy = (role: string) => providerCalls().filter((c) => c.request?.metadata?.agent === role);

  beforeEach(() => {
    script = good;
    h = createAiRuntimeHarness({
      models: [{ modelId: HARNESS_MODEL, capabilities: FAKE_TEXT_MODEL_CAPABILITIES }],
      fake: { responses: (req, ctx) => script(req as never, ctx as never) },
    });
    rig = createAdaptationRig({ ai: h, planOwner: HARNESS_USER });
    rig.source = {};
  });

  describe('identity', () => {
    it('is the permanent ai.training.adapt.run type: server-only, five minutes, one attempt', () => {
      expect(rig.handler.type).toBe('ai.training.adapt.run');
      expect(rig.handler.profile).toEqual({ maxRuntimeMs: 5 * 60_000, maxAttempts: 1 });
      expect('nodeResultSchema' in rig.handler).toBe(false);
      expect('persistNodeResult' in rig.handler).toBe(false);
    });

    it('self-registers with the job registry', () => {
      const registry = new JobHandlerRegistry();
      const handler = new AdaptationRunHandler(registry, rig.db.prisma as never, h.ai, h.aiConfig, rig.events as never, {} as never);
      handler.onModuleInit();

      expect(registry.get('ai.training.adapt.run')).toBe(handler);
    });

    it('the payload is exactly { adaptationId: uuid }', () => {
      expect(adaptationRunPayloadSchema.safeParse({ adaptationId: randomUUID() }).success).toBe(true);
      expect(adaptationRunPayloadSchema.safeParse({ adaptationId: 'nope' }).success).toBe(false);
      expect(adaptationRunPayloadSchema.safeParse({}).success).toBe(false);
    });

    it('an invalid payload throws', async () => {
      await expect(rig.handler.process({ id: randomUUID(), payload: {} } as unknown as Job)).rejects.toThrow(/Invalid ai\.training\.adapt\.run payload/);
    });
  });

  describe('a good run', () => {
    it('queued -> running -> ready; the run succeeds; the proposal and reports are stored; the stage events replay', async () => {
      const started = await start({ minutes: 30, equipment: onlyDumbbellsRequest().equipment });
      expect(row(started.adaptationId).status).toBe('queued');

      await rig.runJob(started.adaptationId);

      const stored = row(started.adaptationId);
      expect(stored.status).toBe('ready');
      expect(stored.errorCode).toBeNull();
      expect((stored.proposal as { estimatedMinutes: number }).estimatedMinutes).toBeLessThanOrEqual(30);
      expect(stored.criticReport).toMatchObject({ verdict: 'accept', rounds: 1 });
      expect(stored.guardrailReport).toMatchObject({ promptVersion: 1, fitsRequest: true });
      expect(stored.contextSnapshot).toMatchObject({ version: 1 });
      expect(stored.jobId).toBe(rig.jobFor(started.adaptationId).id);
      expect(run(started.runId!)).toMatchObject({ status: 'succeeded', kind: 'adapt', result: { adaptationId: started.adaptationId } });
      expect(callsBy('planner')).toHaveLength(1);
      expect(callsBy('critic')).toHaveLength(1);

      const types = rig.eventTypes(started.runId!);
      expect(types[0]).toBe('run.queued');
      expect(types[1]).toBe('run.started');
      expect(types.filter((t) => t === 'stage.started')).toHaveLength(5);
      expect(types.filter((t) => t === 'stage.completed')).toHaveLength(5);
      expect(types).toContain('workout_adaptation.ready');
      expect(types.at(-1)).toBe('run.completed');
      expect(types.filter((t) => t === 'agent.usage')).toHaveLength(2);
    });

    it('spends the caller\'s key under the job id, and the run row keeps the token usage', async () => {
      const started = await start();
      await rig.runJob(started.adaptationId);

      expect(h.usageEvents.length).toBeGreaterThanOrEqual(2);
      for (const usage of h.usageEvents) {
        expect(usage).toMatchObject({ userId: HARNESS_USER, jobId: rig.jobFor(started.adaptationId).id, provider: 'openai', modelId: HARNESS_MODEL });
      }
      expect(run(started.runId!).usage).toMatchObject({ total: { calls: 2 } });
    });

    it('records nothing sensitive in events or audit rows: no key, no free text, no prompt', async () => {
      const started = await start({ minutes: 30, freeText: 'FREE-TEXT-CANARY-42' });
      await rig.runJob(started.adaptationId);

      const logged = JSON.stringify({ events: rig.events.events.get(started.runId!), audits: rig.db.audits, run: run(started.runId!) });
      expect(logged).not.toContain('FREE-TEXT-CANARY-42');
      expect(logged).not.toContain(HARNESS_USER_KEY);
      expect(logged).not.toContain('UNTRUSTED DATA');
    });

    it('a second process() of the same job is a no-op (the adaptation is no longer queued)', async () => {
      const started = await start();
      await rig.runJob(started.adaptationId);
      const calls = providerCalls().length;

      await rig.runJob(started.adaptationId);

      expect(providerCalls()).toHaveLength(calls);
      expect(row(started.adaptationId).status).toBe('ready');
    });
  });

  describe('a revise round', () => {
    it('one second planner pass, no second critic pass, and the guardrails run on the revision', async () => {
      const first = proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: 4 }), modelExercise('barbell_row', { isPriority: true, sets: 4 })]);
      const second = proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: 3 }), modelExercise('barbell_row', { isPriority: true, sets: 40 })]);
      let planner = 0;
      script = (req) => (agentOf(req) === 'critic' ? answer(REVISE_MAJOR) : answer(planner++ === 0 ? first : second));
      const started = await start({ minutes: 60 });

      await rig.runJob(started.adaptationId);

      expect(callsBy('planner')).toHaveLength(2);
      expect(callsBy('critic')).toHaveLength(1);
      const stored = row(started.adaptationId);
      expect(stored.status).toBe('ready');
      // The revision's 40 sets were repaired by the guardrails, not shipped.
      const sets = (stored.proposal as { exercises: Array<{ exerciseKey: string; sets: number }> }).exercises.find((e) => e.exerciseKey === 'barbell_row')!.sets;
      expect(sets).toBeLessThanOrEqual(4);
      expect(stored.criticReport).toMatchObject({ rounds: 1 });
    });
  });

  describe('the critic is optional, the guardrails are not', () => {
    it('a critic whose answer is unusable is skipped ("error"): the adaptation is still ready, with a warning', async () => {
      script = (req) => (agentOf(req) === 'critic' ? { outputText: 'not json', usage: SCRIPT_USAGE } : answer(DUMBBELL_30_ANSWER));
      const started = await start({ minutes: 30, equipment: onlyDumbbellsRequest().equipment });

      await rig.runJob(started.adaptationId);

      const stored = row(started.adaptationId);
      expect(stored.status).toBe('ready');
      expect(stored.criticReport).toMatchObject({ skipped: 'error' });
      expect((stored.guardrailReport as { warnings: string[] }).warnings).toContain('critic_skipped');
    });

    it('a spent token cap skips the critic ("token_cap") instead of failing the run', async () => {
      script = (req) =>
        agentOf(req) === 'critic' ? answer(ACCEPT) : { outputText: JSON.stringify(DUMBBELL_30_ANSWER), usage: { inputTokens: 200_000, outputTokens: 10 } };
      const started = await start({ minutes: 30, equipment: onlyDumbbellsRequest().equipment });

      await rig.runJob(started.adaptationId);

      expect(row(started.adaptationId).status).toBe('ready');
      expect(row(started.adaptationId).criticReport).toMatchObject({ skipped: 'token_cap' });
      expect(callsBy('critic')).toHaveLength(0);
    });
  });

  describe('run failures that are rules, not provider errors', () => {
    it('ADAPTATION_CANNOT_FIT: failed with the "try N+10" message, job returns normally, the critic is never asked', async () => {
      script = (req) =>
        agentOf(req) === 'critic'
          ? answer(ACCEPT)
          : answer(proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: 4, repMax: 8, restSeconds: 300 }), modelExercise('barbell_row', { isPriority: true, sets: 4, restSeconds: 300 })]));
      const started = await start({ minutes: 12 });

      await expect(rig.runJob(started.adaptationId)).resolves.toBeUndefined();

      expect(row(started.adaptationId)).toMatchObject({
        status: 'failed',
        errorCode: 'ADAPTATION_CANNOT_FIT',
        errorMessage: "Can't fit these lifts in 12 minutes; try 22",
      });
      expect(row(started.adaptationId).proposal).toBeNull();
      expect(run(started.runId!)).toMatchObject({ status: 'failed', errorCode: 'ADAPTATION_CANNOT_FIT' });
      expect(callsBy('critic')).toHaveLength(0);
      expect(rig.eventTypes(started.runId!).at(-1)).toBe('run.failed');
    });

    it('ADAPTATION_INVALID: an answer with nothing usable fails the run', async () => {
      script = (req) => (agentOf(req) === 'critic' ? answer(ACCEPT) : answer(proposalAnswer([modelExercise('made_up_lift'), modelExercise('another_made_up_lift')])));
      const started = await start();

      await rig.runJob(started.adaptationId);

      expect(row(started.adaptationId)).toMatchObject({ status: 'failed', errorCode: ADAPTATION_REASONS.INVALID });
      expect(row(started.adaptationId).proposal).toBeNull();
    });

    it('a gym deleted before the run starts fails it with ADAPTATION_GYM_NOT_FOUND', async () => {
      const started = await start({ minutes: 30 });
      // The handler holds the port object, so replacing its `build` reaches the graph's context node.
      rig.contextPort.build = jest.fn(async () => {
        throw new AdaptationContextError('ADAPTATION_GYM_NOT_FOUND', 'Gym not found');
      });

      await rig.runJob(started.adaptationId);

      expect(row(started.adaptationId)).toMatchObject({ status: 'failed', errorCode: ADAPTATION_REASONS.GYM_NOT_FOUND });
      expect(providerCalls()).toHaveLength(0);
    });
  });

  describe('urgent symptoms (defence in depth: the graph re-screens what create already screened)', () => {
    it('blocked_safety with zero provider calls, the run blocked, no proposal, no stack of user words', async () => {
      const started = await start({ minutes: 30 });
      // A row created before the screen existed, or edited by hand: the context node stops it anyway.
      rig.db.getAdaptation(started.adaptationId)!.request = { minutes: 30, freeText: 'I have chest pain and my arm is numb', useReadiness: true, baseWorkout: 'planned' };

      await rig.runJob(started.adaptationId);

      const stored = row(started.adaptationId);
      expect(stored).toMatchObject({ status: 'blocked_safety', errorCode: ADAPTATION_REASONS.SAFETY_STOP, proposal: null });
      expect(stored.safety).toMatchObject({ level: 'blocked' });
      expect(run(started.runId!).status).toBe('blocked_safety');
      expect(h.fake.calls).toHaveLength(0);
      expect(JSON.stringify(stored.safety)).not.toContain('chest pain');
    });
  });

  describe('AI errors', () => {
    const codes = [...AI_RUN_TERMINAL_CODES].filter((code) => code !== 'AI_DISABLED') as AiErrorCode[];

    it('discovers the terminal set (a code added to it is covered automatically)', () => {
      expect(codes.length).toBeGreaterThanOrEqual(8);
      expect(codes).toContain('AI_KEY_REQUIRED');
      expect(codes).toContain('AI_STRUCTURED_OUTPUT_INVALID');
    });

    it.each(codes)('terminal %s: the adaptation and its run fail with that code, and the job RETURNS (no retry)', async (code) => {
      script = () => {
        throw new AiError(code, 'the provider said no');
      };
      const started = await start();

      await expect(rig.runJob(started.adaptationId)).resolves.toBeUndefined();

      expect(row(started.adaptationId)).toMatchObject({ status: 'failed', errorCode: code });
      expect(row(started.adaptationId).proposal).toBeNull();
      expect(run(started.runId!)).toMatchObject({ status: 'failed', errorCode: code });
      expect(rig.eventTypes(started.runId!).at(-1)).toBe('run.failed');
    });

    it('an unparseable planner answer is AI_STRUCTURED_OUTPUT_INVALID from the real gateway, and terminal', async () => {
      script = () => ({ outputText: '{"title": 12', usage: SCRIPT_USAGE });
      const started = await start();

      await expect(rig.runJob(started.adaptationId)).resolves.toBeUndefined();

      expect(row(started.adaptationId)).toMatchObject({ status: 'failed', errorCode: 'AI_STRUCTURED_OUTPUT_INVALID' });
      expect(callsBy('critic')).toHaveLength(0);
    });

    it('the kill switch: AI switched off between enqueue and run is AI_DISABLED, zero provider calls, the job returns', async () => {
      const started = await start();
      h.setPolicy({ enabled: false });

      await expect(rig.runJob(started.adaptationId)).resolves.toBeUndefined();

      expect(row(started.adaptationId)).toMatchObject({ status: 'failed', errorCode: 'AI_DISABLED' });
      expect(h.fake.calls).toHaveLength(0);
    });

    it('a non-terminal AI error (provider down) fails the row with its code and THROWS, so the job is failed', async () => {
      script = () => {
        throw new AiError('AI_PROVIDER_UNAVAILABLE', 'provider is down');
      };
      const started = await start();

      await expect(rig.runJob(started.adaptationId)).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });

      expect(row(started.adaptationId)).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
      expect(run(started.runId!).status).toBe('failed');
    });

    it('any other error fails the row with INTERNAL_ERROR, a safe message (never the error\'s text), and throws', async () => {
      script = () => {
        throw new Error('boom: database password is hunter2');
      };
      const started = await start();

      await expect(rig.runJob(started.adaptationId)).rejects.toThrow();

      const stored = row(started.adaptationId);
      expect(stored.status).toBe('failed');
      expect(JSON.stringify(stored)).not.toContain('hunter2');
      expect(JSON.stringify(rig.events.events.get(started.runId!))).not.toContain('hunter2');
    });
  });

  describe('rate limit: the job is deferred and the graph resumes from its checkpoint', () => {
    it('AI_RATE_LIMITED in the critic: RateLimitError to the queue, both rows back to queued, run.deferred with retryAfterMs; the retry does not repeat the planner', async () => {
      let criticCalls = 0;
      script = (req) => {
        if (agentOf(req) === 'planner') return answer(DUMBBELL_30_ANSWER);
        if (criticCalls++ === 0) throw new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1500 });
        return answer(ACCEPT);
      };
      const started = await start({ minutes: 30, equipment: onlyDumbbellsRequest().equipment });

      const first = await rig.runJob(started.adaptationId).catch((e: unknown) => e);

      expect(first).toBeInstanceOf(RateLimitError);
      expect((first as RateLimitError).retryAfterMs).toBe(1500);
      expect(row(started.adaptationId).status).toBe('queued');
      expect(run(started.runId!).status).toBe('queued');
      expect(rig.events.events.get(started.runId!)!.find((e) => e.type === 'run.deferred')?.data).toEqual({ retryAfterMs: 1500 });
      expect(row(started.adaptationId).proposal).toBeNull();

      await rig.runJob(started.adaptationId);

      expect(row(started.adaptationId).status).toBe('ready');
      expect(run(started.runId!).status).toBe('succeeded');
      expect(callsBy('planner')).toHaveLength(1);
      expect(rig.eventTypes(started.runId!)).toContain('run.resumed');
      expect(rig.eventTypes(started.runId!).filter((t) => t === 'run.started')).toHaveLength(1);
    });

    it('AI_RATE_LIMITED without a retry-after still defers (retryAfterMs: null)', async () => {
      let first = true;
      script = (req) => {
        if (first) {
          first = false;
          throw new AiError('AI_RATE_LIMITED', 'slow down');
        }
        return good(req, {});
      };
      const started = await start();

      const error = await rig.runJob(started.adaptationId).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RateLimitError);
      expect(rig.events.events.get(started.runId!)!.find((e) => e.type === 'run.deferred')?.data).toEqual({ retryAfterMs: null });
    });
  });

  describe('cancel', () => {
    it('a queued adaptation is cancelled at once; the job that still fires is a no-op with no provider call', async () => {
      const started = await start();

      const view = await rig.service.cancel(HARNESS_USER, started.adaptationId);

      expect(view.status).toBe('cancelled');
      expect(run(started.runId!).status).toBe('cancelled');
      expect(rig.eventTypes(started.runId!)).toContain('run.cancelled');

      await rig.runJob(started.adaptationId);

      expect(h.fake.calls).toHaveLength(0);
      expect(row(started.adaptationId).status).toBe('cancelled');
    });

    it('a running adaptation: the in-flight provider call is aborted, the status is cancelled, there is no proposal', async () => {
      let sawAbort = false;
      let inFlight!: () => void;
      const providerStarted = new Promise<void>((resolve) => (inFlight = resolve));
      script = (_req, ctx) =>
        new Promise((_resolve, reject) => {
          inFlight();
          ctx.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              reject(ctx.signal?.reason);
            },
            { once: true },
          );
        });
      const started = await start();

      const running = rig.runJob(started.adaptationId);
      await providerStarted;
      expect(row(started.adaptationId).status).toBe('running');

      await rig.service.cancel(HARNESS_USER, started.adaptationId);
      await expect(running).resolves.toBeUndefined();

      expect(sawAbort).toBe(true);
      expect(row(started.adaptationId)).toMatchObject({ status: 'cancelled', proposal: null });
      expect(run(started.runId!).status).toBe('cancelled');
      expect(rig.eventTypes(started.runId!).at(-1)).toBe('run.cancelled');
      expect(callsBy('critic')).toHaveLength(0);
    });

    it('a cancel that arrives after the run finished cannot turn a ready adaptation into cancelled', async () => {
      const started = await start();
      await rig.runJob(started.adaptationId);

      await expect(rig.service.cancel(HARNESS_USER, started.adaptationId)).rejects.toMatchObject({
        response: { details: { reason: 'ADAPTATION_NOT_CANCELLABLE', status: 'ready' } },
      });
      expect(row(started.adaptationId).status).toBe('ready');
    });
  });

  describe('deadline', () => {
    it('a run past its deadline fails with ADAPTATION_TIMEOUT, aborts the call, and the job returns', async () => {
      const timed = createAdaptationRig({ ai: h, planOwner: HARNESS_USER, handler: { deadlineMs: 60 } });
      let sawAbort = false;
      script = (_req, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              reject(ctx.signal?.reason);
            },
            { once: true },
          );
        });
      const started = await timed.service.create(HARNESS_USER, adaptationRequestFixture({ minutes: 30 }));

      await expect(timed.runJob(started.adaptationId)).resolves.toBeUndefined();

      expect(sawAbort).toBe(true);
      expect(timed.db.getAdaptation(started.adaptationId)).toMatchObject({ status: 'failed', errorCode: ADAPTATION_REASONS.TIMEOUT });
    });
  });

  describe('guards', () => {
    it('an adaptation that no longer exists is a no-op', async () => {
      const id = randomUUID();
      await expect(rig.handler.process({ id: randomUUID(), payload: { adaptationId: id } } as unknown as Job)).resolves.toBeUndefined();
      expect(h.fake.calls).toHaveLength(0);
    });

    it.each(['ready', 'failed', 'cancelled', 'discarded', 'running'])('an adaptation that is already %s is a no-op', async (status) => {
      const started = await start();
      rig.db.getAdaptation(started.adaptationId)!.status = status;

      await rig.runJob(started.adaptationId);

      expect(h.fake.calls).toHaveLength(0);
      expect(row(started.adaptationId).status).toBe(status);
    });

    it('an adaptation whose kit run is gone fails with ADAPTATION_RUN_LOST', async () => {
      const started = await start();
      rig.db.runs.delete(started.runId!);

      await rig.runJob(started.adaptationId);

      expect(row(started.adaptationId)).toMatchObject({ status: 'failed', errorCode: ADAPTATION_REASONS.RUN_LOST });
      expect(h.fake.calls).toHaveLength(0);
    });

    it('a run whose cancel was requested before the job started finishes cancelled without a provider call', async () => {
      const started = await start();
      run(started.runId!).cancelRequestedAt = new Date();

      await rig.runJob(started.adaptationId);

      expect(row(started.adaptationId).status).toBe('cancelled');
      expect(h.fake.calls).toHaveLength(0);
    });
  });

  describe('the settle safety net (an orphaned adaptation when its job ends unsuccessfully)', () => {
    const event = (over: Partial<JobSettledEvent>): JobSettledEvent =>
      ({ jobId: randomUUID(), type: ADAPTATION_RUN_JOB_TYPE, subjectType: ADAPTATION_SUBJECT_TYPE, subjectId: randomUUID(), succeeded: false, ...over }) as JobSettledEvent;

    it('exposes the listener on the job-settled event', () => {
      expect(JOB_SETTLED_EVENT).toBeTruthy();
      expect(typeof rig.handler.onJobSettled).toBe('function');
    });

    it('fails a running adaptation whose job failed, and its run', async () => {
      const started = await start();
      const job = rig.jobFor(started.adaptationId);
      Object.assign(rig.db.getAdaptation(started.adaptationId)!, { status: 'running', jobId: job.id });
      run(started.runId!).status = 'running';

      await rig.handler.onJobSettled(event({ jobId: job.id, subjectId: started.adaptationId }));

      expect(row(started.adaptationId)).toMatchObject({ status: 'failed', errorCode: ADAPTATION_REASONS.RUN_LOST });
      expect(run(started.runId!).status).toBe('failed');
    });

    it('also fails a still-queued one (the job crashed before it started)', async () => {
      const started = await start();
      const job = rig.jobFor(started.adaptationId);
      rig.db.getAdaptation(started.adaptationId)!.jobId = job.id;

      await rig.handler.onJobSettled(event({ jobId: job.id, subjectId: started.adaptationId }));

      expect(row(started.adaptationId).status).toBe('failed');
    });

    it.each([
      ['a succeeded job', { succeeded: true }],
      ['another job type', { type: 'ai.response.run' }],
      ['another subject type', { subjectType: 'something_else' }],
      ['an unrelated job id (an older attempt)', { jobId: randomUUID() }],
    ])('ignores %s', async (_label, over) => {
      const started = await start();
      const job = rig.jobFor(started.adaptationId);
      Object.assign(rig.db.getAdaptation(started.adaptationId)!, { status: 'running', jobId: job.id });

      await rig.handler.onJobSettled(event({ jobId: job.id, subjectId: started.adaptationId, ...over }));

      expect(row(started.adaptationId).status).toBe('running');
    });

    it('never overwrites a finished adaptation', async () => {
      const started = await start();
      await rig.runJob(started.adaptationId);

      await rig.handler.onJobSettled(event({ jobId: rig.jobFor(started.adaptationId).id, subjectId: started.adaptationId }));

      expect(row(started.adaptationId).status).toBe('ready');
    });

    it('a database error in the listener is swallowed (it must never break the queue)', async () => {
      rig.db.workoutAdaptation.findUnique.mockRejectedValueOnce(new Error('db down'));
      await expect(rig.handler.onJobSettled(event({}))).resolves.toBeUndefined();
    });
  });

  describe('canDelete (the admin job delete)', () => {
    it('refuses to delete a runnable job whose adaptation is active on it, and allows the rest', async () => {
      const started = await start();
      const job = { ...rig.jobFor(started.adaptationId), status: 'pending' } as Job;
      rig.db.getAdaptation(started.adaptationId)!.jobId = job.id;

      await expect(rig.handler.canDelete(job)).resolves.toMatch(/Cancel the adaptation instead/);
      await expect(rig.handler.canDelete({ ...job, status: 'succeeded' } as Job)).resolves.toBeNull();
      await expect(rig.handler.canDelete({ ...job, subjectType: 'other' } as Job)).resolves.toBeNull();

      rig.db.getAdaptation(started.adaptationId)!.status = 'ready';
      await expect(rig.handler.canDelete(job)).resolves.toBeNull();
    });
  });
});
