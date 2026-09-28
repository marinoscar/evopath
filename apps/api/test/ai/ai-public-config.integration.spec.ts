// =============================================================================
// Public AI config + kill switch Integration (issue #428, epic #419)
// =============================================================================
//
//   * `GET /api/ai/config` is readable by EVERY signed-in role, answers while AI
//     is off (`{ enabled:false, keyPolicy, providers:[] }`), and never carries
//     a key or a key hint.
//   * `AiEnabledGuard` answers `403` with `details.reason: 'AI_DISABLED'` while
//     AI is off, and an admin turning AI on is effective on the very next
//     request in the same process (the admin write invalidates the cache).
//
// No user-facing AI controller exists yet (#431, #433 add them), so the guard
// is exercised through a probe controller mounted on the full `AppModule` —
// the same wiring those controllers will get.
// =============================================================================

import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { Auth } from '../../src/auth/decorators/auth.decorator';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import { AiProviderRegistry } from '../../src/ai/core';
import { AiConfigModule } from '../../src/ai/config/ai-config.module';
import { AI_POLICY_CACHE_MS, AiConfigService } from '../../src/ai/config/ai-config.service';
import { AiEnabledGuard } from '../../src/ai/config/ai-enabled.guard';
import { FakeAiProvider } from '../../src/ai/testing/fake-ai-provider';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { JobWorker } from '../../src/jobs/job.worker';
import { PrismaService } from '../../src/prisma/prisma.service';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import type { TestContext } from '../helpers/test-app.helper';

const ORG_KEY = 'sk-org-key-never-public-Hh42';

/** Stands in for #431/#433's user-facing controllers: guard on the class, auth on the method. */
@Controller('ai/probe')
@UseGuards(AiEnabledGuard)
class AiProbeController {
  @Get()
  @Auth({ permissions: [PERMISSIONS.AI_USE] })
  probe() {
    return { ok: true };
  }
}

@Module({ imports: [AiConfigModule], controllers: [AiProbeController] })
class AiProbeModule {}

