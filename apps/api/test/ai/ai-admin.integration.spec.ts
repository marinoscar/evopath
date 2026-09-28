// =============================================================================
// AI Administration Integration (issue #428, epic #419)
// =============================================================================
//
// HTTP-level coverage for `/api/admin/ai/*`, modelled on
// `test/settings/storage-config.integration.spec.ts`:
//
//   * RBAC: `ai_config:read` gates the reads, `ai_config:write` every write —
//     asserted as declared metadata AND by driving real 401s/403s.
//   * `If-Match` (409 on mismatch, malformed treated as absent).
//   * An invalid key stores nothing and answers `AI_KEY_INVALID`.
//   * The test probe answers 200 with `success:false` and per-check codes.
//   * ⚠ NO RESPONSE FROM ANY ROUTE CONTAINS THE PLAINTEXT KEY.
//   * Audit rows use `targetType` `ai_config` / `ai_model` with codes-only meta.
//
// `CredentialsService` is a controllable stub and `FakeAiProvider` is
// registered as `openai` in the real `AiProviderRegistry`; everything else —
// controllers, services, guards, the validation pipe, the exception filter —
// is what `AppModule` wires.
// =============================================================================

import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
  TestUser,
} from '../helpers/auth-mock.helper';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { AiProviderRegistry } from '../../src/ai/core';
import { FAKE_TEXT_MODEL_CAPABILITIES, FakeAiProvider } from '../../src/ai/testing/fake-ai-provider';
import { AiAdminController } from '../../src/ai/config/ai-admin.controller';
import { AiConfigService } from '../../src/ai/config/ai-config.service';

const BASE = '/api/admin/ai';

/** ⚠ The value that must never come back out of the API. */
const ADMIN_KEY = 'sk-admin-key-do-not-leak-Zq81xY';
const MODEL_ID = '22222222-2222-4222-8222-222222222222';

type StoredAi = {
  enabled: boolean;
  keyPolicy: 'byok' | 'byok_with_org_fallback';
  providers: { openai: { enabled: boolean; baseUrl?: string } };
  defaults: { allowBackgroundRuns: boolean; maxOutputTokensCap?: number };
  logPromptContent: boolean;
};

function defaultAi(): StoredAi {
  return {
    enabled: false,
    keyPolicy: 'byok',
    providers: { openai: { enabled: false } },
    defaults: { allowBackgroundRuns: true },
    logPromptContent: false,
  };
}

function configBody(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    keyPolicy: 'byok',
    logPromptContent: false,
    defaults: { allowBackgroundRuns: true },
    providers: { openai: { enabled: true } },
    ...overrides,
  };
}

function modelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MODEL_ID,
    provider: 'openai',
    modelId: 'gpt-mini',
    displayName: null,
    capabilities: FAKE_TEXT_MODEL_CAPABILITIES,
    capabilitySource: 'catalog',
    enabled: false,
    contextWindow: null,
    maxOutputTokens: null,
    discoveredAt: new Date('2026-01-01T00:00:00.000Z'),
    lastSeenAt: new Date('2026-01-02T00:00:00.000Z'),
    deprecatedAt: null,
    updatedByUserId: null,
    updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AI Administration Integration', () => {
  let context: TestContext;
  let fake: FakeAiProvider;
  let storedAi: StoredAi;
  let storedKey: string | null;
  let rowExists: boolean;
  let version: number;
  let bodies: string[];
  let mockCredentials: {
    describe: jest.Mock;
    setSecret: jest.Mock;
    getSecret: jest.Mock;
    deleteSecret: jest.Mock;
  };

  beforeAll(async () => {
    mockCredentials = {
      describe: jest.fn(),
      setSecret: jest.fn(),
      getSecret: jest.fn(),
      deleteSecret: jest.fn(),
    };

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: CredentialsService, useValue: mockCredentials }],
    });

    fake = new FakeAiProvider({ id: 'openai', validKeys: [ADMIN_KEY], models: ['gpt-mini'] });
    context.app.get(AiProviderRegistry).register(fake);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    fake.reset();
    context.app.get(AiConfigService).invalidateCache();

    storedAi = defaultAi();
    storedKey = null;
    rowExists = true;
    version = 4;
    bodies = [];

    mockCredentials.describe.mockReset().mockImplementation(async (purpose: string, name: string) =>
      storedKey && purpose === 'ai' && name === 'openai'
        ? {
            purpose,
            name,
            hint: '••••81xY',
            label: 'AI provider key (Fake AI)',
            updatedByUserId: 'admin-1',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-02-02T00:00:00.000Z'),
          }
        : null,
    );
    mockCredentials.getSecret.mockReset().mockImplementation(async () => storedKey);
    mockCredentials.setSecret.mockReset().mockImplementation(async (_p: string, _n: string, secret: string) => {
      storedKey = secret;
    });
    mockCredentials.deleteSecret.mockReset().mockImplementation(async () => {
      storedKey = null;
    });

    // One row serves every read shape (`getAiPolicy`'s select, `loadOrCreateRow`'s
    // include, and the admin service's provenance read).
    context.prismaMock.systemSettings.findUnique.mockImplementation(async () =>
      rowExists
        ? {
            id: 'settings-global',
            key: 'global',
            value: { ai: storedAi },
            version,
            updatedAt: new Date('2026-03-03T00:00:00.000Z'),
            updatedByUserId: 'admin-1',
            updatedByUser: { id: 'admin-1', email: 'admin@example.com' },
          }
        : null,
    );
    context.prismaMock.systemSettings.update.mockImplementation(async ({ data }: any) => {
      storedAi = data.value.ai;
      version += 1;
      return {
        id: 'settings-global',
        key: 'global',
        value: data.value,
        version,
        updatedAt: new Date(),
        updatedByUserId: 'admin-1',
        updatedByUser: { id: 'admin-1', email: 'admin@example.com' },
      };
    });
    context.prismaMock.auditEvent.create.mockResolvedValue({} as never);
    context.prismaMock.aiModel.findMany.mockResolvedValue([]);
    context.prismaMock.aiModel.count.mockResolvedValue(0);
    context.prismaMock.job.create.mockResolvedValue({ id: 'job-refresh-1', status: 'pending' });
  });

  /** Every response body a test produced, for the no-egress assertion. */
  function server() {
    return context.app.getHttpServer();
  }

  function record(res: request.Response): request.Response {
    bodies.push(res.text);
    return res;
  }

  function auditCalls(): Array<{ action: string; targetType: string; meta: unknown }> {
    return context.prismaMock.auditEvent.create.mock.calls.map((call: any[]) => call[0].data);
  }

  // ==========================================================================
  // RBAC — declared metadata
  // ==========================================================================

  describe('declared permission metadata', () => {
    it.each([
      ['getConfig', 'ai_config:read'],
      ['replaceConfig', 'ai_config:write'],
      ['setKey', 'ai_config:write'],
      ['deleteKey', 'ai_config:write'],
      ['testProvider', 'ai_config:write'],
      ['listModels', 'ai_config:read'],
      ['updateModel', 'ai_config:write'],
      ['refreshModels', 'ai_config:write'],
    ] as Array<[keyof AiAdminController, string]>)('%s requires exactly %s', (handler, permission) => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AiAdminController.prototype[handler])).toEqual([
        permission,
      ]);
    });
  });

  // ==========================================================================
  // RBAC — driven through real requests
  // ==========================================================================

  describe('RBAC', () => {
    const routes: Array<['get' | 'put' | 'delete' | 'post' | 'patch', string, Record<string, unknown> | undefined]> = [
      ['get', `${BASE}/config`, undefined],
      ['put', `${BASE}/config`, configBody()],
      ['put', `${BASE}/providers/openai/key`, { apiKey: ADMIN_KEY }],
      ['delete', `${BASE}/providers/openai/key`, { confirmation: 'REMOVE' }],
      ['post', `${BASE}/providers/openai/test`, {}],
      ['get', `${BASE}/models`, undefined],
      ['patch', `${BASE}/models/${MODEL_ID}`, { enabled: true }],
      ['post', `${BASE}/models/refresh`, { provider: 'openai' }],
    ];

    it.each(routes)('%s %s: 401 without a token', async (method, path, payload) => {
      const req = request(server())[method](path);
      await (payload ? req.send(payload) : req).expect(401);
    });

    it.each(routes)('%s %s: 403 for a viewer', async (method, path, payload) => {
      const viewer = await createMockViewerUser(context);
      const req = request(server())[method](path).set(authHeader(viewer.accessToken));
      await (payload ? req.send(payload) : req).expect(403);
    });

    it.each(routes)('%s %s: 403 for a contributor', async (method, path, payload) => {
      const contributor = await createMockContributorUser(context);
      const req = request(server())[method](path).set(authHeader(contributor.accessToken));
      await (payload ? req.send(payload) : req).expect(403);
    });

    it('GET /config is 200 for an admin', async () => {
      const admin = await createMockAdminUser(context);
      await request(server()).get(`${BASE}/config`).set(authHeader(admin.accessToken)).expect(200);
    });
  });

  // ==========================================================================
  // Behaviour
  // ==========================================================================

  describe('as an admin', () => {
    let admin: TestUser;

    beforeEach(async () => {
      admin = await createMockAdminUser(context);
    });

    afterEach(() => {
      // ⚠ Acceptance criterion: no response from any route contains the key.
      for (const body of bodies) {
        expect(body).not.toContain(ADMIN_KEY);
      }
    });

    it('a fresh install reports AI off at version 0, without writing', async () => {
      rowExists = false;

      const res = record(
        await request(server()).get(`${BASE}/config`).set(authHeader(admin.accessToken)).expect(200),
      );

      expect(res.body.data).toMatchObject({
        enabled: false,
        keyPolicy: 'byok',
        logPromptContent: false,
        defaults: { maxOutputTokensCap: null, allowBackgroundRuns: true },
        version: 0,
        updatedBy: null,
        providers: [
          {
            id: 'openai',
            displayName: 'Fake AI',
            registered: true,
            enabled: false,
            baseUrl: null,
            keyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
          },
          {
            id: 'anthropic',
            displayName: 'Anthropic',
            registered: true,
            enabled: false,
            baseUrl: null,
            keyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
          },
          {
            id: 'gemini',
            displayName: 'Google Gemini',
            registered: true,
            enabled: false,
            baseUrl: null,
            keyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
          },
          // #448: each reports the settings fields its card renders.
          {
            id: 'azure-openai',
            displayName: 'Azure OpenAI',
            registered: true,
            enabled: false,
            baseUrl: null,
            settingsFields: ['baseUrl', 'apiVersion', 'apiStyle', 'deployments'],
            apiVersion: null,
            apiStyle: null,
            deployments: null,
            requiresKey: null,
            keyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
          },
          {
            id: 'openai-compatible',
            displayName: 'OpenAI-compatible',
            registered: true,
            enabled: false,
            baseUrl: null,
            settingsFields: ['baseUrl', 'apiStyle', 'requiresKey'],
            requiresKey: null,
            keyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
          },
        ],
      });
      // Anthropic runs none of the neutral hosted tools, and says so (#446).
      const capabilitiesOf = (id: string) =>
        (res.body.data.providers as Array<{ id: string; supportedCapabilities: string[] }>).find((p) => p.id === id)
          ?.supportedCapabilities;
      expect(capabilitiesOf('openai')).toContain('hosted_tools');
      expect(capabilitiesOf('anthropic')).toEqual(expect.arrayContaining(['responses', 'reasoning', 'tools']));
      expect(capabilitiesOf('anthropic')).not.toContain('hosted_tools');
      // Gemini carries responses AND embeddings, and no hosted tools yet (#447).
      expect(capabilitiesOf('gemini')).toEqual(
        expect.arrayContaining(['responses', 'reasoning', 'tools', 'embeddings']),
      );
      expect(capabilitiesOf('gemini')).not.toContain('hosted_tools');
      expect(capabilitiesOf('gemini')).not.toContain('image_generation');
      // The OpenAI-family adapters (#448): responses + embeddings, no hosted tools, no media ports.
      for (const id of ['azure-openai', 'openai-compatible']) {
        expect(capabilitiesOf(id)).toEqual(expect.arrayContaining(['responses', 'tools', 'structured_output', 'embeddings']));
        expect(capabilitiesOf(id)).not.toContain('hosted_tools');
        expect(capabilitiesOf(id)).not.toContain('image_generation');
      }
      expect(context.prismaMock.systemSettings.create).not.toHaveBeenCalled();
      expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    describe('PUT /config', () => {
      it('replaces the namespace and audits field names only', async () => {
        const res = record(
          await request(server())
            .put(`${BASE}/config`)
            .set(authHeader(admin.accessToken))
            .set('If-Match', '4')
            .send(configBody())
            .expect(200),
        );

        expect(res.body.data).toMatchObject({ enabled: true, version: 5 });
        expect(storedAi).toMatchObject({ enabled: true, providers: { openai: { enabled: true } } });
        expect(auditCalls()).toContainEqual(
          expect.objectContaining({
            action: 'ai_config:replace',
            targetType: 'ai_config',
            meta: { changedFields: ['enabled', 'providers.openai.enabled'] },
          }),
        );
      });

      it('clears a stored baseUrl and cap end to end', async () => {
        storedAi = {
          ...defaultAi(),
          providers: { openai: { enabled: false, baseUrl: 'https://gw.example.com' } },
          defaults: { allowBackgroundRuns: true, maxOutputTokensCap: 4096 },
        };

        const res = record(
          await request(server())
            .put(`${BASE}/config`)
            .set(authHeader(admin.accessToken))
            .send(
              configBody({
                providers: { openai: { enabled: true, baseUrl: '' } },
                defaults: { allowBackgroundRuns: true, maxOutputTokensCap: null },
              }),
            )
            .expect(200),
        );

        // As persisted (JSON drops undefined): the keys are gone.
        const persisted = JSON.parse(JSON.stringify(storedAi));
        expect(persisted.providers.openai).toEqual({ enabled: true });
        expect(persisted.defaults).toEqual({ allowBackgroundRuns: true, allowRealtime: false });
        expect(res.body.data.providers[0].baseUrl).toBeNull();
        expect(res.body.data.defaults.maxOutputTokensCap).toBeNull();
      });

      it('stores the Azure and OpenAI-compatible settings end to end (#448)', async () => {
        const res = record(
          await request(server())
            .put(`${BASE}/config`)
            .set(authHeader(admin.accessToken))
            .send(
              configBody({
                providers: {
                  openai: { enabled: true },
                  'azure-openai': {
                    enabled: true,
                    baseUrl: 'https://contoso.openai.azure.com',
                    apiVersion: '2024-10-21',
                    apiStyle: 'chat_completions',
                    deployments: { 'gpt-4o': 'prod-4o' },
                  },
                  'openai-compatible': {
                    enabled: true,
                    baseUrl: 'http://ollama.internal:11434/v1',
                    apiStyle: null,
                    requiresKey: false,
                  },
                },
              }),
            )
            .expect(200),
        );

        const persisted = JSON.parse(JSON.stringify(storedAi));
        expect(persisted.providers['azure-openai']).toEqual({
          enabled: true,
          baseUrl: 'https://contoso.openai.azure.com',
          apiVersion: '2024-10-21',
          apiStyle: 'chat_completions',
          deployments: { 'gpt-4o': 'prod-4o' },
        });
        expect(persisted.providers['openai-compatible']).toEqual({
          enabled: true,
          baseUrl: 'http://ollama.internal:11434/v1',
          requiresKey: false,
        });

        const byId = Object.fromEntries(
          (res.body.data.providers as Array<{ id: string }>).map((provider) => [provider.id, provider]),
        );
        expect(byId['azure-openai']).toMatchObject({ apiStyle: 'chat_completions', deployments: { 'gpt-4o': 'prod-4o' } });
        expect(byId['openai-compatible']).toMatchObject({ requiresKey: false, apiStyle: null });
      });

      it.each([
        ['a plain-http Azure endpoint', { 'azure-openai': { enabled: false, baseUrl: 'http://contoso.openai.azure.com' } }, 'AI_PROVIDER_SETTINGS_INVALID'],
        ['credentials in the URL', { 'openai-compatible': { enabled: false, baseUrl: 'http://u:p@ollama.internal/v1' } }, 'AI_PROVIDER_SETTINGS_INVALID'],
        ['a field the provider does not have', { openai: { enabled: true, requiresKey: false } }, 'AI_PROVIDER_FIELD_UNSUPPORTED'],
        ['enabling without an endpoint', { 'openai-compatible': { enabled: true } }, 'AI_BASE_URL_REQUIRED'],
      ])('refuses %s with 400 and writes nothing (#448)', async (_label, providers, reason) => {
        const res = record(
          await request(server())
            .put(`${BASE}/config`)
            .set(authHeader(admin.accessToken))
            .send(configBody({ providers }))
            .expect(400),
        );

        expect(res.body.details).toMatchObject({ reason });
        expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
      });

      it('answers 409 on a version mismatch and writes nothing', async () => {
        record(
          await request(server())
            .put(`${BASE}/config`)
            .set(authHeader(admin.accessToken))
            .set('If-Match', '3')
            .send(configBody())
            .expect(409),
        );

        expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
      });

      it('treats a malformed If-Match as absent', async () => {
        record(
          await request(server())
            .put(`${BASE}/config`)
            .set(authHeader(admin.accessToken))
            .set('If-Match', 'W/"abc"')
            .send(configBody())
            .expect(200),
        );
      });

      it('rejects byok_with_org_fallback with no admin key: 400 AI_KEY_REQUIRED', async () => {
        const res = record(
          await request(server())
            .put(`${BASE}/config`)
            .set(authHeader(admin.accessToken))
            .send(configBody({ keyPolicy: 'byok_with_org_fallback' }))
            .expect(400),
        );

        expect(res.body.details).toMatchObject({ reason: 'AI_KEY_REQUIRED', provider: 'openai' });
        expect(res.body.message).toContain('openai');
        expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
      });

      it('rejects an unknown provider id', async () => {
        const res = record(
          await request(server())
            .put(`${BASE}/config`)
            .set(authHeader(admin.accessToken))
            .send(configBody({ providers: { mystery: { enabled: true } } }))
            .expect(400),
        );

        expect(res.body.details).toMatchObject({ reason: 'AI_UNKNOWN_PROVIDER' });
      });

      it('rejects a malformed body with 400', async () => {
        record(
          await request(server())
            .put(`${BASE}/config`)
            .set(authHeader(admin.accessToken))
            .send({ enabled: 'yes' })
            .expect(400),
        );
      });

      describe('limits (#450)', () => {
        const limits = {
          perUser: { requestsPerMinute: 20, requestsPerDay: 500 },
          orgKey: { requestsPerDayPerUser: 100, tokensPerDayPerUser: 200_000 },
          perModel: { 'openai:gpt-4.1-mini': { maxOutputTokens: 2_048, requestsPerMinutePerUser: 5 } },
        };

        it('stores them, returns them on GET, and audits the changed limit fields by name', async () => {
          const res = record(
            await request(server())
              .put(`${BASE}/config`)
              .set(authHeader(admin.accessToken))
              .send(configBody({ limits }))
              .expect(200),
          );

          expect(res.body.data.limits).toEqual(limits);
          expect((storedAi as Record<string, unknown>).limits).toEqual(limits);

          const read = record(await request(server()).get(`${BASE}/config`).set(authHeader(admin.accessToken)).expect(200));
          expect(read.body.data.limits).toEqual(limits);

          expect(auditCalls()).toContainEqual(
            expect.objectContaining({
              meta: {
                changedFields: expect.arrayContaining([
                  'limits.perUser.requestsPerMinute',
                  'limits.perUser.requestsPerDay',
                  'limits.orgKey.requestsPerDayPerUser',
                  'limits.orgKey.tokensPerDayPerUser',
                  'limits.perModel',
                ]),
              },
            }),
          );
        });

        it('keeps the stored limits when the body omits them, and lifts them all with {}', async () => {
          (storedAi as Record<string, unknown>).limits = limits;

          record(
            await request(server()).put(`${BASE}/config`).set(authHeader(admin.accessToken)).send(configBody()).expect(200),
          );
          expect((storedAi as Record<string, unknown>).limits).toEqual(limits);

          record(
            await request(server())
              .put(`${BASE}/config`)
              .set(authHeader(admin.accessToken))
              .send(configBody({ limits: {} }))
              .expect(200),
          );
          expect((storedAi as Record<string, unknown>).limits).toEqual({});
        });

        it.each([
          ['a zero limit', { perUser: { requestsPerMinute: 0 } }],
          ['a fractional limit', { orgKey: { tokensPerDayPerUser: 1.5 } }],
          ['a per-model key without a provider', { perModel: { 'gpt-4.1-mini': { maxOutputTokens: 10 } } }],
          ['a per-model key with an upper-case provider', { perModel: { 'OpenAI:gpt': { maxOutputTokens: 10 } } }],
        ])('rejects %s with 400 and writes nothing', async (_name, bad) => {
          record(
            await request(server())
              .put(`${BASE}/config`)
              .set(authHeader(admin.accessToken))
              .send(configBody({ limits: bad }))
              .expect(400),
          );

          expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
        });
      });
    });

    describe('provider key', () => {
      it('an invalid key stores nothing and answers 400 AI_KEY_INVALID', async () => {
        const res = record(
          await request(server())
            .put(`${BASE}/providers/openai/key`)
            .set(authHeader(admin.accessToken))
            .send({ apiKey: 'sk-not-a-valid-key' })
            .expect(400),
        );

        expect(res.body.details).toMatchObject({ reason: 'AI_KEY_INVALID' });
        expect(res.text).not.toContain('sk-not-a-valid-key');
        expect(mockCredentials.setSecret).not.toHaveBeenCalled();
        expect(auditCalls()).toEqual([]);
      });

      it('a valid key is verified, stored and never echoed', async () => {
        const res = record(
          await request(server())
            .put(`${BASE}/providers/openai/key`)
            .set(authHeader(admin.accessToken))
            .send({ apiKey: ADMIN_KEY })
            .expect(200),
        );

        expect(fake.callsTo('verifyKey')).toHaveLength(1);
        expect(mockCredentials.setSecret).toHaveBeenCalledWith('ai', 'openai', ADMIN_KEY, {
          label: 'AI provider key (Fake AI)',
          updatedByUserId: admin.id,
        });
        expect(res.body.data.providers[0].keyStatus).toMatchObject({ configured: true, hint: '••••81xY' });
        expect(auditCalls()).toContainEqual(
          expect.objectContaining({
            action: 'ai_config:set_key',
            targetType: 'ai_config',
            meta: { provider: 'openai' },
          }),
        );
      });

      it('rejects a key shorter than 8 characters', async () => {
        record(
          await request(server())
            .put(`${BASE}/providers/openai/key`)
            .set(authHeader(admin.accessToken))
            .send({ apiKey: 'short' })
            .expect(400),
        );
      });

      it('404s for an unknown provider', async () => {
        record(
          await request(server())
            .put(`${BASE}/providers/mystery/key`)
            .set(authHeader(admin.accessToken))
            .send({ apiKey: ADMIN_KEY })
            .expect(404),
        );
      });

      it('DELETE requires the REMOVE confirmation', async () => {
        record(
          await request(server())
            .delete(`${BASE}/providers/openai/key`)
            .set(authHeader(admin.accessToken))
            .send({ confirmation: 'remove' })
            .expect(400),
        );
        expect(mockCredentials.deleteSecret).not.toHaveBeenCalled();
      });

      it('DELETE warns ORG_FALLBACK_WITHOUT_KEY under the fallback policy', async () => {
        storedKey = ADMIN_KEY;
        storedAi = { ...defaultAi(), keyPolicy: 'byok_with_org_fallback' };

        const res = record(
          await request(server())
            .delete(`${BASE}/providers/openai/key`)
            .set(authHeader(admin.accessToken))
            .send({ confirmation: 'REMOVE' })
            .expect(200),
        );

        expect(res.body.data.warnings).toEqual(['ORG_FALLBACK_WITHOUT_KEY']);
        expect(res.body.data.providers[0].keyStatus.configured).toBe(false);
        expect(auditCalls()).toContainEqual(
          expect.objectContaining({ action: 'ai_config:delete_key', targetType: 'ai_config' }),
        );
      });

      it('fallback policy is accepted once the key is stored', async () => {
        storedKey = ADMIN_KEY;

        record(
          await request(server())
            .put(`${BASE}/config`)
            .set(authHeader(admin.accessToken))
            .send(configBody({ keyPolicy: 'byok_with_org_fallback' }))
            .expect(200),
        );
      });
    });

    describe('POST /providers/:provider/test', () => {
      it('answers 200 with success:false and per-check codes for a bad key', async () => {
        const res = record(
          await request(server())
            .post(`${BASE}/providers/openai/test`)
            .set(authHeader(admin.accessToken))
            .send({ apiKey: 'sk-wrong-key-000000' })
            .expect(200),
        );

        expect(res.body.data).toMatchObject({ success: false, provider: 'openai', usedStoredKey: false });
        expect(res.body.data.checks.map((c: { code: string }) => c.code)).toEqual([
          'AI_KEY_INVALID',
          'not_attempted',
          'not_attempted',
        ]);
        expect(res.text).not.toContain('sk-wrong-key-000000');
        expect(auditCalls()).toContainEqual(
          expect.objectContaining({ action: 'ai_config:test', targetType: 'ai_config' }),
        );
      });

      it('tests the stored key when none is submitted', async () => {
        storedKey = ADMIN_KEY;
        context.prismaMock.aiModel.findMany.mockResolvedValue([
          { modelId: 'gpt-mini', capabilities: FAKE_TEXT_MODEL_CAPABILITIES },
        ]);

        const res = record(
          await request(server())
            .post(`${BASE}/providers/openai/test`)
            .set(authHeader(admin.accessToken))
            .send({})
            .expect(200),
        );

        expect(res.body.data).toMatchObject({
          success: true,
          usedStoredKey: true,
          modelCount: 1,
          smokeModelId: 'gpt-mini',
        });
        expect(fake.apiKeys).toEqual([ADMIN_KEY]);
        // Codes only in the audit row — never the key.
        expect(JSON.stringify(auditCalls())).not.toContain(ADMIN_KEY);
      });
    });

    describe('models', () => {
      it('lists with flat pagination', async () => {
        context.prismaMock.aiModel.findMany.mockResolvedValue([modelRow()]);
        context.prismaMock.aiModel.count.mockResolvedValue(1);

        const res = record(
          await request(server())
            .get(`${BASE}/models?provider=openai&capability=reasoning&enabled=false`)
            .set(authHeader(admin.accessToken))
            .expect(200),
        );

        expect(res.body.data).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
        expect(res.body.data.items[0]).toMatchObject({ id: MODEL_ID, modelId: 'gpt-mini', enabled: false });
        expect(context.prismaMock.aiModel.findMany.mock.calls[0][0].where).toMatchObject({
          provider: 'openai',
          enabled: false,
          deprecatedAt: null,
        });
      });

      it('PATCH enables a model and audits ai_model:update', async () => {
        context.prismaMock.aiModel.findUnique.mockResolvedValue(modelRow());
        context.prismaMock.aiModel.update.mockResolvedValue(modelRow({ enabled: true }));

        const res = record(
          await request(server())
            .patch(`${BASE}/models/${MODEL_ID}`)
            .set(authHeader(admin.accessToken))
            .send({ enabled: true })
            .expect(200),
        );

        expect(res.body.data.enabled).toBe(true);
        expect(auditCalls()).toContainEqual(
          expect.objectContaining({
            action: 'ai_model:update',
            targetType: 'ai_model',
            meta: { provider: 'openai', modelId: 'gpt-mini', fields: ['enabled'] },
          }),
        );
      });

      it('PATCH refuses to enable a deprecated model (409)', async () => {
        context.prismaMock.aiModel.findUnique.mockResolvedValue(modelRow({ deprecatedAt: new Date() }));

        record(
          await request(server())
            .patch(`${BASE}/models/${MODEL_ID}`)
            .set(authHeader(admin.accessToken))
            .send({ enabled: true })
            .expect(409),
        );
      });

      it('PATCH rejects an empty body and a non-uuid id', async () => {
        record(
          await request(server())
            .patch(`${BASE}/models/${MODEL_ID}`)
            .set(authHeader(admin.accessToken))
            .send({})
            .expect(400),
        );
        record(
          await request(server())
            .patch(`${BASE}/models/not-a-uuid`)
            .set(authHeader(admin.accessToken))
            .send({ enabled: true })
            .expect(400),
        );
      });

      it('refresh is 409 without an admin key', async () => {
        const res = record(
          await request(server())
            .post(`${BASE}/models/refresh`)
            .set(authHeader(admin.accessToken))
            .send({ provider: 'openai' })
            .expect(409),
        );

        expect(res.body.details).toMatchObject({ reason: 'AI_KEY_REQUIRED' });
        expect(context.prismaMock.job.create).not.toHaveBeenCalled();
      });

      it('refresh enqueues ai.catalog.refresh and returns the job id', async () => {
        storedKey = ADMIN_KEY;

        const res = record(
          await request(server())
            .post(`${BASE}/models/refresh`)
            .set(authHeader(admin.accessToken))
            .send({ provider: 'openai' })
            .expect(200),
        );

        expect(res.body.data).toEqual({ jobId: 'job-refresh-1', status: 'pending' });
        expect(context.prismaMock.job.create.mock.calls[0][0].data).toMatchObject({
          type: 'ai.catalog.refresh',
          reason: 'rerun',
          subjectType: 'ai_provider',
          subjectId: 'openai',
          payload: { providerId: 'openai', actorUserId: admin.id },
        });
        expect(auditCalls()).toContainEqual(
          expect.objectContaining({ action: 'ai_catalog:refresh_requested', targetType: 'ai_config' }),
        );
      });
    });

    it('is reachable while AI is disabled', async () => {
      storedAi = defaultAi();

      record(
        await request(server()).get(`${BASE}/config`).set(authHeader(admin.accessToken)).expect(200),
      );
      record(
        await request(server()).get(`${BASE}/models`).set(authHeader(admin.accessToken)).expect(200),
      );
    });
  });
});
