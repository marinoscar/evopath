import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_USER,
  type AiRuntimeHarness,
  type AiRuntimeHarnessOptions,
} from '../../ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../ai/testing/fake-ai-provider';
import { TrainingModelResolver } from './training-model-resolver.service';

// The resolver over the real UsableModelsService, AiConfigService,
// AiKeyResolver and provider registry (the AI runtime harness), so the facts
// it gathers are the ones production computes.

const HOSTED = {
  ...FAKE_TEXT_MODEL_CAPABILITIES,
  capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools' as const],
};

function build(opts: AiRuntimeHarnessOptions = {}): { harness: AiRuntimeHarness; resolver: TrainingModelResolver } {
  const harness = createAiRuntimeHarness(opts);
  const resolver = new TrainingModelResolver(
    harness.prisma as never,
    harness.aiConfig,
    harness.registry,
    harness.resolver,
    harness.usableModels,
  );

  return { harness, resolver };
}

describe('TrainingModelResolver', () => {
  it('auto-picks the usable capable model for every non-researcher role', async () => {
    const { resolver } = build();
    const all = await resolver.resolveAll(HARNESS_USER);

    for (const role of ['planner', 'critic', 'evaluator'] as const) {
      expect(all[role]).toMatchObject({ state: 'auto', model: { provider: 'openai', modelId: HARNESS_MODEL, keySource: 'user' } });
    }
    // The default fake model does not declare hosted_tools.
    expect(all.researcher.state).toBe('missing_capability');
  });

  it('researcher: web_search_disabled while the switch is off, auto once it is on', async () => {
    const models = [{ modelId: 'hosted', capabilities: HOSTED }];

    expect((await build({ models }).resolver.resolve(HARNESS_USER, 'researcher')).state).toBe('web_search_disabled');
    expect(
      await build({ models, policy: { hostedTools: { web_search: true } } }).resolver.resolve(HARNESS_USER, 'researcher'),
    ).toMatchObject({ state: 'auto', model: { modelId: 'hosted' } });
  });

  it('missing_capability lists a disabled capable model as a candidate', async () => {
    const { resolver } = build({
      models: [
        { modelId: HARNESS_MODEL, capabilities: FAKE_TEXT_MODEL_CAPABILITIES },
        { modelId: 'hosted-off', capabilities: HOSTED, enabled: false },
      ],
      policy: { hostedTools: { web_search: true } },
    });

    expect(await resolver.resolve(HARNESS_USER, 'researcher')).toMatchObject({
      state: 'missing_capability',
      candidates: [{ provider: 'openai', modelId: 'hosted-off', enabled: false }],
      fix: 'admin',
    });
  });

  it('no_key without any key, no_models with a key that reaches nothing', async () => {
    expect((await build({ userKey: false }).resolver.resolve(HARNESS_USER, 'planner')).state).toBe('no_key');
    expect((await build({ reachable: [] }).resolver.resolve(HARNESS_USER, 'planner')).state).toBe('no_models');
  });

  it('ai_disabled for every role while the kill switch is off', async () => {
    const { harness, resolver } = build();
    harness.setPolicy({ enabled: false });

    const all = await resolver.resolveAll(HARNESS_USER);

    expect(Object.values(all).map((r) => r.state)).toEqual(['ai_disabled', 'ai_disabled', 'ai_disabled', 'ai_disabled']);
  });

  it('reads the stored taskModels preference', async () => {
    const { harness, resolver } = build();
    (harness.prisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
      value: {
        ai: {
          defaultModel: null,
          taskModels: { planner: { provider: 'openai', modelId: HARNESS_MODEL, reasoningEffort: 'low' } },
        },
      },
    });

    expect(await resolver.resolve(HARNESS_USER, 'planner')).toMatchObject({
      state: 'ready',
      requestedEffort: 'low',
      effectiveEffort: 'low',
    });
  });

  it('an invalid stored ai namespace is ignored rather than failing the read', async () => {
    const { harness, resolver } = build();
    (harness.prisma.userSettings.findUnique as jest.Mock).mockResolvedValue({ value: { ai: { taskModels: 'bad' } } });

    expect((await resolver.resolve(HARNESS_USER, 'planner')).state).toBe('auto');
  });
});