describe('Public AI config and kill switch', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let context: TestContext;
  let storedAi: Record<string, unknown>;
  let hasKey: boolean;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule, AiProbeModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(JobWorker)
      .useValue({})
      .overrideProvider(CredentialsService)
      .useValue({
        describe: jest.fn(async () =>
          hasKey
            ? { hint: '••••Hh42', updatedAt: new Date(), updatedByUserId: 'admin-1' }
            : null,
        ),
        getSecret: jest.fn(async () => (hasKey ? ORG_KEY : null)),
        setSecret: jest.fn(),
        deleteSecret: jest.fn(),
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    app.get(AiProviderRegistry).register(new FakeAiProvider({ id: 'openai' }));

    context = {
      app,
      module: moduleRef,
      prisma: prismaMock,
      prismaMock,
      isMocked: true,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    app.get(AiConfigService).invalidateCache();

    hasKey = false;
    storedAi = {
      enabled: false,
      keyPolicy: 'byok',
      providers: { openai: { enabled: false } },
      defaults: { allowBackgroundRuns: true },
      logPromptContent: false,
    };

    prismaMock.systemSettings.findUnique.mockImplementation(async () => ({
      id: 'settings-global',
      key: 'global',
      value: { ai: storedAi },
      version: 1,
      updatedAt: new Date(),
      updatedByUserId: null,
      updatedByUser: null,
    }));
    prismaMock.systemSettings.update.mockImplementation(async ({ data }: any) => {
      storedAi = data.value.ai;
      return {
        id: 'settings-global',
        key: 'global',
        value: data.value,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: 'admin-1',
        updatedByUser: null,
      };
    });
    prismaMock.auditEvent.create.mockResolvedValue({});
  });

  function server() {
    return app.getHttpServer();
  }

  describe('GET /api/ai/config', () => {
    it('401s without a token', async () => {
      await request(server()).get('/api/ai/config').expect(401);
    });

    it.each([
      ['admin', createMockAdminUser],
      ['contributor', createMockContributorUser],
      ['viewer', createMockViewerUser],
    ] as const)('is readable by a %s', async (_role, create) => {
      const user = await create(context);

      await request(server()).get('/api/ai/config').set(authHeader(user.accessToken)).expect(200);
    });

    it('answers { enabled:false, providers:[] } on a fresh install, while AI is off', async () => {
      prismaMock.systemSettings.findUnique.mockResolvedValue(null);
      const viewer = await createMockViewerUser(context);

      const res = await request(server())
        .get('/api/ai/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data).toEqual({
        enabled: false,
        keyPolicy: 'byok',
        allowBackgroundRuns: false,
        allowRealtime: false,
        hostedTools: { web_search: false, file_search: false, code_interpreter: false, image_generation: false, mcp: false },
        providers: [],
      });
    });

    it('publishes allowRealtime only while AI is on (#449)', async () => {
      storedAi = { ...storedAi, enabled: true, providers: { openai: { enabled: true } }, defaults: { allowBackgroundRuns: true, allowRealtime: true } };
      const viewer = await createMockViewerUser(context);

      const on = await request(server()).get('/api/ai/config').set(authHeader(viewer.accessToken)).expect(200);
      expect(on.body.data.allowRealtime).toBe(true);

      storedAi = { ...storedAi, enabled: false };
      app.get(AiConfigService).invalidateCache();

      const off = await request(server()).get('/api/ai/config').set(authHeader(viewer.accessToken)).expect(200);
      expect(off.body.data.allowRealtime).toBe(false);
    });

    it('lists providers with hasOrgKey when AI is on, and never a key or hint', async () => {
      storedAi = { ...storedAi, enabled: true, keyPolicy: 'byok_with_org_fallback', providers: { openai: { enabled: true } } };
      hasKey = true;
      const viewer = await createMockViewerUser(context);

      const res = await request(server())
        .get('/api/ai/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(res.body.data).toEqual({
        enabled: true,
        keyPolicy: 'byok_with_org_fallback',
        allowBackgroundRuns: true,
        allowRealtime: false,
        hostedTools: { web_search: false, file_search: false, code_interpreter: false, image_generation: false, mcp: false },
        providers: [
          { id: 'openai', displayName: 'Fake AI', enabled: true, hasOrgKey: true, supportsPreviousResponseId: true, requiresKey: true },
          // Registered (#446) but switched off; this test's credential store
          // answers "configured" for every provider. Anthropic stores no
          // responses, so a client must resend the conversation.
          { id: 'anthropic', displayName: 'Anthropic', enabled: false, hasOrgKey: true, supportsPreviousResponseId: false, requiresKey: true },
          // Gemini (#447): likewise registered, off, and stateless.
          { id: 'gemini', displayName: 'Google Gemini', enabled: false, hasOrgKey: true, supportsPreviousResponseId: false, requiresKey: true },
          // #448: the two OpenAI-family adapters — registered, off, and declared stateless.
          { id: 'azure-openai', displayName: 'Azure OpenAI', enabled: false, hasOrgKey: true, supportsPreviousResponseId: false, requiresKey: true },
          {
            id: 'openai-compatible',
            displayName: 'OpenAI-compatible',
            enabled: false,
            hasOrgKey: true,
            supportsPreviousResponseId: false,
            requiresKey: true,
          },
        ],
      });
      expect(res.text).not.toContain(ORG_KEY);
      expect(res.text).not.toContain('Hh42');
    });
  });

  describe('AiEnabledGuard', () => {
    it('403s with details.reason AI_DISABLED while AI is off', async () => {
      const viewer = await createMockViewerUser(context);

      const res = await request(server())
        .get('/api/ai/probe')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      // The envelope's top-level `code` is status-derived (`FORBIDDEN`) for
      // every error; the AI reason travels in `details.reason` (see ai-error.ts).
      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
        details: { reason: 'AI_DISABLED' },
      });
    });

    it('lets the request through while AI is on', async () => {
      storedAi = { ...storedAi, enabled: true };
      // #499: the probe controller also requires `ai:use`, which Viewer no
      // longer holds — a Contributor stands in as the "everyday, allowed"
      // caller so this test exercises the guard, not RBAC.
      const contributor = await createMockContributorUser(context);

      await request(server()).get('/api/ai/probe').set(authHeader(contributor.accessToken)).expect(200);
    });

    it('an admin turning AI on is effective on the next request (cache invalidated)', async () => {
      const admin = await createMockAdminUser(context);
      const contributor = await createMockContributorUser(context);

      await request(server()).get('/api/ai/probe').set(authHeader(contributor.accessToken)).expect(403);

      await request(server())
        .put('/api/admin/ai/config')
        .set(authHeader(admin.accessToken))
        .send({
          enabled: true,
          keyPolicy: 'byok',
          logPromptContent: false,
          defaults: { allowBackgroundRuns: true },
          providers: { openai: { enabled: true } },
        })
        .expect(200);

      await request(server()).get('/api/ai/probe').set(authHeader(contributor.accessToken)).expect(200);
    });

    it('a change made elsewhere lands once the cache window passes', async () => {
      const contributor = await createMockContributorUser(context);
      let now = Date.now();
      const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);

      try {
        await request(server()).get('/api/ai/probe').set(authHeader(contributor.accessToken)).expect(403);

        // Another instance flips the row; this one still has the old answer cached.
        storedAi = { ...storedAi, enabled: true };
        await request(server()).get('/api/ai/probe').set(authHeader(contributor.accessToken)).expect(403);

        now += AI_POLICY_CACHE_MS;
        await request(server()).get('/api/ai/probe').set(authHeader(contributor.accessToken)).expect(200);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
