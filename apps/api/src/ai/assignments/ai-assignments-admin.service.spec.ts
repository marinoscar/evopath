import { BadRequestException, ConflictException } from '@nestjs/common';

import type { SystemAiValue } from '../../common/schemas/settings.schema';
import type { AiModelCapabilities } from '../core/capabilities';
import { AiProviderRegistry } from '../core/provider-registry';
import { FakeAiProvider } from '../testing/fake-ai-provider';
import { AiAssignmentsAdminService, diffAssignmentFields, normalize } from './ai-assignments-admin.service';
import type { UpdateAiAssignmentsInput } from './dto/ai-assignments.dto';

// PUT validation (every refusal code, all reported at once, nothing written),
// the GET's eligible models and warnings, the audit row and If-Match (#173).

const VISION: AiModelCapabilities = {
  capabilities: ['responses', 'structured_output', 'vision_input', 'reasoning'],
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  reasoningEfforts: ['low', 'high'],
};
const TEXT: AiModelCapabilities = {
  capabilities: ['responses', 'structured_output'],
  inputModalities: ['text'],
  outputModalities: ['text'],
};

interface Row {
  provider: string;
  modelId: string;
  displayName: string | null;
  capabilities: AiModelCapabilities;
  enabled: boolean;
  deprecatedAt: Date | null;
}

const row = (modelId: string, capabilities: AiModelCapabilities, over: Partial<Row> = {}): Row => ({
  provider: 'openai',
  modelId,
  displayName: `${modelId} name`,
  capabilities,
  enabled: true,
  deprecatedAt: null,
  ...over,
});

function policy(over: Partial<SystemAiValue> = {}): SystemAiValue {
  return {
    enabled: true,
    keyPolicy: 'byok',
    providers: {
      openai: { enabled: true },
      anthropic: { enabled: false },
      gemini: { enabled: false },
      'azure-openai': { enabled: false },
      'openai-compatible': { enabled: false },
    },
    defaults: { allowBackgroundRuns: true, allowRealtime: false },
    logPromptContent: false,
    usageRetentionDays: 180,
    hostedTools: { web_search: false, file_search: false, code_interpreter: false, image_generation: false, mcp: false, mcpAllowedHosts: [] },
    limits: {},
    ...over,
  };
}

const body = (over: Partial<UpdateAiAssignmentsInput> = {}): UpdateAiAssignmentsInput => ({
  default: null,
  features: {},
  ...over,
});

