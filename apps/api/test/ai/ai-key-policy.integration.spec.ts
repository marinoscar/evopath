// =============================================================================
// AI key policy invariant — cross-cutting conformance (issue #435, epic #419)
// =============================================================================
//
// The invariant this suite exists to prove, over every synchronous inference
// ROUTE the HTTP surface offers (`POST /api/ai/responses`,
// `POST /api/ai/responses/stream`, `POST /api/ai/embeddings`) plus the queued
// paths (`POST /api/ai/runs`, executed via its `ai.response.run` handler
// exactly as `ai-kill-switch.integration.spec.ts` drives it,
// `POST /api/ai/images`, executed via `ai.image.generate` — #437, and
// `POST /api/ai/audio/transcriptions`, executed via `ai.audio.transcribe` — #438,
// and `POST /api/ai/audio/speech`, executed via `ai.audio.speech` — #439):
//
//   - `byok`, no user key            -> AI_KEY_REQUIRED, the ORG key is never
//                                        even looked at (`FakeAiProvider`
//                                        never receives it).
//   - `byok_with_org_fallback`,
//     no user key, an org key stored -> the call proceeds WITH the org key,
//                                        recorded `keySource: 'org'`.
//   - the caller holds
//     `ai_config:write` (#593), no    -> the call proceeds WITH the org key
//     user key, an org key stored        under EITHER policy — the org account
//                                        is the administrator's own — recorded
//                                        `keySource: 'org'`. A caller without
//                                        the permission is unaffected (the
//                                        `byok` block above still refuses).
//   - a user key exists              -> ALWAYS the user's own key, however the
//                                        deployment's policy is set and however
//                                        an org key is configured. This is the
//                                        sharpest form of "the admin key is
//                                        never spent on a user's own call".
//   - the provider is keyless        -> (#448: an OpenAI-compatible server the
//     (`requiresKey: false`)             administrator marked `requiresKey:
//                                        false`) the call proceeds with NO key:
//                                        the adapter receives only the
//                                        `AI_KEYLESS_API_KEY` marker — never the
//                                        user's key, never the org key — and the
//                                        usage row says `keySource: 'none'`.
//
// `FakeAiProvider.calls` records the literal `apiKey` each provider call
// carried (`ai/testing/fake-ai-provider.ts`'s own header explains why that is
// safe test-only surface), so "never used" is a fact about what the fake
// actually saw, not about what a mock was told to expect.
//
// CATALOG DISCOVERY'S `keySource: 'admin_discovery'` is deliberately NOT
// re-proven here: `ai-catalog.service.spec.ts` ("records one catalog usage
// row with keySource admin_discovery") already pins it at the unit level,
// and duplicating it here would be exactly the redundant per-story retest
// this cross-cutting suite is not supposed to be. What IS cross-cutting and
// worth a structural check is that the literal string has not drifted.
// =============================================================================

import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AI_KEYLESS_API_KEY } from '../../src/ai/core/provider-adapter.interface';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { createMockTestUser, authHeader } from '../helpers/auth-mock.helper';
import {
  HARNESS_EMBEDDING_MODEL,
  HARNESS_IMAGE_MODEL,
  HARNESS_SPEECH_MODEL,
  HARNESS_TRANSCRIPTION_MODEL,
  HARNESS_USER,
  HARNESS_USER_KEY,
  HARNESS_ORG_KEY,
} from '../../src/ai/testing/ai-runtime-harness';
import { createAiHttpTestApp, type AiHttpTestApp, parseSse } from './ai-http.helper';

const BODY = { model: 'fake-model', input: 'hello' };
const EMBED_BODY = { model: HARNESS_EMBEDDING_MODEL, input: ['hello', 'world'] };
const IMAGE_BODY = { model: HARNESS_IMAGE_MODEL, prompt: 'a lighthouse' };
const recordingFor = (app: AiHttpTestApp) =>
  app.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'audio/mpeg', bytes: Buffer.alloc(1200, 1) });
const SPEECH_BODY = { input: 'hello there', model: HARNESS_SPEECH_MODEL };
const IMAGE_REQUEST = { operation: 'images.generate', provider: 'openai', model: HARNESS_IMAGE_MODEL, prompt: 'a lighthouse' };

