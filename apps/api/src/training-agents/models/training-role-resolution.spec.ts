import type { AiCapability, AiReasoningEffort } from '../../ai/core/capabilities';
import type { UsableAiModel } from '../../ai/keys/dto/usable-ai-model.dto';
import { TRAINING_AGENT_ROLES } from '../../common/schemas/settings.schema';
import {
  type CatalogModel,
  effectiveEffortFor,
  pickAuto,
  resolveRole,
  type RoleResolutionFacts,
} from './training-role-resolution';

// The role resolver's state table, precedence, auto pick and effort clamping,
// over crafted facts (no database, no provider).

const BASE: AiCapability[] = ['responses', 'structured_output'];
const RESEARCH: AiCapability[] = [...BASE, 'hosted_tools'];

function model(
  modelId: string,
  capabilities: AiCapability[],
  opts: { provider?: string; efforts?: AiReasoningEffort[]; contextWindow?: number; keySource?: UsableAiModel['keySource'] } = {},
): UsableAiModel {
  return {
    provider: opts.provider ?? 'openai',
    modelId,
    displayName: `${modelId} display`,
    keySource: opts.keySource ?? 'user',
    capabilities: {
      capabilities,
      inputModalities: ['text'],
      outputModalities: ['text'],
      ...(opts.efforts ? { reasoningEfforts: opts.efforts } : {}),
      ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
    },
  };
}

function catalogOf(m: UsableAiModel, enabled = true): CatalogModel {
  return { provider: m.provider, modelId: m.modelId, displayName: m.displayName, capabilities: m.capabilities.capabilities, enabled };
}

function facts(over: Partial<RoleResolutionFacts> = {}): RoleResolutionFacts {
  return {
    aiEnabled: true,
    webSearchEnabled: true,
    usable: [],
    hasAnyKeySource: true,
    providerSupports: (provider, cap) => cap !== 'hosted_tools' || provider === 'openai' || provider === 'anthropic',
    catalog: [],
    settings: undefined,
    ...over,
  };
}

const reasoner = model('reasoner', [...RESEARCH, 'reasoning'], { efforts: ['low', 'medium', 'high'], contextWindow: 200_000 });
const plain = model('plain', BASE);

