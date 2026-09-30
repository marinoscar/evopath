import { randomUUID } from 'node:crypto';

import type { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { createAiRuntimeHarness, HARNESS_MODEL, HARNESS_OTHER_USER, HARNESS_USER } from '../ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES, type FakeAiScriptedResponse } from '../ai/testing/fake-ai-provider';
import { TRAINING_MIN_RUN_TOKENS } from '../common/schemas/settings.schema';
import { PROGRAM_REASONS } from '../programs/programs.constants';
import type { RoleResolution } from '../training-agents/models/dto/role-resolution.dto';
import { SAFETY_STOP_GUIDANCE } from '../training-agents/guardrails/safety-keywords';
import { ET, LIB, LIBRARY } from '../training-agents/testing/context-fixtures';
import { SCRIPT_USAGE } from '../training-agents/testing/agent-scripts';
import { ADAPTATION_MAX_RUN_TOKENS, ADAPTATION_TTL_MS } from './adaptation.constants';
import { adaptedNote, baseRefOf, describeRequest, replaceWorkout, toAdaptationView } from './adaptation.service';
import { AdaptationContextError, snapshotOf } from './context/adaptation-context.contract';
import { adaptedWorkoutSchema } from './contracts/adapted-workout.contract';
import {
  ACCEPT,
  ADAPT_FULL_GYM,
  ADAPT_GYM_ID,
  ADAPT_PLAN_VERSION_ID,
  ADAPT_PROGRAM_ID,
  ADAPT_PROGRAM_WORKOUT_ID,
  DUMBBELL_30_ANSWER,
  adaptationContextFixture,
  adaptationRequestFixture,
  adaptationSourceFixture,
  modelExercise,
  onlyDumbbellsRequest,
  proposalAnswer,
} from './testing/adaptation-fixtures';
import { type AdaptationRig, createAdaptationRig, planTreeFixture } from './testing/adaptation-rig';

// =============================================================================
// AdaptationService: preview, create, read, cancel, discard and both applies
// =============================================================================
//
// The real service over the in-memory tables, the fixture context builder and
// the fake provider. Rows that must be `ready` come from a REAL run of the
// handler (`readyAdaptation`), so what apply reads is exactly what a run
// stores. The real-Postgres suite proves the apply writes and the partial
// indexes; here every decision the service makes is exercised.
// =============================================================================

const answer = (value: unknown): FakeAiScriptedResponse => ({ outputText: JSON.stringify(value), usage: SCRIPT_USAGE });
const reasonOf = (error: unknown) => ((error as HttpException).getResponse() as { details?: { reason?: string } }).details?.reason;
const detailsOf = (error: unknown) => ((error as HttpException).getResponse() as { details?: Record<string, unknown> }).details;
const statusOf = (error: unknown) => (error as HttpException).getStatus();

async function failure(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('Expected the call to be refused');
}

describe('AdaptationService', () => {
  let h: ReturnType<typeof createAiRuntimeHarness>;
  let rig: AdaptationRig;
  let plannerAnswer: unknown;

  const providerCalls = () => h.fake.calls.filter((c) => c.method !== 'listModels' && c.method !== 'verifyKey');

  beforeEach(() => {
    plannerAnswer = DUMBBELL_30_ANSWER;
    h = createAiRuntimeHarness({
      models: [{ modelId: HARNESS_MODEL, capabilities: FAKE_TEXT_MODEL_CAPABILITIES }],
      fake: { responses: (req) => answer(req.metadata?.agent === 'critic' ? ACCEPT : plannerAnswer) },
    });
    rig = createAdaptationRig({ ai: h, planOwner: HARNESS_USER });
  });

  // Typed as the 202 answer (a stopped request answers `jobId: null, runId: null`; those tests assert the raw values).
  const create = (body: Parameters<typeof adaptationRequestFixture>[0] = { minutes: 30 }, userId = HARNESS_USER) =>
    rig.service.create(userId, adaptationRequestFixture(body)) as Promise<{ adaptationId: string; jobId: string; runId: string; status: string }>;

  /** A REAL run: create, execute the handler, and answer the adaptation id that is now `ready`. */
  async function readyAdaptation(body: Parameters<typeof adaptationRequestFixture>[0] = { minutes: 30, soreness: { muscles: ['chest'], level: 'mild' } }) {
    const started = await create(body);
    await rig.runJob(started.adaptationId);
    expect(rig.db.getAdaptation(started.adaptationId)!.status).toBe('ready');
    return started;
  }

  describe('preview', () => {
    it('is exactly what create stores as the "what was sent" snapshot', async () => {
      const request = { minutes: 30, soreness: { muscles: ['chest' as const], level: 'mild' as const }, equipment: onlyDumbbellsRequest().equipment };

      const preview = await rig.service.preview(HARNESS_USER, request);
      const started = await create(request);
      const stored = rig.db.getAdaptation(started.adaptationId)!.contextSnapshot as { summary: unknown; sent: unknown };

      expect(preview.sentData).toEqual(stored.summary);
      expect(stored.sent).toEqual(snapshotOf(adaptationContextFixture({ request: adaptationRequestFixture(request) })).sent);
    });

    it('calls no provider and stores nothing: no row, no run, no job, no event', async () => {
      await rig.service.preview(HARNESS_USER, { minutes: 30 });

      expect(rig.db.adaptations.size).toBe(0);
      expect(rig.db.runs.size).toBe(0);
      expect(rig.jobs.enqueueWithin).not.toHaveBeenCalled();
      expect(rig.events.events.size).toBe(0);
      expect(h.fake.calls).toHaveLength(0);
    });

    it('describes the base, the planner and critic models, and that a provider would be called', async () => {
      const preview = await rig.service.preview(HARNESS_USER, { minutes: 30 });

      expect(preview).toMatchObject({
        baseWorkout: 'planned',
        base: { programWorkoutId: ADAPT_PROGRAM_WORKOUT_ID, name: 'Upper A', date: '2026-09-30', planVersion: 3 },
        willCallProvider: true,
        safety: { level: 'ok', reasons: [] },
        blocked: null,
        models: {
          planner: { role: 'planner', state: 'ready', runnable: true, model: { provider: 'openai', modelId: HARNESS_MODEL } },
          critic: { role: 'critic', state: 'ready', runnable: true },
        },
      });
      expect(preview.sentData.sections.map((s) => s.key)).toEqual(['request', 'plan', 'today', 'gym', 'candidates', 'lastSessions', 'readiness', 'constraints']);
    });

    it('with no planned workout it previews an ad-hoc session (no base)', async () => {
      rig.source = { planned: null };

      const preview = await rig.service.preview(HARNESS_USER, { minutes: 30 });

      expect(preview).toMatchObject({ baseWorkout: 'none', base: null });
    });

    it.each(['planner', 'critic'] as const)('a blocked %s role is shown with its state and fix, and no provider would be called', async (role) => {
      rig.roles[role] = { role, state: 'no_key', needs: [], requestedEffort: null, effectiveEffort: null, fix: 'user' } as unknown as RoleResolution;

      const preview = await rig.service.preview(HARNESS_USER, { minutes: 30 });

      expect(preview.willCallProvider).toBe(false);
      expect(preview.models[role]).toMatchObject({ state: 'no_key', model: null, runnable: false, fix: 'user' });
    });

    it('urgent text: blocked with the fixed guidance, no provider would be called (and still nothing stored)', async () => {
      const preview = await rig.service.preview(HARNESS_USER, { freeText: 'I get chest pain when I lift' });

      expect(preview.willCallProvider).toBe(false);
      expect(preview.safety.level).toBe('blocked');
      expect(preview.blocked).toEqual({ reason: 'TRAINING_SAFETY_STOP', guidance: SAFETY_STOP_GUIDANCE });
      expect(rig.db.adaptations.size).toBe(0);
    });
  });

  describe('request refusals', () => {
    it.each([
      ['an empty body', {}],
      ['minutes out of range', { minutes: 5 }],
      ['unknown keys', { minutes: 30, loadKg: 200 }],
    ])('%s is 400 and creates nothing', async (_label, body) => {
      const error = await failure(rig.service.create(HARNESS_USER, body));

      expect(statusOf(error)).toBe(400);
      expect(rig.db.adaptations.size).toBe(0);
    });

    it('"Tell us what to change" is the message of an empty request', async () => {
      const error = await failure(rig.service.create(HARNESS_USER, {}));
      expect((error.getResponse() as { message: string }).message).toBe('Tell us what to change');
    });

    it('a gym that is the planned workout\'s own gym is not a change: 400 ADAPTATION_NOTHING_TO_CHANGE', async () => {
      const error = await failure(rig.service.create(HARNESS_USER, { gymId: ADAPT_GYM_ID }));

      expect(statusOf(error)).toBe(400);
      expect(reasonOf(error)).toBe('ADAPTATION_NOTHING_TO_CHANGE');
      expect(rig.db.adaptations.size).toBe(0);
      await expect(rig.service.preview(HARNESS_USER, { gymId: ADAPT_GYM_ID })).rejects.toMatchObject({ status: 400 });
    });

    it('a gym other than the planned one is a change', async () => {
      rig.source = { planned: { ...adaptationSourceFixture().planned! } };
      await expect(rig.service.create(HARNESS_USER, { gymId: randomUUID() })).resolves.toMatchObject({ status: 'queued' });
    });

    it('an only-equipment type the gym does not have is 400 ADAPTATION_EQUIPMENT_NOT_IN_GYM naming the type', async () => {
      const error = await failure(rig.service.create(HARNESS_USER, { equipment: { mode: 'only', equipmentTypeIds: [ET.treadmill] } }));

      expect(statusOf(error)).toBe(400);
      expect(detailsOf(error)).toMatchObject({ reason: 'ADAPTATION_EQUIPMENT_NOT_IN_GYM', path: 'equipment.equipmentTypeIds', equipmentTypeIds: [ET.treadmill] });
      expect(rig.db.adaptations.size).toBe(0);
    });

    it('a gym that is not the caller\'s is a 404 on create and preview', async () => {
      rig.contextPort.build = jest.fn(async () => {
        throw new AdaptationContextError('ADAPTATION_GYM_NOT_FOUND', 'Gym not found');
      });

      await expect(rig.service.create(HARNESS_USER, { gymId: randomUUID() })).rejects.toMatchObject({ status: 404 });
      await expect(rig.service.preview(HARNESS_USER, { gymId: randomUUID() })).rejects.toMatchObject({ status: 404 });
      expect(rig.db.adaptations.size).toBe(0);
    });
  });

  describe('create', () => {
    it('one transaction: a queued adaptation, its adapt run and its ai.training.adapt.run job', async () => {
      const now = new Date('2026-09-30T12:00:00.000Z');
      const request = adaptationRequestFixture({ minutes: 30, soreness: { muscles: ['chest'], level: 'mild' } });

      const started = (await rig.service.create(HARNESS_USER, request, now)) as { adaptationId: string; jobId: string; runId: string; status: string };

      expect(started).toEqual({ adaptationId: expect.any(String), jobId: expect.any(String), runId: expect.any(String), status: 'queued' });
      const row = rig.db.getAdaptation(started.adaptationId)!;
      expect(row).toMatchObject({
        userId: HARNESS_USER,
        status: 'queued',
        request,
        gymId: ADAPT_GYM_ID,
        runId: started.runId,
        jobId: started.jobId,
        baseRef: { planId: ADAPT_PROGRAM_ID, planVersionId: ADAPT_PLAN_VERSION_ID, planVersion: 3, planWorkoutId: ADAPT_PROGRAM_WORKOUT_ID, date: '2026-09-30' },
        safety: { level: 'ok', reasons: [] },
        models: { planner: { provider: 'openai', modelId: HARNESS_MODEL }, critic: { provider: 'openai', modelId: HARNESS_MODEL } },
      });
      expect(row.expiresAt.getTime()).toBe(now.getTime() + ADAPTATION_TTL_MS);
      expect(ADAPTATION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
      expect(row.contextSnapshot).toMatchObject({ version: 1, sent: { request: { minutes: 30 } } });

      expect(rig.db.get(started.runId)).toMatchObject({
        userId: HARNESS_USER,
        kind: 'adapt',
        trigger: 'user',
        status: 'queued',
        jobId: started.jobId,
        jobIds: [started.jobId],
        input: { request: { adaptationId: started.adaptationId }, maxCriticRounds: 1 },
        roleModels: { planner: { provider: 'openai', modelId: HARNESS_MODEL, keySource: 'user' }, critic: { provider: 'openai', modelId: HARNESS_MODEL } },
      });
      expect(rig.jobs.enqueueWithin).toHaveBeenCalledTimes(1);
      expect(rig.jobs.enqueueWithin.mock.calls[0][1]).toMatchObject({
        type: 'ai.training.adapt.run',
        subjectType: 'training_adaptation',
        subjectId: started.adaptationId,
        payload: { adaptationId: started.adaptationId },
      });
      expect(rig.eventTypes(started.runId)).toEqual(['run.queued']);
      expect(rig.db.audits).toHaveLength(1);
      expect(h.fake.calls).toHaveLength(0);
    });

    it('the stored request has the validated defaults, and the kit run never carries the request text', async () => {
      const started = await create({ minutes: 30, freeText: '  my shoulder is fine  ' });

      expect(rig.db.getAdaptation(started.adaptationId)!.request).toMatchObject({ freeText: 'my shoulder is fine', useReadiness: true, baseWorkout: 'planned' });
      expect(JSON.stringify(rig.db.get(started.runId))).not.toContain('my shoulder');
    });

    it.each([
      { maxRunTokens: 50_000, cap: 50_000 },
      { maxRunTokens: 500_000, cap: ADAPTATION_MAX_RUN_TOKENS },
      { maxRunTokens: 100, cap: TRAINING_MIN_RUN_TOKENS },
      { maxRunTokens: undefined, cap: ADAPTATION_MAX_RUN_TOKENS },
    ])('the run\'s token cap: the user\'s $maxRunTokens lowers it, never raises it past 120000 (-> $cap)', async ({ maxRunTokens, cap }) => {
      rig.settings = maxRunTokens === undefined ? undefined : { training: { maxRunTokens } };

      const started = await create();

      expect(rig.db.get(started.runId)!.tokenCap).toBe(cap);
    });

    it('with no plan the base is null and the adaptation is ad hoc', async () => {
      rig.source = { planned: null };

      const started = await create({ minutes: 30, baseWorkout: 'none' });

      expect(rig.db.getAdaptation(started.adaptationId)!.baseRef).toBeNull();
    });

    it('a second adaptation while one is active is 409 ADAPTATION_IN_PROGRESS naming the first; another user is not blocked', async () => {
      const first = await create();

      const error = await failure(create());

      expect(statusOf(error)).toBe(409);
      expect(detailsOf(error)).toEqual({ reason: 'ADAPTATION_IN_PROGRESS', adaptationId: first.adaptationId, status: 'queued', runId: first.runId });
      expect(rig.db.adaptations.size).toBe(1);
      await expect(create({ minutes: 30 }, HARNESS_OTHER_USER)).resolves.toMatchObject({ status: 'queued' });
    });

    it('a running one blocks too; once it is terminal a new one may start', async () => {
      const first = await create();
      rig.db.getAdaptation(first.adaptationId)!.status = 'running';
      expect(reasonOf(await failure(create()))).toBe('ADAPTATION_IN_PROGRESS');

      for (const status of ['ready', 'failed', 'cancelled', 'blocked_safety', 'applied', 'discarded']) {
        rig.db.getAdaptation(first.adaptationId)!.status = status;
        const next = await create();
        rig.db.getAdaptation(next.adaptationId)!.status = 'discarded';
      }
    });

    it('any other unique violation is not mistaken for "in progress"', async () => {
      const { Prisma } = jest.requireActual('@prisma/client') as typeof import('@prisma/client');
      rig.db.workoutAdaptation.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: 'some_other_uniq_idx' } }),
      );

      await expect(create()).rejects.toThrow('dup');
    });

    it('an unusable planner or critic is 409 TRAINING_ROLE_UNAVAILABLE naming the role, its state and the fix; nothing is created', async () => {
      rig.roles.critic = { role: 'critic', state: 'missing_capability', needs: ['structured_output'], requestedEffort: null, effectiveEffort: null, fix: 'model' } as unknown as RoleResolution;

      const error = await failure(create());

      expect(statusOf(error)).toBe(409);
      expect(detailsOf(error)).toEqual({ reason: 'TRAINING_ROLE_UNAVAILABLE', role: 'critic', state: 'missing_capability', fix: 'model' });
      expect(rig.db.adaptations.size).toBe(0);
      expect(rig.db.runs.size).toBe(0);
      expect(rig.jobs.enqueueWithin).not.toHaveBeenCalled();
    });

    it('with both roles unusable the planner is named first', async () => {
      for (const role of ['planner', 'critic'] as const) {
        rig.roles[role] = { role, state: 'no_key', needs: [], requestedEffort: null, effectiveEffort: null, fix: 'user' } as unknown as RoleResolution;
      }

      expect(detailsOf(await failure(create()))).toMatchObject({ role: 'planner', state: 'no_key' });
    });

    it('urgent free text is answered blocked_safety: no run, no job, no provider call, and the text is NOT stored', async () => {
      const started = await create({ minutes: 30, freeText: 'chest pain and my arm is numb' });

      expect(started).toEqual({ adaptationId: expect.any(String), jobId: null, runId: null, status: 'blocked_safety', guidance: SAFETY_STOP_GUIDANCE });
      const row = rig.db.getAdaptation(started.adaptationId)!;
      expect(row).toMatchObject({ status: 'blocked_safety', errorCode: 'TRAINING_SAFETY_STOP', runId: null, jobId: null, proposal: null });
      expect(JSON.stringify(row)).not.toContain('chest pain');
      expect((row.request as Record<string, unknown>).freeText).toBeUndefined();
      expect(row.safety).toMatchObject({ level: 'blocked' });
      expect(rig.db.runs.size).toBe(0);
      expect(rig.jobs.enqueueWithin).not.toHaveBeenCalled();
      expect(h.fake.calls).toHaveLength(0);
    });

    it('the safety stop comes before the role check (a stopped request never depends on a key) and never blocks the next request', async () => {
      rig.roles.planner = { role: 'planner', state: 'no_key', needs: [], requestedEffort: null, effectiveEffort: null, fix: 'user' } as unknown as RoleResolution;

      const stopped = await create({ freeText: 'I fainted yesterday' });
      expect(stopped.status).toBe('blocked_safety');

      rig.roles.planner = { role: 'planner', state: 'ready', model: { provider: 'openai', modelId: HARNESS_MODEL, displayName: 'F', keySource: 'user' }, needs: [], requestedEffort: null, effectiveEffort: null, fix: null } as unknown as RoleResolution;
      await expect(create({ minutes: 30 })).resolves.toMatchObject({ status: 'queued' });
    });
  });

  describe('read, ownership, cancel, discard', () => {
    it('get returns the view of my adaptation, with the run\'s stage', async () => {
      const started = await create();
      rig.db.get(started.runId)!.stage = 'adapt';

      const view = await rig.service.get(HARNESS_USER, started.adaptationId);

      expect(view).toMatchObject({ id: started.adaptationId, status: 'queued', runId: started.runId, jobId: started.jobId, stage: 'adapt', gymId: ADAPT_GYM_ID, proposal: null, guidance: null });
    });

    it('another user\'s adaptation is a 404 on every operation, and looks like a missing one', async () => {
      const started = await create();
      const ops: Array<() => Promise<unknown>> = [
        () => rig.service.get(HARNESS_OTHER_USER, started.adaptationId),
        () => rig.service.cancel(HARNESS_OTHER_USER, started.adaptationId),
        () => rig.service.discard(HARNESS_OTHER_USER, started.adaptationId),
        () => rig.service.applyWorkout(HARNESS_OTHER_USER, started.adaptationId),
        () => rig.service.applyPlan(HARNESS_OTHER_USER, started.adaptationId),
      ];

      for (const op of ops) {
        const error = await failure(op());
        expect(statusOf(error)).toBe(404);
        expect(JSON.stringify(error.getResponse())).toBe(JSON.stringify((await failure(rig.service.get(HARNESS_OTHER_USER, randomUUID()))).getResponse()));
      }
      expect(rig.db.getAdaptation(started.adaptationId)!.status).toBe('queued');
    });

    it('cancel: a queued one is cancelled with its run; a repeat is idempotent', async () => {
      const started = await create();

      const first = await rig.service.cancel(HARNESS_USER, started.adaptationId);
      const again = await rig.service.cancel(HARNESS_USER, started.adaptationId);

      expect(first.status).toBe('cancelled');
      expect(again.status).toBe('cancelled');
      expect(rig.db.get(started.runId)!.status).toBe('cancelled');
      expect(rig.eventTypes(started.runId).filter((t) => t === 'run.cancelled')).toHaveLength(1);
    });

    it.each(['ready', 'failed', 'blocked_safety', 'applied', 'discarded'])('cancel of a %s adaptation is 409 ADAPTATION_NOT_CANCELLABLE', async (status) => {
      const started = await create();
      rig.db.getAdaptation(started.adaptationId)!.status = status;

      const error = await failure(rig.service.cancel(HARNESS_USER, started.adaptationId));

      expect(statusOf(error)).toBe(409);
      expect(detailsOf(error)).toEqual({ reason: 'ADAPTATION_NOT_CANCELLABLE', status });
      expect(rig.db.getAdaptation(started.adaptationId)!.status).toBe(status);
    });

    it('a cancel of a running adaptation asks the kit to stop it (the handler observes it) and leaves the status to the handler', async () => {
      const started = await create();
      rig.db.getAdaptation(started.adaptationId)!.status = 'running';
      rig.db.get(started.runId)!.status = 'running';

      const view = await rig.service.cancel(HARNESS_USER, started.adaptationId);

      expect(rig.db.get(started.runId)!.cancelRequestedAt).toBeInstanceOf(Date);
      expect(view.status).toBe('running');
    });

    it('discard: a ready adaptation becomes discarded; a repeat is idempotent', async () => {
      const started = await readyAdaptation();

      await rig.service.discard(HARNESS_USER, started.adaptationId);
      await rig.service.discard(HARNESS_USER, started.adaptationId);

      expect(rig.db.getAdaptation(started.adaptationId)!.status).toBe('discarded');
    });

    it('discard of a queued one cancels its run first', async () => {
      const started = await create();

      await rig.service.discard(HARNESS_USER, started.adaptationId);

      expect(rig.db.getAdaptation(started.adaptationId)!.status).toBe('discarded');
      expect(rig.db.get(started.runId)!.status).toBe('cancelled');
    });

    it('an applied adaptation cannot be discarded: 409 ADAPTATION_ALREADY_APPLIED', async () => {
      const started = await readyAdaptation();
      await rig.service.applyWorkout(HARNESS_USER, started.adaptationId);

      const error = await failure(rig.service.discard(HARNESS_USER, started.adaptationId));

      expect(statusOf(error)).toBe(409);
      expect(detailsOf(error)).toMatchObject({ reason: 'ADAPTATION_ALREADY_APPLIED', appliedAs: 'one_off' });
      expect(rig.db.getAdaptation(started.adaptationId)!.status).toBe('applied');
    });

    it('a discarded adaptation cannot be applied', async () => {
      const started = await readyAdaptation();
      await rig.service.discard(HARNESS_USER, started.adaptationId);

      for (const op of [rig.service.applyWorkout(HARNESS_USER, started.adaptationId), rig.service.applyPlan(HARNESS_USER, started.adaptationId)]) {
        expect(detailsOf(await failure(op))).toMatchObject({ reason: 'ADAPTATION_NOT_READY', status: 'discarded' });
      }
    });
  });

  describe('apply/workout (use it for today only)', () => {
    it.each(['queued', 'running', 'failed', 'cancelled', 'blocked_safety'])('refuses a %s adaptation: 409 ADAPTATION_NOT_READY', async (status) => {
      const started = await create();
      rig.db.getAdaptation(started.adaptationId)!.status = status;

      const error = await failure(rig.service.applyWorkout(HARNESS_USER, started.adaptationId));

      expect(statusOf(error)).toBe(409);
      expect(detailsOf(error)).toEqual({ reason: 'ADAPTATION_NOT_READY', status });
      expect(rig.workouts.startPrefilled).not.toHaveBeenCalled();
    });

    it('a row without a usable proposal is not applicable', async () => {
      const started = await create();
      Object.assign(rig.db.getAdaptation(started.adaptationId)!, { status: 'ready', proposal: { nonsense: true } });

      expect(reasonOf(await failure(rig.service.applyWorkout(HARNESS_USER, started.adaptationId)))).toBe('ADAPTATION_NOT_READY');
    });

    it('creates one in-progress workout for the server\'s today, prefilled in order, linked to the planned workout, noted "Adapted: ..."; the plan is untouched', async () => {
      const started = await readyAdaptation();
      const proposal = adaptedWorkoutSchema.parse(rig.db.getAdaptation(started.adaptationId)!.proposal);

      const result = await rig.service.applyWorkout(HARNESS_USER, started.adaptationId, new Date('2026-09-30T13:00:00.000Z'));

      expect(result).toEqual({ workoutId: expect.any(String), linkedToPlan: true, planChanged: false });
      expect(rig.workouts.startPrefilled).toHaveBeenCalledTimes(1);
      const input = rig.workouts.startPrefilled.mock.calls[0][2] as {
        name: string;
        date: string;
        gymId: string | null;
        programWorkoutId: string | null;
        exercises: Array<{ exerciseId: string; sets: Array<Record<string, unknown>> }>;
      };
      expect(input).toMatchObject({ name: proposal.title, date: '2026-09-30', gymId: ADAPT_GYM_ID, programWorkoutId: ADAPT_PROGRAM_WORKOUT_ID });
      expect(input.exercises.map((e) => e.exerciseId)).toEqual(proposal.exercises.map((e) => e.exerciseId));
      proposal.exercises.forEach((exercise, i) => expect(input.exercises[i].sets).toHaveLength(exercise.sets));
      expect(rig.created.notes.get(result.workoutId)).toBe('Adapted: 30 min, sore chest (mild)');
      expect(rig.created.sessions).toBe(1);
      expect(rig.programs.applyChange).not.toHaveBeenCalled();
      expect(rig.plan.currentVersion).toBe(3);
      expect(rig.db.getAdaptation(started.adaptationId)).toMatchObject({ status: 'applied', appliedAs: 'one_off', appliedWorkoutId: result.workoutId });
    });

    it('never asks the model for a load: kept lifts keep their plan rule, everything else starts blank', async () => {
      plannerAnswer = proposalAnswer([
        modelExercise('barbell_bench_press', { isPriority: true, sets: 3, repMin: 5, repMax: 8 }),
        modelExercise('dumbbell_row', { source: 'swapped', replacesExerciseKey: 'barbell_row', isPriority: true, sets: 3 }),
      ]);
      const started = await readyAdaptation({ minutes: 45 });

      await rig.service.applyWorkout(HARNESS_USER, started.adaptationId);

      const input = rig.workouts.startPrefilled.mock.calls[0][2] as { exercises: Array<{ exerciseId: string; sets: Array<{ weightKg?: number | null; targetWeightKg?: number | null } & Record<string, unknown>> }> };
      const bench = input.exercises.find((e) => e.exerciseId === LIB.barbell_bench_press.id)!;
      const row = input.exercises.find((e) => e.exerciseId === LIB.dumbbell_row.id)!;
      expect(JSON.stringify(bench.sets)).toContain('80');
      expect(JSON.stringify(row.sets)).not.toMatch(/"(weightKg|targetWeightKg)":[1-9]/);
    });

    it('is idempotent: a repeat answers the same workout and creates nothing new', async () => {
      const started = await readyAdaptation();

      const first = await rig.service.applyWorkout(HARNESS_USER, started.adaptationId);
      const again = await rig.service.applyWorkout(HARNESS_USER, started.adaptationId);

      expect(again).toEqual(first);
      expect(rig.workouts.startPrefilled).toHaveBeenCalledTimes(1);
      expect(rig.created.sessions).toBe(1);
    });

    it('the other mode after it succeeded is 409 ADAPTATION_ALREADY_APPLIED naming the workout', async () => {
      const started = await readyAdaptation();
      const { workoutId } = await rig.service.applyWorkout(HARNESS_USER, started.adaptationId);

      const error = await failure(rig.service.applyPlan(HARNESS_USER, started.adaptationId));

      expect(statusOf(error)).toBe(409);
      expect(detailsOf(error)).toEqual({ reason: 'ADAPTATION_ALREADY_APPLIED', appliedAs: 'one_off', workoutId });
      expect(rig.programs.applyChange).not.toHaveBeenCalled();
    });

    it('another workout in progress is 409 WORKOUT_IN_PROGRESS with its id; nothing is applied, and it works once that one is finished', async () => {
      const started = await readyAdaptation();
      rig.inProgressWorkoutId = randomUUID();

      const error = await failure(rig.service.applyWorkout(HARNESS_USER, started.adaptationId));

      expect(statusOf(error)).toBe(409);
      expect(detailsOf(error)).toEqual({ reason: 'WORKOUT_IN_PROGRESS', workoutId: rig.inProgressWorkoutId });
      expect(rig.db.getAdaptation(started.adaptationId)).toMatchObject({ status: 'ready', appliedAs: null, appliedWorkoutId: null });
      expect(rig.created.workouts).toHaveLength(0);

      rig.inProgressWorkoutId = null;
      await expect(rig.service.applyWorkout(HARNESS_USER, started.adaptationId)).resolves.toMatchObject({ linkedToPlan: true });
    });

    it('two taps at once: the loser of the in-progress index race is answered with the winner\'s workout, not "another workout is in progress"', async () => {
      const started = await readyAdaptation();
      const winnerWorkout = randomUUID();
      rig.workouts.startPrefilled.mockImplementationOnce(async () => {
        // The other tap committed first: this adaptation is applied to ITS workout, and the index refuses ours.
        Object.assign(rig.db.getAdaptation(started.adaptationId)!, { status: 'applied', appliedAs: 'one_off', appliedWorkoutId: winnerWorkout });
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      });

      const result = await rig.service.applyWorkout(HARNESS_USER, started.adaptationId);

      expect(result).toEqual({ workoutId: winnerWorkout, linkedToPlan: expect.any(Boolean), planChanged: false });
      expect(rig.created.workouts).toHaveLength(0);
    });

    describe('staleness: the guardrails run again against current data', () => {
      it('a gym that lost the equipment the request needs is 409 ADAPTATION_STALE (equipment_changed); nothing is created', async () => {
        const started = await readyAdaptation({ minutes: 30, equipment: onlyDumbbellsRequest().equipment });
        rig.source = { gym: { ...ADAPT_FULL_GYM, equipment: ADAPT_FULL_GYM.equipment.filter((e) => e.equipmentTypeId !== ET.dumbbells) } };

        const error = await failure(rig.service.applyWorkout(HARNESS_USER, started.adaptationId));

        expect(statusOf(error)).toBe(409);
        expect(detailsOf(error)).toMatchObject({ reason: 'ADAPTATION_STALE', findings: [{ code: 'equipment_changed' }] });
        expect(rig.workouts.startPrefilled).not.toHaveBeenCalled();
        expect(rig.db.getAdaptation(started.adaptationId)!.status).toBe('ready');
      });

      it('the gym as it is, minus what the proposal uses: equipment_changed for each exercise it can no longer support', async () => {
        const started = await readyAdaptation({ minutes: 30 });
        rig.source = { gym: { ...ADAPT_FULL_GYM, equipment: ADAPT_FULL_GYM.equipment.filter((e) => e.equipmentTypeId !== ET.dumbbells), capabilities: ADAPT_FULL_GYM.capabilities.filter((c) => c.equipmentTypeId !== ET.dumbbells) } };

        const error = await failure(rig.service.applyWorkout(HARNESS_USER, started.adaptationId));

        expect(reasonOf(error)).toBe('ADAPTATION_STALE');
        const findings = (detailsOf(error) as { findings: Array<{ code: string; exerciseKey: string }> }).findings;
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.every((f) => f.code === 'equipment_changed')).toBe(true);
      });

      it('an exercise deleted from the library since is exercise_unavailable', async () => {
        const started = await readyAdaptation();
        rig.library.loadLibrary.mockResolvedValueOnce(LIBRARY.filter((e) => e.key !== 'dumbbell_row'));

        const error = await failure(rig.service.applyWorkout(HARNESS_USER, started.adaptationId));

        expect(detailsOf(error)).toMatchObject({ reason: 'ADAPTATION_STALE', findings: [{ code: 'exercise_unavailable', exerciseKey: 'dumbbell_row' }] });
      });

      it('a pain flag logged since is pain_flagged (exclude, never "push through")', async () => {
        const started = await readyAdaptation();
        rig.source = { painFlagExerciseIds: [LIB.dumbbell_row.id] };

        const error = await failure(rig.service.applyWorkout(HARNESS_USER, started.adaptationId));

        expect(detailsOf(error)).toMatchObject({ reason: 'ADAPTATION_STALE', findings: [{ code: 'pain_flagged', exerciseKey: 'dumbbell_row' }] });
      });

      it('apply/plan re-checks the same way', async () => {
        const started = await readyAdaptation();
        rig.source = { painFlagExerciseIds: [LIB.dumbbell_row.id] };

        expect(reasonOf(await failure(rig.service.applyPlan(HARNESS_USER, started.adaptationId)))).toBe('ADAPTATION_STALE');
        expect(rig.programs.applyChange).not.toHaveBeenCalled();
      });
    });

    it('the planned workout changed since (a newer plan version): still allowed, with planChanged: true and no link to the old workout\'s prescription', async () => {
      const started = await readyAdaptation();
      rig.source = { planned: { ...adaptationSourceFixture().planned!, planVersion: 4 } };

      const result = await rig.service.applyWorkout(HARNESS_USER, started.adaptationId);

      expect(result.planChanged).toBe(true);
      expect(rig.db.getAdaptation(started.adaptationId)!.status).toBe('applied');
    });

    it('an ad-hoc adaptation (no base) starts an unlinked workout', async () => {
      rig.source = { planned: null };
      const started = await readyAdaptation({ minutes: 30, baseWorkout: 'none' });
      expect(rig.db.getAdaptation(started.adaptationId)!.baseRef).toBeNull();

      const result = await rig.service.applyWorkout(HARNESS_USER, started.adaptationId);

      expect(result).toEqual({ workoutId: expect.any(String), linkedToPlan: false, planChanged: false });
      expect((rig.workouts.startPrefilled.mock.calls[0][2] as { programWorkoutId: unknown }).programWorkoutId).toBeNull();
      expect(rig.created.sessions).toBe(0);
    });

    it('a planned workout that is gone from the active plan starts an unlinked workout rather than failing', async () => {
      const started = await readyAdaptation();
      rig.plan.linkable = false;

      const result = await rig.service.applyWorkout(HARNESS_USER, started.adaptationId);

      expect(result.linkedToPlan).toBe(false);
      expect((rig.workouts.startPrefilled.mock.calls[0][2] as { programWorkoutId: unknown }).programWorkoutId).toBeNull();
    });
  });

  describe('apply/plan (update my plan)', () => {
    it('a new plan version replaces only today\'s workout, with an AI change-log entry naming the adaptation', async () => {
      const started = await readyAdaptation();
      const proposal = adaptedWorkoutSchema.parse(rig.db.getAdaptation(started.adaptationId)!.proposal);

      const result = await rig.service.applyPlan(HARNESS_USER, started.adaptationId);

      expect(result).toEqual({ programId: ADAPT_PROGRAM_ID, planVersionId: expect.any(String), versionNumber: 4, changeLogId: rig.plan.changeLogId });
      expect(rig.programs.applyChange).toHaveBeenCalledTimes(1);
      const args = rig.programs.applyChange.mock.calls[0][0] as unknown as Record<string, unknown> & { summary: string; rationale: string };
      expect(args).toMatchObject({
        userId: HARNESS_USER,
        programId: ADAPT_PROGRAM_ID,
        expectedVersion: 3,
        origin: 'ai_adapt',
        actor: 'ai',
        kind: 'adapted',
        runId: started.runId,
        meta: { source: 'workout_adaptation', adaptationId: started.adaptationId, promptVersion: 1, models: { planner: { provider: 'openai' } } },
      });
      expect(args.summary).toBe("Adapted today's workout (30 min, sore chest (mild))");
      expect(args.rationale).toContain(proposal.summary);
      for (const line of proposal.rationale) expect(args.rationale).toContain(`- ${line}`);

      const workout = rig.plan.tree.blocks[0].weeks[0].workouts[0];
      expect(workout.exercises.map((e) => e.exerciseId)).toEqual(proposal.exercises.map((e) => e.exerciseId));
      expect(workout.estimatedMinutes).toBe(Math.max(1, proposal.estimatedMinutes));
      expect(rig.db.getAdaptation(started.adaptationId)).toMatchObject({ status: 'applied', appliedAs: 'plan_change', appliedPlanVersionId: result.planVersionId });
      expect(rig.workouts.startPrefilled).not.toHaveBeenCalled();
    });

    it('is idempotent: a repeat answers the same version without a second write', async () => {
      const started = await readyAdaptation();

      const first = await rig.service.applyPlan(HARNESS_USER, started.adaptationId);
      const again = await rig.service.applyPlan(HARNESS_USER, started.adaptationId);

      expect(again).toEqual(first);
      expect(rig.programs.applyChange).toHaveBeenCalledTimes(1);
    });

    it('the other mode after it succeeded is 409 ADAPTATION_ALREADY_APPLIED', async () => {
      const started = await readyAdaptation();
      const result = await rig.service.applyPlan(HARNESS_USER, started.adaptationId);

      const error = await failure(rig.service.applyWorkout(HARNESS_USER, started.adaptationId));

      expect(detailsOf(error)).toEqual({ reason: 'ADAPTATION_ALREADY_APPLIED', appliedAs: 'plan_change', planVersionId: result.planVersionId });
      expect(rig.workouts.startPrefilled).not.toHaveBeenCalled();
    });

    it('no base (ad hoc): 409 ADAPTATION_NO_BASE with a clear message, and "today only" still works', async () => {
      rig.source = { planned: null };
      const started = await readyAdaptation({ minutes: 30, baseWorkout: 'none' });

      const error = await failure(rig.service.applyPlan(HARNESS_USER, started.adaptationId));

      expect(statusOf(error)).toBe(409);
      expect(detailsOf(error)).toEqual({ reason: 'ADAPTATION_NO_BASE' });
      expect((error.getResponse() as { message: string }).message).toMatch(/no plan to update.*for today only/i);
      expect(rig.programs.applyChange).not.toHaveBeenCalled();
      expect(rig.db.getAdaptation(started.adaptationId)!.status).toBe('ready');
      await expect(rig.service.applyWorkout(HARNESS_USER, started.adaptationId)).resolves.toMatchObject({ linkedToPlan: false });
    });

    it('a plan with a newer version since is 409 ADAPTATION_STALE (plan_changed); the adaptation stays ready', async () => {
      const started = await readyAdaptation();
      rig.plan.currentVersion = 4;
      rig.planRow.currentVersion = 4;

      const error = await failure(rig.service.applyPlan(HARNESS_USER, started.adaptationId));

      expect(detailsOf(error)).toMatchObject({ reason: 'ADAPTATION_STALE', findings: [{ code: 'plan_changed' }] });
      expect(rig.programs.applyChange).not.toHaveBeenCalled();
      expect(rig.db.getAdaptation(started.adaptationId)).toMatchObject({ status: 'ready', appliedAs: null });
    });

    it('a plan that moves between the check and the write (stale-plan refusal) is ADAPTATION_STALE and releases the claim', async () => {
      const started = await readyAdaptation();
      const { HttpException, HttpStatus } = jest.requireActual('@nestjs/common') as typeof import('@nestjs/common');
      rig.programs.applyChange.mockRejectedValueOnce(new HttpException({ message: 'Stale', details: { reason: PROGRAM_REASONS.STALE_PLAN } }, HttpStatus.CONFLICT));

      const error = await failure(rig.service.applyPlan(HARNESS_USER, started.adaptationId));

      expect(reasonOf(error)).toBe('ADAPTATION_STALE');
      expect(rig.db.getAdaptation(started.adaptationId)).toMatchObject({ status: 'ready', appliedAs: null, appliedAt: null });
    });

    it('any other failure of the plan write propagates and releases the claim so the user can retry', async () => {
      const started = await readyAdaptation();
      rig.programs.applyChange.mockRejectedValueOnce(new Error('write failed'));

      await expect(rig.service.applyPlan(HARNESS_USER, started.adaptationId)).rejects.toThrow('write failed');

      expect(rig.db.getAdaptation(started.adaptationId)).toMatchObject({ status: 'ready', appliedAs: null });
      await expect(rig.service.applyPlan(HARNESS_USER, started.adaptationId)).resolves.toMatchObject({ versionNumber: 4 });
    });

    it('today\'s workout gone from the plan is ADAPTATION_STALE, not a crash', async () => {
      const started = await readyAdaptation();
      rig.plan.tree.blocks[0].weeks[0].workouts[0].id = randomUUID();

      const error = await failure(rig.service.applyPlan(HARNESS_USER, started.adaptationId));

      expect(reasonOf(error)).toBe('ADAPTATION_STALE');
      expect(rig.db.getAdaptation(started.adaptationId)!.status).toBe('ready');
    });
  });
});

