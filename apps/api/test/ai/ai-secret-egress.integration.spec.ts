// =============================================================================
// AI secret no-egress — cross-cutting conformance (issue #435, epic #419)
// =============================================================================
//
// No key material — a user's own provider key, the deployment's admin (org)
// key, or a key belonging to some OTHER user — may ever appear anywhere this
// suite can see: a response body, a response header, a captured Pino log
// line, an `audit_events.meta` row, an `ai_usage_events` row, an
// `ai_runs.request` row, or a thrown error's body. Every admin and user AI
// route this suite drives is exercised with a DISTINCT sentinel per role
// (admin/org, this user, another user), so a leak is attributable to exactly
// which key crossed a boundary it should not have.
//
// A presigned storage URL (#441) is held to the same rule: every URL the
// harness's in-memory storage mints carries `IN_MEMORY_PRESIGNED_SIGNATURE`,
// which is one more sentinel below — a stored-file input may reach the
// provider by presigned URL, and nowhere else.
//
// #442 adds another secret: an MCP tool's `headers` (the remote server's
// own credential). `MCP_HEADER_SENTINEL` travels in a hosted `mcp` tool on
// every consumer route that accepts one, the fake provider echoes it back
// in its output and in a thrown error, and it must reach none of the places
// above either — and never an `ai_runs.request` row, because a background
// run carrying headers is refused outright.
//
// #449 adds the ONE deliberate exception: a realtime session's EPHEMERAL
// client secret is returned to the browser by `POST /api/ai/realtime/sessions`
// — that is its whole purpose. The allowlist for it is explicit and narrow:
// the fake provider mints a distinct sentinel (`FAKE_REALTIME_SECRET_PREFIX`),
// which may appear in that one route's `data.clientSecret` and nowhere else
// (no other field, header, log line or usage row), while every REAL key
// sentinel stays banned everywhere — that response included. The DTO scan
// likewise allows exactly one secret-named response property:
// `AiRealtimeSessionResponseDto.clientSecret`.
//
// #448 adds a keyless provider (`requiresKey: false`, `keySource: 'none'`):
// its calls carry the `AI_KEYLESS_API_KEY` marker instead of a key. The marker
// is not a secret, but it is held to the same rule — it exists only between
// the key resolver and the adapter, and the adapter turns it into NO
// credential on the wire — so it must appear in none of the places above.
//
// Two app contexts, because the admin surface (`AiConfigAdminService` and
// friends) and the consumer surface (`AiService`/`AiRunsService`, exercised
// through `ai-http.helper`'s harness) are wired through different services
// and neither substitutes for the other:
//
//   - `adminCtx` mirrors `ai-admin.integration.spec.ts`'s own minimal setup
//     (a stubbed `CredentialsService`, `FakeAiProvider` registered as
//     `openai` in the REAL `AiProviderRegistry`) — reused rather than
//     reinvented, since that file is the worked example for driving this
//     surface at all.
//   - `app` is the `createAiHttpTestApp` harness every other #433 HTTP spec
//     uses, unchanged.
// =============================================================================

import request from 'supertest';
import { Logger } from '@nestjs/common';

import { createTestApp, closeTestApp, type TestContext } from '../helpers/test-app.helper';
import { createMockAdminUser, createMockTestUser, authHeader } from '../helpers/auth-mock.helper';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { AiProviderRegistry } from '../../src/ai/core';
import { AiConfigService } from '../../src/ai/config/ai-config.service';
import { FAKE_REALTIME_SECRET_PREFIX, FakeAiProvider } from '../../src/ai/testing/fake-ai-provider';
import { AI_KEYLESS_API_KEY } from '../../src/ai/core/provider-adapter.interface';
import {
  AI_SETTINGS_CARRIES_NO_SECRET,
  systemAiSchema,
} from '../../src/common/schemas/settings.schema';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import {
  FAKE_EMBEDDING_MODEL_CAPABILITIES,
  FAKE_IMAGE_MODEL_CAPABILITIES,
  FAKE_REALTIME_MODEL_CAPABILITIES,
  FAKE_SPEECH_MODEL_CAPABILITIES,
  FAKE_TRANSCRIPTION_MODEL_CAPABILITIES,
  FAKE_TEXT_MODEL_CAPABILITIES,
} from '../../src/ai/testing/fake-ai-provider';
import {
  HARNESS_EMBEDDING_MODEL,
  HARNESS_IMAGE_MODEL,
  HARNESS_MODEL,
  HARNESS_REALTIME_MODEL,
  HARNESS_SPEECH_MODEL,
  HARNESS_TRANSCRIPTION_MODEL,
  HARNESS_USER,
  HARNESS_USER_KEY,
  HARNESS_ORG_KEY,
} from '../../src/ai/testing/ai-runtime-harness';
import { IN_MEMORY_PRESIGNED_SIGNATURE } from '../../src/ai/testing/in-memory-ai-storage';
import { createAiHttpTestApp, type AiHttpTestApp, ALL_KEYS, OTHER_USER_KEY, parseSse } from './ai-http.helper';
import { aiConfigResponseSchema, aiKeyRemovalResponseSchema } from '../../src/ai/config/dto/ai-config-response.dto';
import { aiModelSchema, refreshAiCatalogResultSchema } from '../../src/ai/config/dto/ai-model.dto';
import { aiProviderTestResultSchema } from '../../src/ai/config/dto/ai-provider-test.dto';
import { aiPublicConfigSchema } from '../../src/ai/config/dto/ai-public-config.dto';
import { usableAiModelSchema } from '../../src/ai/keys/dto/usable-ai-model.dto';
import { userAiKeyViewSchema, userAiKeyTestResultSchema } from '../../src/ai/keys/dto/user-ai-key.dto';
import {
  aiImageRunOutputSchema,
  aiResponseSchema,
  aiRunStartedSchema,
  aiRunSchema,
  aiSpeechRunOutputSchema,
  aiTranscriptionRunOutputSchema,
} from '../../src/ai/http/dto/ai-response.dto';
import { aiEmbeddingsResponseSchema } from '../../src/ai/http/dto/ai-embeddings.dto';
import { aiRealtimeSessionResponseSchema } from '../../src/ai/http/dto/ai-realtime.dto';

