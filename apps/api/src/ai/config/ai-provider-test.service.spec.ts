import { NotFoundException } from '@nestjs/common';

import type { SystemAiValue } from '../../common/schemas/settings.schema';
import { AiError } from '../core/ai-error';
import { AI_KEYLESS_API_KEY } from '../core/provider-adapter.interface';
import { AiProviderRegistry } from '../core/provider-registry';
import { FAKE_TEXT_MODEL_CAPABILITIES, FakeAiProvider } from '../testing/fake-ai-provider';
import { AiConfigAdminService } from './ai-config-admin.service';
import { AI_SMOKE_MAX_OUTPUT_TOKENS, AiProviderTestService } from './ai-provider-test.service';

const STORED_KEY = 'sk-stored-admin-key-0001';
const SUBMITTED_KEY = 'sk-submitted-key-0002';

function policy(overrides: Partial<SystemAiValue> = {}): SystemAiValue {
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

describe('AiProviderTestService', () => {
  let prisma: { aiModel: { findMany: jest.Mock }; auditEvent: { create: jest.Mock } };
  let credentials: { getSecret: jest.Mock };
  let aiConfig: { resolve: jest.Mock };
  let fake: FakeAiProvider;
  let service: AiProviderTestService;

  function build(provider: FakeAiProvider) {
    fake = provider;
    const registry = new AiProviderRegistry();
    registry.register(fake);
    const admin = new AiConfigAdminService(
      {} as never,
      {} as never,
      {} as never,
      registry,
      aiConfig as never,
    );
    service = new AiProviderTestService(
      prisma as never,
      credentials as never,
      aiConfig as never,
      admin,
    );
  }

  beforeEach(() => {
    prisma = {
      aiModel: { findMany: jest.fn().mockResolvedValue([]) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    credentials = { getSecret: jest.fn().mockResolvedValue(STORED_KEY) };
    aiConfig = { resolve: jest.fn().mockResolvedValue(policy()) };
    build(
      new FakeAiProvider({
        id: 'openai',
        validKeys: [STORED_KEY, SUBMITTED_KEY],
        models: ['gpt-big', 'gpt-mini', 'gpt-nano'],
      }),
    );
  });

  it('uses the stored key when none is submitted, and skips the smoke test with no enabled model', async () => {
    const result = await service.test('openai', {}, 'admin-1');

    expect(result).toMatchObject({
      success: true,
      provider: 'openai',
      usedStoredKey: true,
      modelCount: 3,
      smokeModelId: null,
    });
    expect(result.checks.map((c) => [c.id, c.status, c.code])).toEqual([
      ['credentials', 'passed', 'ok'],
      ['list_models', 'passed', 'ok'],
      ['responses_smoke', 'skipped', 'no_eligible_model'],
    ]);
    expect(credentials.getSecret).toHaveBeenCalledWith('ai', 'openai');
    expect(fake.apiKeys).toEqual([STORED_KEY]);
  });

  it('uses a submitted key and baseUrl without reading the stored key', async () => {
    const result = await service.test(
      'openai',
      { apiKey: SUBMITTED_KEY, baseUrl: 'https://gw.example.com' },
      'admin-1',
    );

    expect(result.usedStoredKey).toBe(false);
    expect(credentials.getSecret).not.toHaveBeenCalled();
    expect(fake.apiKeys).toEqual([SUBMITTED_KEY]);
    expect(fake.calls.every((c) => c.baseUrl === 'https://gw.example.com')).toBe(true);
  });

  it('falls back to the stored baseUrl', async () => {
    aiConfig.resolve.mockResolvedValue(
      policy({ providers: { openai: { enabled: true, baseUrl: 'https://stored.example.com' }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } }),
    );

    await service.test('openai', {}, 'admin-1');

    expect(fake.calls[0].baseUrl).toBe('https://stored.example.com');
  });

  it('runs the smoke call against the cheapest-looking enabled, visible text model', async () => {
    prisma.aiModel.findMany.mockResolvedValue([
      { modelId: 'gpt-big', capabilities: FAKE_TEXT_MODEL_CAPABILITIES },
      { modelId: 'gpt-mini', capabilities: FAKE_TEXT_MODEL_CAPABILITIES },
      { modelId: 'gpt-unlisted-nano', capabilities: FAKE_TEXT_MODEL_CAPABILITIES },
      { modelId: 'gpt-nano', capabilities: { capabilities: [] } },
    ]);

    const result = await service.test('openai', {}, 'admin-1');

    expect(prisma.aiModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: 'openai', enabled: true, deprecatedAt: null } }),
    );
    expect(result.smokeModelId).toBe('gpt-mini');
    expect(result.checks[2]).toMatchObject({ status: 'passed', code: 'ok' });
    expect(fake.callsTo('responses.create')[0].request).toMatchObject({
      model: 'gpt-mini',
      maxOutputTokens: AI_SMOKE_MAX_OUTPUT_TOKENS,
    });
    expect(result.success).toBe(true);
  });

  it('answers (never throws) for a rejected key, with later checks not attempted', async () => {
    const result = await service.test('openai', { apiKey: 'sk-bad-key-0000' }, 'admin-1');

    expect(result.success).toBe(false);
    expect(result.checks.map((c) => [c.status, c.code])).toEqual([
      ['failed', 'AI_KEY_INVALID'],
      ['skipped', 'not_attempted'],
      ['skipped', 'not_attempted'],
    ]);
  });

  it('reports every check as not_configured when there is no key at all', async () => {
    credentials.getSecret.mockResolvedValue(null);

    const result = await service.test('openai', { apiKey: '' }, 'admin-1');

    expect(result.success).toBe(false);
    expect(result.checks.every((c) => c.status === 'skipped' && c.code === 'not_configured')).toBe(
      true,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('tests a keyless provider (#448) with no key, passing the slot settings', async () => {
    credentials.getSecret.mockResolvedValue(null);
    aiConfig.resolve.mockResolvedValue(
      policy({
        providers: {
          ...policy().providers,
          openai: { enabled: true, baseUrl: 'http://ollama.internal:11434/v1', requiresKey: false, apiStyle: 'chat_completions' } as SystemAiValue['providers']['openai'],
        },
      }),
    );
    build(new FakeAiProvider({ id: 'openai', models: ['llama3'] }));

    const result = await service.test('openai', {}, 'admin-1');

    expect(result.usedStoredKey).toBe(false);
    expect(result.checks[0]).toMatchObject({ status: 'passed' });
    expect(fake.calls.every((call) => call.apiKey === AI_KEYLESS_API_KEY)).toBe(true);
    expect(fake.calls[0]).toMatchObject({
      baseUrl: 'http://ollama.internal:11434/v1',
      providerSettings: { requiresKey: false, apiStyle: 'chat_completions' },
    });
  });

  it('maps a thrown adapter error to its AI code and redacts the key from the message', async () => {
    jest
      .spyOn(fake, 'listModels')
      .mockRejectedValue(new AiError('AI_RATE_LIMITED', `slow down, key ${STORED_KEY}`));

    const result = await service.test('openai', {}, 'admin-1');

    expect(result.checks[1]).toMatchObject({ status: 'failed', code: 'AI_RATE_LIMITED' });
    expect(result.checks[1].error).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain(STORED_KEY);
  });

  it('wraps a raw error as AI_PROVIDER_UNAVAILABLE', async () => {
    jest.spyOn(fake, 'verifyKey').mockRejectedValue(new TypeError(`fetch failed ${STORED_KEY}`));

    const result = await service.test('openai', {}, 'admin-1');

    expect(result.checks[0]).toMatchObject({ status: 'failed', code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain(STORED_KEY);
  });

  it('skips the smoke test as not_supported for an adapter with no responses port', async () => {
    build(new FakeAiProvider({ id: 'openai', responsesPort: false }));

    const result = await service.test('openai', {}, 'admin-1');

    expect(result.checks[2]).toMatchObject({ status: 'skipped', code: 'not_supported' });
    expect(result.success).toBe(true);
  });

  it('audits every attempt with codes only', async () => {
    await service.test('openai', { apiKey: SUBMITTED_KEY }, 'admin-1');

    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: 'admin-1',
        action: 'ai_config:test',
        targetType: 'ai_config',
        targetId: 'openai',
        meta: {
          provider: 'openai',
          success: true,
          usedStoredKey: false,
          checks: [
            { id: 'credentials', status: 'passed', code: 'ok' },
            { id: 'list_models', status: 'passed', code: 'ok' },
            { id: 'responses_smoke', status: 'skipped', code: 'no_eligible_model' },
          ],
        },
      },
    });
    expect(JSON.stringify(prisma.auditEvent.create.mock.calls)).not.toContain(SUBMITTED_KEY);
  });

  it('404s for a provider with no adapter', async () => {
    await expect(service.test('nope', {}, 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