// =============================================================================
// The pure helpers
// =============================================================================

describe('describeRequest and adaptedNote', () => {
  const snapshot = (names: string[]) => ({ version: 1 as const, sent: { request: { equipment: { names } } } as never, summary: { sections: [], dropped: [], excluded: [] } });

  it.each([
    [{ minutes: 30 }, null, '30 min'],
    [{ minutes: 30, soreness: { muscles: ['chest'], level: 'mild' } }, null, '30 min, sore chest (mild)'],
    [{ soreness: { muscles: ['upper_back', 'lats'], level: 'moderate' } }, null, 'sore upper back, lats (moderate)'],
    [{ lowEnergy: true }, null, 'low energy'],
    [{ equipment: { mode: 'bodyweight' } }, null, 'bodyweight only'],
    [{ equipment: { mode: 'only', equipmentTypeIds: [ET.dumbbells] } }, ['Dumbbells', 'Flat bench'], 'only dumbbells, flat bench'],
    [{ equipment: { mode: 'only', equipmentTypeIds: [ET.dumbbells] } }, null, 'limited equipment'],
    [{ gymId: randomUUID(), freeText: 'note' }, null, 'different gym, your note'],
    [{ minutes: 20, lowEnergy: true, equipment: { mode: 'bodyweight' } }, null, '20 min, low energy, bodyweight only'],
  ])('%j -> "%s"', (body, names, label) => {
    const request = adaptationRequestFixture(body as never);
    expect(describeRequest(request, names ? snapshot(names) : null)).toBe(label);
    expect(adaptedNote(request, names ? snapshot(names) : null)).toBe(`Adapted: ${label}`);
  });

  it('the free text itself is never in the label', () => {
    expect(describeRequest(adaptationRequestFixture({ freeText: 'SECRET-NOTE' }), null)).toBe('your note');
  });
});