describe('AiAssignmentsAdminService', () => {
  let stored: SystemAiValue;
  let catalog: Row[];
  let prisma: { systemSettings: { findUnique: jest.Mock }; auditEvent: { create: jest.Mock }; aiModel: { findMany: jest.Mock } };
  let systemSettings: { patchSettings: jest.Mock };
  let aiConfig: { resolve: jest.Mock; invalidateCache: jest.Mock };
  let service: AiAssignmentsAdminService;

  beforeEach(() => {
    stored = policy();
    catalog = [
      row('vision-1', VISION),
      row('text-1', TEXT),
      row('vision-off', VISION, { enabled: false }),
      row('vision-old', VISION, { deprecatedAt: new Date() }),
      row('claude-vision', VISION, { provider: 'anthropic' }),
    ];
    prisma = {
      systemSettings: { findUnique: jest.fn().mockResolvedValue({ version: 7, updatedAt: new Date('2026-09-30T00:00:00Z'), updatedByUser: null }) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
      aiModel: { findMany: jest.fn(async () => catalog) },
    };
    systemSettings = {
      patchSettings: jest.fn(async (dto: { ai: Partial<SystemAiValue> }) => {
        stored = { ...stored, ...dto.ai };
      }),
    };
    aiConfig = { resolve: jest.fn(async () => stored), invalidateCache: jest.fn() };
    const registry = new AiProviderRegistry();
    registry.register(new FakeAiProvider({ id: 'openai' }));
    registry.register(new FakeAiProvider({ id: 'anthropic' }));
    service = new AiAssignmentsAdminService(prisma as never, systemSettings as never, aiConfig as never, registry);
  });

  async function refusal(input: UpdateAiAssignmentsInput) {
    const error = await service.replace(input, 'admin-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { details: { reason: string; errors: Array<Record<string, unknown>> } }).details;
  }

  describe('replace', () => {
    it('stores a valid body, drops unassigned features, invalidates the cache and audits field names only', async () => {
      const order: string[] = [];
      aiConfig.invalidateCache.mockImplementation(() => order.push('invalidate'));
      prisma.auditEvent.create.mockImplementation(async () => order.push('audit'));

      const view = await service.replace(
        body({
          default: { provider: 'openai', modelId: 'text-1' },
          features: {
            gym_scan: { provider: 'openai', modelId: 'vision-1' },
            workout_prefill: null,
            'training.planner': { provider: 'openai', modelId: 'vision-1', reasoningEffort: 'high' },
          },
        }),
        'admin-1',
        7,
      );

      expect(systemSettings.patchSettings).toHaveBeenCalledWith(
        {
          ai: {
            assignments: {
              default: { provider: 'openai', modelId: 'text-1' },
              features: {
                gym_scan: { provider: 'openai', modelId: 'vision-1' },
                'training.planner': { provider: 'openai', modelId: 'vision-1', reasoningEffort: 'high' },
              },
            },
          },
        },
        'admin-1',
        7,
      );
      expect(order).toEqual(['invalidate', 'audit']);
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: 'admin-1',
          action: 'ai_config:assignments',
          targetType: 'ai_config',
          targetId: 'assignments',
          meta: { changedFields: ['default', 'features.gym_scan', 'features.training.planner'] },
        },
      });
      expect(JSON.stringify(prisma.auditEvent.create.mock.calls)).not.toContain('vision-1');
      expect(view.assignments.features.gym_scan).toEqual({ provider: 'openai', modelId: 'vision-1' });
      expect(view.assignments.features.workout_prefill).toBeNull();
    });

    it('refuses a stale If-Match with 409 before validating or writing', async () => {
      await expect(service.replace(body(), 'admin-1', 3)).rejects.toBeInstanceOf(ConflictException);
      expect(systemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown model', { provider: 'openai', modelId: 'nope' }, 'AI_ASSIGNMENT_MODEL_NOT_FOUND'],
      ['a disabled model', { provider: 'openai', modelId: 'vision-off' }, 'AI_ASSIGNMENT_MODEL_DISABLED'],
      ['a deprecated model', { provider: 'openai', modelId: 'vision-old' }, 'AI_ASSIGNMENT_MODEL_DEPRECATED'],
      ['a model of a disabled provider', { provider: 'anthropic', modelId: 'claude-vision' }, 'AI_ASSIGNMENT_PROVIDER_DISABLED'],
      ['a model without vision', { provider: 'openai', modelId: 'text-1' }, 'AI_ASSIGNMENT_MODEL_INCAPABLE'],
    ])('refuses %s for a photo feature with 400 and writes nothing', async (_label, assignment, code) => {
      const details = await refusal(body({ features: { gym_scan: assignment } }));

      expect(details.reason).toBe('AI_ASSIGNMENT_INVALID');
      expect(details.errors).toEqual([expect.objectContaining({ field: 'features.gym_scan', ...assignment, code })]);
      expect(systemSettings.patchSettings).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('names what an incapable model lacks', async () => {
      const details = await refusal(body({ features: { body_metric_reading: { provider: 'openai', modelId: 'text-1' } } }));

      expect(details.errors[0]).toMatchObject({ missing: ['vision_input', 'input:image'] });
    });

    it('refuses a non-OpenAI researcher as incapable (provider restriction)', async () => {
      stored = policy({ providers: { ...policy().providers, anthropic: { enabled: true } } });
      catalog.push(row('claude-hosted', { ...TEXT, capabilities: [...TEXT.capabilities, 'hosted_tools'] }, { provider: 'anthropic' }));

      const details = await refusal(body({ features: { 'training.researcher': { provider: 'anthropic', modelId: 'claude-hosted' } } }));

      expect(details.errors[0]).toMatchObject({ code: 'AI_ASSIGNMENT_MODEL_INCAPABLE', missing: expect.arrayContaining(['provider:anthropic']) });
    });

    it('refuses a reasoning effort on a photo feature', async () => {
      const details = await refusal(body({ features: { gym_scan: { provider: 'openai', modelId: 'vision-1', reasoningEffort: 'high' } } }));

      expect(details.errors[0]).toMatchObject({ code: 'AI_ASSIGNMENT_EFFORT_UNSUPPORTED' });
    });

    it('the default must be enabled but need not serve every feature', async () => {
      await expect(service.replace(body({ default: { provider: 'openai', modelId: 'text-1' } }), 'admin-1')).resolves.toBeDefined();

      const details = await refusal(body({ default: { provider: 'openai', modelId: 'vision-off' } }));
      expect(details.errors).toEqual([expect.objectContaining({ field: 'default', code: 'AI_ASSIGNMENT_MODEL_DISABLED' })]);
    });

    it('reports every refused assignment in one 400', async () => {
      const details = await refusal(
        body({
          default: { provider: 'openai', modelId: 'nope' },
          features: { gym_scan: { provider: 'openai', modelId: 'text-1' }, 'training.critic': { provider: 'openai', modelId: 'vision-off' } },
        }),
      );

      expect(details.errors.map((e) => e.field)).toEqual(['default', 'features.gym_scan', 'features.training.critic']);
    });
  });

  describe('describe', () => {
    it('lists eligible models per feature and every feature id, with version provenance', async () => {
      const view = await service.describe();

      expect(Object.keys(view.assignments.features)).toHaveLength(13);
      expect(view.default.eligibleModels.map((m) => m.modelId)).toEqual(['text-1', 'vision-1']);
      const gym = view.features.find((f) => f.featureId === 'gym_scan')!;
      expect(gym).toMatchObject({ group: 'photo', defaultReasoningEffort: null, assignment: null, warning: null });
      expect(gym.eligibleModels).toEqual([
        { provider: 'openai', modelId: 'vision-1', displayName: 'vision-1 name', reasoningEfforts: ['low', 'high'] },
      ]);
      expect(view.features.find((f) => f.featureId === 'training.planner')).toMatchObject({ defaultReasoningEffort: 'high' });
      expect(view.version).toBe(7);
    });

    it('warns about a stored assignment that is no longer enabled or capable', async () => {
      stored = policy({
        assignments: {
          default: { provider: 'openai', modelId: 'vision-old' },
          features: { gym_scan: { provider: 'openai', modelId: 'vision-off' }, workout_prefill: { provider: 'openai', modelId: 'text-1' } },
        },
      });

      const view = await service.describe();

      expect(view.default.warning).toMatchObject({ code: 'AI_ASSIGNMENT_MODEL_DEPRECATED' });
      expect(view.features.find((f) => f.featureId === 'gym_scan')!.warning).toMatchObject({ code: 'AI_ASSIGNMENT_MODEL_DISABLED' });
      expect(view.features.find((f) => f.featureId === 'workout_prefill')!.warning).toMatchObject({
        code: 'AI_ASSIGNMENT_MODEL_INCAPABLE',
        missing: ['vision_input', 'input:image'],
      });
    });
  });

  it('normalize and diffAssignmentFields', () => {
    const next = normalize(body({ features: { gym_scan: { provider: 'openai', modelId: 'a', reasoningEffort: null } } }));
    expect(next).toEqual({ default: null, features: { gym_scan: { provider: 'openai', modelId: 'a' } } });
    expect(diffAssignmentFields(next, next)).toEqual([]);
    expect(diffAssignmentFields(next, { default: null, features: {} })).toEqual(['features.gym_scan']);
  });
});