describe('resolveRole — state table', () => {
  it('ai_disabled when the kill switch is off', () => {
    const r = resolveRole('planner', facts({ aiEnabled: false, usable: [reasoner] }));

    expect(r).toMatchObject({ state: 'ai_disabled', fix: 'admin', effectiveEffort: null });
    expect(r.model).toBeUndefined();
  });

  it('no_key when no provider has a key source', () => {
    expect(resolveRole('planner', facts({ hasAnyKeySource: false }))).toMatchObject({ state: 'no_key', fix: 'keys' });
  });

  it('no_models when a key exists but no model is usable', () => {
    expect(resolveRole('planner', facts({ hasAnyKeySource: true }))).toMatchObject({ state: 'no_models', fix: 'admin' });
  });

  it('missing_capability with up to 5 candidates (enabled first) when usable models lack a capability', () => {
    const catalog = [
      ...['c1', 'c2', 'c3', 'c4'].map((id) => catalogOf(model(id, BASE), false)),
      catalogOf(model('c5', BASE), true),
      catalogOf(model('c6', BASE), false),
      catalogOf(model('nope', ['responses']), true),
    ];
    const r = resolveRole('planner', facts({ usable: [model('text-only', ['responses'])], catalog }));

    expect(r.state).toBe('missing_capability');
    expect(r.candidates).toHaveLength(5);
    expect(r.candidates![0]).toMatchObject({ modelId: 'c5', enabled: true });
    expect(r.candidates!.map((c) => c.modelId)).not.toContain('nope');
    expect(r.fix).toBe('keys');
  });

  it('missing_capability points at an administrator when no capable model is enabled', () => {
    const r = resolveRole('planner', facts({ usable: [model('text-only', ['responses'])], catalog: [catalogOf(plain, false)] }));

    expect(r).toMatchObject({ state: 'missing_capability', fix: 'admin' });
  });

  it('auto when nothing is chosen and a capable model exists', () => {
    const r = resolveRole('planner', facts({ usable: [plain] }));

    expect(r).toMatchObject({
      state: 'auto',
      model: { provider: 'openai', modelId: 'plain', displayName: 'plain display', keySource: 'user' },
      fix: null,
    });
  });

  it('ready on the explicit role preference', () => {
    const r = resolveRole(
      'planner',
      facts({
        usable: [plain, reasoner],
        settings: { defaultModel: { provider: 'openai', modelId: 'reasoner' }, taskModels: { planner: { provider: 'openai', modelId: 'plain', reasoningEffort: null } } },
      }),
    );

    expect(r).toMatchObject({ state: 'ready', model: { modelId: 'plain' } });
  });

  it('ready on ai.defaultModel when there is no role preference', () => {
    const r = resolveRole('critic', facts({ usable: [reasoner, plain], settings: { defaultModel: { provider: 'openai', modelId: 'plain' } } }));

    expect(r).toMatchObject({ state: 'ready', model: { modelId: 'plain' } });
  });

  it('an incapable defaultModel is skipped for the auto pick', () => {
    const r = resolveRole(
      'critic',
      facts({ usable: [model('text-only', ['responses']), plain], settings: { defaultModel: { provider: 'openai', modelId: 'text-only' } } }),
    );

    expect(r).toMatchObject({ state: 'auto', model: { modelId: 'plain' } });
  });

  it('stale_preference falls back to the default model, then to auto', () => {
    const gone = { provider: 'openai', modelId: 'gone', reasoningEffort: null };

    expect(
      resolveRole('planner', facts({ usable: [plain, reasoner], settings: { defaultModel: { provider: 'openai', modelId: 'plain' }, taskModels: { planner: gone } } })),
    ).toMatchObject({ state: 'stale_preference', model: { modelId: 'plain' }, stalePreference: { modelId: 'gone' }, fix: 'settings' });

    expect(
      resolveRole('planner', facts({ usable: [plain, reasoner], settings: { defaultModel: null, taskModels: { planner: gone } } })),
    ).toMatchObject({ state: 'stale_preference', model: { modelId: 'reasoner' } });
  });

  it('a preference that is usable but incapable is stale too', () => {
    const r = resolveRole(
      'planner',
      facts({ usable: [model('text-only', ['responses']), plain], settings: { defaultModel: null, taskModels: { planner: { provider: 'openai', modelId: 'text-only', reasoningEffort: null } } } }),
    );

    expect(r).toMatchObject({ state: 'stale_preference', model: { modelId: 'plain' } });
  });

  it('a stale preference with nothing to fall back to reports the blocking state and names the saved model', () => {
    const r = resolveRole(
      'planner',
      facts({ hasAnyKeySource: false, settings: { defaultModel: null, taskModels: { planner: { provider: 'openai', modelId: 'gone', reasoningEffort: 'low' } } } }),
    );

    expect(r).toMatchObject({ state: 'no_key', stalePreference: { provider: 'openai', modelId: 'gone' }, requestedEffort: 'low' });
    expect(r.model).toBeUndefined();
  });

  it('carries the key source and never a key', () => {
    const r = resolveRole('evaluator', facts({ usable: [model('org-model', BASE, { keySource: 'org' })] }));

    expect(r.model).toEqual({ provider: 'openai', modelId: 'org-model', displayName: 'org-model display', keySource: 'org' });
  });

  it('every role resolves, with its needs', () => {
    for (const role of TRAINING_AGENT_ROLES) {
      const r = resolveRole(role, facts({ usable: [reasoner] }));

      expect(r.role).toBe(role);
      expect(r.needs).toEqual(expect.arrayContaining(BASE));
    }
    expect(resolveRole('researcher', facts()).needs).toContain('hosted_tools');
    expect(resolveRole('planner', facts()).needs).not.toContain('hosted_tools');
  });
});

describe('resolveRole — researcher', () => {
  const anthropicHosted = model('claude-hosted', RESEARCH, { provider: 'anthropic' });
  const compatible = model('local', RESEARCH, { provider: 'openai-compatible', keySource: 'none' });

  it('never resolves to a model without hosted_tools', () => {
    const r = resolveRole('researcher', facts({ usable: [plain], settings: { defaultModel: { provider: 'openai', modelId: 'plain' } } }));

    expect(r.state).toBe('missing_capability');
    expect(r.model).toBeUndefined();
  });

  it('never resolves to a non-OpenAI provider, even one declaring hosted_tools', () => {
    const r = resolveRole(
      'researcher',
      facts({ usable: [anthropicHosted, compatible], settings: { defaultModel: null, taskModels: { researcher: { provider: 'anthropic', modelId: 'claude-hosted', reasoningEffort: null } } } }),
    );

    expect(r.state).toBe('missing_capability');
    expect(r.model).toBeUndefined();
  });

  it('never resolves to a model whose provider lacks the hosted-tools port', () => {
    const r = resolveRole('researcher', facts({ usable: [reasoner], providerSupports: (_p, cap) => cap !== 'hosted_tools' }));

    expect(r.state).toBe('missing_capability');
  });

  it('web_search_disabled when a capable model exists but the admin switch is off', () => {
    const r = resolveRole('researcher', facts({ usable: [reasoner], webSearchEnabled: false }));

    expect(r).toMatchObject({ state: 'web_search_disabled', fix: 'admin' });
    expect(r.model).toBeUndefined();
  });

  it('web search off does not affect the other roles', () => {
    expect(resolveRole('planner', facts({ usable: [reasoner], webSearchEnabled: false })).state).toBe('auto');
  });

  it('ready on an OpenAI hosted-tools model', () => {
    expect(resolveRole('researcher', facts({ usable: [anthropicHosted, reasoner] }))).toMatchObject({
      state: 'auto',
      model: { provider: 'openai', modelId: 'reasoner' },
    });
  });
});

