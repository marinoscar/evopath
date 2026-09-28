import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { AiProviderRegistry } from '../core/provider-registry';
import { FAKE_TEXT_MODEL_CAPABILITIES, FakeAiProvider } from '../testing/fake-ai-provider';
import { AiConfigAdminService } from './ai-config-admin.service';
import {
  AiModelsAdminService,
  buildModelWhere,
  toModelView,
} from './ai-models-admin.service';

const ID = '11111111-1111-4111-8111-111111111111';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
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

const QUERY = { page: 1, pageSize: 20, includeDeprecated: false } as const;

describe('AiModelsAdminService', () => {
  let prisma: {
    aiModel: { findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    auditEvent: { create: jest.Mock };
  };
  let credentials: { describe: jest.Mock };
  let catalog: { enqueueRefresh: jest.Mock };
  let service: AiModelsAdminService;
  let policy: { providers: Record<string, unknown> };

  beforeEach(() => {
    policy = { providers: { openai: { enabled: true } } };
    prisma = {
      aiModel: {
        findMany: jest.fn().mockResolvedValue([row()]),
        count: jest.fn().mockResolvedValue(41),
        findUnique: jest.fn().mockResolvedValue(row()),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
          row({ ...data, updatedByUserId: 'admin-1' }),
        ),
      },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    credentials = { describe: jest.fn().mockResolvedValue({ hint: '••••1234' }) };
    catalog = { enqueueRefresh: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }) };

    const registry = new AiProviderRegistry();
    registry.register(new FakeAiProvider({ id: 'openai' }));
    const admin = new AiConfigAdminService(
      {} as never,
      {} as never,
      {} as never,
      registry,
      { resolve: jest.fn(async () => policy) } as never,
    );

    service = new AiModelsAdminService(
      prisma as never,
      credentials as never,
      catalog as never,
      admin,
    );
  });

  describe('list', () => {
    it('returns the flat pagination shape', async () => {
      const result = await service.list({ ...QUERY, page: 2 });

      expect(result).toMatchObject({ total: 41, page: 2, pageSize: 20, totalPages: 3 });
      expect(result.items[0]).toMatchObject({ id: ID, modelId: 'gpt-mini', capabilitySource: 'catalog' });
      expect(prisma.aiModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
    });

    it('excludes deprecated models by default', () => {
      expect(buildModelWhere(QUERY)).toEqual({ deprecatedAt: null });
      expect(buildModelWhere({ ...QUERY, includeDeprecated: true })).toEqual({});
    });

    it('builds every filter', () => {
      expect(
        buildModelWhere({
          ...QUERY,
          provider: 'openai',
          enabled: true,
          capability: 'reasoning',
          q: 'mini',
        }),
      ).toEqual({
        provider: 'openai',
        enabled: true,
        deprecatedAt: null,
        capabilities: { path: ['capabilities'], array_contains: ['reasoning'] },
        OR: [
          { modelId: { contains: 'mini', mode: 'insensitive' } },
          { displayName: { contains: 'mini', mode: 'insensitive' } },
        ],
      });
    });
  });

  describe('toModelView', () => {
    it('publishes null capabilities for an invalid stored record', () => {
      expect(toModelView(row({ capabilities: {}, capabilitySource: 'unclassified' }) as never)).toMatchObject({
        capabilities: null,
        capabilitySource: 'unclassified',
      });
    });
  });

  describe('update', () => {
    it('enables a classified model and audits field names', async () => {
      const view = await service.update(ID, { enabled: true }, 'admin-1');

      expect(prisma.aiModel.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: { enabled: true, updatedByUser: { connect: { id: 'admin-1' } } },
      });
      expect(view.enabled).toBe(true);
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: 'admin-1',
          action: 'ai_model:update',
          targetType: 'ai_model',
          targetId: ID,
          meta: { provider: 'openai', modelId: 'gpt-mini', fields: ['enabled'] },
        },
      });
    });

    it('marks a capability override as admin_override and syncs the columns', async () => {
      const capabilities = { ...FAKE_TEXT_MODEL_CAPABILITIES, contextWindow: 8000, maxOutputTokens: 1000 };

      await service.update(ID, { capabilities, displayName: 'Mini' }, 'admin-1');

      expect(prisma.aiModel.update.mock.calls[0][0].data).toMatchObject({
        capabilities,
        capabilitySource: 'admin_override',
        contextWindow: 8000,
        maxOutputTokens: 1000,
        displayName: 'Mini',
      });
    });

    it('refuses to enable a deprecated model (409)', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(row({ deprecatedAt: new Date() }));

      await expect(service.update(ID, { enabled: true }, 'admin-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.aiModel.update).not.toHaveBeenCalled();
    });

    it('refuses to enable an unclassified model without capabilities (400)', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(row({ capabilitySource: 'unclassified', capabilities: {} }));

      await expect(service.update(ID, { enabled: true }, 'admin-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('enables an unclassified model when capabilities come with it', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(row({ capabilitySource: 'unclassified', capabilities: {} }));

      await service.update(ID, { enabled: true, capabilities: FAKE_TEXT_MODEL_CAPABILITIES }, 'admin-1');

      expect(prisma.aiModel.update.mock.calls[0][0].data).toMatchObject({
        enabled: true,
        capabilitySource: 'admin_override',
      });
    });

    it('allows disabling a deprecated model', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(row({ deprecatedAt: new Date(), enabled: true }));

      await expect(service.update(ID, { enabled: false }, 'admin-1')).resolves.toBeDefined();
    });

    it('404s for an unknown row', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(null);

      await expect(service.update(ID, { enabled: true }, 'admin-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('refresh', () => {
    it('enqueues through AiCatalogService.enqueueRefresh and audits', async () => {
      await expect(service.refresh('openai', 'admin-1')).resolves.toEqual({
        jobId: 'job-1',
        status: 'pending',
      });

      expect(catalog.enqueueRefresh).toHaveBeenCalledWith('openai', 'admin-1');
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: 'admin-1',
          action: 'ai_catalog:refresh_requested',
          targetType: 'ai_config',
          targetId: 'openai',
          meta: { provider: 'openai', jobId: 'job-1' },
        },
      });
    });

    it('409s when no admin key is stored', async () => {
      credentials.describe.mockResolvedValue(null);

      const error = await service.refresh('openai', 'admin-1').catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        details: { reason: 'AI_KEY_REQUIRED', provider: 'openai' },
      });
      expect(catalog.enqueueRefresh).not.toHaveBeenCalled();
    });

    it('enqueues with no admin key for a keyless provider (#448)', async () => {
      credentials.describe.mockResolvedValue(null);
      policy.providers.openai = { enabled: true, requiresKey: false };

      await expect(service.refresh('openai', 'admin-1')).resolves.toEqual({ jobId: 'job-1', status: 'pending' });
      expect(catalog.enqueueRefresh).toHaveBeenCalledWith('openai', 'admin-1');
    });

    it('404s for an unregistered provider', async () => {
      await expect(service.refresh('nope', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