const ADMIN_KEY_SENTINEL = 'sk-admin-egress-sentinel-Zq81xY';
/** An MCP server credential, sent as a hosted `mcp` tool's `Authorization` header (#442). */
const MCP_HEADER_SENTINEL = 'mcp-hdr-egress-sentinel-Wv73Kd';
/** Every value that must never appear anywhere this suite inspects. */
const ALL_SENTINELS = [...ALL_KEYS, ADMIN_KEY_SENTINEL, IN_MEMORY_PRESIGNED_SIGNATURE, MCP_HEADER_SENTINEL];

/** A hosted MCP tool carrying the header sentinel. */
const MCP_TOOL = {
  type: 'mcp',
  serverLabel: 'docs',
  serverUrl: 'https://mcp.example.com/sse',
  headers: { Authorization: `Bearer ${MCP_HEADER_SENTINEL}`, 'X-Api-Key': MCP_HEADER_SENTINEL },
} as const;

/** Every place a sentinel might leak, joined into one haystack per capture. */
function assertNoLeak(label: string, haystack: string): void {
  const leaked = ALL_SENTINELS.filter((sentinel) => haystack.includes(sentinel));
  if (leaked.length > 0) {
    throw new Error(`${label} leaks: ${leaked.join(', ')}`);
  }
  expect(leaked).toEqual([]);
}