describe('pickAuto', () => {
  const a = model('a-small', BASE, { contextWindow: 8_000 });
  const b = model('b-big', BASE, { contextWindow: 128_000 });
  const c = model('c-reason', [...BASE, 'reasoning'], { contextWindow: 16_000, efforts: ['low'] });
  const d = model('a-big', BASE, { contextWindow: 128_000 });
  const e = model('a-big', BASE, { contextWindow: 128_000, provider: 'anthropic' });

  it('reasoning first, then larger context, then modelId ascending, then provider', () => {
    expect(pickAuto([a, b, c, d, e])?.modelId).toBe('c-reason');
    expect(pickAuto([a, b, d, e])).toBe(e);
    expect(pickAuto([a, b])).toBe(b);
  });

  it('is deterministic under shuffled input order', () => {
    const all = [a, b, c, d, e];
    const expected = pickAuto(all);

    for (let i = 0; i < 20; i++) {
      const shuffled = [...all].sort(() => Math.random() - 0.5);

      expect(pickAuto(shuffled)).toBe(expected);
    }
  });

  it('returns undefined for no models', () => {
    expect(pickAuto([])).toBeUndefined();
  });
});

describe('effort', () => {
  it('uses the role default when nothing is chosen', () => {
    const r = resolveRole('planner', facts({ usable: [reasoner] }));

    expect(r).toMatchObject({ requestedEffort: 'high', effectiveEffort: 'high' });
    expect(r.effortNote).toBeUndefined();
    expect(resolveRole('researcher', facts({ usable: [reasoner] }))).toMatchObject({ requestedEffort: 'medium' });
    expect(resolveRole('critic', facts({ usable: [reasoner] }))).toMatchObject({ requestedEffort: 'high' });
    expect(resolveRole('evaluator', facts({ usable: [reasoner] }))).toMatchObject({ requestedEffort: 'medium' });
  });

  it('uses the chosen effort; a null choice means the role default', () => {
    const settings = (reasoningEffort: 'low' | null) => ({
      defaultModel: null,
      taskModels: { planner: { provider: 'openai', modelId: 'reasoner', reasoningEffort } },
    });

    expect(resolveRole('planner', facts({ usable: [reasoner], settings: settings('low') }))).toMatchObject({ requestedEffort: 'low', effectiveEffort: 'low' });
    expect(resolveRole('planner', facts({ usable: [reasoner], settings: settings(null) }))).toMatchObject({ requestedEffort: 'high', effectiveEffort: 'high' });
  });

  it.each<[AiReasoningEffort[], AiReasoningEffort, AiReasoningEffort, 'clamped' | undefined]>([
    [['low', 'medium', 'high'], 'high', 'high', undefined],
    [['low', 'medium'], 'high', 'medium', 'clamped'],
    [['minimal', 'high'], 'medium', 'minimal', 'clamped'],
    [['medium', 'high'], 'minimal', 'medium', 'clamped'],
    [['high', 'low'], 'medium', 'low', 'clamped'],
  ])('offers %p, requested %p -> %p (%p)', (offered, requested, effective, note) => {
    const m = model('m', [...BASE, 'reasoning'], { efforts: offered });
    const result = effectiveEffortFor(m, requested);

    expect(result.effectiveEffort).toBe(effective);
    expect(result.effortNote).toBe(note);
    expect(offered).toContain(result.effectiveEffort);
  });

  it('null with model_has_no_reasoning without the reasoning capability', () => {
    expect(effectiveEffortFor(model('m', BASE, { efforts: ['high'] }), 'high')).toEqual({
      effectiveEffort: null,
      effortNote: 'model_has_no_reasoning',
    });
  });

  it('null with model_has_no_reasoning for reasoning with an empty or absent effort list', () => {
    expect(effectiveEffortFor(model('m', [...BASE, 'reasoning'], { efforts: [] }), 'high').effectiveEffort).toBeNull();
    expect(effectiveEffortFor(model('m', [...BASE, 'reasoning']), 'high')).toEqual({
      effectiveEffort: null,
      effortNote: 'model_has_no_reasoning',
    });
  });
});
