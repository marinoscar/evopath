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

    forEachOperation(document, (_operation, path, method) => {
      if (path.startsWith('/api/admin/ai')) {
        adminAiRoutes.push({ path, method: method.toUpperCase() });
      } else if (path.startsWith('/api/ai')) {
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
      expect.arrayContaining([{ path: '/api/ai/config', method: 'GET' }]),
    );
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
