// =============================================================================
// AI kill switch — cross-cutting conformance (issue #435, epic #419)
// =============================================================================
//
// The invariant: with `ai.enabled = false`, EVERY route under `/api/ai/*`
// except `GET /api/ai/config` answers 403 `AI_DISABLED`, `GET /api/ai/config`
// itself stays reachable (it is how a client LEARNS AI is off), and every
// route under `/api/admin/ai/*` stays reachable (an administrator must always
// be able to turn the platform back on).
//
// THE ROUTE LIST IS DISCOVERED, NEVER HAND-WRITTEN — the same tripwire shape
// as `test/jobs/cron-enqueue-only.spec.ts`. `createOpenApiDocument` reflects on
// the real Nest router, so a future `/api/ai/foo` route added without
// `@UseGuards(AiEnabledGuard)` (or a future `/api/admin/ai/foo` accidentally
// given that guard) fails this suite the moment it is registered — nobody has
// to remember to add it to a list here. (Proof: add an ungated
// `@Get('ai/foo')` to `AiResponsesController` on a scratch branch and the
// "every /api/ai/* route enforces the kill switch" case below fails on it by
// name, with no other change to this file.)
//
// GUARD ORDER. `AiEnabledGuard` is applied at CONTROLLER level and `@Auth()`'s
// guards at METHOD level; Nest runs class guards before method guards, so the
// kill switch answers even an UNAUTHENTICATED caller with 403 `AI_DISABLED`
// rather than 401 — see `ai-enabled.guard.ts`'s own header for why that is
// deliberate. This suite therefore sends no Authorization header at all for
// the disabled-state checks: the guard must already have answered by the time
// any credential would matter.
//
// JOB TYPES. Every `Job.type` beginning with `ai.` is discovered from
// `JobHandlerRegistry.types()` (never hand-listed either) and driven through
// its handler directly with AI disabled, proving no adapter call is made — a
// user's or the deployment's provider key must never be spent while the
// platform is switched off.
// =============================================================================

import request from 'supertest';

import { createOpenApiDocument } from '../../src/openapi/document';
import { forEachOperation, MutableDocument } from '../../src/openapi/types';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { AiProviderRegistry } from '../../src/ai/core';
import { createMockTestUser, createMockViewerUser, authHeader } from '../helpers/auth-mock.helper';
import { HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { createAiHttpTestApp, type AiHttpTestApp } from './ai-http.helper';

interface AiRoute {
  path: string;
  method: string;
}

/** `{provider}` -> `test-value`, `{id}` -> `test-value`, etc. — the guard runs before any pipe reads these. */
function concretePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, 'test-value');
}

