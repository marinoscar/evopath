import { aiModelCapabilitiesSchema } from '../../core/capabilities';
import {
  ANTHROPIC_ADAPTIVE_EFFORTS,
  ANTHROPIC_CLASSIFIER_RULES,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGETS,
  anthropicModelProfile,
  classifyAnthropicModel,
} from './anthropic-model-catalog';

describe('Anthropic model classifier', () => {
  it.each([
    // [id, thinking, structured output, sampling, file_input]
    ['claude-fable-5-1', 'adaptive', 'native', false, true],
    ['claude-mythos-5', 'adaptive', 'native', false, true],
    ['claude-mythos-preview', 'adaptive', 'native', false, true],
    ['claude-opus-5-5', 'adaptive', 'native', false, true],
    ['claude-opus-5', 'adaptive', 'native', false, true],
    ['claude-sonnet-5', 'adaptive', 'native', false, true],
    ['claude-opus-4-8', 'adaptive', 'native', false, true],
    ['claude-opus-4-7', 'adaptive', 'tool', false, true],
    ['claude-opus-4-6', 'adaptive', 'tool', true, true],
    ['claude-sonnet-4-6', 'adaptive', 'tool', true, true],
    ['claude-opus-4-5-20251101', 'budget', 'native', true, true],
    ['claude-haiku-4-5-20251001', 'budget', 'native', true, true],
    ['claude-sonnet-4-5-20250929', 'budget', 'tool', true, true],
    ['claude-opus-4-1-20250805', 'budget', 'native', true, true],
    ['claude-opus-4-20250514', 'budget', 'tool', true, true],
    ['claude-sonnet-4-0', 'budget', 'tool', true, true],
    ['claude-3-7-sonnet-20250219', 'budget', 'tool', true, true],
    ['claude-3-5-sonnet-20241022', 'none', 'tool', true, true],
    ['claude-3-5-haiku-20241022', 'none', 'tool', true, false],
    ['claude-3-haiku-20240307', 'none', 'tool', true, false],
  ] as const)('%s -> thinking %s, schemas %s, sampling %s', (id, thinking, structuredOutput, sampling, pdf) => {
    const profile = anthropicModelProfile(id);

    expect(profile).not.toBeNull();
    expect(profile).toMatchObject({ thinking, structuredOutput, sampling });
    expect(aiModelCapabilitiesSchema.safeParse(profile!.capabilities).success).toBe(true);

    const caps = profile!.capabilities.capabilities;

    expect(caps).toEqual(expect.arrayContaining(['responses', 'tools', 'structured_output', 'streaming']));
    expect(caps.includes('reasoning')).toBe(thinking !== 'none');
    expect(caps.includes('file_input')).toBe(pdf);
    expect(caps).not.toContain('hosted_tools');
    expect(profile!.capabilities.maxOutputTokens).toBeGreaterThan(0);
  });

  it('declares every neutral effort on a reasoning family (each is mapped)', () => {
    expect(classifyAnthropicModel('claude-opus-5')?.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(classifyAnthropicModel('claude-3-5-haiku-20241022')?.reasoningEfforts).toBeUndefined();
  });

  it.each(['claude-2.1', 'claude-instant-1.2', 'claude-haiku-9', 'gpt-4o', ''])('leaves %p unclassified', (id) => {
    expect(classifyAnthropicModel(id)).toBeNull();
  });

  it('matches case-insensitively and returns a fresh copy each call', () => {
    const a = classifyAnthropicModel('Claude-Opus-5');

    expect(a).not.toBeNull();
    a!.capabilities.push('embeddings');

    expect(classifyAnthropicModel('claude-opus-5')?.capabilities).not.toContain('embeddings');
  });

  it('keeps the documented constants coherent', () => {
    expect(ANTHROPIC_THINKING_BUDGETS.minimal).toBeGreaterThanOrEqual(1024);
    expect(Object.values(ANTHROPIC_THINKING_BUDGETS)).toEqual(
      [...Object.values(ANTHROPIC_THINKING_BUDGETS)].sort((a, b) => a - b),
    );
    expect(ANTHROPIC_ADAPTIVE_EFFORTS.minimal).toBe('low');
    expect(ANTHROPIC_DEFAULT_MAX_TOKENS).toBe(16_000);
    expect(ANTHROPIC_CLASSIFIER_RULES.every((rule) => rule.match instanceof RegExp)).toBe(true);
  });
});