describe('baseRefOf', () => {
  it('reads a stored base loosely and answers null for anything unusable', () => {
    expect(baseRefOf({ baseRef: null })).toBeNull();
    expect(baseRefOf({ baseRef: {} })).toBeNull();
    expect(baseRefOf({ baseRef: { planId: 'p', planWorkoutId: 'w' } })).toBeNull();
    expect(baseRefOf({ baseRef: { planId: 'p', planWorkoutId: 'w', planVersion: 3 } })).toEqual({ planId: 'p', planVersionId: null, planVersion: 3, planWorkoutId: 'w', date: '' });
  });
});

describe('replaceWorkout', () => {
  const proposal = () =>
    adaptedWorkoutSchema.parse({
      title: 'Upper A, 30',
      summary: 's',
      estimatedMinutes: 27,
      dropped: [],
      rationale: ['r'],
      uncertainty: [],
      exercises: [
        { exerciseId: LIB.dumbbell_bench_press.id, exerciseKey: 'dumbbell_bench_press', name: 'Dumbbell bench press', position: 0, source: 'swapped', replacesExerciseId: LIB.barbell_bench_press.id, replacesExerciseKey: 'barbell_bench_press', isPriority: true, sets: 3, repMin: 8, repMax: 10, targetRpe: 7.5, restSeconds: 90, note: 'Light, chest is sore', primaryMuscles: ['chest'], trackingMode: 'weight_reps' },
        { exerciseId: LIB.barbell_row.id, exerciseKey: 'barbell_row', name: 'Barbell row', position: 1, source: 'kept', replacesExerciseId: null, replacesExerciseKey: null, isPriority: true, sets: 3, repMin: 6, repMax: 10, targetRpe: 8, restSeconds: 120, note: null, primaryMuscles: ['lats'], trackingMode: 'weight_reps' },
      ],
    });

  it('replaces only the named workout; kept rows keep their id-bound load rules, new ones start without a load', () => {
    const tree = replaceWorkout(planTreeFixture(), ADAPT_PROGRAM_WORKOUT_ID, proposal());
    const workout = tree.blocks[0].weeks[0].workouts[0];

    expect(workout.exercises).toHaveLength(2);
    expect(workout.estimatedMinutes).toBe(27);
    expect(workout.exercises[0]).toMatchObject({ exerciseId: LIB.dumbbell_bench_press.id, position: 0, targetSets: 3, targetLoadKg: null, loadGuidance: 'from_history', rationale: 'Light, chest is sore' });
    const kept = workout.exercises[1];
    expect(kept).toMatchObject({ exerciseId: LIB.barbell_row.id, position: 1, targetSets: 3, repMin: 6, repMax: 10, restSeconds: 120 });
  });

  it('a kept exercise\'s prescription (load) survives; nothing else in the tree changes', () => {
    const before = planTreeFixture();
    const bench = before.blocks[0].weeks[0].workouts[0].exercises.find((e) => e.exerciseId === LIB.barbell_bench_press.id)!;
    const kept = adaptedWorkoutSchema.parse({ ...proposal(), exercises: [{ ...proposal().exercises[1], exerciseId: LIB.barbell_bench_press.id, exerciseKey: 'barbell_bench_press', name: 'Barbell bench press', sets: 3 }] });

    const tree = replaceWorkout(before, ADAPT_PROGRAM_WORKOUT_ID, kept);
    const workout = tree.blocks[0].weeks[0].workouts[0];

    expect(workout.exercises[0].targetLoadKg).toBe(bench.targetLoadKg);
    expect(workout.name).toBe('Upper A');
    expect(workout.weekday).toBe(3);
  });

  it('a workout that is not in the plan throws (the service turns it into ADAPTATION_STALE)', () => {
    expect(() => replaceWorkout(planTreeFixture(), randomUUID(), proposal())).toThrow(/no longer in the plan/);
  });
});