describe('AI kill switch — cross-cutting conformance (#435)', () => {
  let app: AiHttpTestApp;
  let aiRoutes: AiRoute[];
  let adminAiRoutes: AiRoute[];

  beforeAll(async () => {
    app = await createAiHttpTestApp();

    const document = createOpenApiDocument(app.context.app) as unknown as MutableDocument;
    aiRoutes = [];
    adminAiRoutes = [];

    // The AI Coach (docs/specs/ai-coach.md §3.6) follows the same rule: its
    // consumer routes `/api/coach/*` are kill-switched, its admin routes
    // `/api/admin/coach/*` are not.
    const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
    forEachOperation(document, (_operation, path, method) => {
      if (under(path, '/api/admin/ai') || under(path, '/api/admin/coach')) {
        adminAiRoutes.push({ path, method: method.toUpperCase() });
      } else if (under(path, '/api/ai') || under(path, '/api/coach')) {
        aiRoutes.push({ path, method: method.toUpperCase() });
      }
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    app.reset();
  });

  it('discovers a non-trivial, non-vacuous route set', () => {
    // Guards against a broken scan silently passing every case below because
    // it found nothing to check.
    expect(aiRoutes.length).toBeGreaterThanOrEqual(10);
    expect(adminAiRoutes.length).toBeGreaterThanOrEqual(5);
    expect(aiRoutes).toEqual(
      expect.arrayContaining([
        { path: '/api/ai/config', method: 'GET' },
        { path: '/api/coach/settings', method: 'PUT' },
      ]),
    );
    expect(adminAiRoutes).toEqual(expect.arrayContaining([{ path: '/api/admin/coach/settings', method: 'PUT' }]));
  });

  describe('while ai.enabled = false', () => {
    beforeEach(() => {
      app.harness.setPolicy({ enabled: false });
    });

    it('every /api/ai/* route except GET /api/ai/config answers 403 AI_DISABLED, unauthenticated', async () => {
      const failures: string[] = [];

      for (const route of aiRoutes) {
        if (route.path === '/api/ai/config' && route.method === 'GET') continue;

        const res = await request(app.context.app.getHttpServer())
          [route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](
            concretePath(route.path),
          )
          .send({});

        if (res.status !== 403 || res.body?.code !== 'FORBIDDEN' || res.body?.details?.reason !== 'AI_DISABLED') {
          failures.push(
            `${route.method} ${route.path}: status=${res.status} code=${res.body?.code} reason=${res.body?.details?.reason}`,
          );
        }
      }

      expect(failures).toEqual([]);
    });

    it('GET /api/ai/config stays reachable and reports enabled:false — it is how a client learns AI is off', async () => {
      const viewer = await createMockViewerUser(app.context);

      const res = await request(app.context.app.getHttpServer())
        .get('/api/ai/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data.enabled).toBe(false);
      expect(res.body.data.providers).toEqual([]);
    });

    it('every /api/admin/ai/* route stays reachable — an admin must always be able to turn AI back on', async () => {
      const failures: string[] = [];

      for (const route of adminAiRoutes) {
        const res = await request(app.context.app.getHttpServer())
          [route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](
            concretePath(route.path),
          )
          .send({});

        // No Authorization header at all: the ONLY thing being proved here is
        // that nothing answers with the kill switch's own 403/AI_DISABLED —
        // an unauthenticated 401 is exactly the evidence that no
        // `AiEnabledGuard` sits in front of this route, because that guard
        // would have answered 403 first (see the guard-order note above).
        if (res.status === 403 && res.body?.details?.reason === 'AI_DISABLED') {
          failures.push(`${route.method} ${route.path}: blocked by the kill switch (${res.status})`);
        } else if (res.status !== 401) {
          failures.push(`${route.method} ${route.path}: expected 401 (not kill-switched), got ${res.status}`);
        }
      }

      expect(failures).toEqual([]);
    });
  });

  describe('while ai.enabled = true', () => {
    it('GET /api/ai/config reports enabled:true, so the disabled-state assertions above are not vacuously true', async () => {
      const viewer = await createMockViewerUser(app.context);

      const res = await request(app.context.app.getHttpServer())
        .get('/api/ai/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data.enabled).toBe(true);
    });

    it('a real ai:use route succeeds — the guard denies for the right reason, not indiscriminately', async () => {
      // HARNESS_USER, not an arbitrary mock user: the harness only seeds a
      // provider key for this id, and a caller with no key gets `AI_KEY_REQUIRED`
      // rather than the 200 this case is trying to prove. `roleName:
      // 'contributor'`, not 'viewer' (#499): Viewer no longer holds `ai:use`.
      const holder = await createMockTestUser(app.context, { id: HARNESS_USER, roleName: 'contributor' });

      await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holder.accessToken))
        .send({ model: 'fake-model', input: 'hello' })
        .expect(200);
    });
  });

  describe('every ai.* job type makes zero provider calls while AI is disabled', () => {
    // Job types are DISCOVERED from the registry, never hand-listed. If a new
    // `ai.*` handler is added with no entry here, the sanity check below names
    // it and fails loudly rather than silently skipping it.
    const KNOWN_AI_JOB_PAYLOADS: Record<string, unknown> = {
      'ai.response.run': null, // filled in per-test: needs a live run row
      'ai.image.generate': null, // filled in per-test: needs a live image run row (#437)
      'ai.audio.transcribe': null, // filled in per-test: needs a live transcription run row (#438)
      'ai.audio.speech': null, // filled in per-test: needs a live speech run row (#439)
      'ai.catalog.refresh': { providerId: 'openai' },
      'ai.keys.recheck': { provider: 'openai' },
      'ai.usage.purge': {},
      // E2.6 (#64): reads a scale/cuff display off a photo intake; filled in per-test.
      'ai.health.body_metric_reading': null,
      // H4 (#188): transcribes a lab report off a lab_report intake; filled in per-test.
      'ai.health.lab_report': null,
      // H8 (#192): the opt-in health summary for the training planner; filled in per-test.
      'ai.health.summary': null,
      'ai.equipment.scan': null, // filled in per-test: needs a scanning gym_equipment intake (E3.4)
      'ai.workout.prefill': null, // filled in per-test: needs a scanning workout_prefill intake (E4.5)
      'ai.training.plan.run': null, // filled in per-test: needs a queued training_plan_runs row (E5.3)
      'ai.training.adapt.run': null, // filled in per-test: needs a queued workout_adaptations row and its run (E6.1)
      // E7.5 (#245): one coach nudge for a planned moment; filled in per-test.
      'ai.coach.nudge': null,
    };

    let registry: JobHandlerRegistry;
    let aiJobTypes: string[];

    beforeAll(() => {
      registry = app.context.app.get(JobHandlerRegistry);
      aiJobTypes = registry.types().filter((type) => type.startsWith('ai.'));
    });

    it('finds the ai.* job types at all, so a broken discovery cannot pass vacuously', () => {
      expect(aiJobTypes.length).toBeGreaterThanOrEqual(3);
    });

    it('has a payload fixture for every discovered ai.* type', () => {
      const unknown = aiJobTypes.filter((type) => !(type in KNOWN_AI_JOB_PAYLOADS));
      expect(unknown).toEqual([]);
    });

    it('ai.response.run: disabled makes zero provider calls, run fails with AI_DISABLED, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.response.run');
      expect(handler).toBeDefined();

      // Build the run the way `AiRunsService.get`/queueing would: pending,
      // owned by the harness user, carrying a storable request.
      const created = await app.harness.prisma.aiRun.create({
        data: {
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: 'fake-model',
          status: 'pending',
          // Must satisfy `storedAiRunRequestSchema` (`ai-run-request.ts`):
          // `fromStoredRunRequest` parses this BEFORE the handler ever calls
          // `AiService`, so a malformed stub would fail with
          // `AI_INVALID_REQUEST` before the kill switch is ever consulted.
          request: { provider: 'openai', model: 'fake-model', input: 'hello' },
        },
      });

      await handler!.process({ id: 'job-kill-switch', payload: { runId: created.id } } as never);

      expect(app.harness.fake.calls).toEqual([]);
      const stored = app.harness.runRows.find((r) => r.id === created.id);
      expect(stored?.status).toBe('failed');
      expect(stored?.errorCode).toBe('AI_DISABLED');
    });

    it('ai.image.generate: disabled makes zero provider calls and writes no storage, run fails with AI_DISABLED, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.image.generate');
      expect(handler).toBeDefined();

      // A stored image run the way `generateImage` writes one: the handler
      // parses it with `parseStoredImageRunRequest` before any gate, so a
      // malformed stub would fail AI_INVALID_REQUEST without ever reaching
      // the kill switch.
      const created = await app.harness.prisma.aiRun.create({
        data: {
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: 'fake-image-model',
          status: 'pending',
          request: { operation: 'images.generate', provider: 'openai', model: 'fake-image-model', prompt: 'hello' },
        },
      });

      await handler!.process({ id: 'job-kill-switch', payload: { runId: created.id } } as never);

      expect(app.harness.fake.calls).toEqual([]);
      expect(app.harness.storage.provider.upload).not.toHaveBeenCalled();
      const stored = app.harness.runRows.find((r) => r.id === created.id);
      expect(stored?.status).toBe('failed');
      expect(stored?.errorCode).toBe('AI_DISABLED');
    });

    it('ai.audio.transcribe: disabled makes zero provider calls and reads no recording, run fails with AI_DISABLED, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.audio.transcribe');
      expect(handler).toBeDefined();

      const recording = app.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'audio/mpeg' });
      (app.harness.storage.provider.download as jest.Mock).mockClear();

      // A stored transcription run the way `transcribe` writes one (#438): the
      // handler parses it before any gate, so a malformed stub would fail
      // AI_INVALID_REQUEST without ever reaching the kill switch.
      const created = await app.harness.prisma.aiRun.create({
        data: {
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: 'fake-transcription-model',
          status: 'pending',
          request: {
            operation: 'audio.transcribe',
            provider: 'openai',
            model: 'fake-transcription-model',
            storageObjectId: recording.id,
          },
        },
      });

      await handler!.process({ id: 'job-kill-switch', payload: { runId: created.id } } as never);

      expect(app.harness.fake.calls).toEqual([]);
      expect(app.harness.storage.provider.download).not.toHaveBeenCalled();
      const stored = app.harness.runRows.find((r) => r.id === created.id);
      expect(stored?.status).toBe('failed');
      expect(stored?.errorCode).toBe('AI_DISABLED');
    });

    it('ai.audio.speech: disabled makes zero provider calls and writes no storage, run fails with AI_DISABLED, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.audio.speech');
      expect(handler).toBeDefined();
      (app.harness.storage.provider.upload as jest.Mock).mockClear();

      // A stored speech run the way `speak` writes one (#439), voice and
      // format resolved, so the kill switch is what refuses it.
      const created = await app.harness.prisma.aiRun.create({
        data: {
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: 'fake-speech-model',
          status: 'pending',
          request: {
            operation: 'audio.speech',
            provider: 'openai',
            model: 'fake-speech-model',
            input: 'hello',
            voice: 'alloy',
            format: 'mp3',
          },
        },
      });

      await handler!.process({ id: 'job-kill-switch', payload: { runId: created.id } } as never);

      expect(app.harness.fake.calls).toEqual([]);
      expect(app.harness.storage.provider.upload).not.toHaveBeenCalled();
      const stored = app.harness.runRows.find((r) => r.id === created.id);
      expect(stored?.status).toBe('failed');
      expect(stored?.errorCode).toBe('AI_DISABLED');
    });

    it('ai.health.body_metric_reading: disabled makes zero provider calls, intake fails with AI_DISABLED, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.health.body_metric_reading');
      expect(handler).toBeDefined();

      const photo = app.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'image/jpeg' });
      (app.harness.storage.provider.download as jest.Mock).mockClear();
      const intakeId = '99999999-9999-4999-8999-999999999999';
      const prisma = app.context.prismaMock as any;

      // A `scanning` intake the way `POST /api/intakes/:id/analyze` leaves it.
      prisma.photoIntake.findUnique.mockResolvedValueOnce({
        id: intakeId,
        userId: HARNESS_USER,
        kind: 'body_metric_reading',
        status: 'scanning',
        provider: 'openai',
        modelId: 'fake-model',
        jobId: 'job-kill-switch',
        photos: [{ storageObjectId: photo.id }],
      });
      prisma.photoIntake.updateMany.mockResolvedValueOnce({ count: 1 });

      await expect(
        handler!.process({ id: 'job-kill-switch', payload: { intakeId } } as never),
      ).resolves.toBeUndefined();

      expect(app.harness.fake.calls).toEqual([]);
      expect(app.harness.storage.provider.download).not.toHaveBeenCalled();
      expect(prisma.draftItem.createMany).not.toHaveBeenCalled();
      expect(prisma.photoIntake.updateMany).toHaveBeenCalledWith({
        where: { id: intakeId, status: 'scanning' },
        data: expect.objectContaining({ status: 'failed', errorCode: 'AI_DISABLED' }),
      });
    });

    it('ai.health.lab_report: disabled makes zero provider calls, intake fails with AI_DISABLED, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.health.lab_report');
      expect(handler).toBeDefined();

      const report = app.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'application/pdf' });
      (app.harness.storage.provider.download as jest.Mock).mockClear();
      const intakeId = '99999999-9999-4999-8999-999999999999';
      const prisma = app.context.prismaMock as any;

      // A `scanning` intake the way `POST /api/intakes/:id/analyze` leaves it.
      prisma.photoIntake.findUnique.mockResolvedValueOnce({
        id: intakeId,
        userId: HARNESS_USER,
        kind: 'lab_report',
        status: 'scanning',
        provider: 'openai',
        modelId: 'fake-model',
        jobId: 'job-kill-switch',
        context: null,
        photos: [{ storageObjectId: report.id, storageObject: { mimeType: 'application/pdf' } }],
      });
      prisma.photoIntake.updateMany.mockResolvedValueOnce({ count: 1 });

      await expect(
        handler!.process({ id: 'job-kill-switch', payload: { intakeId } } as never),
      ).resolves.toBeUndefined();

      expect(app.harness.fake.calls).toEqual([]);
      expect(app.harness.storage.provider.download).not.toHaveBeenCalled();
      expect(prisma.draftItem.createMany).not.toHaveBeenCalled();
      expect(prisma.photoIntake.updateMany).toHaveBeenCalledWith({
        where: { id: intakeId, status: 'scanning' },
        data: expect.objectContaining({ status: 'failed', errorCode: 'AI_DISABLED' }),
      });
    });

    it('ai.health.summary: disabled makes zero provider calls, records a failed AI_DISABLED version, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.health.summary');
      expect(handler).toBeDefined();
      const prisma = app.context.prismaMock as any;

      // Consent on and health data present, so the kill switch is what refuses it.
      prisma.healthSummarySetting.findUnique.mockResolvedValueOnce({ enabled: true });
      prisma.healthProfile.findUnique.mockResolvedValueOnce(null);
      prisma.measurement.findMany.mockResolvedValue([
        {
          metricKey: 'weight',
          value: 80,
          measuredAt: new Date('2026-09-30T08:00:00Z'),
          localDate: null,
          flag: null,
          referenceLow: null,
          referenceHigh: null,
        },
      ]);
      prisma.healthSummary.findFirst.mockResolvedValue(null);
      prisma.healthSummary.create.mockResolvedValue({});

      await expect(
        handler!.process({
          id: 'job-kill-switch',
          type: 'ai.health.summary',
          subjectType: 'health_summary',
          subjectId: HARNESS_USER,
          payload: {},
        } as never),
      ).resolves.toBeUndefined();

      expect(app.harness.fake.calls).toEqual([]);
      expect(prisma.healthSummary.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: HARNESS_USER, status: 'failed', errorCode: 'AI_DISABLED', narrative: null }),
      });
    });

    it('ai.equipment.scan: disabled makes zero provider calls and reads no photo, intake fails with AI_DISABLED, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.equipment.scan');
      expect(handler).toBeDefined();

      const photo = app.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'image/jpeg' });
      (app.harness.storage.provider.download as jest.Mock).mockClear();
      const intakeId = '99999999-9999-4999-8999-999999999999';
      const prisma = app.context.prismaMock;

      // A `scanning` intake the way `POST /intakes/:id/analyze` leaves it, and
      // a one-row vocabulary, so the kill switch is what refuses the scan.
      (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValue({
        id: intakeId,
        userId: HARNESS_USER,
        kind: 'gym_equipment',
        status: 'scanning',
        provider: 'openai',
        modelId: 'fake-model',
        photos: [{ storageObjectId: photo.id }],
      });
      (prisma.capability.findMany as jest.Mock).mockResolvedValue([
        { slug: 'leg_curl', name: 'Leg curl', movementPattern: 'isolation', primaryMuscles: ['hamstrings'] },
      ]);
      (prisma.equipmentType.findMany as jest.Mock).mockResolvedValue([
        {
          slug: 'leg_curl_machine',
          name: 'Leg curl machine',
          category: 'selectorized',
          aliases: [],
          capabilities: [{ capability: { slug: 'leg_curl' } }],
        },
      ]);
      (prisma.photoIntake.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await expect(
        handler!.process({ id: 'job-kill-switch', type: 'ai.equipment.scan', payload: { intakeId } } as never),
      ).resolves.toBeUndefined();

      expect(app.harness.fake.calls).toEqual([]);
      expect(app.harness.storage.provider.download).not.toHaveBeenCalled();
      expect(prisma.photoIntake.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: intakeId, status: 'scanning' },
          data: expect.objectContaining({ status: 'failed', errorCode: 'AI_DISABLED' }),
        }),
      );
      expect(prisma.draftItem.createMany).not.toHaveBeenCalled();
    });

    it('ai.workout.prefill: disabled makes zero provider calls and reads no photo, intake fails with AI_DISABLED, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.workout.prefill');
      expect(handler).toBeDefined();

      const photo = app.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'image/jpeg' });
      (app.harness.storage.provider.download as jest.Mock).mockClear();
      const intakeId = '99999999-9999-4999-8999-999999999999';
      const prisma = app.context.prismaMock;

      // A `scanning` intake the way `POST /intakes/:id/analyze` leaves it, and
      // a one-row exercise vocabulary, so the kill switch is what refuses it.
      (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValue({
        id: intakeId,
        userId: HARNESS_USER,
        kind: 'workout_prefill',
        status: 'scanning',
        provider: 'openai',
        modelId: 'fake-model',
        context: { workoutId: '88888888-8888-4888-8888-888888888888', sourceHint: 'notebook' },
        photos: [{ storageObjectId: photo.id }],
      });
      (prisma.healthProfile.findUnique as jest.Mock).mockResolvedValue({ unitSystem: 'imperial' });
      (prisma.exercise.findMany as jest.Mock).mockResolvedValue([{ slug: 'leg_curl', name: 'Leg curl', aliases: [] }]);
      (prisma.photoIntake.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await expect(
        handler!.process({ id: 'job-kill-switch', type: 'ai.workout.prefill', payload: { intakeId } } as never),
      ).resolves.toBeUndefined();

      expect(app.harness.fake.calls).toEqual([]);
      expect(app.harness.storage.provider.download).not.toHaveBeenCalled();
      expect(prisma.photoIntake.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: intakeId, status: 'scanning' },
          data: expect.objectContaining({ status: 'failed', errorCode: 'AI_DISABLED' }),
        }),
      );
      expect(prisma.draftItem.createMany).not.toHaveBeenCalled();
      expect(prisma.workoutExercise.create).not.toHaveBeenCalled();
      expect(prisma.setLog.createMany).not.toHaveBeenCalled();
    });

    it('ai.training.plan.run: disabled makes zero provider calls, run fails with AI_DISABLED, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.training.plan.run');
      expect(handler).toBeDefined();

      const runId = '77777777-7777-4777-8777-777777777777';
      const prisma = app.context.prismaMock;

      // A `queued` run the way `POST /api/ai/training/runs` leaves it, so the
      // kill switch is what refuses it before any graph or provider call.
      (prisma.trainingPlanRun.findUnique as jest.Mock).mockResolvedValue({
        id: runId,
        userId: HARNESS_USER,
        kind: 'create',
        trigger: 'user',
        status: 'queued',
        programId: null,
        jobId: 'job-kill-switch',
        jobIds: ['job-kill-switch'],
        input: { request: {}, maxCriticRounds: 2 },
        roleModels: {
          planner: { provider: 'openai', modelId: 'fake-model', effort: 'medium', keySource: 'user' },
        },
        tokenCap: 100_000,
        usage: {},
        cancelRequestedAt: null,
        resumeCount: 0,
        startedAt: null,
      });
      (prisma.trainingPlanRun.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await expect(
        handler!.process({
          id: 'job-kill-switch',
          type: 'ai.training.plan.run',
          subjectType: 'training_run',
          subjectId: runId,
          payload: { runId },
        } as never),
      ).resolves.toBeUndefined();

      expect(app.harness.fake.calls).toEqual([]);
      expect(prisma.trainingPlanRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: runId, status: { in: ['queued'] } },
          data: expect.objectContaining({ status: 'failed', errorCode: 'AI_DISABLED' }),
        }),
      );
      // It never moved to `running`.
      expect(prisma.trainingPlanRun.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'running' }) }),
      );
    });

    it('ai.training.adapt.run: disabled makes zero provider calls, adaptation fails with AI_DISABLED, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.training.adapt.run');
      expect(handler).toBeDefined();

      const adaptationId = '88888888-8888-4888-8888-888888888888';
      const runId = '99999999-9999-4999-8999-999999999999';
      const prisma = app.context.prismaMock;

      // A `queued` adaptation and its `adapt` run, the way `POST /api/ai/training/adaptations` leaves them.
      (prisma.workoutAdaptation.findUnique as jest.Mock).mockResolvedValue({
        id: adaptationId,
        userId: HARNESS_USER,
        status: 'queued',
        request: { minutes: 30, useReadiness: true, baseWorkout: 'planned' },
        runId,
        jobId: 'job-kill-switch',
      });
      (prisma.trainingPlanRun.findUnique as jest.Mock).mockResolvedValue({
        id: runId,
        userId: HARNESS_USER,
        kind: 'adapt',
        trigger: 'user',
        status: 'queued',
        jobId: 'job-kill-switch',
        jobIds: ['job-kill-switch'],
        input: { request: { adaptationId }, maxCriticRounds: 1 },
        roleModels: {
          planner: { provider: 'openai', modelId: 'fake-model', effort: 'medium', keySource: 'user' },
          critic: { provider: 'openai', modelId: 'fake-model', effort: 'medium', keySource: 'user' },
        },
        tokenCap: 100_000,
        usage: {},
        cancelRequestedAt: null,
        resumeCount: 0,
        startedAt: null,
      });
      (prisma.workoutAdaptation.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.trainingPlanRun.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await expect(
        handler!.process({
          id: 'job-kill-switch',
          type: 'ai.training.adapt.run',
          subjectType: 'training_adaptation',
          subjectId: adaptationId,
          payload: { adaptationId },
        } as never),
      ).resolves.toBeUndefined();

      expect(app.harness.fake.calls).toEqual([]);
      expect(prisma.workoutAdaptation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: adaptationId, status: { in: ['queued'] } },
          data: expect.objectContaining({ status: 'failed', errorCode: 'AI_DISABLED' }),
        }),
      );
      // It never moved to `running`.
      expect(prisma.workoutAdaptation.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'running' }) }),
      );
    });

    it('ai.coach.nudge: disabled makes zero provider calls, persists and delivers nothing, job does not throw', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.coach.nudge');
      expect(handler).toBeDefined();
      const prisma = app.context.prismaMock as any;
      prisma.coachMessage.create.mockClear();

      await expect(
        handler!.process({
          id: 'job-kill-switch',
          type: 'ai.coach.nudge',
          subjectType: 'user',
          subjectId: HARNESS_USER,
          payload: {
            userId: HARNESS_USER,
            moment: 'missed_twice',
            momentKey: 'missed_twice:2026-10-01',
            candidates: [{ moment: 'missed_twice', priority: 1, reason: 'missed_streak' }],
            trigger: 'sweep',
          },
        } as never),
      ).resolves.toBeUndefined();

      expect(app.harness.fake.calls).toEqual([]);
      expect(prisma.coachMessage.create).not.toHaveBeenCalled();
    });

    it('ai.catalog.refresh: disabled never reaches the provider registry', async () => {
      app.harness.setPolicy({ enabled: false });

      const handler = registry.get('ai.catalog.refresh');
      expect(handler).toBeDefined();

      const providerRegistry = app.context.app.get(AiProviderRegistry);
      const getSpy = jest.spyOn(providerRegistry, 'get');

      await expect(
        handler!.process({ id: 'job-kill-switch', payload: { providerId: 'openai' } } as never),
      ).resolves.toBeUndefined();

      expect(getSpy).not.toHaveBeenCalled();
      getSpy.mockRestore();
    });

    it('ai.keys.recheck: disabled never reaches the provider registry', async () => {
      app.harness.setPolicy({ enabled: false });

      // One stale row, so `recheckStale` actually enters `recheckReachable` —
      // where `assertProviderEnabled` throws AI_DISABLED before the adapter is
      // ever looked up (`providerContext`, user-ai-keys.service.ts). Without a
      // row the sweep would exit on an empty page having proven nothing.
      (app.context.prismaMock.userAiKey.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'stale-key-1', userId: HARNESS_USER },
      ]);

      const handler = registry.get('ai.keys.recheck');
      expect(handler).toBeDefined();

      const providerRegistry = app.context.app.get(AiProviderRegistry);
      const getSpy = jest.spyOn(providerRegistry, 'get');

      await expect(
        handler!.process({ id: 'job-kill-switch', payload: { provider: 'openai' } } as never),
      ).resolves.toBeUndefined();

      expect(getSpy).not.toHaveBeenCalled();
      getSpy.mockRestore();
    });

    it('ai.usage.purge: makes no provider call, and still purges while AI is off (retention is not AI use)', async () => {
      app.harness.setPolicy({ enabled: false });

      const settings = app.context.app.get(SystemSettingsService);
      jest.spyOn(settings, 'getAiPolicy').mockResolvedValueOnce({
        ...DEFAULT_SYSTEM_SETTINGS.ai,
        usageRetentionDays: 180,
      });
      (app.context.prismaMock.aiUsageEvent.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'old-1' }]);
      (app.context.prismaMock.aiUsageEvent.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

      const handler = registry.get('ai.usage.purge');
      expect(handler).toBeDefined();

      const providerRegistry = app.context.app.get(AiProviderRegistry);
      const getSpy = jest.spyOn(providerRegistry, 'get');

      await expect(
        handler!.process({ id: 'job-kill-switch', payload: {} } as never),
      ).resolves.toBeUndefined();

      expect(getSpy).not.toHaveBeenCalled();
      expect(app.harness.fake.calls).toEqual([]);
      expect(app.context.prismaMock.aiUsageEvent.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['old-1'] } },
      });
      getSpy.mockRestore();
    });
  });
});
