import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import type { SystemAiValue } from '../../common/schemas/settings.schema';
import { AiError } from '../core/ai-error';
import { AiProviderRegistry } from '../core/provider-registry';
import { FakeAiProvider } from '../testing/fake-ai-provider';
import { AiConfigAdminService, diffFieldNames } from './ai-config-admin.service';
import type { UpdateAiConfigInput } from './dto/update-ai-config.dto';

const SECRET = 'sk-admin-secret-key-do-not-leak';

function policy(overrides: Partial<SystemAiValue> = {}): SystemAiValue {
  return {
    enabled: false,
    keyPolicy: 'byok',
    providers: { openai: { enabled: false }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } },
    defaults: { allowBackgroundRuns: true, allowRealtime: false },
    logPromptContent: false,
    usageRetentionDays: 180,
    hostedTools: {
      web_search: false,
      file_search: false,
      code_interpreter: false,
      image_generation: false,
      mcp: false,
      mcpAllowedHosts: [],
    },
    limits: {},
    ...overrides,
  };
}

function input(overrides: Partial<UpdateAiConfigInput> = {}): UpdateAiConfigInput {
  return {
    enabled: true,
    keyPolicy: 'byok',
    logPromptContent: false,
    defaults: { allowBackgroundRuns: true, allowRealtime: false },
    providers: { openai: { enabled: true }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } },
    ...overrides,
  };
}

const KEY_INFO = {
  purpose: 'ai',
  name: 'openai',
  hint: '••••leak',
  label: 'AI provider key (Fake AI)',
  updatedByUserId: 'admin-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-02T00:00:00.000Z'),
};

