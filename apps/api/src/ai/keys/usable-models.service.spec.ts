import { AiConfigService, type AiPolicy } from '../config/ai-config.service';
import { AiError } from '../core/ai-error';
import { AiProviderRegistry } from '../core/provider-registry';
import { FakeAiProvider } from '../testing/fake-ai-provider';
import { createInMemoryAiKeysPrisma, type InMemoryAiKeysPrisma } from '../testing/in-memory-ai-keys-prisma';
import { AiKeyResolver } from './ai-key-resolver.service';
import { UsableModelsService } from './usable-models.service';

// =============================================================================
// UsableModelsService (issue #431) — usable = admin-enabled ∩ reachable, or
// admin-enabled under the org fallback; deprecated never.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const TEXT = {
  capabilities: ['responses', 'streaming', 'structured_output'],
  inputModalities: ['text'],
  outputModalities: ['text'],
};
const EMBED = { capabilities: ['embeddings'], inputModalities: ['text'], outputModalities: ['embedding'] };

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

describe('UsableModelsService', () => {
  let db: InMemoryAiKeysPrisma;
  let current: AiPolicy;
  let orgKeyStored: boolean;
  let getSecret: jest.Mock;
  let describeOrgKey: jest.Mock;
  let aiConfigWriters: Set<string>;
  let holdsAiConfigWrite: jest.Mock;
  let registry: AiProviderRegistry;
  let service: UsableModelsService;

  function addUserKey(userId: string, reachable: string[]) {
    db.keys.push({
      id: `key-${userId}`,
      userId,
      provider: 'openai',
      secret: 'ciphertext',
      hint: '••••abcd',
      verifiedAt: new Date(),
      lastErrorCode: null,
      reachableModelIds: reachable,
      reachableCheckedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  beforeEach(() => {
    db = createInMemoryAiKeysPrisma();
    db.addModel({ modelId: 'gpt-mini', displayName: 'GPT mini', capabilities: TEXT });
    db.addModel({ modelId: 'gpt-big', capabilities: TEXT });
    db.addModel({ modelId: 'gpt-off', enabled: false, capabilities: TEXT });
    db.addModel({ modelId: 'gpt-old', deprecatedAt: new Date('2026-02-01'), capabilities: TEXT });
    db.addModel({ modelId: 'embed-small', capabilities: EMBED });
    db.addModel({ modelId: 'weird', capabilities: { not: 'valid' } });

    current = policy();
    orgKeyStored = false;
    getSecret = jest.fn(async () => (orgKeyStored ? 'sk-org' : null));

    describeOrgKey = jest.fn(async () => (orgKeyStored ? { hint: 'x' } : null));
    aiConfigWriters = new Set();
    holdsAiConfigWrite = jest.fn(async (userId: string) => aiConfigWriters.has(userId));

    registry = new AiProviderRegistry();
    registry.register(new FakeAiProvider({ id: 'openai' }));
    const aiConfig = new AiConfigService(
      { getAiPolicy: jest.fn(async () => current) } as never,
      { getSecret, describe: describeOrgKey } as never,
      registry,
    );
    const resolver = new AiKeyResolver(
      { getDecrypted: jest.fn() } as never,
      aiConfig,
      { holdsAiConfigWrite } as never,
    );
    service = new UsableModelsService(db.prisma as never, aiConfig, registry, resolver);
  });

  describe('listForUser', () => {
    it('is enabled ∩ reachable with the user key, sorted, keySource user', async () => {
      addUserKey(USER, ['gpt-mini', 'gpt-off', 'gpt-old', 'embed-small', 'not-in-catalog']);

      const models = await service.listForUser(USER);

      expect(models.map((m) => m.modelId)).toEqual(['embed-small', 'gpt-mini']);
      expect(models.every((m) => m.keySource === 'user')).toBe(true);
      expect(models.find((m) => m.modelId === 'gpt-mini')).toEqual({
        provider: 'openai',
        modelId: 'gpt-mini',
        displayName: 'GPT mini',
        capabilities: TEXT,
        keySource: 'user',
      });
    });

    it('excludes deprecated models even when reachable', async () => {
      addUserKey(USER, ['gpt-old']);

      expect(await service.listForUser(USER)).toEqual([]);
    });

    it('with no key under byok, the provider contributes nothing — even with an org key', async () => {
      orgKeyStored = true;

      expect(await service.listForUser(USER)).toEqual([]);
    });

    it("a keyless provider (requiresKey: false, #448) offers every enabled model with no key, keySource 'none'", async () => {
      current = policy({
        providers: { ...policy().providers, openai: { enabled: true, requiresKey: false } as AiPolicy['providers']['openai'] },
      });

      const models = await service.listForUser(USER);

      // Like the org fallback: every enabled, non-deprecated model (an unclassified one included).
      expect(models.map((m) => m.modelId)).toEqual(['embed-small', 'gpt-big', 'gpt-mini', 'weird']);
      expect(models.every((m) => m.keySource === 'none')).toBe(true);
      await expect(service.assertUsable(USER, 'openai', 'gpt-big', ['responses'])).resolves.toMatchObject({
        keySource: 'none',
      });
      expect(getSecret).not.toHaveBeenCalled();
    });

    it('with no key under the fallback, every enabled model with keySource org', async () => {
      current = policy({ keyPolicy: 'byok_with_org_fallback' });
      orgKeyStored = true;

      const models = await service.listForUser(USER);

      expect(models.map((m) => m.modelId)).toEqual(['embed-small', 'gpt-big', 'gpt-mini', 'weird']);
      expect(models.every((m) => m.keySource === 'org')).toBe(true);
      expect(getSecret).not.toHaveBeenCalled();
    });

    it('under the fallback, a user WITH a key is still limited to what it reaches', async () => {
      current = policy({ keyPolicy: 'byok_with_org_fallback' });
      orgKeyStored = true;
      addUserKey(USER, ['gpt-big']);

      expect(await service.listForUser(USER)).toEqual([
        expect.objectContaining({ modelId: 'gpt-big', keySource: 'user' }),
      ]);
    });

    it('fallback without an org key lists nothing', async () => {
      current = policy({ keyPolicy: 'byok_with_org_fallback' });

      expect(await service.listForUser(USER)).toEqual([]);
    });

    it("uses the caller's own key row, not another user's", async () => {
      addUserKey(OTHER, ['gpt-mini', 'gpt-big']);

      expect(await service.listForUser(USER)).toEqual([]);
    });

    it('reports an unparseable capability record as empty lists', async () => {
      current = policy({ keyPolicy: 'byok_with_org_fallback' });
      orgKeyStored = true;

      const weird = (await service.listForUser(USER)).find((m) => m.modelId === 'weird');
      expect(weird?.capabilities).toEqual({ capabilities: [], inputModalities: [], outputModalities: [] });
    });

    describe('a holder of ai_config:write (#593)', () => {
      beforeEach(() => {
        aiConfigWriters.add(USER);
        orgKeyStored = true;
      });

      it.each(['byok', 'byok_with_org_fallback'] as const)(
        'with no key under %s, every enabled model with keySource org',
        async (keyPolicy) => {
          current = policy({ keyPolicy });

          const models = await service.listForUser(USER);

          expect(models.map((m) => m.modelId)).toEqual(['embed-small', 'gpt-big', 'gpt-mini', 'weird']);
          expect(models.every((m) => m.keySource === 'org')).toBe(true);
          expect(getSecret).not.toHaveBeenCalled();
        },
      );

      it('with a key of their own, the personal key overrides the org key', async () => {
        addUserKey(USER, ['gpt-big']);

        expect(await service.listForUser(USER)).toEqual([
          expect.objectContaining({ modelId: 'gpt-big', keySource: 'user' }),
        ]);
        expect(holdsAiConfigWrite).not.toHaveBeenCalled();
      });

      it('without an org key, lists nothing', async () => {
        orgKeyStored = false;

        expect(await service.listForUser(USER)).toEqual([]);
      });

      it('looks the permission up once per listing, not once per provider', async () => {
        registry.register(new FakeAiProvider({ id: 'anthropic' }));
        db.addModel({ provider: 'anthropic', modelId: 'claude-x', capabilities: TEXT });
        current = policy({
          providers: { ...policy().providers, anthropic: { enabled: true } },
        });

        const models = await service.listForUser(USER);

        expect(models.map((m) => `${m.provider}/${m.modelId}`)).toContain('anthropic/claude-x');
        expect(models.every((m) => m.keySource === 'org')).toBe(true);
        expect(holdsAiConfigWrite).toHaveBeenCalledTimes(1);
        expect(holdsAiConfigWrite).toHaveBeenCalledWith(USER);
      });

      it('does not extend to another user: a non-holder under byok still gets nothing, org key unread', async () => {
        expect(await service.listForUser(OTHER)).toEqual([]);
        expect(describeOrgKey).not.toHaveBeenCalled();
        expect(getSecret).not.toHaveBeenCalled();
      });
    });

    it('is empty while AI is off', async () => {
      addUserKey(USER, ['gpt-mini']);

      current = policy({ enabled: false });
      expect(await service.listForUser(USER)).toEqual([]);
    });

    it('is empty when the provider is disabled', async () => {
      addUserKey(USER, ['gpt-mini']);
      current = policy({ providers: { openai: { enabled: false }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } });

      expect(await service.listForUser(USER)).toEqual([]);
    });
  });

  describe('assertUsable', () => {
    const code = async (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error: unknown) => (error instanceof AiError ? error.code : String(error)),
      );

    it('passes an enabled, reachable model with the user key', async () => {
      addUserKey(USER, ['gpt-mini']);

      await expect(service.assertUsable(USER, 'openai', 'gpt-mini', 'responses')).resolves.toEqual({
        model: expect.objectContaining({ modelId: 'gpt-mini' }),
        keySource: 'user',
      });
    });

    it('AI_MODEL_NOT_ENABLED for unknown, disabled or deprecated models', async () => {
      addUserKey(USER, ['gpt-off', 'gpt-old']);

      expect(await code(service.assertUsable(USER, 'openai', 'nope'))).toBe('AI_MODEL_NOT_ENABLED');
      expect(await code(service.assertUsable(USER, 'openai', 'gpt-off'))).toBe('AI_MODEL_NOT_ENABLED');
      expect(await code(service.assertUsable(USER, 'openai', 'gpt-old'))).toBe('AI_MODEL_NOT_ENABLED');
    });

    it('AI_MODEL_NOT_REACHABLE when the user key cannot reach it', async () => {
      addUserKey(USER, ['gpt-mini']);

      expect(await code(service.assertUsable(USER, 'openai', 'gpt-big'))).toBe('AI_MODEL_NOT_REACHABLE');
    });

    it('AI_KEY_REQUIRED with no key under byok, even with an org key stored', async () => {
      orgKeyStored = true;

      expect(await code(service.assertUsable(USER, 'openai', 'gpt-mini'))).toBe('AI_KEY_REQUIRED');
    });

    it('a holder of ai_config:write is served by the org key under byok (#593)', async () => {
      aiConfigWriters.add(USER);
      orgKeyStored = true;

      await expect(service.assertUsable(USER, 'openai', 'gpt-big')).resolves.toMatchObject({
        keySource: 'org',
      });
      expect(await code(service.assertUsable(OTHER, 'openai', 'gpt-big'))).toBe('AI_KEY_REQUIRED');
    });

    it('org fallback serves any enabled model', async () => {
      current = policy({ keyPolicy: 'byok_with_org_fallback' });
      orgKeyStored = true;

      await expect(service.assertUsable(USER, 'openai', 'gpt-big')).resolves.toMatchObject({
        keySource: 'org',
      });
    });

    it('AI_CAPABILITY_UNSUPPORTED when the model lacks a needed capability', async () => {
      addUserKey(USER, ['embed-small', 'gpt-mini']);

      expect(await code(service.assertUsable(USER, 'openai', 'embed-small', 'responses'))).toBe(
        'AI_CAPABILITY_UNSUPPORTED',
      );
      expect(
        await code(service.assertUsable(USER, 'openai', 'gpt-mini', ['responses', 'reasoning'])),
      ).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(
        await code(service.assertUsable(USER, 'openai', 'gpt-mini', ['responses', 'structured_output'])),
      ).toBe('ok');
    });

    it('AI_DISABLED / AI_PROVIDER_DISABLED before anything else', async () => {
      addUserKey(USER, ['gpt-mini']);

      current = policy({ providers: { openai: { enabled: false }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } });
      expect(await code(service.assertUsable(USER, 'openai', 'gpt-mini'))).toBe('AI_PROVIDER_DISABLED');
    });
  });
});
