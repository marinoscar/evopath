import { aiModelCapabilitiesSchema } from '../../core/capabilities';
import {
  GEMINI_THINKING_BUDGETS,
  classifyGeminiModel,
  geminiModelProfile,
  normalizeGeminiModelId,
} from './gemini-model-catalog';

describe('gemini model catalog', () => {
  it.each([
    ['gemini-3-pro-preview', 'level'],
    ['gemini-3.1-pro-preview', 'level'],
    ['gemini-3-flash-preview', 'level'],
    ['gemini-3.1-flash-lite-preview', 'level'],
    ['gemini-2.5-pro', 'budget'],
    ['gemini-2.5-flash', 'budget'],
    ['gemini-2.5-flash-lite', 'budget'],
    ['gemini-2.5-flash-preview-09-2025', 'budget'],
    ['gemini-2.0-flash', 'none'],
    ['gemini-2.0-flash-lite-001', 'none'],
    ['gemini-1.5-pro-002', 'none'],
    ['gemini-1.5-flash-8b', 'none'],
  ])('classifies %s as a generative model with %s thinking', (id, thinking) => {
    const profile = geminiModelProfile(id);

    expect(profile?.kind).toBe('generate');
    expect(profile?.thinking).toBe(thinking);
    expect(aiModelCapabilitiesSchema.safeParse(profile?.capabilities).success).toBe(true);
    expect(profile?.capabilities.capabilities).toEqual(
      expect.arrayContaining(['responses', 'tools', 'streaming', 'vision_input', 'file_input']),
    );
    expect(profile?.capabilities.capabilities).not.toContain('hosted_tools');
    expect(profile?.capabilities.capabilities.includes('reasoning')).toBe(thinking !== 'none');
  });

  it('sends a schema on 2.5+ only, and combines it with tools on 3.x only', () => {
    expect(geminiModelProfile('gemini-3-pro-preview')).toMatchObject({ structuredOutput: true, structuredWithTools: true });
    expect(geminiModelProfile('gemini-2.5-flash')).toMatchObject({ structuredOutput: true, structuredWithTools: false });
    expect(geminiModelProfile('gemini-2.0-flash')).toMatchObject({ structuredOutput: false });
    expect(classifyGeminiModel('gemini-2.0-flash')?.capabilities).not.toContain('structured_output');
  });

  it('maps Gemini 3 Pro efforts onto its two levels and Flash onto all four', () => {
    expect(geminiModelProfile('gemini-3-pro-preview')?.thinkingLevels).toEqual({
      minimal: 'LOW',
      low: 'LOW',
      medium: 'HIGH',
      high: 'HIGH',
    });
    expect(geminiModelProfile('gemini-3-flash-preview')?.thinkingLevels).toEqual({
      minimal: 'MINIMAL',
      low: 'LOW',
      medium: 'MEDIUM',
      high: 'HIGH',
    });
  });

  it('keeps every budget inside the ranges of all three 2.5 families', () => {
    for (const budget of Object.values(GEMINI_THINKING_BUDGETS)) {
      expect(budget).toBeGreaterThanOrEqual(512); // Flash-Lite's floor
      expect(budget).toBeLessThanOrEqual(24_576); // Flash's ceiling
    }
  });

  it.each(['gemini-embedding-001', 'gemini-embedding-2-preview', 'text-embedding-004'])(
    'classifies %s as an embedding model that accepts dimensions',
    (id) => {
      const profile = geminiModelProfile(id);

      expect(profile?.kind).toBe('embedding');
      expect(profile?.embeddingDimensions).toBe(true);
      expect(profile?.capabilities).toMatchObject({ capabilities: ['embeddings'], outputModalities: ['embedding'] });
    },
  );

  it.each([
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-image-preview',
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-pro-preview-tts',
    'gemini-2.5-flash-native-audio-preview-09-2025',
    'gemini-live-2.5-flash-preview',
    'gemini-2.5-computer-use-preview-10-2025',
    'gemini-robotics-er-1.5-preview',
    'imagen-4.0-generate-001',
    'veo-3.0-generate-001',
    'gemma-3-27b-it',
    'aqa',
    'embedding-001',
    'gemini-flash-latest',
    'something-else',
  ])('leaves %s unclassified without metadata', (id) => {
    expect(classifyGeminiModel(id)).toBeNull();
  });

  it('normalises the id: case, whitespace and the models/ prefix', () => {
    expect(normalizeGeminiModelId('  models/Gemini-2.5-Flash ')).toBe('gemini-2.5-flash');
    expect(classifyGeminiModel('models/gemini-2.5-flash')).toEqual(classifyGeminiModel('gemini-2.5-flash'));
  });

  it('returns a fresh copy each call', () => {
    const first = classifyGeminiModel('gemini-2.5-flash');

    first?.capabilities.push('realtime');

    expect(classifyGeminiModel('gemini-2.5-flash')?.capabilities).not.toContain('realtime');
  });

  describe('enrichment from listing metadata (#447)', () => {
    it("replaces the table's token limits with the provider's own", () => {
      const caps = classifyGeminiModel('gemini-2.5-flash', {
        inputTokenLimit: 1_000_000,
        outputTokenLimit: 32_768,
        supportedActions: ['generateContent', 'countTokens'],
      });

      expect(caps).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 32_768 });
    });

    it('ignores limits that are not positive integers', () => {
      const caps = classifyGeminiModel('gemini-2.5-flash', { inputTokenLimit: -1, outputTokenLimit: 1.5 });

      expect(caps).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 65_536 });
    });

    it('never gives an embedding model an output limit', () => {
      const caps = classifyGeminiModel('gemini-embedding-001', {
        inputTokenLimit: 2048,
        outputTokenLimit: 1,
        supportedActions: ['embedContent'],
      });

      expect(caps?.contextWindow).toBe(2048);
      expect(caps?.maxOutputTokens).toBeUndefined();
    });

    it('lets a listing that says the model cannot generate outrank its name', () => {
      expect(classifyGeminiModel('gemini-2.5-flash', { supportedActions: ['countTokens'] })).toBeNull();
      expect(classifyGeminiModel('text-embedding-004', { supportedActions: ['generateContent'] })).toBeNull();
      // No `supportedActions` at all: the table answers.
      expect(classifyGeminiModel('gemini-2.5-flash', { inputTokenLimit: 5 })).not.toBeNull();
    });

    it('classifies an alias no rule knows from its metadata, reasoning per the thinking flag', () => {
      const thinking = geminiModelProfile('gemini-flash-latest', {
        supportedActions: ['generateContent'],
        thinking: true,
        outputTokenLimit: 65_536,
      });
      const plain = geminiModelProfile('gemini-pro-latest', { supportedActions: ['generateContent'] });

      expect(thinking?.capabilities.capabilities).toContain('reasoning');
      expect(thinking?.thinking).toBe('budget');
      expect(plain?.capabilities.capabilities).not.toContain('reasoning');
      expect(plain?.capabilities.reasoningEfforts).toBeUndefined();
      expect(plain?.thinking).toBe('none');
      expect(aiModelCapabilitiesSchema.safeParse(plain?.capabilities).success).toBe(true);
    });

    it('classifies an unknown embedding model from its metadata', () => {
      expect(
        geminiModelProfile('gemini-embedding-exp', { supportedActions: ['embedContent'] })?.kind,
      ).toBe('embedding');
      expect(geminiModelProfile('future-embedding-9', { supportedActions: ['embedContent'] })?.kind).toBe('embedding');
    });

    it('never classifies a deliberately unclassified family, whatever its metadata says', () => {
      expect(classifyGeminiModel('gemini-2.5-flash-image', { supportedActions: ['generateContent'] })).toBeNull();
      expect(classifyGeminiModel('gemma-3-27b-it', { supportedActions: ['generateContent'] })).toBeNull();
    });

    it('does not classify a non-gemini generative id from metadata alone', () => {
      expect(classifyGeminiModel('learnlm-2.0-flash', { supportedActions: ['generateContent'] })).toBeNull();
      expect(classifyGeminiModel('mystery-model', { supportedActions: ['generateContent'] })).toBeNull();
    });
  });
});