describe('AI key policy invariant — admin key never spent on a user’s own inference (#435)', () => {
  let app: AiHttpTestApp;
  let holderToken: string;

  beforeAll(async () => {
    app = await createAiHttpTestApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // `reset()` clears the mocked user registry along with everything else,
    // so the auth token has to be minted fresh every test — one created in
    // `beforeAll` would 401 from the second test onward.
    app.reset();
    const holder = await createMockTestUser(app.context, { id: HARNESS_USER, roleName: 'contributor' });
    holderToken = holder.accessToken;
  });

  describe('byok, caller has no key', () => {
    beforeEach(() => {
      app.harness.setPolicy({ keyPolicy: 'byok' });
      app.harness.removeUserKeys(HARNESS_USER);
      app.harness.setOrgKey(HARNESS_ORG_KEY); // present, and must be ignored
    });

    it('POST /api/ai/responses: 403 AI_KEY_REQUIRED, the org key is never handed to the fake', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send(BODY)
        .expect(403);

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(app.harness.fake.calls).toEqual([]);
      expect(app.harness.fake.apiKeys).not.toContain(HARNESS_ORG_KEY);
    });

    it('POST /api/ai/responses/stream: the same JSON refusal before any frame is sent, org key untouched', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses/stream')
        .set(authHeader(holderToken))
        .set('Accept', 'text/event-stream')
        .send(BODY)
        .expect(403);

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(app.harness.fake.calls).toEqual([]);
    });

    it('POST /api/ai/embeddings: 403 AI_KEY_REQUIRED, the org key is never handed to the fake', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/embeddings')
        .set(authHeader(holderToken))
        .send(EMBED_BODY)
        .expect(403);

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(app.harness.fake.calls).toEqual([]);
    });

    it('POST /api/ai/images: 403 AI_KEY_REQUIRED at queue time, nothing queued, org key untouched', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/images')
        .set(authHeader(holderToken))
        .send(IMAGE_BODY)
        .expect(403);

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(app.harness.runRows).toEqual([]);
      expect(app.harness.fake.calls).toEqual([]);
    });

    it('ai.image.generate: a queued image run also fails AI_KEY_REQUIRED when executed, org key untouched', async () => {
      const handler = app.context.app.get(JobHandlerRegistry).get('ai.image.generate');
      const created = await app.harness.prisma.aiRun.create({
        data: { userId: HARNESS_USER, provider: 'openai', modelId: HARNESS_IMAGE_MODEL, status: 'pending', request: IMAGE_REQUEST },
      });

      await handler!.process({ id: 'job-img-1', payload: { runId: created.id } } as never);

      const stored = app.harness.runRows.find((r) => r.id === created.id);
      expect(stored?.status).toBe('failed');
      expect(stored?.errorCode).toBe('AI_KEY_REQUIRED');
      expect(app.harness.fake.calls).toEqual([]);
    });

    it('POST /api/ai/audio/transcriptions: 403 AI_KEY_REQUIRED at queue time, nothing queued, org key untouched', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/audio/transcriptions')
        .set(authHeader(holderToken))
        .send({ storageObjectId: recordingFor(app).id, model: HARNESS_TRANSCRIPTION_MODEL })
        .expect(403);

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(app.harness.runRows).toEqual([]);
      expect(app.harness.fake.calls).toEqual([]);
    });

    it('ai.audio.transcribe: a queued transcription also fails AI_KEY_REQUIRED when executed, org key untouched', async () => {
      const handler = app.context.app.get(JobHandlerRegistry).get('ai.audio.transcribe');
      const recording = recordingFor(app);
      const created = await app.harness.prisma.aiRun.create({
        data: {
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: HARNESS_TRANSCRIPTION_MODEL,
          status: 'pending',
          request: { operation: 'audio.transcribe', provider: 'openai', model: HARNESS_TRANSCRIPTION_MODEL, storageObjectId: recording.id },
        },
      });

      await handler!.process({ id: 'job-stt-1', payload: { runId: created.id } } as never);

      const stored = app.harness.runRows.find((r) => r.id === created.id);
      expect(stored?.status).toBe('failed');
      expect(stored?.errorCode).toBe('AI_KEY_REQUIRED');
      expect(app.harness.fake.calls).toEqual([]);
    });

    it('POST /api/ai/audio/speech: 403 AI_KEY_REQUIRED at queue time, nothing queued, org key untouched', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/audio/speech')
        .set(authHeader(holderToken))
        .send(SPEECH_BODY)
        .expect(403);

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(app.harness.runRows).toEqual([]);
      expect(app.harness.fake.calls).toEqual([]);
    });

    it('ai.audio.speech: a queued speech run also fails AI_KEY_REQUIRED when executed, org key untouched', async () => {
      const handler = app.context.app.get(JobHandlerRegistry).get('ai.audio.speech');
      const created = await app.harness.prisma.aiRun.create({
        data: {
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: HARNESS_SPEECH_MODEL,
          status: 'pending',
          request: { operation: 'audio.speech', provider: 'openai', model: HARNESS_SPEECH_MODEL, input: 'hi', voice: 'alloy', format: 'mp3' },
        },
      });

      await handler!.process({ id: 'job-tts-1', payload: { runId: created.id } } as never);

      const stored = app.harness.runRows.find((r) => r.id === created.id);
      expect(stored?.status).toBe('failed');
      expect(stored?.errorCode).toBe('AI_KEY_REQUIRED');
      expect(app.harness.fake.calls).toEqual([]);
    });

    it('POST /api/ai/runs -> the queued run also fails AI_KEY_REQUIRED when executed, org key untouched', async () => {
      const registry = app.context.app.get(JobHandlerRegistry);
      const handler = registry.get('ai.response.run');

      const created = await app.harness.prisma.aiRun.create({
        data: {
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: 'fake-model',
          status: 'pending',
          request: { provider: 'openai', model: 'fake-model', input: 'hello' },
        },
      });

      await handler!.process({ id: 'job-1', payload: { runId: created.id } } as never);

      const stored = app.harness.runRows.find((r) => r.id === created.id);
      expect(stored?.status).toBe('failed');
      expect(stored?.errorCode).toBe('AI_KEY_REQUIRED');
      expect(app.harness.fake.calls).toEqual([]);
    });
  });

  describe('byok_with_org_fallback, caller has no key, an org key is stored', () => {
    beforeEach(() => {
      app.harness.setPolicy({ keyPolicy: 'byok_with_org_fallback' });
      app.harness.removeUserKeys(HARNESS_USER);
      app.harness.setOrgKey(HARNESS_ORG_KEY);
    });

    it('POST /api/ai/responses: succeeds WITH the org key, usage row keySource=org — the one legitimate case', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send(BODY)
        .expect(200);

      expect(res.body.data.outputText).toBeDefined();
      expect(app.harness.fake.apiKeys).toEqual([HARNESS_ORG_KEY]);
      expect(app.harness.usageEvents).toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: HARNESS_USER, keySource: 'org' })]),
      );
    });

    it('POST /api/ai/embeddings: succeeds WITH the org key, usage row keySource=org', async () => {
      await request(app.context.app.getHttpServer())
        .post('/api/ai/embeddings')
        .set(authHeader(holderToken))
        .send(EMBED_BODY)
        .expect(200);

      expect(app.harness.fake.callsTo('embeddings.embed').map((c) => c.apiKey)).toEqual([HARNESS_ORG_KEY]);
      expect(app.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, operation: 'embeddings', keySource: 'org' }),
      ]);
    });

    it('POST /api/ai/images -> ai.image.generate: generated WITH the org key, usage row keySource=org', async () => {
      const started = await request(app.context.app.getHttpServer())
        .post('/api/ai/images')
        .set(authHeader(holderToken))
        .send(IMAGE_BODY)
        .expect(202);

      const handler = app.context.app.get(JobHandlerRegistry).get('ai.image.generate');
      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      expect(app.harness.fake.callsTo('images.generate').map((c) => c.apiKey)).toEqual([HARNESS_ORG_KEY]);
      expect(app.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, operation: 'images', keySource: 'org' }),
      ]);
    });

    it('POST /api/ai/audio/transcriptions -> ai.audio.transcribe: transcribed WITH the org key, usage row keySource=org', async () => {
      const started = await request(app.context.app.getHttpServer())
        .post('/api/ai/audio/transcriptions')
        .set(authHeader(holderToken))
        .send({ storageObjectId: recordingFor(app).id, model: HARNESS_TRANSCRIPTION_MODEL })
        .expect(202);

      const handler = app.context.app.get(JobHandlerRegistry).get('ai.audio.transcribe');
      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      expect(app.harness.fake.callsTo('audio.transcribe').map((c) => c.apiKey)).toEqual([HARNESS_ORG_KEY]);
      expect(app.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, operation: 'audio.transcribe', keySource: 'org' }),
      ]);
    });

    it('POST /api/ai/audio/speech -> ai.audio.speech: synthesized WITH the org key, usage row keySource=org', async () => {
      const started = await request(app.context.app.getHttpServer())
        .post('/api/ai/audio/speech')
        .set(authHeader(holderToken))
        .send(SPEECH_BODY)
        .expect(202);

      const handler = app.context.app.get(JobHandlerRegistry).get('ai.audio.speech');
      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      expect(app.harness.fake.callsTo('audio.speech').map((c) => c.apiKey)).toEqual([HARNESS_ORG_KEY]);
      expect(app.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, operation: 'audio.speech', keySource: 'org' }),
      ]);
    });
  });

  describe('the caller holds ai_config:write (#593), has no key, an org key is stored', () => {
    let adminToken: string;

    beforeEach(async () => {
      const admin = await createMockTestUser(app.context, { id: HARNESS_USER, roleName: 'admin' });
      adminToken = admin.accessToken;
      app.harness.setAiConfigWriter(HARNESS_USER, true);
      app.harness.removeUserKeys(HARNESS_USER);
      app.harness.setOrgKey(HARNESS_ORG_KEY);
    });

    it.each(['byok', 'byok_with_org_fallback'] as const)(
      'under %s, POST /api/ai/responses succeeds WITH the org key, usage row keySource=org',
      async (keyPolicy) => {
        app.harness.setPolicy({ keyPolicy });

        await request(app.context.app.getHttpServer())
          .post('/api/ai/responses')
          .set(authHeader(adminToken))
          .send(BODY)
          .expect(200);

        expect(app.harness.fake.apiKeys).toEqual([HARNESS_ORG_KEY]);
        expect(app.harness.usageEvents).toEqual(
          expect.arrayContaining([expect.objectContaining({ userId: HARNESS_USER, keySource: 'org' })]),
        );
      },
    );

    it('under byok, the usable-models answer (GET /api/ai/models) lists every model with keySource org', async () => {
      app.harness.setPolicy({ keyPolicy: 'byok' });

      const models = await app.harness.usableModels.listForUser(HARNESS_USER);

      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.keySource === 'org')).toBe(true);
    });

    it('a personal key still overrides the org key', async () => {
      app.harness.setPolicy({ keyPolicy: 'byok' });
      app.harness.addUserKey(HARNESS_USER, HARNESS_USER_KEY, ['fake-model']);

      await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(adminToken))
        .send(BODY)
        .expect(200);

      expect(app.harness.fake.apiKeys).toEqual([HARNESS_USER_KEY]);
    });

    it('once the permission is gone, byok refuses again with the org key untouched', async () => {
      app.harness.setPolicy({ keyPolicy: 'byok' });
      app.harness.setAiConfigWriter(HARNESS_USER, false);

      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(adminToken))
        .send(BODY)
        .expect(403);

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(app.harness.fake.calls).toEqual([]);
    });
  });

  describe('a user key exists — it always wins, whatever the policy and however an org key is configured', () => {
    beforeEach(() => {
      app.harness.setPolicy({ keyPolicy: 'byok_with_org_fallback' });
      app.harness.setOrgKey(HARNESS_ORG_KEY);
      // Re-asserted rather than assumed: an earlier describe block in this
      // file (deliberately) removes HARNESS_USER's key, and `reset()` does
      // not restore one it never set up itself — the harness instance, and
      // its in-memory key table, are shared across every test in this file.
      app.harness.addUserKey(HARNESS_USER, HARNESS_USER_KEY, [
        'fake-model',
        HARNESS_EMBEDDING_MODEL,
        HARNESS_IMAGE_MODEL,
        HARNESS_TRANSCRIPTION_MODEL,
        HARNESS_SPEECH_MODEL,
      ]);
    });

    it('POST /api/ai/responses: the fake is called with the user key, never the org key', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send(BODY)
        .expect(200);

      expect(res.body.data.outputText).toBeDefined();
      expect(app.harness.fake.apiKeys).toEqual([HARNESS_USER_KEY]);
      expect(app.harness.fake.apiKeys).not.toContain(HARNESS_ORG_KEY);
      expect(app.harness.usageEvents).toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: HARNESS_USER, keySource: 'user' })]),
      );
    });

    it('POST /api/ai/responses/stream: every SSE frame is served over the user key, never the org key', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses/stream')
        .set(authHeader(holderToken))
        .set('Accept', 'text/event-stream')
        .send(BODY)
        .expect(200);

      const frames = parseSse(res.text);
      expect(frames.some((f) => f.event === 'response.completed')).toBe(true);
      expect(app.harness.fake.apiKeys).toEqual([HARNESS_USER_KEY]);
    });

    it('POST /api/ai/embeddings: the fake is called with the user key, never the org key', async () => {
      await request(app.context.app.getHttpServer())
        .post('/api/ai/embeddings')
        .set(authHeader(holderToken))
        .send(EMBED_BODY)
        .expect(200);

      expect(app.harness.fake.callsTo('embeddings.embed').map((c) => c.apiKey)).toEqual([HARNESS_USER_KEY]);
      expect(app.harness.fake.apiKeys).not.toContain(HARNESS_ORG_KEY);
      expect(app.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, operation: 'embeddings', keySource: 'user' }),
      ]);
    });

    it('the queued run path also spends the user key, never the org key', async () => {
      const registry = app.context.app.get(JobHandlerRegistry);
      const handler = registry.get('ai.response.run');

      const created = await app.harness.prisma.aiRun.create({
        data: {
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: 'fake-model',
          status: 'pending',
          request: { provider: 'openai', model: 'fake-model', input: 'hello' },
        },
      });

      await handler!.process({ id: 'job-2', payload: { runId: created.id } } as never);

      const stored = app.harness.runRows.find((r) => r.id === created.id);
      expect(stored?.status).toBe('succeeded');
      expect(app.harness.fake.apiKeys).toEqual([HARNESS_USER_KEY]);
    });

    it('the queued image path (POST /api/ai/images -> ai.image.generate) spends the user key, never the org key', async () => {
      const started = await request(app.context.app.getHttpServer())
        .post('/api/ai/images')
        .set(authHeader(holderToken))
        .send(IMAGE_BODY)
        .expect(202);

      const handler = app.context.app.get(JobHandlerRegistry).get('ai.image.generate');
      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      expect(app.harness.runRows.find((r) => r.id === started.body.data.runId)?.status).toBe('succeeded');
      expect(app.harness.fake.callsTo('images.generate').map((c) => c.apiKey)).toEqual([HARNESS_USER_KEY]);
      expect(app.harness.fake.apiKeys).not.toContain(HARNESS_ORG_KEY);
      expect(app.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, operation: 'images', keySource: 'user' }),
      ]);
    });

    it('the queued transcription path (POST /api/ai/audio/transcriptions -> ai.audio.transcribe) spends the user key, never the org key', async () => {
      const started = await request(app.context.app.getHttpServer())
        .post('/api/ai/audio/transcriptions')
        .set(authHeader(holderToken))
        .send({ storageObjectId: recordingFor(app).id, model: HARNESS_TRANSCRIPTION_MODEL })
        .expect(202);

      const handler = app.context.app.get(JobHandlerRegistry).get('ai.audio.transcribe');
      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      expect(app.harness.runRows.find((r) => r.id === started.body.data.runId)?.status).toBe('succeeded');
      expect(app.harness.fake.callsTo('audio.transcribe').map((c) => c.apiKey)).toEqual([HARNESS_USER_KEY]);
      expect(app.harness.fake.apiKeys).not.toContain(HARNESS_ORG_KEY);
      expect(app.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, operation: 'audio.transcribe', keySource: 'user' }),
      ]);
    });

    it('the queued speech path (POST /api/ai/audio/speech -> ai.audio.speech) spends the user key, never the org key', async () => {
      const started = await request(app.context.app.getHttpServer())
        .post('/api/ai/audio/speech')
        .set(authHeader(holderToken))
        .send(SPEECH_BODY)
        .expect(202);

      const handler = app.context.app.get(JobHandlerRegistry).get('ai.audio.speech');
      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      expect(app.harness.runRows.find((r) => r.id === started.body.data.runId)?.status).toBe('succeeded');
      expect(app.harness.fake.callsTo('audio.speech').map((c) => c.apiKey)).toEqual([HARNESS_USER_KEY]);
      expect(app.harness.fake.apiKeys).not.toContain(HARNESS_ORG_KEY);
      expect(app.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, operation: 'audio.speech', keySource: 'user' }),
      ]);
    });
  });

  describe("a keyless provider (requiresKey: false, #448) — no key at all, keySource 'none'", () => {
    // The harness's fake provider sits in the `openai` slot; the runtime reads
    // `requiresKey` generically off whichever slot a provider has, so marking
    // that slot keyless models an Ollama-style `openai-compatible` provider.
    const providers = (openai: Record<string, unknown>) => ({
      openai: openai as { enabled: boolean },
      anthropic: { enabled: false },
      gemini: { enabled: false },
      'azure-openai': { enabled: false },
      'openai-compatible': { enabled: false },
    });

    beforeEach(() => {
      // Strict BYOK, no user key, and an org key present — none of which may matter.
      app.harness.setPolicy({ keyPolicy: 'byok', providers: providers({ enabled: true, requiresKey: false }) });
      app.harness.removeUserKeys(HARNESS_USER);
      app.harness.setOrgKey(HARNESS_ORG_KEY);
    });

    afterEach(() => {
      app.harness.setPolicy({ providers: providers({ enabled: true }) });
    });

    const expectKeylessOnly = () => {
      expect(app.harness.fake.calls.length).toBeGreaterThan(0);
      expect(app.harness.fake.calls.every((call) => call.apiKey === AI_KEYLESS_API_KEY)).toBe(true);
      expect(app.harness.fake.apiKeys).not.toContain(HARNESS_ORG_KEY);
      expect(app.harness.fake.apiKeys).not.toContain(HARNESS_USER_KEY);
    };

    it('POST /api/ai/responses: works without a user key, usage row keySource none', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send(BODY)
        .expect(200);

      expect(res.body.data.outputText).toBeDefined();
      expectKeylessOnly();
      expect(app.harness.usageEvents).toEqual([expect.objectContaining({ userId: HARNESS_USER, keySource: 'none' })]);
      expect(res.text).not.toContain(AI_KEYLESS_API_KEY);
    });

    it('POST /api/ai/responses/stream: streams without a user key', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses/stream')
        .set(authHeader(holderToken))
        .set('Accept', 'text/event-stream')
        .send(BODY)
        .expect(200);

      expect(parseSse(res.text).some((frame) => frame.event === 'response.completed')).toBe(true);
      expectKeylessOnly();
      expect(res.text).not.toContain(AI_KEYLESS_API_KEY);
    });

    it('POST /api/ai/embeddings: embeds without a user key, usage row keySource none', async () => {
      await request(app.context.app.getHttpServer())
        .post('/api/ai/embeddings')
        .set(authHeader(holderToken))
        .send(EMBED_BODY)
        .expect(200);

      expectKeylessOnly();
      expect(app.harness.usageEvents).toEqual([
        expect.objectContaining({ userId: HARNESS_USER, operation: 'embeddings', keySource: 'none' }),
      ]);
    });

    it('the queued run path (ai.response.run) executes without a key, keySource none', async () => {
      const handler = app.context.app.get(JobHandlerRegistry).get('ai.response.run');
      const created = await app.harness.prisma.aiRun.create({
        data: {
          userId: HARNESS_USER,
          provider: 'openai',
          modelId: 'fake-model',
          status: 'pending',
          request: { provider: 'openai', model: 'fake-model', input: 'hello' },
        },
      });

      await handler!.process({ id: 'job-none-1', payload: { runId: created.id } } as never);

      expect(app.harness.runRows.find((r) => r.id === created.id)?.status).toBe('succeeded');
      expectKeylessOnly();
      expect(app.harness.usageEvents).toEqual([expect.objectContaining({ keySource: 'none' })]);
      expect(JSON.stringify(app.harness.runRows)).not.toContain(AI_KEYLESS_API_KEY);
    });

    it('is the admin opt-in only: with requiresKey back on, the same call is AI_KEY_REQUIRED again', async () => {
      app.harness.setPolicy({ providers: providers({ enabled: true }) });

      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send(BODY)
        .expect(403);

      expect(res.body.details.reason).toBe('AI_KEY_REQUIRED');
      expect(app.harness.fake.calls).toEqual([]);
    });
  });

  describe('admin_discovery — the catalog-refresh key source string has not drifted', () => {
    it('ai-catalog.service.ts still tags discovery usage keySource: admin_discovery, exactly as ai-catalog.service.spec.ts pins', () => {
      // A structural check, not a behavioral retest — `ai-catalog.service
      // .spec.ts`'s "records one catalog usage row with keySource
      // admin_discovery" test already drives the real behavior; this only
      // guards the literal string this cross-cutting suite's own header
      // promises against a silent rename on one side only.
      const source = readFileSync(
        join(__dirname, '..', '..', 'src', 'ai', 'catalog', 'ai-catalog.service.ts'),
        'utf8',
      );

      expect(source).toContain("keySource: 'admin_discovery'");
    });
  });
});