describe('AI secret no-egress — cross-cutting conformance (#435)', () => {
  // ---- consumer-side context (the #433 HTTP harness) -------------------------
  let app: AiHttpTestApp;
  let holderToken: string;

  // ---- admin-side context (mirrors ai-admin.integration.spec.ts's setup) ----
  let adminCtx: TestContext;
  let adminFake: FakeAiProvider;
  let storedAi: Record<string, unknown>;
  let storedAdminKey: string | null;
  let adminToken: string;

  // ---- Pino/Nest Logger capture, across BOTH contexts -----------------------
  let logLines: string[];
  let logSpies: jest.SpyInstance[];

  beforeAll(async () => {
    app = await createAiHttpTestApp({
      policy: { keyPolicy: 'byok_with_org_fallback' },
      // `fake-model` also declares `hosted_tools`, so the MCP sentinel below
      // reaches the provider rather than stopping at the capability gate.
      models: [
        { modelId: HARNESS_MODEL, capabilities: { ...FAKE_TEXT_MODEL_CAPABILITIES, capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'] } },
        { modelId: HARNESS_EMBEDDING_MODEL, capabilities: FAKE_EMBEDDING_MODEL_CAPABILITIES },
        { modelId: HARNESS_IMAGE_MODEL, capabilities: FAKE_IMAGE_MODEL_CAPABILITIES },
        { modelId: HARNESS_TRANSCRIPTION_MODEL, capabilities: FAKE_TRANSCRIPTION_MODEL_CAPABILITIES },
        { modelId: HARNESS_SPEECH_MODEL, capabilities: FAKE_SPEECH_MODEL_CAPABILITIES },
        { modelId: HARNESS_REALTIME_MODEL, capabilities: FAKE_REALTIME_MODEL_CAPABILITIES },
      ],
      fake: { hostedTools: ['mcp'] },
    });

    adminCtx = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        {
          provide: CredentialsService,
          useValue: {
            describe: jest.fn(async () => null),
            setSecret: jest.fn(async (_p: string, _n: string, secret: string) => {
              storedAdminKey = secret;
            }),
            getSecret: jest.fn(async () => storedAdminKey),
            deleteSecret: jest.fn(async () => {
              storedAdminKey = null;
            }),
          },
        },
      ],
    });

    adminFake = new FakeAiProvider({ id: 'openai', validKeys: [ADMIN_KEY_SENTINEL], models: ['gpt-mini'] });
    adminCtx.app.get(AiProviderRegistry).register(adminFake);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await closeTestApp(adminCtx);
  });

  beforeEach(async () => {
    // ONE shared mock-Prisma/mock-user registry underlies BOTH app contexts
    // (`test/mocks/prisma.mock.ts` and `test/fixtures/mock-setup.helper.ts`
    // are process-global module state) — `app.reset()` already resets and
    // re-seeds it, so nothing else in this hook may call
    // `resetPrismaMock()`/`setupBaseMocks()` again, or it wipes out whichever
    // mock user was registered first. Every admin-specific override below is
    // layered on top, after the shared reset, never a second reset of it.
    app.reset();
    app.harness.setOrgKey(HARNESS_ORG_KEY);
    app.harness.setPolicy({
      hostedTools: {
        web_search: false,
        file_search: false,
        code_interpreter: false,
        image_generation: false,
        mcp: true,
        mcpAllowedHosts: [],
      },
    });

    adminFake.reset();
    adminCtx.app.get(AiConfigService).invalidateCache();

    storedAi = {
      enabled: true,
      keyPolicy: 'byok',
      providers: { openai: { enabled: true } },
      defaults: { allowBackgroundRuns: true },
      logPromptContent: false,
    };
    storedAdminKey = null;

    adminCtx.prismaMock.systemSettings.findUnique.mockImplementation(async () => ({
      id: 'settings-global',
      key: 'global',
      value: { ai: storedAi },
      version: 4,
      updatedAt: new Date(),
      updatedByUserId: 'admin-1',
      updatedByUser: { id: 'admin-1', email: 'admin@example.com' },
    }));
    adminCtx.prismaMock.systemSettings.update.mockImplementation(async ({ data }: any) => {
      storedAi = data.value.ai;
      return {
        id: 'settings-global',
        key: 'global',
        value: data.value,
        version: 5,
        updatedAt: new Date(),
        updatedByUserId: 'admin-1',
        updatedByUser: { id: 'admin-1', email: 'admin@example.com' },
      };
    });
    adminCtx.prismaMock.auditEvent.create.mockResolvedValue({} as never);
    adminCtx.prismaMock.aiModel.findMany.mockResolvedValue([]);
    adminCtx.prismaMock.aiModel.count.mockResolvedValue(0);

    // Both mock users are created LAST, after every reset above, so neither
    // registration is wiped by the other context's setup.
    const holder = await createMockTestUser(app.context, { id: HARNESS_USER, roleName: 'contributor' });
    holderToken = holder.accessToken;
    const admin = await createMockAdminUser(adminCtx);
    adminToken = admin.accessToken;

    logLines = [];
    logSpies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );
  });

  afterEach(() => {
    for (const spy of logSpies) spy.mockRestore();
  });

  it('the ai settings namespace still carries no secret field (compile-time proof, runtime pin)', () => {
    // `AI_SETTINGS_CARRIES_NO_SECRET` resolves to the type `never` — and this
    // file stops compiling — the instant a key-shaped field is added to
    // `systemAiSchema`. This assertion only pins the runtime value so the
    // constant cannot be silently deleted; `npx tsc --noEmit` is the real
    // guarantee (see `settings.schema.ts`'s own header, and the identical
    // pattern in `email-settings.service.spec.ts`).
    expect(AI_SETTINGS_CARRIES_NO_SECRET).toBe(true);

    const banned = ['secretAccessKey', 'secretKey', 'sessionToken', 'secret', 'password', 'apiKey', 'apiKeys', 'key', 'token'];
    const schemaKeys = Object.keys(systemAiSchema.shape);

    for (const name of banned) {
      expect(schemaKeys).not.toContain(name);
    }
  });

  describe('DTO scan: no AI response schema has a property that could carry key material', () => {
    // Zod schemas, walked structurally — property NAMES, never values, and
    // request DTOs (`SetAiProviderKeyDto`, `SetUserAiKeyDto`, …) are
    // deliberately excluded: those legitimately carry `apiKey` IN, which is
    // the whole point of a write-only key route. What must never happen is a
    // RESPONSE schema publishing a property shaped to hold one back out.
    const BANNED_PROPERTY_NAMES = new Set([
      'secret',
      'secretkey',
      'secretaccesskey',
      'sessiontoken',
      'apikey',
      'apikeys',
      'password',
      'token',
      'privatekey',
      'rawkey',
    ]);

    /** Unwraps optional/nullable/default wrappers to the schema they wrap. */
    function unwrap(schema: any): any {
      let current = schema;
      while (current && typeof current.unwrap === 'function') {
        current = current.unwrap();
      }
      return current;
    }

    /** Every property name reachable from `schema`, however deeply nested. */
    function collectPropertyNames(schema: any, seen = new Set<any>()): string[] {
      const node = unwrap(schema);
      if (!node || seen.has(node)) return [];
      seen.add(node);

      const type = node.def?.type;
      const names: string[] = [];

      if (type === 'object' && node.shape) {
        for (const [key, value] of Object.entries(node.shape)) {
          names.push(key);
          names.push(...collectPropertyNames(value, seen));
        }
      } else if (type === 'array' && node.element) {
        names.push(...collectPropertyNames(node.element, seen));
      } else if ((type === 'union' || type === 'discriminatedUnion') && node.options) {
        for (const option of node.options) names.push(...collectPropertyNames(option, seen));
      } else if (type === 'record' && node.valueType) {
        names.push(...collectPropertyNames(node.valueType, seen));
      }

      return names;
    }

    // The RESPONSE schemas — every `*Dto` this module publishes as an
    // HTTP response, imported by its underlying zod schema so this walk
    // needs no OpenAPI document at all.
    const responseSchemas: Record<string, unknown> = {
      AiConfigResponseDto: aiConfigResponseSchema,
      AiKeyRemovalResponseDto: aiKeyRemovalResponseSchema,
      AiModelDto: aiModelSchema,
      RefreshAiCatalogResultDto: refreshAiCatalogResultSchema,
      AiProviderTestResultDto: aiProviderTestResultSchema,
      AiPublicConfigDto: aiPublicConfigSchema,
      UsableAiModelDto: usableAiModelSchema,
      UserAiKeyViewDto: userAiKeyViewSchema,
      UserAiKeyTestResultDto: userAiKeyTestResultSchema,
      AiResponseDto: aiResponseSchema,
      AiRunStartedDto: aiRunStartedSchema,
      AiRunDto: aiRunSchema,
      AiEmbeddingsResponseDto: aiEmbeddingsResponseSchema,
      AiImageRunOutput: aiImageRunOutputSchema,
      AiTranscriptionRunOutput: aiTranscriptionRunOutputSchema,
      AiSpeechRunOutput: aiSpeechRunOutputSchema,
      AiRealtimeSessionResponseDto: aiRealtimeSessionResponseSchema,
    };

    /**
     * #449: the ONLY response property allowed a secret-shaped name. It holds
     * the provider's ephemeral realtime secret — the single deliberate
     * credential egress (docs/specs/ai-platform.md §2.15) — never a key.
     */
    const ALLOWED_SECRET_PROPERTIES = new Set(['AiRealtimeSessionResponseDto.clientSecret']);

    it('only AiRealtimeSessionResponseDto.clientSecret carries a secret-shaped name (#449 allowlist)', () => {
      const found: string[] = [];

      for (const [name, schema] of Object.entries(responseSchemas)) {
        for (const prop of collectPropertyNames(schema)) {
          if (/secret|credential|apikey/i.test(prop)) found.push(`${name}.${prop}`);
        }
      }

      expect(found).toEqual([...ALLOWED_SECRET_PROPERTIES]);
    });

    it('finds every response schema, so a broken import list cannot pass vacuously', () => {
      expect(Object.keys(responseSchemas).length).toBeGreaterThanOrEqual(10);
      for (const schema of Object.values(responseSchemas)) {
        expect(schema).toBeDefined();
      }
    });

    it.each(Object.entries(responseSchemas))('%s carries no key-shaped property', (_name, schema) => {
      const offenders = collectPropertyNames(schema).filter((prop) =>
        BANNED_PROPERTY_NAMES.has(prop.toLowerCase()),
      );

      expect(offenders).toEqual([]);
    });
  });

  describe('consumer surface: responses, streaming, key listing', () => {
    it('POST /api/ai/responses: no sentinel anywhere in the body or headers', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send({ model: 'fake-model', input: 'hello' })
        .expect(200);

      assertNoLeak('POST /api/ai/responses body', JSON.stringify(res.body));
      assertNoLeak('POST /api/ai/responses headers', JSON.stringify(res.headers));
    });

    it('POST /api/ai/responses/stream: no sentinel in any SSE frame', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses/stream')
        .set(authHeader(holderToken))
        .set('Accept', 'text/event-stream')
        .send({ model: 'fake-model', input: 'hello' })
        .expect(200);

      const frames = parseSse(res.text);
      assertNoLeak('SSE frames', JSON.stringify(frames));
      assertNoLeak('SSE response headers', JSON.stringify(res.headers));
    });

    it('POST /api/ai/embeddings: no sentinel in the body, headers, usage rows or log output', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/embeddings')
        .set(authHeader(holderToken))
        .send({ model: HARNESS_EMBEDDING_MODEL, input: ['hello', 'world'] })
        .expect(200);

      expect(app.harness.fake.callsTo('embeddings.embed')).toHaveLength(1);
      assertNoLeak('POST /api/ai/embeddings body', JSON.stringify(res.body));
      assertNoLeak('POST /api/ai/embeddings headers', JSON.stringify(res.headers));
      assertNoLeak('ai_usage_events (embeddings)', JSON.stringify(app.harness.usageEvents));
      assertNoLeak('log output (embeddings)', logLines.join('\n'));
    });

    it('POST /api/ai/embeddings refused by the provider: the error body carries no sentinel', async () => {
      const port = app.harness.fake.embeddings!;
      const original = port.embed;
      port.embed = async () => {
        throw new Error(`upstream rejected ${HARNESS_USER_KEY}`);
      };

      try {
        const res = await request(app.context.app.getHttpServer())
          .post('/api/ai/embeddings')
          .set(authHeader(holderToken))
          .send({ model: HARNESS_EMBEDDING_MODEL, input: 'hello' })
          .expect(503);

        assertNoLeak('embeddings error body', JSON.stringify(res.body));
        assertNoLeak('embeddings error log output', logLines.join('\n'));
      } finally {
        port.embed = original;
      }
    });

    it('POST /api/ai/images -> ai.image.generate -> GET /api/ai/runs/:id: no sentinel in any body, row, stored object or log line', async () => {
      const started = await request(app.context.app.getHttpServer())
        .post('/api/ai/images')
        .set(authHeader(holderToken))
        .send({ model: HARNESS_IMAGE_MODEL, prompt: 'a lighthouse', n: 2 })
        .expect(202);

      const handler = app.context.app.get(JobHandlerRegistry).get('ai.image.generate');
      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      const run = await request(app.context.app.getHttpServer())
        .get(`/api/ai/runs/${started.body.data.runId}`)
        .set(authHeader(holderToken))
        .expect(200);

      expect(run.body.data.status).toBe('succeeded');
      expect(app.harness.fake.callsTo('images.generate')).toHaveLength(1);
      assertNoLeak('POST /api/ai/images body', JSON.stringify(started.body));
      assertNoLeak('POST /api/ai/images headers', JSON.stringify(started.headers));
      assertNoLeak('image run body', JSON.stringify(run.body));
      assertNoLeak('ai_runs rows (images)', JSON.stringify(app.harness.runRows));
      assertNoLeak('ai_usage_events (images)', JSON.stringify(app.harness.usageEvents));
      assertNoLeak(
        'storage objects (images)',
        JSON.stringify(app.harness.storage.objects, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      );
      assertNoLeak('log output (images)', logLines.join('\n'));
    });

    it('an image run whose provider call fails records a run error with no sentinel', async () => {
      const port = app.harness.fake.images!;
      const original = port.generate;
      port.generate = async () => {
        throw new Error(`upstream rejected ${HARNESS_USER_KEY}`);
      };

      try {
        const started = await request(app.context.app.getHttpServer())
          .post('/api/ai/images')
          .set(authHeader(holderToken))
          .send({ model: HARNESS_IMAGE_MODEL, prompt: 'x' })
          .expect(202);

        const handler = app.context.app.get(JobHandlerRegistry).get('ai.image.generate');
        const thrown = await handler!
          .process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never)
          .catch((err: unknown) => err);

        const run = await request(app.context.app.getHttpServer())
          .get(`/api/ai/runs/${started.body.data.runId}`)
          .set(authHeader(holderToken))
          .expect(200);

        expect(run.body.data.status).toBe('failed');
        assertNoLeak('failed image run body', JSON.stringify(run.body));
        assertNoLeak('failed image run rows', JSON.stringify(app.harness.runRows));
        assertNoLeak('failed image run usage rows', JSON.stringify(app.harness.usageEvents));
        // The job's own lastError is the wrapped AiError — its serialised form carries no sentinel either.
        assertNoLeak('thrown error body', JSON.stringify(thrown));
        assertNoLeak('thrown error message (the job lastError)', String((thrown as Error | undefined)?.message));
        assertNoLeak('image failure log output', logLines.join('\n'));
      } finally {
        port.generate = original;
      }
    });

    it('POST /api/ai/audio/transcriptions -> ai.audio.transcribe -> GET /api/ai/runs/:id: no sentinel in any body, row or log line', async () => {
      const recording = app.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'audio/mpeg', bytes: Buffer.alloc(900, 2) });
      const started = await request(app.context.app.getHttpServer())
        .post('/api/ai/audio/transcriptions')
        .set(authHeader(holderToken))
        .send({ storageObjectId: recording.id, model: HARNESS_TRANSCRIPTION_MODEL, prompt: 'names: Acme' })
        .expect(202);

      const handler = app.context.app.get(JobHandlerRegistry).get('ai.audio.transcribe');
      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      const run = await request(app.context.app.getHttpServer())
        .get(`/api/ai/runs/${started.body.data.runId}`)
        .set(authHeader(holderToken))
        .expect(200);

      expect(run.body.data.status).toBe('succeeded');
      expect(app.harness.fake.callsTo('audio.transcribe')).toHaveLength(1);
      assertNoLeak('POST /api/ai/audio/transcriptions body', JSON.stringify(started.body));
      assertNoLeak('POST /api/ai/audio/transcriptions headers', JSON.stringify(started.headers));
      assertNoLeak('transcription run body', JSON.stringify(run.body));
      assertNoLeak('ai_runs rows (transcription)', JSON.stringify(app.harness.runRows));
      assertNoLeak('ai_usage_events (transcription)', JSON.stringify(app.harness.usageEvents));
      assertNoLeak('log output (transcription)', logLines.join('\n'));
    });

    it('a transcription whose provider call fails records a run error with no sentinel', async () => {
      const port = app.harness.fake.audio!;
      const original = port.transcribe;
      port.transcribe = async () => {
        throw new Error(`upstream rejected ${HARNESS_USER_KEY}`);
      };

      try {
        const recording = app.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'audio/wav' });
        const started = await request(app.context.app.getHttpServer())
          .post('/api/ai/audio/transcriptions')
          .set(authHeader(holderToken))
          .send({ storageObjectId: recording.id, model: HARNESS_TRANSCRIPTION_MODEL })
          .expect(202);

        const handler = app.context.app.get(JobHandlerRegistry).get('ai.audio.transcribe');
        // The last attempt, so the run is failed rather than released for a retry.
        const thrown = await handler!
          .process({ id: started.body.data.jobId, attempts: 2, payload: { runId: started.body.data.runId } } as never)
          .catch((err: unknown) => err);

        const run = await request(app.context.app.getHttpServer())
          .get(`/api/ai/runs/${started.body.data.runId}`)
          .set(authHeader(holderToken))
          .expect(200);

        expect(run.body.data.status).toBe('failed');
        assertNoLeak('failed transcription run body', JSON.stringify(run.body));
        assertNoLeak('failed transcription run rows', JSON.stringify(app.harness.runRows));
        assertNoLeak('failed transcription usage rows', JSON.stringify(app.harness.usageEvents));
        assertNoLeak('thrown error body (transcription)', JSON.stringify(thrown));
        assertNoLeak('thrown error message (transcription job lastError)', String((thrown as Error | undefined)?.message));
        assertNoLeak('transcription failure log output', logLines.join('\n'));
      } finally {
        port.transcribe = original;
      }
    });

    it('POST /api/ai/audio/speech -> ai.audio.speech -> GET /api/ai/runs/:id: no sentinel in any body, row, stored object or log line', async () => {
      const started = await request(app.context.app.getHttpServer())
        .post('/api/ai/audio/speech')
        .set(authHeader(holderToken))
        .send({ input: 'Read this aloud.', model: HARNESS_SPEECH_MODEL, instructions: 'calm' })
        .expect(202);

      const handler = app.context.app.get(JobHandlerRegistry).get('ai.audio.speech');
      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      const run = await request(app.context.app.getHttpServer())
        .get(`/api/ai/runs/${started.body.data.runId}`)
        .set(authHeader(holderToken))
        .expect(200);

      expect(run.body.data.status).toBe('succeeded');
      expect(app.harness.fake.callsTo('audio.speech')).toHaveLength(1);
      assertNoLeak('POST /api/ai/audio/speech body', JSON.stringify(started.body));
      assertNoLeak('POST /api/ai/audio/speech headers', JSON.stringify(started.headers));
      assertNoLeak('speech run body', JSON.stringify(run.body));
      assertNoLeak('ai_runs rows (speech)', JSON.stringify(app.harness.runRows));
      assertNoLeak('ai_usage_events (speech)', JSON.stringify(app.harness.usageEvents));
      assertNoLeak(
        'storage objects (speech)',
        JSON.stringify(app.harness.storage.objects, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      );
      assertNoLeak('stored audio bytes (speech)', [...app.harness.storage.blobs.values()].map((b) => b.toString()).join('\n'));
      assertNoLeak('log output (speech)', logLines.join('\n'));
    });

    it('a speech run whose provider call fails records a run error with no sentinel', async () => {
      const port = app.harness.fake.audio!;
      const original = port.speech;
      port.speech = async () => {
        throw new Error(`upstream rejected ${HARNESS_USER_KEY}`);
      };

      try {
        const started = await request(app.context.app.getHttpServer())
          .post('/api/ai/audio/speech')
          .set(authHeader(holderToken))
          .send({ input: 'x', model: HARNESS_SPEECH_MODEL })
          .expect(202);

        const handler = app.context.app.get(JobHandlerRegistry).get('ai.audio.speech');
        // The last attempt, so the run is failed rather than released for a retry.
        const thrown = await handler!
          .process({ id: started.body.data.jobId, attempts: 2, payload: { runId: started.body.data.runId } } as never)
          .catch((err: unknown) => err);

        const run = await request(app.context.app.getHttpServer())
          .get(`/api/ai/runs/${started.body.data.runId}`)
          .set(authHeader(holderToken))
          .expect(200);

        expect(run.body.data.status).toBe('failed');
        assertNoLeak('failed speech run body', JSON.stringify(run.body));
        assertNoLeak('failed speech run rows', JSON.stringify(app.harness.runRows));
        assertNoLeak('failed speech usage rows', JSON.stringify(app.harness.usageEvents));
        assertNoLeak('thrown error body (speech)', JSON.stringify(thrown));
        assertNoLeak('thrown error message (speech job lastError)', String((thrown as Error | undefined)?.message));
        assertNoLeak('speech failure log output', logLines.join('\n'));
      } finally {
        port.speech = original;
      }
    });

    it('a rejected key (AI_KEY_INVALID) carries no sentinel in its error body', async () => {
      // FakeAiProvider's default `validKeys` is unrestricted for the harness
      // provider — force a rejection by asking it to verify a key it was
      // never told to accept, through the "set my key" route.
      const res = await request(app.context.app.getHttpServer())
        .put('/api/ai/keys/openai')
        .set(authHeader(holderToken))
        .send({ apiKey: '' })
        .expect(400);

      assertNoLeak('AI_KEY_INVALID body', JSON.stringify(res.body));
    });

    it('GET /api/ai/keys: only a masked hint, never a full key', async () => {
      // `UserAiKeysService.list` is a REAL provider (not overridden by the
      // harness) reading the REAL, mocked `PrismaService` directly, unlike
      // `AiService`/`AiRunsService` above — it needs its own row.
      app.context.prismaMock.userAiKey.findMany.mockResolvedValue([
        {
          provider: 'openai',
          hint: '••••1111',
          verifiedAt: new Date(),
          lastErrorCode: null,
          reachableModelIds: ['fake-model'],
          reachableCheckedAt: new Date(),
        },
      ]);

      const res = await request(app.context.app.getHttpServer())
        .get('/api/ai/keys')
        .set(authHeader(holderToken))
        .expect(200);

      assertNoLeak('GET /api/ai/keys body', JSON.stringify(res.body));
    });

    it('storage-object inputs (#441): the presigned URL reaches the provider and nothing else — responses, stream, runs', async () => {
      const server = app.context.app.getHttpServer();
      const image = app.harness.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'image/png', name: 'cat.png' });
      const file = app.harness.storage.addObject({
        uploadedById: HARNESS_USER,
        mimeType: 'application/pdf',
        name: 'contract.pdf',
        bytes: Buffer.from('%PDF-1.7'),
      });
      const body = {
        model: 'fake-model',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'text', text: 'Summarise.' },
              { type: 'image', storageObjectId: image.id },
              { type: 'file', storageObjectId: file.id },
            ],
          },
        ],
      };

      const res = await request(server).post('/api/ai/responses').set(authHeader(holderToken)).send(body).expect(200);
      const streamed = await request(server)
        .post('/api/ai/responses/stream')
        .set(authHeader(holderToken))
        .set('Accept', 'text/event-stream')
        .send(body)
        .expect(200);
      const started = await request(server).post('/api/ai/runs').set(authHeader(holderToken)).send(body).expect(202);

      await app.context.app
        .get(JobHandlerRegistry)
        .get('ai.response.run')!
        .process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      const run = await request(server)
        .get(`/api/ai/runs/${started.body.data.runId}`)
        .set(authHeader(holderToken))
        .expect(200);

      // The provider DID receive presigned URLs — so their absence below is meaningful.
      const delivered = [...app.harness.fake.callsTo('responses.create'), ...app.harness.fake.callsTo('responses.stream')]
        .flatMap((call) => call.storageInputs ?? [])
        .filter((input) => input.url);

      expect(delivered).toHaveLength(3);
      expect(delivered.every((input) => input.url!.includes(IN_MEMORY_PRESIGNED_SIGNATURE))).toBe(true);
      expect(run.body.data.status).toBe('succeeded');

      assertNoLeak('POST /api/ai/responses (storage inputs) body', JSON.stringify(res.body));
      assertNoLeak('POST /api/ai/responses (storage inputs) headers', JSON.stringify(res.headers));
      assertNoLeak('SSE frames (storage inputs)', streamed.text);
      assertNoLeak('POST /api/ai/runs (storage inputs) body', JSON.stringify(started.body));
      assertNoLeak('run body (storage inputs)', JSON.stringify(run.body));
      assertNoLeak('ai_runs rows (storage inputs)', JSON.stringify(app.harness.runRows));
      assertNoLeak('ai_usage_events (storage inputs)', JSON.stringify(app.harness.usageEvents));
      assertNoLeak('log output (storage inputs)', logLines.join('\n'));
    });

    it('POST /api/ai/realtime/sessions: the ephemeral secret is in data.clientSecret and nowhere else; no key anywhere (#449)', async () => {
      app.harness.setPolicy({ defaults: { allowBackgroundRuns: true, allowRealtime: true } });

      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/realtime/sessions')
        .set(authHeader(holderToken))
        .send({ model: HARNESS_REALTIME_MODEL, instructions: 'hello' })
        .expect(201);

      // The real key paid for the mint, server-side, as the provider call's key only.
      expect(app.harness.fake.callsTo('realtime.createSession').map((c) => c.apiKey)).toEqual([HARNESS_USER_KEY]);

      // The allowlisted field: the ephemeral sentinel, and it is not a key.
      const ephemeral: string = res.body.data.clientSecret;
      expect(ephemeral.startsWith(FAKE_REALTIME_SECRET_PREFIX)).toBe(true);
      expect(ALL_SENTINELS).not.toContain(ephemeral);

      // Every real-key sentinel stays banned — this response included.
      assertNoLeak('POST /api/ai/realtime/sessions body', JSON.stringify(res.body));
      assertNoLeak('POST /api/ai/realtime/sessions headers', JSON.stringify(res.headers));
      assertNoLeak('ai_usage_events (realtime)', JSON.stringify(app.harness.usageEvents));
      assertNoLeak('log output (realtime)', logLines.join('\n'));

      // …and the ephemeral secret appears ONLY in that one field.
      const { clientSecret: _allowed, ...rest } = res.body.data;
      const elsewhere = {
        restOfBody: JSON.stringify({ ...res.body, data: rest }),
        headers: JSON.stringify(res.headers),
        usageRows: JSON.stringify(app.harness.usageEvents),
        runRows: JSON.stringify(app.harness.runRows),
        logs: logLines.join('\n'),
      };

      for (const [where, haystack] of Object.entries(elsewhere)) {
        expect({ where, leaked: haystack.includes(FAKE_REALTIME_SECRET_PREFIX) }).toEqual({ where, leaked: false });
      }
    });

    it('a realtime mint the provider refuses carries no sentinel in its error body or logs (#449)', async () => {
      app.harness.setPolicy({ defaults: { allowBackgroundRuns: true, allowRealtime: true } });

      const port = app.harness.fake.realtime!;
      const original = port.createSession;
      port.createSession = async () => {
        throw new Error(`upstream rejected ${HARNESS_USER_KEY}`);
      };

      try {
        const res = await request(app.context.app.getHttpServer())
          .post('/api/ai/realtime/sessions')
          .set(authHeader(holderToken))
          .send({ model: HARNESS_REALTIME_MODEL })
          .expect(503);

        assertNoLeak('realtime error body', JSON.stringify(res.body));
        assertNoLeak('realtime error log output', logLines.join('\n'));
        assertNoLeak('ai_usage_events (realtime failure)', JSON.stringify(app.harness.usageEvents));
      } finally {
        port.createSession = original;
      }
    });

    it('every ai_usage_events row and every ai_runs.request row carries no sentinel', async () => {
      await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send({ model: 'fake-model', input: 'hello' })
        .expect(200);

      assertNoLeak('ai_usage_events', JSON.stringify(app.harness.usageEvents));
      assertNoLeak('ai_runs.request', JSON.stringify(app.harness.runRows.map((r) => r.request)));
    });

    it('captured Nest/Pino log output carries no sentinel', () => {
      assertNoLeak('log output', logLines.join('\n'));
    });
  });

  describe('MCP header secrets (#442)', () => {
    /** The fake's MCP server "echoes" the credential it was sent — the worst case. */
    function echoHeaders(): void {
      app.script(() => ({
        output: [
          {
            type: 'hosted_tool_call',
            id: 'mcp_1',
            tool: 'mcp',
            status: 'completed',
            result: {
              kind: 'call',
              serverLabel: 'docs',
              name: 'whoami',
              arguments: '{}',
              output: `authorized with Bearer ${MCP_HEADER_SENTINEL}`,
              error: null,
            },
          },
          { type: 'message', text: `The server said ${MCP_HEADER_SENTINEL}.` },
        ],
      }));
    }

    it('POST /api/ai/responses: the headers reach the provider and nowhere else', async () => {
      app.harness.setPolicy({ logPromptContent: true });
      echoHeaders();

      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send({ model: HARNESS_MODEL, input: 'who am I?', tools: [MCP_TOOL] })
        .expect(200);

      // Proof the sentinel was really in play: the adapter received it.
      const sent = app.harness.fake.callsTo('responses.create')[0].request?.tools?.[0] as { headers?: Record<string, string> };
      expect(sent.headers?.['X-Api-Key']).toBe(MCP_HEADER_SENTINEL);

      assertNoLeak('MCP: response body', JSON.stringify(res.body));
      assertNoLeak('MCP: response headers', JSON.stringify(res.headers));
      assertNoLeak('MCP: ai_usage_events', JSON.stringify(app.harness.usageEvents));
      assertNoLeak('MCP: log output (logPromptContent on)', logLines.join('\n'));
      expect(res.body.data.outputText).toContain('[REDACTED]');
    });

    it('POST /api/ai/responses/stream: no SSE frame carries a header value', async () => {
      echoHeaders();

      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses/stream')
        .set(authHeader(holderToken))
        .set('Accept', 'text/event-stream')
        .send({ model: HARNESS_MODEL, input: 'who am I?', tools: [MCP_TOOL] })
        .expect(200);

      assertNoLeak('MCP: SSE frames', JSON.stringify(parseSse(res.text)));
      assertNoLeak('MCP: SSE log output', logLines.join('\n'));
    });

    it('POST /api/ai/runs: refused, so no ai_runs.request row can hold the headers', async () => {
      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/runs')
        .set(authHeader(holderToken))
        .send({ model: HARNESS_MODEL, input: 'later', tools: [MCP_TOOL] })
        .expect(400);

      expect(res.body.details.reason).toBe('AI_INVALID_REQUEST');
      assertNoLeak('MCP: runs error body', JSON.stringify(res.body));
      assertNoLeak('MCP: ai_runs.request', JSON.stringify(app.harness.runRows.map((r) => r.request)));
      expect(app.harness.runRows).toHaveLength(0);
    });

    it('a provider failure that echoes the header surfaces no header in the error body or logs', async () => {
      app.script(() => {
        throw new Error(`MCP server rejected Authorization: Bearer ${MCP_HEADER_SENTINEL}`);
      });

      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send({ model: HARNESS_MODEL, input: 'x', tools: [MCP_TOOL] })
        .expect(503);

      assertNoLeak('MCP: error body', JSON.stringify(res.body));
      assertNoLeak('MCP: error usage rows', JSON.stringify(app.harness.usageEvents));
      assertNoLeak('MCP: error log output', logLines.join('\n'));
    });

    it('a gate refusal (MCP switched off) carries no header in its body', async () => {
      app.harness.setPolicy({
        hostedTools: {
          web_search: false,
          file_search: false,
          code_interpreter: false,
          image_generation: false,
          mcp: false,
          mcpAllowedHosts: [],
        },
      });

      const res = await request(app.context.app.getHttpServer())
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send({ model: HARNESS_MODEL, input: 'x', tools: [MCP_TOOL] })
        .expect(403);

      expect(res.body.details.reason).toBe('AI_TOOL_DISABLED');
      assertNoLeak('MCP: AI_TOOL_DISABLED body', JSON.stringify(res.body));
    });
  });

  describe("keyless providers (requiresKey: false, keySource 'none', #448)", () => {
    const providers = (openai: Record<string, unknown>) => ({
      openai: openai as { enabled: boolean },
      anthropic: { enabled: false },
      gemini: { enabled: false },
      'azure-openai': { enabled: false },
      'openai-compatible': { enabled: false },
    });

    /** The sentinels plus the keyless marker. */
    function assertNoLeakOrMarker(label: string, haystack: string): void {
      assertNoLeak(label, haystack);
      expect(`${label}: ${haystack.includes(AI_KEYLESS_API_KEY) ? 'carries the keyless marker' : 'clean'}`).toBe(`${label}: clean`);
    }

    beforeEach(() => {
      app.harness.setPolicy({ providers: providers({ enabled: true, requiresKey: false }) });
    });

    afterEach(() => {
      app.harness.setPolicy({ providers: providers({ enabled: true }) });
    });

    it('responses, stream, embeddings and a queued run: the marker reaches the adapter and nothing else', async () => {
      const server = app.context.app.getHttpServer();

      const res = await request(server)
        .post('/api/ai/responses')
        .set(authHeader(holderToken))
        .send({ model: 'fake-model', input: 'hello' })
        .expect(200);
      const streamed = await request(server)
        .post('/api/ai/responses/stream')
        .set(authHeader(holderToken))
        .set('Accept', 'text/event-stream')
        .send({ model: 'fake-model', input: 'hello' })
        .expect(200);
      const embedded = await request(server)
        .post('/api/ai/embeddings')
        .set(authHeader(holderToken))
        .send({ model: HARNESS_EMBEDDING_MODEL, input: 'hello' })
        .expect(200);
      const started = await request(server)
        .post('/api/ai/runs')
        .set(authHeader(holderToken))
        .send({ model: 'fake-model', input: 'hello' })
        .expect(202);

      const handler = app.context.app.get(JobHandlerRegistry).get('ai.response.run');
      await handler!.process({ id: started.body.data.jobId, payload: { runId: started.body.data.runId } } as never);

      const run = await request(server)
        .get(`/api/ai/runs/${started.body.data.runId}`)
        .set(authHeader(holderToken))
        .expect(200);

      // It did reach the adapter — and only as the marker, never a real key.
      expect(app.harness.fake.calls.length).toBeGreaterThanOrEqual(4);
      expect(app.harness.fake.calls.every((call) => call.apiKey === AI_KEYLESS_API_KEY)).toBe(true);
      expect(app.harness.usageEvents.every((row) => row.keySource === 'none')).toBe(true);

      assertNoLeakOrMarker('POST /api/ai/responses body', JSON.stringify(res.body));
      assertNoLeakOrMarker('POST /api/ai/responses headers', JSON.stringify(res.headers));
      assertNoLeakOrMarker('SSE frames', streamed.text);
      assertNoLeakOrMarker('POST /api/ai/embeddings body', JSON.stringify(embedded.body));
      assertNoLeakOrMarker('run body', JSON.stringify(run.body));
      assertNoLeakOrMarker('ai_runs rows', JSON.stringify(app.harness.runRows));
      assertNoLeakOrMarker('ai_usage_events', JSON.stringify(app.harness.usageEvents));
      assertNoLeakOrMarker('log output', logLines.join('\n'));
    });
  });

  describe('admin surface: setting, testing and removing the org key', () => {
    it('PUT /api/admin/ai/providers/openai/key: response body carries no sentinel, audit meta is codes-only', async () => {
      const res = await request(adminCtx.app.getHttpServer())
        .put('/api/admin/ai/providers/openai/key')
        .set(authHeader(adminToken))
        .send({ apiKey: ADMIN_KEY_SENTINEL })
        .expect(200);

      assertNoLeak('PUT admin key body', JSON.stringify(res.body));
      assertNoLeak('PUT admin key headers', JSON.stringify(res.headers));

      const auditCalls = adminCtx.prismaMock.auditEvent.create.mock.calls.map((call: any[]) => call[0].data);
      assertNoLeak('audit_events rows', JSON.stringify(auditCalls));
      expect(auditCalls.length).toBeGreaterThan(0);
    });

    it('GET /api/admin/ai/config: only a masked keyStatus, never the key', async () => {
      storedAdminKey = ADMIN_KEY_SENTINEL;

      const res = await request(adminCtx.app.getHttpServer())
        .get('/api/admin/ai/config')
        .set(authHeader(adminToken))
        .expect(200);

      assertNoLeak('GET admin config body', JSON.stringify(res.body));
    });

    it('POST /api/admin/ai/providers/openai/test: the diagnosis carries no sentinel even when it succeeds', async () => {
      storedAdminKey = ADMIN_KEY_SENTINEL;

      const res = await request(adminCtx.app.getHttpServer())
        .post('/api/admin/ai/providers/openai/test')
        .set(authHeader(adminToken))
        .send({})
        .expect(200);

      assertNoLeak('provider test body', JSON.stringify(res.body));
    });

    it('DELETE /api/admin/ai/providers/openai/key: response and audit meta carry no sentinel', async () => {
      storedAdminKey = ADMIN_KEY_SENTINEL;

      const res = await request(adminCtx.app.getHttpServer())
        .delete('/api/admin/ai/providers/openai/key')
        .set(authHeader(adminToken))
        .send({ confirmation: 'REMOVE' })
        .expect(200);

      assertNoLeak('DELETE admin key body', JSON.stringify(res.body));

      const auditCalls = adminCtx.prismaMock.auditEvent.create.mock.calls.map((call: any[]) => call[0].data);
      assertNoLeak('audit_events rows (delete)', JSON.stringify(auditCalls));
    });

    it('captured Nest/Pino log output on the admin surface carries no sentinel', async () => {
      await request(adminCtx.app.getHttpServer())
        .put('/api/admin/ai/providers/openai/key')
        .set(authHeader(adminToken))
        .send({ apiKey: ADMIN_KEY_SENTINEL })
        .expect(200);

      assertNoLeak('admin log output', logLines.join('\n'));
    });
  });
});