describe('toAdaptationView', () => {
  const base = () => ({
    id: randomUUID(),
    status: 'ready',
    request: { minutes: 30 },
    gymId: null,
    baseRef: null,
    proposal: null,
    guardrailReport: {},
    criticReport: null,
    safety: {},
    contextSnapshot: {},
    models: {},
    runId: null,
    jobId: null,
    errorCode: null,
    errorMessage: null,
    appliedAs: null,
    appliedWorkoutId: null,
    appliedPlanVersionId: null,
    appliedAt: null,
    expiresAt: new Date('2026-10-30T12:00:00.000Z'),
    createdAt: new Date('2026-09-30T12:00:00.000Z'),
    updatedAt: new Date('2026-09-30T12:01:00.000Z'),
    userId: randomUUID(),
  });

  it('tolerates the empty defaults of a fresh row: nulls, not crashes', () => {
    const view = toAdaptationView(base() as never);

    expect(view).toMatchObject({ proposal: null, guardrailReport: null, criticReport: null, safety: null, sentData: null, models: { planner: null, critic: null }, guidance: null, stage: null, appliedAt: null });
    expect(view.expiresAt).toBe('2026-10-30T12:00:00.000Z');
    expect(view.createdAt).toBe('2026-09-30T12:00:00.000Z');
  });

  it('never carries the owner id, and a blocked adaptation shows the fixed guidance', () => {
    const view = toAdaptationView({ ...base(), status: 'blocked_safety' } as never);

    expect(view.guidance).toBe(SAFETY_STOP_GUIDANCE);
    expect(JSON.stringify(view)).not.toContain('userId');
  });

  it('reads the model refs, the safety level and the guardrail report when present', () => {
    const view = toAdaptationView(
      {
        ...base(),
        models: { planner: { provider: 'openai', modelId: 'm1' }, critic: { provider: 'openai' } },
        safety: { level: 'conservative', reasons: ['readiness:low_energy'] },
        guardrailReport: { repairs: [], rejected: [], estimatedMinutes: 20, fitsRequest: true, promptVersion: 1, warnings: [] },
      } as never,
      'critic',
    );

    expect(view.models).toEqual({ planner: { provider: 'openai', modelId: 'm1' }, critic: null });
    expect(view.safety).toEqual({ level: 'conservative', reasons: ['readiness:low_energy'] });
    expect(view.guardrailReport).toMatchObject({ estimatedMinutes: 20 });
    expect(view.stage).toBe('critic');
  });

  it('an invalid stored safety level is dropped, and an invalid proposal is null', () => {
    const view = toAdaptationView({ ...base(), safety: { level: 'catastrophic' }, proposal: { nope: 1 } } as never);

    expect(view.safety).toBeNull();
    expect(view.proposal).toBeNull();
  });
});

