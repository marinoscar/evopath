import { AiError } from '../core/ai-error';
import { AiProviderRegistry } from '../core/provider-registry';
import { FakeAiProvider } from '../testing/fake-ai-provider';
import { AI_POLICY_CACHE_MS, AiConfigService, type AiPolicy } from './ai-config.service';

function policy(overrides: Partial<AiPolicy> = {}): AiPolicy {
  return {
    enabled: true,
    keyPolicy: 'byok',
    providers: { openai: { enabled: true }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } },
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

describe('AiConfigService', () => {
  let getAiPolicy: jest.Mock;
  let getSecret: jest.Mock;
  let describe_: jest.Mock;
  let registry: AiProviderRegistry;
  let service: AiConfigService;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    getAiPolicy = jest.fn().mockResolvedValue(policy());
    getSecret = jest.fn().mockResolvedValue('sk-org-key-123');
    describe_ = jest.fn().mockResolvedValue(null);
    registry = new AiProviderRegistry();
    registry.register(new FakeAiProvider({ id: 'openai' }));
    service = new AiConfigService(
      { getAiPolicy } as never,
      { getSecret, describe: describe_ } as never,
      registry,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('resolve', () => {
    it('reuses a read within the cache window', async () => {
      await service.resolve();
      now += AI_POLICY_CACHE_MS - 1;
      await service.resolve();

      expect(getAiPolicy).toHaveBeenCalledTimes(1);
    });

    it('reads again once the window has passed', async () => {
      await service.resolve();
      now += AI_POLICY_CACHE_MS;
      await service.resolve();

      expect(getAiPolicy).toHaveBeenCalledTimes(2);
    });

    it('bypasses the cache with fresh: true', async () => {
      await service.resolve();
      await service.resolve({ fresh: true });

      expect(getAiPolicy).toHaveBeenCalledTimes(2);
    });

    it('reads again immediately after invalidateCache()', async () => {
      getAiPolicy.mockResolvedValueOnce(policy({ enabled: false }));
      expect(await service.isEnabled()).toBe(false);

      getAiPolicy.mockResolvedValueOnce(policy({ enabled: true }));
      // Still cached: the toggle has not been observed yet.
      expect(await service.isEnabled()).toBe(false);

      service.invalidateCache();
      expect(await service.isEnabled()).toBe(true);
    });
  });

  describe('assertEnabled', () => {
    it('passes when enabled', async () => {
      await expect(service.assertEnabled()).resolves.toBeUndefined();
    });

    it('throws AI_DISABLED (403) when the kill switch is off', async () => {
      getAiPolicy.mockResolvedValue(policy({ enabled: false }));

      const error = await service.assertEnabled().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).code).toBe('AI_DISABLED');
      expect((error as AiError).getStatus()).toBe(403);
    });
  });

  describe('assertProviderEnabled', () => {
    it('returns the provider slot when everything agrees', async () => {
      getAiPolicy.mockResolvedValue(
        policy({ providers: { openai: { enabled: true, baseUrl: 'https://proxy.example.com' }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } }),
      );

      await expect(service.assertProviderEnabled('openai')).resolves.toEqual({
        enabled: true,
        baseUrl: 'https://proxy.example.com',
      });
    });

    it('throws AI_DISABLED before anything else', async () => {
      getAiPolicy.mockResolvedValue(policy({ enabled: false }));

      await expect(service.assertProviderEnabled('openai')).rejects.toMatchObject({
        code: 'AI_DISABLED',
      });
    });

    it('throws AI_PROVIDER_DISABLED when the provider is off in settings', async () => {
      getAiPolicy.mockResolvedValue(policy({ providers: { openai: { enabled: false }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } }));

      await expect(service.assertProviderEnabled('openai')).rejects.toMatchObject({
        code: 'AI_PROVIDER_DISABLED',
      });
    });

    it('throws AI_PROVIDER_DISABLED when no adapter is registered', async () => {
      service = new AiConfigService(
        { getAiPolicy } as never,
        { getSecret, describe: describe_ } as never,
        new AiProviderRegistry(),
      );

      await expect(service.assertProviderEnabled('openai')).rejects.toMatchObject({
        code: 'AI_PROVIDER_DISABLED',
      });
    });

    it('throws AI_PROVIDER_DISABLED for an id with no settings slot', async () => {
      registry.register(new FakeAiProvider({ id: 'other' }));

      await expect(service.assertProviderEnabled('other')).rejects.toMatchObject({
        code: 'AI_PROVIDER_DISABLED',
      });
      // Not fooled by an inherited property name.
      await expect(service.assertProviderEnabled('toString')).rejects.toMatchObject({
        code: 'AI_PROVIDER_DISABLED',
      });
    });
  });

  describe('getOrgKey', () => {
    it("reads (purpose 'ai', name providerId) and never caches it", async () => {
      await service.getOrgKey('openai');
      await service.getOrgKey('openai');

      expect(getSecret).toHaveBeenCalledTimes(2);
      expect(getSecret).toHaveBeenCalledWith('ai', 'openai');
    });

    it('returns null when no key is stored', async () => {
      getSecret.mockResolvedValue(null);

      await expect(service.getOrgKey('openai')).resolves.toBeNull();
    });
  });

  describe('hasOrgKey', () => {
    it('answers from the credential metadata without decrypting', async () => {
      await expect(service.hasOrgKey('openai')).resolves.toBe(false);

      describe_.mockResolvedValue({ hint: '••••1234' });
      await expect(service.hasOrgKey('openai')).resolves.toBe(true);

      expect(describe_).toHaveBeenCalledWith('ai', 'openai');
      expect(getSecret).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit', () => {
    it('warms the cache without reading any key', async () => {
      service.onModuleInit();
      await new Promise((resolve) => setImmediate(resolve));
      await service.resolve();

      expect(getAiPolicy).toHaveBeenCalledTimes(1);
      expect(getSecret).not.toHaveBeenCalled();
    });

    it('swallows a failed read', async () => {
      getAiPolicy.mockRejectedValueOnce(new Error('db down'));

      expect(() => service.onModuleInit()).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  describe('describePublic', () => {
    it('surfaces defaults.allowBackgroundRuns while AI is on', async () => {
      getAiPolicy.mockResolvedValue(policy({ defaults: { allowBackgroundRuns: false, allowRealtime: false } }));

      await expect(service.describePublic()).resolves.toMatchObject({ allowBackgroundRuns: false });

      getAiPolicy.mockResolvedValue(policy({ defaults: { allowBackgroundRuns: false, allowRealtime: true } }));
      service.invalidateCache();
      await expect(service.describePublic()).resolves.toMatchObject({ allowRealtime: true });
    });

    it('publishes each hosted tool switch as a boolean, never the MCP host allowlist (#442)', async () => {
      getAiPolicy.mockResolvedValue(
        policy({
          hostedTools: {
            web_search: true,
            file_search: false,
            code_interpreter: true,
            image_generation: false,
            mcp: true,
            mcpAllowedHosts: ['secret-host.example.com'],
          },
        }),
      );

      const view = await service.describePublic();

      expect(view.hostedTools).toEqual({
        web_search: true,
        file_search: false,
        code_interpreter: true,
        image_generation: false,
        mcp: true,
      });
      expect(JSON.stringify(view)).not.toContain('secret-host');
    });

    it('reports every hosted tool off while AI is off, whatever is stored (#442)', async () => {
      getAiPolicy.mockResolvedValue(
        policy({
          enabled: false,
          hostedTools: {
            web_search: true,
            file_search: true,
            code_interpreter: true,
            image_generation: true,
            mcp: true,
            mcpAllowedHosts: [],
          },
        }),
      );

      expect(Object.values((await service.describePublic()).hostedTools)).toEqual([false, false, false, false, false]);
    });

    it('returns no providers while AI is off', async () => {
      getAiPolicy.mockResolvedValue(policy({ enabled: false, keyPolicy: 'byok_with_org_fallback' }));

      await expect(service.describePublic()).resolves.toEqual({
        enabled: false,
        keyPolicy: 'byok_with_org_fallback',
        allowBackgroundRuns: false,
        allowRealtime: false,
        hostedTools: { web_search: false, file_search: false, code_interpreter: false, image_generation: false, mcp: false },
        providers: [],
      });
      expect(describe_).not.toHaveBeenCalled();
    });

    it('lists registered providers with enabled and hasOrgKey, never a key or hint', async () => {
      describe_.mockResolvedValue({ hint: '••••-123', updatedAt: new Date() });

      const view = await service.describePublic();

      expect(view).toEqual({
        enabled: true,
        keyPolicy: 'byok',
        allowBackgroundRuns: true,
        allowRealtime: false,
        hostedTools: { web_search: false, file_search: false, code_interpreter: false, image_generation: false, mcp: false },
        providers: [
          { id: 'openai', displayName: 'Fake AI', enabled: true, hasOrgKey: true, supportsPreviousResponseId: true, requiresKey: true },
        ],
      });
      expect(JSON.stringify(view)).not.toContain('123');
      expect(getSecret).not.toHaveBeenCalled();
    });

    it('reports a registered provider with no settings slot as disabled', async () => {
      registry.register(new FakeAiProvider({ id: 'other', displayName: 'Other' }));

      const view = await service.describePublic();

      expect(view.providers).toContainEqual({
        id: 'other',
        displayName: 'Other',
        enabled: false,
        hasOrgKey: false,
        supportsPreviousResponseId: true,
        requiresKey: true,
      });
    });

    it('publishes supportsPreviousResponseId from the adapter declaration (#446)', async () => {
      registry.register(new FakeAiProvider({ id: 'stateless', displayName: 'Stateless', supportsPreviousResponseId: false }));

      const view = await service.describePublic();

      expect(view.providers.find((p) => p.id === 'stateless')).toMatchObject({ supportsPreviousResponseId: false });
      expect(view.providers.find((p) => p.id === 'openai')).toMatchObject({ supportsPreviousResponseId: true });
    });
  });

  describe('describePublic — keyless providers (#448)', () => {
    it('publishes requiresKey: false for a slot the administrator marked keyless', async () => {
      getAiPolicy.mockResolvedValue(
        policy({
          providers: {
            ...policy().providers,
            openai: { enabled: true, requiresKey: false } as AiPolicy['providers']['openai'],
          },
        }),
      );

      const view = await service.describePublic();

      expect(view.providers.find((p) => p.id === 'openai')).toMatchObject({ requiresKey: false });
    });
  });
});