describe('AiConfigAdminService', () => {
  let prisma: { systemSettings: { findUnique: jest.Mock }; auditEvent: { create: jest.Mock } };
  let systemSettings: { getAiPolicy: jest.Mock; patchSettings: jest.Mock };
  let credentials: {
    describe: jest.Mock;
    setSecret: jest.Mock;
    deleteSecret: jest.Mock;
    getSecret: jest.Mock;
  };
  let aiConfig: { resolve: jest.Mock; invalidateCache: jest.Mock };
  let registry: AiProviderRegistry;
  let fake: FakeAiProvider;
  let service: AiConfigAdminService;
  let stored: SystemAiValue;

  beforeEach(() => {
    stored = policy();
    prisma = {
      systemSettings: {
        findUnique: jest.fn().mockResolvedValue({
          version: 3,
          updatedAt: new Date('2026-03-03T00:00:00.000Z'),
          updatedByUser: { id: 'admin-1', email: 'admin@example.com' },
        }),
      },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    systemSettings = {
      getAiPolicy: jest.fn(async () => stored),
      patchSettings: jest.fn(async (dto: { ai: SystemAiValue }) => {
        stored = dto.ai;
      }),
    };
    credentials = {
      describe: jest.fn().mockResolvedValue(null),
      setSecret: jest.fn().mockResolvedValue(undefined),
      deleteSecret: jest.fn().mockResolvedValue(undefined),
      getSecret: jest.fn(),
    };
    aiConfig = {
      resolve: jest.fn(async () => stored),
      invalidateCache: jest.fn(),
    };
    registry = new AiProviderRegistry();
    fake = new FakeAiProvider({ id: 'openai', validKeys: [SECRET] });
    registry.register(fake);
    service = new AiConfigAdminService(
      prisma as never,
      systemSettings as never,
      credentials as never,
      registry,
      aiConfig as never,
    );
  });

  describe('describeForAdmin', () => {
    it('joins policy, provenance, registry and masked key status', async () => {
      credentials.describe.mockResolvedValue(KEY_INFO);
      stored = policy({ providers: { openai: { enabled: true, baseUrl: 'https://gw.example.com' }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } });

      const view = await service.describeForAdmin();

      expect(view).toMatchObject({
        enabled: false,
        keyPolicy: 'byok',
        defaults: { maxOutputTokensCap: null, allowBackgroundRuns: true, allowRealtime: false },
        version: 3,
        updatedAt: '2026-03-03T00:00:00.000Z',
        updatedBy: { id: 'admin-1', email: 'admin@example.com' },
      });
      expect(view.providers).toEqual([
        {
          id: 'openai',
          displayName: 'Fake AI',
          registered: true,
          enabled: true,
          baseUrl: 'https://gw.example.com',
          settingsFields: ['baseUrl'],
          apiVersion: null,
          apiStyle: null,
          deployments: null,
          requiresKey: null,
          keyStatus: {
            configured: true,
            hint: '••••leak',
            updatedAt: '2026-02-02T00:00:00.000Z',
            updatedByUserId: 'admin-1',
          },
          supportedCapabilities: expect.arrayContaining(['responses', 'streaming']),
        },
        // A settings slot with no adapter registered in this test (#446).
        expect.objectContaining({ id: 'anthropic', registered: false, enabled: false, baseUrl: null }),
        expect.objectContaining({ id: 'gemini', registered: false, enabled: false, baseUrl: null }),
        expect.objectContaining({
          id: 'azure-openai',
          registered: false,
          settingsFields: ['baseUrl', 'apiVersion', 'apiStyle', 'deployments'],
        }),
        expect.objectContaining({
          id: 'openai-compatible',
          registered: false,
          settingsFields: ['baseUrl', 'apiStyle', 'requiresKey'],
        }),
      ]);
      expect(credentials.describe).toHaveBeenCalledWith('ai', 'openai');
      expect(credentials.getSecret).not.toHaveBeenCalled();
    });

    it('lists registry ids ∪ settings slots, and reports an unregistered slot', async () => {
      registry = new AiProviderRegistry();
      registry.register(new FakeAiProvider({ id: 'fake' }));
      service = new AiConfigAdminService(
        prisma as never,
        systemSettings as never,
        credentials as never,
        registry,
        aiConfig as never,
      );

      const view = await service.describeForAdmin();

      expect(view.providers.map((p) => [p.id, p.registered])).toEqual([
        ['fake', true],
        ['openai', false],
        ['anthropic', false],
        ['gemini', false],
        ['azure-openai', false],
        ['openai-compatible', false],
      ]);
      expect(view.providers[1].supportedCapabilities).toEqual([]);
    });

    it('reports version 0 when no settings row exists', async () => {
      prisma.systemSettings.findUnique.mockResolvedValue(null);

      await expect(service.describeForAdmin()).resolves.toMatchObject({
        version: 0,
        updatedAt: null,
        updatedBy: null,
      });
    });
  });

  describe('replace', () => {
    it('writes the namespace, invalidates the cache before auditing, and audits field names only', async () => {
      const order: string[] = [];
      aiConfig.invalidateCache.mockImplementation(() => order.push('invalidate'));
      prisma.auditEvent.create.mockImplementation(async () => order.push('audit'));

      await service.replace(input(), 'admin-1', 3);

      expect(systemSettings.patchSettings).toHaveBeenCalledWith(
        {
          ai: {
            enabled: true,
            keyPolicy: 'byok',
            logPromptContent: false,
            defaults: { allowBackgroundRuns: true, allowRealtime: false, maxOutputTokensCap: null },
            providers: { openai: { enabled: true, baseUrl: null }, anthropic: { enabled: false, baseUrl: null }, gemini: { enabled: false, baseUrl: null }, 'azure-openai': { enabled: false, baseUrl: null, apiVersion: null, apiStyle: null, deployments: null }, 'openai-compatible': { enabled: false, baseUrl: null, apiStyle: null, requiresKey: null } },
            usageRetentionDays: 180,
            hostedTools: {
              web_search: false,
              file_search: false,
              code_interpreter: false,
              image_generation: false,
              mcp: false,
              mcpAllowedHosts: [],
            },
            limits: {},
          },
        },
        'admin-1',
        3,
      );
      expect(order).toEqual(['invalidate', 'audit']);
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: 'admin-1',
          action: 'ai_config:replace',
          targetType: 'ai_config',
          targetId: 'ai',
          meta: { changedFields: ['enabled', 'providers.openai.enabled'] },
        },
      });
    });

    it('refuses a stale If-Match with 409 before writing', async () => {
      await expect(service.replace(input(), 'admin-1', 2)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(systemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('round-trips usageRetentionDays, and keeps the stored value when the body omits it (#443)', async () => {
      stored = policy({ usageRetentionDays: 45 });

      await service.replace(input(), 'admin-1');
      expect(systemSettings.patchSettings.mock.calls[0][0].ai.usageRetentionDays).toBe(45);

      await service.replace(input({ usageRetentionDays: 30 }), 'admin-1');
      expect(systemSettings.patchSettings.mock.calls[1][0].ai.usageRetentionDays).toBe(30);
      expect(prisma.auditEvent.create.mock.calls[1][0].data.meta.changedFields).toContain(
        'usageRetentionDays',
      );

      await expect(service.describeForAdmin()).resolves.toMatchObject({ usageRetentionDays: 30 });
    });

    it('round-trips hostedTools, and keeps the stored value when the body omits it (#442)', async () => {
      const on = {
        web_search: true,
        file_search: false,
        code_interpreter: false,
        image_generation: false,
        mcp: true,
        mcpAllowedHosts: ['mcp.example.com'],
      };
      stored = policy({ hostedTools: on });

      await service.replace(input(), 'admin-1');
      expect(systemSettings.patchSettings.mock.calls[0][0].ai.hostedTools).toEqual(on);

      await service.replace(
        input({ hostedTools: { ...on, web_search: false, mcpAllowedHosts: ['a.example.com', 'a.example.com', '*.b.example.com'] } }),
        'admin-1',
      );
      expect(systemSettings.patchSettings.mock.calls[1][0].ai.hostedTools).toEqual({
        ...on,
        web_search: false,
        mcpAllowedHosts: ['a.example.com', '*.b.example.com'],
      });

      const changed = prisma.auditEvent.create.mock.calls[1][0].data.meta.changedFields;
      expect(changed).toEqual(expect.arrayContaining(['hostedTools.web_search', 'hostedTools.mcpAllowedHosts']));
      // Field NAMES only: the audit row never lists the hosts themselves.
      expect(JSON.stringify(prisma.auditEvent.create.mock.calls)).not.toContain('b.example.com');

      await expect(service.describeForAdmin()).resolves.toMatchObject({
        hostedTools: { web_search: false, mcp: true, mcpAllowedHosts: ['a.example.com', '*.b.example.com'] },
      });
    });

    it('keeps a provider the body leaves out', async () => {
      stored = policy({ providers: { openai: { enabled: true, baseUrl: 'https://gw.example.com' }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } });

      await service.replace(input({ providers: {} }), 'admin-1');

      expect(systemSettings.patchSettings.mock.calls[0][0].ai.providers).toEqual({
        openai: { enabled: true, baseUrl: 'https://gw.example.com' },
        anthropic: { enabled: false, baseUrl: null },
        gemini: { enabled: false, baseUrl: null },
        'azure-openai': { enabled: false, baseUrl: null, apiVersion: null, apiStyle: null, deployments: null },
        'openai-compatible': { enabled: false, baseUrl: null, apiStyle: null, requiresKey: null },
      });
    });

    it('rejects a provider id with no settings slot (400)', async () => {
      const error = await service
        .replace(input({ providers: { nope: { enabled: false } } }), 'admin-1')
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        details: { reason: 'AI_UNKNOWN_PROVIDER', provider: 'nope' },
      });
      expect(systemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('rejects enabling a provider with no registered adapter (400)', async () => {
      registry = new AiProviderRegistry();
      service = new AiConfigAdminService(
        prisma as never,
        systemSettings as never,
        credentials as never,
        registry,
        aiConfig as never,
      );

      const error = await service.replace(input(), 'admin-1').catch((err: unknown) => err);

      expect((error as BadRequestException).getResponse()).toMatchObject({
        details: { reason: 'AI_PROVIDER_NOT_REGISTERED' },
      });
    });

    it('rejects byok_with_org_fallback while an enabled provider has no admin key (400 AI_KEY_REQUIRED)', async () => {
      const error = await service
        .replace(input({ keyPolicy: 'byok_with_org_fallback' }), 'admin-1')
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getStatus()).toBe(400);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: expect.stringContaining('openai'),
        details: { reason: 'AI_KEY_REQUIRED', provider: 'openai' },
      });
      expect(systemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('accepts byok_with_org_fallback when the key exists', async () => {
      credentials.describe.mockResolvedValue(KEY_INFO);

      await expect(
        service.replace(input({ keyPolicy: 'byok_with_org_fallback' }), 'admin-1'),
      ).resolves.toMatchObject({ keyPolicy: 'byok_with_org_fallback' });
    });

    it('never blocks turning the kill switch off', async () => {
      stored = policy({ enabled: true, keyPolicy: 'byok_with_org_fallback', providers: { openai: { enabled: true }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } });

      await expect(
        service.replace(input({ enabled: false, keyPolicy: 'byok_with_org_fallback' }), 'admin-1'),
      ).resolves.toMatchObject({ enabled: false });
    });

    it.each([
      ['empty string', ''],
      ['null', null],
      ['omission', undefined],
    ])('clears a stored baseUrl sent as %s by patching it to null', async (_label, baseUrl) => {
      stored = policy({ providers: { openai: { enabled: true, baseUrl: 'https://gw.example.com' }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } });

      await service.replace(
        input({ providers: { openai: { enabled: true, ...(baseUrl === undefined ? {} : { baseUrl }) } } }),
        'admin-1',
      );

      expect(systemSettings.patchSettings.mock.calls[0][0].ai.providers).toEqual({
        openai: { enabled: true, baseUrl: null },
        anthropic: { enabled: false, baseUrl: null },
        gemini: { enabled: false, baseUrl: null },
        'azure-openai': { enabled: false, baseUrl: null, apiVersion: null, apiStyle: null, deployments: null },
        'openai-compatible': { enabled: false, baseUrl: null, apiStyle: null, requiresKey: null },
      });
      expect(prisma.auditEvent.create.mock.calls[0][0].data.meta.changedFields).toContain(
        'providers.openai.baseUrl',
      );
    });

    it('clears a stored maxOutputTokensCap by patching it to null', async () => {
      stored = policy({ defaults: { allowBackgroundRuns: true, allowRealtime: false, maxOutputTokensCap: 4096 } });

      await service.replace(
        input({ defaults: { allowBackgroundRuns: true, maxOutputTokensCap: null } }),
        'admin-1',
      );

      expect(systemSettings.patchSettings.mock.calls[0][0].ai.defaults).toEqual({
        allowBackgroundRuns: true,
        allowRealtime: false,
        maxOutputTokensCap: null,
      });
    });

    it('keeps a stored allowRealtime when the body omits it, and writes it when sent (#449)', async () => {
      stored = policy({ defaults: { allowBackgroundRuns: true, allowRealtime: true } });

      await service.replace(input({ defaults: { allowBackgroundRuns: true } }), 'admin-1');
      expect(systemSettings.patchSettings.mock.calls[0][0].ai.defaults.allowRealtime).toBe(true);

      await service.replace(input({ defaults: { allowBackgroundRuns: true, allowRealtime: false } }), 'admin-1');
      expect(systemSettings.patchSettings.mock.calls[1][0].ai.defaults.allowRealtime).toBe(false);
      expect(prisma.auditEvent.create.mock.calls.at(-1)?.[0].data.meta.changedFields).toContain(
        'defaults.allowRealtime',
      );
    });

    it('writes a new baseUrl and cap', async () => {
      await service.replace(
        input({
          defaults: { allowBackgroundRuns: false, maxOutputTokensCap: 2048 },
          providers: { openai: { enabled: true, baseUrl: 'https://gw.example.com' }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } },
        }),
        'admin-1',
      );

      expect(systemSettings.patchSettings.mock.calls[0][0].ai).toMatchObject({
        defaults: { allowBackgroundRuns: false, maxOutputTokensCap: 2048 },
        providers: { openai: { enabled: true, baseUrl: 'https://gw.example.com' }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } },
      });
    });
  });

  describe('setKey', () => {
    it('verifies, stores, audits and returns the masked view', async () => {
      credentials.describe.mockResolvedValue(KEY_INFO);

      const view = await service.setKey('openai', SECRET, 'admin-1');

      expect(fake.callsTo('verifyKey')).toHaveLength(1);
      expect(credentials.setSecret).toHaveBeenCalledWith('ai', 'openai', SECRET, {
        label: 'AI provider key (Fake AI)',
        updatedByUserId: 'admin-1',
      });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'ai_config:set_key',
          targetType: 'ai_config',
          targetId: 'openai',
          meta: { provider: 'openai' },
        }),
      });
      expect(JSON.stringify(view)).not.toContain(SECRET);
      expect(JSON.stringify(prisma.auditEvent.create.mock.calls)).not.toContain(SECRET);
    });

    it('passes the stored baseUrl to verification', async () => {
      stored = policy({ providers: { openai: { enabled: true, baseUrl: 'https://gw.example.com' }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } });

      await service.setKey('openai', SECRET, 'admin-1');

      expect(fake.callsTo('verifyKey')[0].baseUrl).toBe('https://gw.example.com');
    });

    it('stores nothing and throws AI_KEY_INVALID (400) for a rejected key', async () => {
      const error = await service.setKey('openai', 'sk-wrong-key-123', 'admin-1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).code).toBe('AI_KEY_INVALID');
      expect((error as AiError).getStatus()).toBe(400);
      expect(JSON.stringify(error)).not.toContain('sk-wrong-key-123');
      expect(credentials.setSecret).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('stores nothing when verification itself fails', async () => {
      jest.spyOn(fake, 'verifyKey').mockRejectedValue(new Error(`boom ${SECRET}`));

      const error = await service.setKey('openai', SECRET, 'admin-1').catch((e: unknown) => e);

      expect((error as AiError).code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(JSON.stringify(error)).not.toContain(SECRET);
      expect(credentials.setSecret).not.toHaveBeenCalled();
    });

    it('404s for a provider with no adapter', async () => {
      await expect(service.setKey('nope', SECRET, 'admin-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('deleteKey', () => {
    it('deletes, audits, and warns nothing under byok', async () => {
      const view = await service.deleteKey('openai', 'admin-1');

      expect(credentials.deleteSecret).toHaveBeenCalledWith('ai', 'openai');
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'ai_config:delete_key',
          targetType: 'ai_config',
          meta: { provider: 'openai' },
        }),
      });
      expect(view.warnings).toEqual([]);
    });

    it('warns ORG_FALLBACK_WITHOUT_KEY under byok_with_org_fallback', async () => {
      stored = policy({ keyPolicy: 'byok_with_org_fallback' });

      await expect(service.deleteKey('openai', 'admin-1')).resolves.toMatchObject({
        warnings: ['ORG_FALLBACK_WITHOUT_KEY'],
      });
    });

    it('404s for an unknown provider', async () => {
      await expect(service.deleteKey('nope', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(credentials.deleteSecret).not.toHaveBeenCalled();
    });
  });

  describe('diffFieldNames', () => {
    it('names changed fields, never values', () => {
      expect(
        diffFieldNames(
          policy(),
          policy({
            keyPolicy: 'byok_with_org_fallback',
            providers: { openai: { enabled: false, baseUrl: 'https://x.example.com' }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } },
          }),
        ),
      ).toEqual(['keyPolicy', 'providers.openai.baseUrl']);
    });
  });

  describe('OpenAI-family provider settings (#448)', () => {
    beforeEach(() => {
      registry.register(new FakeAiProvider({ id: 'azure-openai', validKeys: [SECRET] }));
      registry.register(new FakeAiProvider({ id: 'openai-compatible', validKeys: [SECRET] }));
    });

    async function rejection(body: UpdateAiConfigInput): Promise<{ reason?: string; field?: string; fields?: string[] }> {
      try {
        await service.replace(body, 'admin-1');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);

        return ((err as BadRequestException).getResponse() as { details: { reason?: string } }).details;
      }

      throw new Error('expected a 400');
    }

    it('stores the Azure and OpenAI-compatible fields, sending every absent one as null', async () => {
      await service.replace(
        input({
          providers: {
            'azure-openai': {
              enabled: true,
              baseUrl: 'https://contoso.openai.azure.com',
              apiVersion: '2024-10-21',
              apiStyle: 'chat_completions',
              deployments: { 'gpt-4o': 'prod-4o' },
            },
            'openai-compatible': { enabled: true, baseUrl: 'http://ollama.internal:11434/v1', requiresKey: false },
          },
        }),
        'admin-1',
      );

      const providers = systemSettings.patchSettings.mock.calls[0][0].ai.providers;

      expect(providers['azure-openai']).toEqual({
        enabled: true,
        baseUrl: 'https://contoso.openai.azure.com',
        apiVersion: '2024-10-21',
        apiStyle: 'chat_completions',
        deployments: { 'gpt-4o': 'prod-4o' },
      });
      expect(providers['openai-compatible']).toEqual({
        enabled: true,
        baseUrl: 'http://ollama.internal:11434/v1',
        apiStyle: null,
        requiresKey: false,
      });

      const changed = prisma.auditEvent.create.mock.calls[0][0].data.meta.changedFields as string[];

      expect(changed).toEqual(
        expect.arrayContaining([
          'providers.azure-openai.deployments',
          'providers.azure-openai.apiVersion',
          'providers.openai-compatible.requiresKey',
        ]),
      );
      // Names only: no endpoint, deployment name or model id in the audit row.
      expect(JSON.stringify(prisma.auditEvent.create.mock.calls[0][0].data.meta)).not.toMatch(/contoso|prod-4o|ollama/);
    });

    it('describes the stored fields back', async () => {
      stored = policy({
        providers: {
          ...policy().providers,
          'azure-openai': { enabled: false, baseUrl: 'https://contoso.openai.azure.com', deployments: { a: 'b' } },
          'openai-compatible': { enabled: false, apiStyle: 'responses', requiresKey: false },
        },
      });

      const view = await service.describeForAdmin();
      const byId = Object.fromEntries(view.providers.map((p) => [p.id, p]));

      expect(byId['azure-openai']).toMatchObject({
        baseUrl: 'https://contoso.openai.azure.com',
        apiVersion: null,
        apiStyle: null,
        deployments: { a: 'b' },
        requiresKey: null,
      });
      expect(byId['openai-compatible']).toMatchObject({ baseUrl: null, apiStyle: 'responses', requiresKey: false, deployments: null });
    });

    it('treats an empty value as absent: {} deployments and an empty apiVersion clear the stored ones', async () => {
      stored = policy({
        providers: {
          ...policy().providers,
          'azure-openai': { enabled: false, apiVersion: '2024-10-21', deployments: { a: 'b' } },
        },
      });

      await service.replace(
        input({ providers: { 'azure-openai': { enabled: false, apiVersion: '', deployments: {} } } }),
        'admin-1',
      );

      expect(systemSettings.patchSettings.mock.calls[0][0].ai.providers['azure-openai']).toEqual({
        enabled: false,
        baseUrl: null,
        apiVersion: null,
        apiStyle: null,
        deployments: null,
      });
    });

    it('refuses a field the provider has no slot for', async () => {
      expect(await rejection(input({ providers: { openai: { enabled: true, requiresKey: false } } }))).toMatchObject({
        reason: 'AI_PROVIDER_FIELD_UNSUPPORTED',
        field: 'requiresKey',
      });
      expect(
        await rejection(input({ providers: { 'openai-compatible': { enabled: false, deployments: { a: 'b' } } } })),
      ).toMatchObject({ reason: 'AI_PROVIDER_FIELD_UNSUPPORTED', field: 'deployments' });
      expect(systemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it.each([
      ['a plain-http Azure endpoint', { 'azure-openai': { enabled: false, baseUrl: 'http://contoso.openai.azure.com' } }],
      ['credentials in a compatible URL', { 'openai-compatible': { enabled: false, baseUrl: 'http://u:p@ollama.internal/v1' } }],
    ])('refuses %s as AI_PROVIDER_SETTINGS_INVALID', async (_label, providers) => {
      expect(await rejection(input({ providers }))).toMatchObject({
        reason: 'AI_PROVIDER_SETTINGS_INVALID',
        fields: ['baseUrl'],
      });
      expect(systemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it.each(['azure-openai', 'openai-compatible'])('refuses enabling %s without a base URL', async (id) => {
      expect(await rejection(input({ providers: { [id]: { enabled: true } } }))).toMatchObject({
        reason: 'AI_BASE_URL_REQUIRED',
      });
    });

    it('does not ask a keyless provider for an org key under byok_with_org_fallback', async () => {
      credentials.describe.mockImplementation(async (_purpose: string, name: string) => (name === 'openai' ? KEY_INFO : null));

      await expect(
        service.replace(
          input({
            keyPolicy: 'byok_with_org_fallback',
            providers: {
              'openai-compatible': { enabled: true, baseUrl: 'http://ollama.internal:11434/v1', requiresKey: false },
            },
          }),
          'admin-1',
        ),
      ).resolves.toBeDefined();

      await expect(
        service.replace(
          input({
            keyPolicy: 'byok_with_org_fallback',
            providers: { 'openai-compatible': { enabled: true, baseUrl: 'http://ollama.internal:11434/v1' } },
          }),
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
